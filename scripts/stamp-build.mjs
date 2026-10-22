import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeWorkerBuildInfo } from './build-info.mjs';

const info = JSON.parse(readFileSync('.build-info.json', 'utf8'));
const schema = JSON.parse(readFileSync('dist/openapi.json', 'utf8'));
schema['x-build'] = info;
writeFileSync('dist/openapi.json', JSON.stringify(schema, null, 2) + '\n');
const guide = readFileSync('dist/llms.txt', 'utf8').replace(/^Build:.*\r?\n\r?\n/, '');
writeFileSync('dist/llms.txt', `Build: ${info.commit} · ${info.built_at}${info.dirty ? ' · dirty' : ''}\n\n${guide}`);
writeWorkerBuildInfo({
  ...info,
  openapi_sha256: createHash('sha256').update(readFileSync('dist/openapi.json')).digest('hex'),
});
