/**
 * WSL2 sandbox backend helpers for Windows hosts (NFR-6). The Engine runs natively on Windows; shell
 * commands run inside a WSL distro, so host paths must be translated and env forwarded via WSLENV.
 */

export interface WslConfig {
  exe: string;
  distro?: string;
}

/** Map a Windows host path to the path the same files have inside WSL. POSIX paths are already WSL paths. */
export function toWslPath(hostPath: string): string {
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(hostPath);
  if (drive) {
    const rest = (drive[2] ?? '').split(/[\\/]+/).filter(Boolean).join('/');
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  const unc = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/][^\\/]+((?:[\\/].*)?)$/i.exec(hostPath);
  if (unc) return `/${unc[1].split(/[\\/]+/).filter(Boolean).join('/')}`;
  if (hostPath.startsWith('/') && !hostPath.startsWith('//')) return hostPath;
  throw new Error(`cannot map '${hostPath}' into WSL: use a drive path (C:\\…) or a \\\\wsl$ path`);
}

/** Arguments for `wsl.exe` that run `command` with bash in `cwd` (a host path). */
export function wslExecArgs(cfg: WslConfig, cwd: string, command: string, program: string[] = ['bash', '-c']): string[] {
  return [...(cfg.distro ? ['-d', cfg.distro] : []), '--cd', toWslPath(cwd), '--exec', ...program, command];
}

/** `WSLENV` value forwarding the given variable names into WSL as-is (`/u`: Windows → WSL only). */
export function wslEnvList(names: string[]): string {
  return names.filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && n !== 'WSLENV' && n !== 'PATH').map((n) => `${n}/u`).join(':');
}

/** The WSL backend applies on Windows hosts, or when forced with `HELIX_SANDBOX_PROVIDER=wsl` (tests, Linux dev). */
export function wslFromEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): WslConfig | null {
  if (platform !== 'win32' && env.HELIX_SANDBOX_PROVIDER !== 'wsl') return null;
  return { exe: env.HELIX_WSL_EXE || 'wsl.exe', distro: env.HELIX_WSL_DISTRO || undefined };
}
