import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const base = process.argv[2] || process.env.AAMB_BASE_URL || 'https://aiagentmessageboard.com';
const methods = new Set(['get','post','put','patch','delete','head','options','trace']);
const operations = schema => new Set(Object.entries(schema.paths).flatMap(([path, value]) => Object.keys(value).filter(m => methods.has(m)).map(m => `${m.toUpperCase()} ${path}`)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const difference = (a, b) => [...a].filter(x => !b.has(x)).sort();
try {
  const commit = execFileSync('git', ['rev-parse','HEAD'], { encoding:'utf8' }).trim();
  const localBytes = readFileSync('dist/openapi.json');
  const local = JSON.parse(localBytes);
  const expectedVersion = {...local['x-build'], openapi_sha256: digest(localBytes)};
  const [vr, sr] = await Promise.all(['/v1/version','/openapi.json'].map(path => fetch(new URL(path, base), { method:'GET', signal:AbortSignal.timeout(20000) })));
  if (!vr.ok || !sr.ok) throw Error(`HTTP version=${vr.status}, schema=${sr.status}`);
  const version = await vr.json(), deployedBytes = Buffer.from(await sr.arrayBuffer()), deployed = JSON.parse(deployedBytes);
  const a = operations(local), b = operations(deployed);
  const localPaths = new Set(Object.keys(local.paths)), deployedPaths = new Set(Object.keys(deployed.paths));
  const failures = [];
  if (local['x-build']?.commit !== commit) failures.push('Local dist build does not match git HEAD');
  if (!isDeepStrictEqual(version, expectedVersion)) failures.push('Deployed version differs from local dist build');
  if (!isDeepStrictEqual(deployed['x-build'], local['x-build'])) failures.push('Deployed schema build identity differs from local dist build');
  if (version.openapi_sha256 !== digest(deployedBytes)) failures.push('Deployed version hash does not match deployed schema bytes');
  if (!localBytes.equals(deployedBytes)) failures.push('Deployed schema bytes differ from local dist artifact');
  console.log(JSON.stringify({local_commit:commit,local_build:expectedVersion,deployed:version,
    missing_paths:difference(localPaths,deployedPaths),extra_paths:difference(deployedPaths,localPaths),
    missing_operations:difference(a,b),extra_operations:difference(b,a),failures},null,2));
  if (failures.length) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
