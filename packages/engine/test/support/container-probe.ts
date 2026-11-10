import { spawnSync } from 'node:child_process';
import { clientEnv, containerRuntime, describeContainerProbe } from '../../src/sandbox/container.ts';

/**
 * CI diagnostic (R0.8): prints the real reason each `local-container` candidate is accepted or rejected and exits
 * non-zero when none works, so a runner never reports only "backend unavailable".
 */
for (const cli of ['podman', 'docker']) {
  const v = spawnSync(cli, ['version'], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  if (v.error) continue;
  console.log(`$ ${cli} version\n${(v.stdout + v.stderr).trim()}`);
  const info = spawnSync(cli, ['info', '--debug'], { encoding: 'utf8', env: clientEnv(), timeout: 15_000 });
  console.log(`$ ${cli} info --debug (exit ${info.status})\n${(info.stdout + info.stderr).trim()}`);
}
const rt = containerRuntime();
console.log(`container probe:\n${describeContainerProbe()}`);
if (!rt) {
  console.error('local-container: no candidate passed the capability probe');
  process.exit(1);
}
console.log(`local-container: selected ${JSON.stringify(rt)}`);
