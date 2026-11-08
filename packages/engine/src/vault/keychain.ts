import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const SERVICE = 'helix';

/** OS credential store (F-AUTH-1, §8.1). Secrets travel on stdin, never on argv where `ps` can read them. */
export interface Keychain {
  readonly kind: 'macos-keychain' | 'libsecret' | 'windows-credential-manager' | 'none';
  get(account: string): string | undefined;
  set(account: string, secret: string): void;
  delete(account: string): void;
}

function findBinary(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here */ }
  }
  return undefined;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  const r = spawnSync(bin, args, { env, input, encoding: 'utf8', timeout: 15_000 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

/** Linux Secret Service (GNOME Keyring, KWallet) via libsecret's `secret-tool`. */
class LibsecretKeychain implements Keychain {
  readonly kind = 'libsecret' as const;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(bin: string, env: NodeJS.ProcessEnv) {
    this.bin = bin;
    this.env = env;
  }
  get(account: string): string | undefined {
    const r = run(this.bin, ['lookup', 'service', SERVICE, 'account', account], this.env);
    return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : undefined;
  }
  set(account: string, secret: string): void {
    const r = run(this.bin, ['store', `--label=Helix ${account}`, 'service', SERVICE, 'account', account], this.env, secret);
    if (r.code !== 0) throw new Error(`secret-tool store failed: ${r.stderr || `exit ${r.code}`}`);
  }
  delete(account: string): void {
    run(this.bin, ['clear', 'service', SERVICE, 'account', account], this.env);
  }
}

/** macOS login keychain via `security`; writes use interactive mode so the secret is read from stdin. */
class MacKeychain implements Keychain {
  readonly kind = 'macos-keychain' as const;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(bin: string, env: NodeJS.ProcessEnv) {
    this.bin = bin;
    this.env = env;
  }
  get(account: string): string | undefined {
    const r = run(this.bin, ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], this.env);
    return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : undefined;
  }
  set(account: string, secret: string): void {
    const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
    const r = run(this.bin, ['-i'], this.env, `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -w ${quote(secret)}\n`);
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`security add-generic-password failed: ${r.stderr || `exit ${r.code}`}`);
  }
  delete(account: string): void {
    run(this.bin, ['delete-generic-password', '-s', SERVICE, '-a', account], this.env);
  }
}

const CRED_TYPES = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class HelixCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CredRead(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
'@
`;

/** Windows Credential Manager (generic credentials) via PowerShell P/Invoke; script on argv, secret on stdin. */
class WindowsKeychain implements Keychain {
  readonly kind = 'windows-credential-manager' as const;
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(bin: string, env: NodeJS.ProcessEnv) {
    this.bin = bin;
    this.env = env;
  }
  private ps(op: 'get' | 'set' | 'delete', account: string, input?: string) {
    const target = `${SERVICE}:${account}`.replace(/'/g, "''");
    const body = {
      get: `$p=[IntPtr]::Zero; if (-not [HelixCred]::CredRead('${target}',1,0,[ref]$p)) { exit 1 }; $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][HelixCred+CREDENTIAL]); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($c.CredentialBlob,$c.CredentialBlobSize/2)); [HelixCred]::CredFree($p)`,
      set: `$s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::Unicode.GetBytes($s); $c=New-Object HelixCred+CREDENTIAL; $c.Type=1; $c.Persist=2; $c.TargetName='${target}'; $c.UserName='helix'; $c.CredentialBlobSize=$b.Length; $c.CredentialBlob=[Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length); [Runtime.InteropServices.Marshal]::Copy($b,0,$c.CredentialBlob,$b.Length); $ok=[HelixCred]::CredWrite([ref]$c,0); [Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob); if (-not $ok) { exit 1 }`,
      delete: `[void][HelixCred]::CredDelete('${target}',1,0)`,
    }[op];
    const script = `$ErrorActionPreference='Stop'\n${CRED_TYPES}\n# helix-op: ${op}\n${body}\n`;
    return run(this.bin, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], this.env, input ?? '');
  }
  get(account: string): string | undefined {
    const r = this.ps('get', account);
    return r.code === 0 && r.stdout ? r.stdout : undefined;
  }
  set(account: string, secret: string): void {
    const r = this.ps('set', account, secret);
    if (r.code !== 0) throw new Error(`Credential Manager write failed: ${r.stderr || `exit ${r.code}`}`);
  }
  delete(account: string): void {
    this.ps('delete', account);
  }
}

/** No OS store available: reads find nothing and writes refuse. There is deliberately no plaintext fallback. */
export class NoKeychain implements Keychain {
  readonly kind = 'none' as const;
  get(): undefined { return undefined; }
  set(): void { throw new Error('no OS keychain available (macOS Keychain, libsecret `secret-tool`, or Windows Credential Manager required); set the key in the Engine environment instead'); }
  delete(): void {}
}

export function detectKeychain(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Keychain {
  if (platform === 'darwin') {
    const bin = findBinary('security', env);
    if (bin) return new MacKeychain(bin, env);
  } else if (platform === 'linux') {
    const bin = findBinary('secret-tool', env);
    if (bin) return new LibsecretKeychain(bin, env);
  } else if (platform === 'win32') {
    const bin = findBinary('powershell.exe', env);
    if (bin) return new WindowsKeychain(bin, env);
  }
  return new NoKeychain();
}
