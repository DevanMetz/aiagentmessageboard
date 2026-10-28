import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localRuntime } from './support/runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
// Synthetic fixture credentials; never use real account credentials in tests.
const key = 'coverage-fixture-owner', admin = 'coverage-fixture-admin';
const mod = 'ambmod_' + 'c'.repeat(64), bridge = 'coverage-fixture-bridge';
const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
let runtime, sequence = 0;
before(async () => {
  const day = Math.floor(Date.now()/86400000);
  runtime = await localRuntime({ port: 8840, vars: { MODERATION_KEY_HASH: hash(mod), CONTRIBUTION_BRIDGE_HASH: hash(bridge) }, seed: `
    INSERT INTO agents(id,name,key_hash,is_admin,created_at) VALUES
      ('${owner}','Coverage Owner','${hash(key)}',0,'2000-01-01T00:00:00Z'),
      ('${other}','Coverage Other','unused-coverage-hash',0,'2000-01-01T00:00:00Z'),
      ('coverage-admin','Coverage Admin','${hash(admin)}',1,'2000-01-01T00:00:00Z'),
      ('coverage-disabled','Coverage Disabled','${hash('coverage-revoked')}',0,'2000-01-01T00:00:00Z');
    UPDATE agents SET disabled=1 WHERE id='coverage-disabled';
    INSERT INTO boards(id,slug,name,description,visibility,join_mode,owner_id) VALUES
      ('coverage-board','coverage-board','Coverage Board','','public','open','${owner}'),
      ('coverage-private','coverage-private','Private Coverage','','private','invite','${other}');
    INSERT INTO memberships(board_id,agent_id,role) VALUES ('coverage-board','${owner}','owner');
    INSERT INTO threads(id,board_id,author_id,title) VALUES ('coverage-thread','coverage-board','${owner}','Coverage thread'),('coverage-secret','coverage-private','${other}','Secret thread');
    INSERT INTO tasks(thread_id,goal,deliverable,acceptance_criteria) VALUES ('coverage-thread','Goal','Result','Acceptance');
    INSERT INTO messages(id,thread_id,author_id,content) VALUES (80001,'coverage-thread','${owner}','First coverage message'),(80002,'coverage-thread','${other}','Second coverage message'),(80003,'coverage-secret','${other}','Secret');
    INSERT INTO rate_limits(key,count,expires_at) VALUES ('daily-agent:coverage-admin:${day}',5000,${Math.floor(Date.now()/1000)+172800});
  ` });
});
after(() => runtime?.stop());
async function call(path, { method='GET', body, raw, token=key, headers={} }={}) {
  const r = await fetch(runtime.base + path, { method, headers: { Connection:'close', 'Content-Type':'application/json', 'cf-connecting-ip':`198.19.${Math.floor(++sequence/250)}.${sequence%250+1}`, ...(token ? { Authorization:'Bearer '+token } : {}), ...headers }, body:raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  return { status:r.status, headers:r.headers, data:r.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
}
async function status(path, expected, options) {
  const r = await call(path, options);
  assert.equal(r.status, expected, `${options?.method || 'GET'} ${path}: unexpected status`);
  return r;
}

test('credential failures distinguish anonymous, malformed, wrong and revoked keys', async () => {
  assert.equal((await status('/v1/me',200,{token:null})).data.agent,null);
  for (const token of ['wrong-fixture-key','coverage-revoked']) await status('/v1/me',401,{token});
  await status('/v1/me',401,{headers:{Authorization:'Basic invalid'}});
  for (const path of ['/v1/inbox','/v1/reviews','/v1/chat/blocks','/v1/subscriptions']) await status(path,401,{token:null});
});

test('admin usage and audit reject ordinary agents and accept administrators', async () => {
  for (const path of ['/v1/admin/usage','/v1/admin/audit']) {
    await status(path,401,{token:null}); await status(path,403);
    await status(path,200,{token:admin});
  }
  await status('/v1/usage',200,{token:null});
});

test('daily write quota is deterministic and leaves reads available', async () => {
  const r = await status('/v1/me',429,{method:'PATCH',body:{bio:'Quota test'},token:admin});
  assert.ok(Number(r.headers.get('retry-after'))>0);
  assert.equal((await status('/v1/me',200,{token:admin})).data.agent.bio,'');
});

test('JSON envelope and profile field validation reject bad input without mutation', async () => {
  for (const raw of ['{','null','[]','42','"text"']) await status('/v1/me',400,{method:'PATCH',raw});
  await status('/v1/me',415,{method:'PATCH',raw:'{}',headers:{'Content-Type':'text/plain'}});
  await status('/v1/me',413,{method:'PATCH',body:{bio:'x'.repeat(24001)}});
  for (const body of [{name:3},{name:''},{name:'x'.repeat(41)},{bio:[]},{bio:'x'.repeat(301)}]) await status('/v1/me',400,{method:'PATCH',body});
  await status('/v1/me',200,{method:'PATCH',body:{bio:'Validated profile'}});
  assert.equal((await status('/v1/me',200)).data.agent.bio,'Validated profile');
});

for (const path of ['/v1/boards','/v1/boards/coverage-board/threads','/v1/boards/coverage-board/members','/v1/boards/coverage-board/messages','/v1/threads/coverage-thread','/v1/tasks','/v1/inbox','/v1/search/messages?q=coverage','/v1/reviews','/v1/agents','/v1/resources','/v1/subscriptions/messages']) {
  test(`pagination bounds: ${path}`, async () => {
    const separator = path.includes('?')?'&':'?';
    for (const limit of ['0','-1','nope','101','9007199254740992']) await status(`${path}${separator}limit=${limit}`,400);
    await status(`${path}${separator}limit=1`,200);
  });
}

test('offset bounds and terminal pages remain consistent', async () => {
  for (const path of ['/v1/boards','/v1/boards/coverage-board/threads','/v1/boards/coverage-board/members','/v1/tasks','/v1/inbox','/v1/search/threads?q=coverage','/v1/reviews','/v1/dao/proposals','/v1/chat/conversations']) {
    const separator=path.includes('?')?'&':'?';
    for (const offset of ['-1','nope','9007199254740992']) await status(`${path}${separator}offset=${offset}`,400);
    const r=await status(`${path}${separator}offset=10000`,200);
    assert.equal(r.data.next_offset,null,path);
    if ('has_more' in r.data) assert.equal(r.data.has_more,false,path);
  }
});

test('message cursors and has_more advance exactly across final and empty pages', async () => {
  for (const path of ['/v1/threads/coverage-thread','/v1/boards/coverage-board/messages']) {
    for (const after of ['-1','abc','1.5','9007199254740992']) await status(`${path}?after=${after}`,400);
    const first=(await status(`${path}?limit=1`,200)).data;
    assert.equal(first.has_more,true); assert.equal(first.next_cursor,80001);
    const last=(await status(`${path}?limit=1&after=${first.next_cursor}`,200)).data;
    assert.equal(last.has_more,false); assert.equal(last.next_cursor,80002);
    const empty=(await status(`${path}?after=${last.next_cursor}`,200)).data;
    assert.deepEqual(empty.messages,[]); assert.equal(empty.has_more,false); assert.equal(empty.next_cursor,last.next_cursor);
  }
  for (const before of ['0','-1','abc','9007199254740992']) await status(`/v1/agents/${owner}/messages?before=${before}`,400);
});

test('private board reads and writes stay hidden from nonmembers', async () => {
  for (const token of [null,key]) for (const path of ['/v1/boards/coverage-private','/v1/boards/coverage-private/messages','/v1/threads/coverage-secret','/v1/search/messages?q=Secret&board=coverage-private']) await status(path,404,{token});
  await status('/v1/threads/coverage-secret/messages',404,{method:'POST',body:{content:'Outsider'}});
});

test('GET write adapters reject cookie auth, wrong methods and ambiguous parameters', async () => {
  const visitor=await status('/v1/visitor',201,{method:'POST',body:{},token:null});
  const cookie=visitor.headers.get('set-cookie').split(';')[0];
  for (const path of ['/v1/get/boards/general/threads?title=Test&content=Test&request_id=one','/v1/get/me/profile','/v1/get/resources','/v1/get/threads/coverage-thread/subscribe']) await status(path,401,{token:null,headers:{Cookie:cookie}});
  await status('/v1/get/agents',405,{method:'POST',body:{}});
  await status('/v1/get/agents?name=One&name=Two',400,{token:null});
  await status('/v1/get/agents?unknown=field',400,{token:null});
  await status('/v1/get/agents',403,{token:null,headers:{Purpose:'prefetch'}});
  await status('/v1/get/no-such-route',404);
});

test('routing preserves intended 404 and 405 responses for wrong methods and bad IDs', async () => {
  for (const path of ['/v1/unknown','/v1/messages/nope/vote','/v1/threads/missing','/v1/boards/Bad_Slug','/v1/contributions/invalid','/v1/reviews/invalid','/v1/dao/unknown']) await status(path,404);
  await status('/v1/boards',404,{method:'DELETE'});
  await status('/v1/resources',405,{method:'POST',body:{}});
  await status('/v1/chat/conversations/not-a-uuid',400);
  await status('/v1/chat/blocks/not-a-uuid',400,{method:'PUT',body:{}});
  await status('/v1/health',200,{method:'PUT',body:{}});
  await status('/v1/boards',204,{method:'OPTIONS',token:null});
});

test('chat empty reads, settings, and request validation need no cryptographic fixtures', async () => {
  assert.equal((await status('/v1/chat/keys/me',200)).data.identity,null);
  assert.deepEqual((await status('/v1/chat/blocks',200)).data.blocks,[]);
  assert.deepEqual((await status('/v1/chat/people?q=x',200)).data.people,[]);
  await status('/v1/chat/settings',409,{method:'PATCH',body:{accept_requests:true}});
  for (const body of [{},{accept_requests:'true'},{accept_requests:true,plaintext:'no'}]) await status('/v1/chat/settings',400,{method:'PATCH',body});
  for (const body of [{},{kind:'dm',member_ids:'bad'},{kind:'group',member_ids:[null]}]) await status('/v1/chat/conversations',400,{method:'POST',body});
});

test('moderation credential separation, empty history and boundary validation', async () => {
  for (const token of [null,key,bridge]) await status('/v1/moderation/history',401,{token});
  assert.deepEqual((await status('/v1/moderation/history',200,{token:mod})).data.actions,[]);
  for (const query of ['limit=0','limit=-1','limit=51','limit=nope','offset=100001','offset=-1','offset=nope']) await status('/v1/moderation/history?'+query,400,{token:mod});
  await status('/v1/moderation/accounts/missing',404,{token:mod});
  await status('/v1/moderation/accounts/'+owner+'?before=nope',400,{token:mod});
  await status('/v1/moderation/queue?mode=invalid',400,{token:mod});
  for (const raw of ['{','null','[]']) await status('/v1/moderation/actions',400,{method:'POST',raw,token:mod});
  await status('/v1/moderation/actions',400,{method:'POST',body:{reason:'x'.repeat(4001)},token:mod});
});

test('contribution and review bridges isolate credentials and validate empty work', async () => {
  for (const token of [null,key,mod]) await status('/v1/contribution-bridge/queue',401,{method:'POST',body:{},token});
  assert.deepEqual((await status('/v1/contribution-bridge/queue',200,{method:'POST',body:{},token:bridge})).data.contributions,[]);
  for (const path of ['/v1/contribution-bridge/reviews/sync','/v1/contribution-bridge/reviews/ack']) await status(path,400,{method:'POST',body:{},token:bridge});
  await status('/v1/threads/coverage-thread/contributions?offset=100001',400);
  assert.deepEqual((await status('/v1/threads/coverage-thread/contributions',200)).data,{contributions:[],next_offset:null});
  await status('/v1/reviews?state=invalid',400);
});

test('malformed percent-encoded identifiers are client errors', async () => {
  for (const path of [`/v1/agents/%ZZ/messages`,`/v1/agents/%ZZ/profile`,`/v1/threads/%ZZ/subscription`]) await status(path,400);
  for (const path of ['/b/%ZZ','/t/%ZZ','/a/%ZZ']) await status(path,404,{token:null});
});

test('DAO discovery and unlinked wallets work without external RPC requests', async () => {
  assert.equal((await status('/v1/dao',200,{token:null})).data.testnetOnly,true);
  await status('/v1/dao',404,{method:'POST',body:{}});
  for (const token of [null,key]) assert.equal((await status('/v1/dao/wallet',200,{token})).data.wallet,null);
  assert.deepEqual((await status('/v1/dao/proposals',200)).data.proposals,[]);
  await status('/v1/dao/wallet/challenge',401,{method:'POST',body:{},token:null});
  for (const address of [null,12,'bad','0x'+'0'.repeat(40)]) await status('/v1/dao/wallet/challenge',400,{method:'POST',body:{address}});
});

test('board, task and vote fields reject missing, oversized and wrong-type values', async () => {
  for (const body of [{},{name:[]},{name:'x'.repeat(61)},{name:'Valid Board',slug:'Bad_Slug'}]) await status('/v1/boards',400,{method:'POST',body});
  for (const body of [{expires_in_hours:0},{expires_in_hours:169},{max_uses:0},{max_uses:101}]) await status('/v1/boards/coverage-board/invites',400,{method:'POST',body});
  await status('/v1/boards/coverage-board/invites',201,{method:'POST',body:{expires_in_hours:1,max_uses:1}});
  for (const body of [{},{value:'1'},{value:0},{value:2}]) {
    await status('/v1/messages/80001/vote',400,{method:'PUT',body});
    await status('/v1/threads/coverage-thread/vote',400,{method:'PUT',body});
  }
  await status('/v1/threads/coverage-thread/task',400,{method:'PATCH',body:{action:'unknown'}});
  await status('/v1/threads/coverage-thread/task',401,{method:'PATCH',body:{action:'release'},token:null});
});

test('public pages cover static views, redirect, HEAD and invalid sitemap shards', async () => {
  for (const path of ['/docs','/analytics','/agents','/resources','/dao','/messages','/moderation','/subscriptions','/feed.xml','/sitemaps/pages.xml']) {
    await status(path,200,{token:null});
    const r=await status(path,200,{method:'HEAD',token:null}); assert.equal(r.data,'');
  }
  for (const path of ['/sitemaps/unknown-1.xml','/sitemaps/threads-0.xml','/sitemaps/threads-99999.xml','/b/missing','/t/missing','/a/missing','/boards?offset=-1']) await status(path,404,{token:null});
  const r=await fetch(runtime.base+'/tasks',{redirect:'manual'});
  assert.equal(r.status,308); assert.ok(r.headers.get('location').endsWith('/boards'));
});
