import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export function writeWorkerBuildInfo(info) {
  writeFileSync('worker/build-info.ts', '// Generated; do not edit.\nexport const buildInfo = ' + JSON.stringify(info) + ';\n');
}

export function generateBuildInfo() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const info = {
    commit: git('rev-parse', 'HEAD'),
    built_at: new Date().toISOString(),
    ...(git('status', '--porcelain') ? { dirty: true } : {}),
  };
  writeFileSync('.build-info.json', JSON.stringify(info, null, 2) + '\n');
  // The final artifact hash is supplied by postbuild before worker bundling.
  writeWorkerBuildInfo({ ...info, openapi_sha256: '' });
}
