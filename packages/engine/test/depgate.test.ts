import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, type FakeTurn } from '@helix/provider-conformance';
import { Engine } from '../src/engine.ts';
import { DepGate, parseInstall } from '../src/policy/depgate.ts';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/m0/', import.meta.url));
const ADVISORIES: Record<string, Array<{ id: string; summary: string; aliases: string[] }>> = {
  'npm:lodash@4.17.20': [{ id: 'GHSA-29mw-wpgm-hmr9', summary: 'ReDoS in lodash', aliases: ['CVE-2020-28500'] }],
  'PyPI:requests@2.19.0': [{ id: 'PYSEC-2018-28', summary: 'requests leaks credentials on redirect', aliases: ['CVE-2018-18074'] }],
};

async function fakeOsv(): Promise<{ url: string; queries: string[]; close: () => Promise<void> }> {
  const queries: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/query') {
        const q = JSON.parse(raw) as { package: { name: string; ecosystem: string }; version: string };
        const key = `${q.package.ecosystem}:${q.package.name}@${q.version}`;
        queries.push(key);
        res.end(JSON.stringify(ADVISORIES[key] ? { vulns: ADVISORIES[key] } : {}));
      } else if (req.url === '/left-pad/latest') res.end(JSON.stringify({ version: '1.3.0' }));
      else if (req.url === '/pypi/requests/json') res.end(JSON.stringify({ info: { version: '2.32.3' } }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries, close: () => new Promise((r) => server.close(() => r())) };
}

test('parseInstall: npm/pnpm/yarn/pip specs, flags and local paths skipped, bare install reads package.json', () => {
  assert.deepEqual(parseInstall('npm install --save-dev lodash@4.17.20 @types/node ./local; echo hi'), [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }, { ecosystem: 'npm', name: '@types/node' }]);
  assert.deepEqual(parseInstall('pnpm add react@^18'), [{ ecosystem: 'npm', name: 'react' }]);
  assert.deepEqual(parseInstall('pip install -q requests==2.19.0 flask[async] -r requirements.txt'), [{ ecosystem: 'PyPI', name: 'requests', version: '2.19.0' }, { ecosystem: 'PyPI', name: 'flask' }]);
  assert.deepEqual(parseInstall('node --test'), []);
  const dir = mkdtempSync(join(tmpdir(), 'helix-dep-pkg-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.17.20' }, devDependencies: { tsx: 'latest' } }));
  assert.deepEqual(parseInstall('npm ci || npm install', dir), [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }, { ecosystem: 'npm', name: 'tsx' }]);
});

test('DepGate: latest version resolved via registry, workspace policy, OSV outage asks', async () => {
  const osv = await fakeOsv();
  try {
    const gate = new DepGate({ osvUrl: osv.url, npmRegistryUrl: osv.url, pypiUrl: osv.url });
    const dir = mkdtempSync(join(tmpdir(), 'helix-dep-ws-'));
    const clean = await gate.decide('npm i left-pad', dir);
    assert.equal(clean?.verdict, 'allow');
    assert.ok(osv.queries.includes('npm:left-pad@1.3.0'), osv.queries.join(','));
    assert.equal((await gate.decide('pip install requests', dir))?.verdict, 'allow');
    assert.ok(osv.queries.includes('PyPI:requests@2.32.3'));
    const vuln = await gate.decide('pip install requests==2.19.0', dir);
    assert.equal(vuln?.verdict, 'deny');
    assert.match(vuln!.reason, /requests@2\.19\.0: PYSEC-2018-28 \(CVE-2018-18074\)/);
    mkdirSync(join(dir, '.helix'));
    writeFileSync(join(dir, '.helix/deps.json'), JSON.stringify({ onVulnerable: 'ask' }));
    assert.equal((await gate.decide('pip install requests==2.19.0', dir))?.verdict, 'ask');
    assert.equal(await gate.decide('ls -la', dir), null);
    const down = await new DepGate({ osvUrl: 'http://127.0.0.1:9', npmRegistryUrl: osv.url, timeoutMs: 2000 }).decide('npm install lodash@4.17.21', dir);
    assert.equal(down?.verdict, 'ask');
    assert.match(down!.reason, /could not check lodash/);
  } finally {
    await osv.close();
  }
});

test('agent: vulnerable npm install is denied with the advisory before it runs; a fixed version runs', async () => {
  const osv = await fakeOsv();
  const dir = mkdtempSync(join(tmpdir(), 'helix-dep-agent-'));
  cpSync(join(FIXTURES, 'js-calc'), dir, { recursive: true });
  const shell = (command: string) => ({ toolCalls: [{ name: 'run_shell', args: { command } }], usage: { input: 300, output: 10 } });
  const turns: FakeTurn[] = [
    shell('npm install --offline lodash@4.17.20; touch ran-vulnerable.txt'),
    shell('npm install --offline lodash@4.17.21; touch ran-fixed.txt'),
    { text: 'Done.', usage: { input: 400, output: 5 } },
  ];
  let i = 0;
  const fake = await startFakeProvider('gemini', () => turns[Math.min(i++, turns.length - 1)]);
  const engine = new Engine({ home: mkdtempSync(join(tmpdir(), 'helix-home-')), env: { GEMINI_API_KEY: fake.apiKey, HELIX_GEMINI_BASE_URL: fake.url, HELIX_OSV_URL: osv.url, HELIX_NPM_REGISTRY_URL: osv.url }, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 }, mcp: false } as never);
  const events: Array<{ verdict?: string }> = [];
  engine.bus.subscribe('deps.checked', (e) => { events.push(e.data as { verdict?: string }); });
  try {
    const t = engine.runtime.create({ workspacePath: dir, goal: 'Add lodash.', preapprove: ['exec', 'write', 'network'] });
    const s = await engine.runtime.wait(t.id, 60_000);
    assert.equal(s.status, 'done', s.error ?? '');
    const results = engine.runtime.transcript(t.id).flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as Array<{ content: string; isError?: boolean }>;
    assert.equal(results[0].isError, true);
    assert.match(results[0].content, /^denied by policy: dependency gate: known vulnerabilities \(OSV\) in lodash@4\.17\.20: GHSA-29mw-wpgm-hmr9 \(CVE-2020-28500\) ReDoS in lodash/);
    assert.equal(existsSync(join(dir, 'ran-vulnerable.txt')), false, 'denied command never ran');
    assert.doesNotMatch(results[1].content, /denied by policy/);
    assert.equal(existsSync(join(dir, 'ran-fixed.txt')), true);
    assert.deepEqual(events.map((e) => e.verdict), ['deny', 'allow']);
    const calls = engine.db.all<{ status: string }>('SELECT status FROM tool_calls WHERE task = ? ORDER BY at', t.id);
    assert.equal(calls[0].status, 'denied');
  } finally {
    await engine.close();
    await fake.close();
    await osv.close();
  }
});
