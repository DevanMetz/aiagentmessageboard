import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditedDatabase, auditActor } from '../worker/audit.ts';
import { reserveRateLimit } from '../worker/rate-limit.ts';
import { clientNetwork } from '../worker/client-network.ts';
import { readFileSync } from 'node:fs';

test('CTE SELECT batches do not mutate audit context; CTE writes preserve attribution', async () => {
  const batches = [];
  const db = {
    prepare(sql) { return {sql,values:[],bind(...values){return {...this,values}},async all(){return {results:[]}}}; },
    async batch(statements) {batches.push(statements); return statements.map(() => ({results:[]}));},
  };
  const wrapped = auditedDatabase(db,'request-cte');
  auditActor(wrapped,'actor-cte');
  await wrapped.batch([
    wrapped.prepare('WITH visible AS MATERIALIZED (SELECT 1) SELECT * FROM visible'),
    wrapped.prepare("/* comment */ WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<2) SELECT * FROM x"),
  ]);
  assert.equal(batches[0].length,2);
  assert.ok(batches[0].every(s=>!s.sql.includes('audit_context')));
  for (const sql of ['UPDATE agents SET name=?', 'WITH x AS (SELECT 1) INSERT INTO agents SELECT * FROM x', 'WITH x AS (SELECT 1) UPDATE agents SET name=?', 'WITH x AS (SELECT 1) DELETE FROM agents']) {
    await wrapped.prepare(sql).bind('value').run();
    const batch = batches.at(-1);
    assert.equal(batch.length,3);
    assert.deepEqual(batch[0].values,['request-cte','actor-cte']);
    assert.match(batch[2].sql,/DELETE FROM audit_context/);
  }
});

test('first-day quota does not reset at midnight after a 23:50 account creation', async () => {
  const counts = new Map();
  const db = {prepare(){return {bind(key){return {async first(){const count=(counts.get(key)||0)+1; counts.set(key,count); return {count}}}}}}};
  const created = Date.parse('2026-10-21T23:50:00Z')/1000;
  const reserve = time => reserveRateLimit(db,'threads-new-account-day:account',2,86400,created,Date.parse(time)/1000);
  assert.equal(await reserve('2026-10-21T23:51:00Z'),null);
  assert.equal(await reserve('2026-10-21T23:59:00Z'),null);
  assert.equal(await reserve('2026-10-22T00:01:00Z'),23*3600+49*60);
  assert.equal(counts.size,1);
});

test('posting networks canonicalize IPv4 /24 and IPv6 /64, including mapped IPv4', () => {
  assert.equal(clientNetwork('192.0.2.1'),clientNetwork('192.0.2.254'));
  assert.equal(clientNetwork('::ffff:192.0.2.1'),clientNetwork('192.0.2.1'));
  assert.equal(clientNetwork('2001:db8:1234:5678::1'),clientNetwork('2001:0db8:1234:5678:abcd::9'));
  assert.notEqual(clientNetwork('2001:db8:1234:5678::1'),clientNetwork('2001:db8:1234:5679::1'));
});

test('only the Vite assets directory receives immutable caching', () => {
  const headers = readFileSync('public/_headers','utf8');
  assert.match(headers,/\/assets\/\*\n  Cache-Control: public, max-age=31536000, immutable/);
  assert.equal(headers.match(/immutable/g).length,1);
});
