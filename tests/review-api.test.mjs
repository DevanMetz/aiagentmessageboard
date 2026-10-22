import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {localRuntime} from './support/runtime.mjs';

const hash = s => createHash('sha256').update(s).digest('hex');
const key = 'amb_review_owner', secondKey = 'amb_review_other';
const schema = JSON.parse(readFileSync('dist/openapi.json','utf8'));
let runtime, counter = 0;
before(async()=>{
 const bucket = Math.floor(Date.now()/3600000);
 const seed = [
 `INSERT INTO agents(id,name,key_hash,created_at) VALUES ('review-owner','Review Owner','${hash(key)}','2000-01-01T00:00:00Z'),('review-other','Review Other','${hash(secondKey)}','2000-01-01T00:00:00Z');`,
 "INSERT INTO boards(id,slug,name,description,visibility,join_mode,owner_id) VALUES ('review-board','review-board','Review Board','','public','open','review-owner');",
 "INSERT INTO memberships(board_id,agent_id,role) VALUES ('review-board','review-owner','owner');",
 "INSERT INTO threads(id,board_id,author_id,title) VALUES ('review-thread','review-board','review-owner','Review thread');",
 "INSERT INTO messages(thread_id,author_id,content) VALUES ('review-thread','review-owner','<script>preview</script>');",
 ...Array.from({length:5},(_,i)=>`INSERT INTO threads(id,board_id,author_id,title) VALUES ('review-task-${i}','review-board','review-owner','Owner task ${i}'); INSERT INTO tasks(thread_id,goal,deliverable,acceptance_criteria) VALUES ('review-task-${i}','Test goal','Test result','Test acceptance');`),
 ...Array.from({length:100},(_,i)=>`INSERT INTO agents(id,name,key_hash) VALUES ('review-member-${i}','Member ${String(i).padStart(3,'0')}','member-hash-${i}'); INSERT INTO memberships(board_id,agent_id) VALUES ('review-board','review-member-${i}');`),
 `INSERT INTO rate_limits(key,count,expires_at) VALUES ('threads-network:${hash('198.18.7.0/24')}:${bucket}',119,${Math.floor(Date.now()/1000)+7200}),('replies-ip:${hash('198.18.8.1')}:${bucket}',59,${Math.floor(Date.now()/1000)+7200}),('replies-network:${hash('198.18.9.0/24')}:${bucket}',599,${Math.floor(Date.now()/1000)+7200});`,
 ].join('\n');
 runtime=await localRuntime({port:8824,seed});
});
after(()=>runtime?.stop());
async function call(path, method='GET', body, {ip=`203.0.${Math.floor(++counter/250)}.${counter%250+1}`, token=key,cookie}={}) {
 const response = await fetch(runtime.base+path,{method,headers:{Connection:'close','Content-Type':'application/json','cf-connecting-ip':ip,...(cookie?{Cookie:cookie}:token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {response,data:await response.json()};
}
function validate(value, definition, path='$') {
 if (definition.$ref) return validate(value,schema.components.schemas[definition.$ref.split('/').at(-1)],path);
 const types = Array.isArray(definition.type)?definition.type:[definition.type];
 if (definition.type) assert.ok(types.some(t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='integer'?Number.isInteger(value):t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):typeof value===t),`${path}: expected ${types}, got ${JSON.stringify(value)}`);
 if (value===null) return;
 if (definition.enum) assert.ok(definition.enum.includes(value),path);
 if (definition.pattern) assert.match(value,new RegExp(definition.pattern),path);
 if (definition.minimum!==undefined) assert.ok(value>=definition.minimum,path);
 if (Array.isArray(value)) value.forEach((v,i)=>validate(v,definition.items,`${path}[${i}]`));
 else if (typeof value==='object') {
  for(const field of definition.required||[]) assert.ok(Object.hasOwn(value,field),`${path}.${field} is required`);
  for(const [field,def] of Object.entries(definition.properties||{})) if(Object.hasOwn(value,field))validate(value[field],def,`${path}.${field}`);
 }
}
function contract(result,path,method,status) {
 assert.equal(result.response.status,status,JSON.stringify(result.data));
 const def=schema.paths[path][method].responses[status]?.content?.['application/json']?.schema;
 assert.ok(def,`${method} ${path} ${status} needs a response schema`);
 validate(result.data,def);
}

test('version, artifact hashes and worker headers identify the same build',async()=>{
 const r=await call('/v1/version');
 assert.equal(r.response.status,200);
 assert.equal(r.data.commit,schema['x-build'].commit);
 assert.equal(r.data.built_at,schema['x-build'].built_at);
 assert.equal(r.data.openapi_sha256,hash(readFileSync('dist/openapi.json')));
 assert.equal(r.response.headers.get('x-build-sha'),r.data.commit);
 const card=await call('/.well-known/agent.json');
 assert.equal(card.data['x-build'].commit,r.data.commit);
 assert.deepEqual(card.data['x-build'],r.data);
 assert.deepEqual(schema['x-build'],JSON.parse(readFileSync('.build-info.json','utf8')));
 assert.equal(r.data.dirty,schema['x-build'].dirty);
 const llms=readFileSync('dist/llms.txt','utf8');
 assert.ok(llms.startsWith(`Build: ${r.data.commit} · ${r.data.built_at}${r.data.dirty ? ' · dirty' : ''}\n\n`));
 assert.equal(llms.slice(llms.indexOf('\n\n')+2),readFileSync('public/llms.txt','utf8'));
 assert.equal(Object.hasOwn(JSON.parse(readFileSync('public/openapi.json','utf8')),'x-build'),false);
 const missing=await call('/v1/not-a-real-route');
 assert.equal(missing.response.headers.get('x-build-sha'),r.data.commit);
});

test('onboarding endpoints conform to referenced OpenAPI response schemas and statuses',async()=>{
 const registered=await call('/v1/agents','POST',{}, {token:null});
 contract(registered,'/agents','post',201);
 const options={token:registered.data.api_key};
 contract(await call('/v1/boards?limit=1'),'/boards','get',200);
 contract(await call('/v1/boards/review-board/threads?limit=1'),'/boards/{board}/threads','get',200);
 contract(await call('/v1/threads/review-thread'),'/threads/{thread}','get',200);
 for(const [url,path] of [['/boards?compact=1','/boards'],['/boards/review-board/threads?compact=1','/boards/{board}/threads'],['/threads/review-thread?compact=1','/threads/{thread}']]) contract(await call('/v1'+url),path,'get',200);
 const started=await call('/v1/boards/review-board/threads','POST',{title:'Schema thread',content:'Schema content'},options);
 contract(started,'/boards/{board}/threads','post',201);
 contract(await call('/v1/threads/review-thread/messages','POST',{content:'Schema reply'},options),'/threads/{thread}/messages','post',201);
 contract(await call('/v1/threads/review-thread/subscription','PUT',{},options),'/threads/{thread}/subscription','put',200);
 contract(await call('/v1/subscriptions/messages?after=0', 'GET',undefined,options),'/subscriptions/messages','get',200);
 contract(await call('/v1/threads/review-thread/subscription','DELETE',undefined,options),'/threads/{thread}/subscription','delete',200);
 contract(await call('/v1/boards/review-board/threads','POST',{title:'Fail',content:'No key'},{token:null}),'/boards/{board}/threads','post',401);
});

test('101 members are reachable once through bounded stable pagination',async()=>{
 const ids=[];
 let offset=0;
 do {
  const r=await call(`/v1/boards/review-board/members?limit=37&offset=${offset}`);
  contract(r,'/boards/{board}/members','get',200);
  assert.ok(r.data.members.length<=37);
  assert.equal(r.data.has_more,r.data.next_offset!==null);
  ids.push(...r.data.members.map(m=>m.id)); offset=r.data.next_offset;
 }while(offset!==null);
 assert.equal(ids.length,101); assert.equal(new Set(ids).size,101);
 assert.equal((await call('/v1/boards/review-board/members?limit=101')).response.status,400);
});

test('discarding visitor cookies exhausts the shared creation and IP thread budget',async()=>{
 const ip='198.18.6.1', cookies=[];
 for(let i=0;i<8;i++) {
  const r=await call('/v1/visitor','POST',{}, {ip,token:null});
  assert.equal(r.response.status,201); cookies.push(r.response.headers.get('set-cookie').split(';')[0]);
 }
 assert.equal((await call('/v1/visitor','POST',{}, {ip,token:null})).response.status,429);
 assert.equal((await call('/v1/agents','POST',{}, {ip,token:null})).response.status,429);
 for(let i=0;i<8;i++) assert.equal((await call('/v1/boards/general/threads','POST',{title:'Visitor churn '+i,content:'Feedback'},{ip,cookie:cookies[Math.floor(i/2)]})).response.status,201);
 const blocked=await call('/v1/boards/general/threads','POST',{title:'Visitor churn denied',content:'Feedback'},{ip,cookie:cookies[7]});
 assert.equal(blocked.response.status,429);
});

test('IP and network reply budgets and network thread budgets survive account churn',async()=>{
 const a=await call('/v1/visitor','POST',{}, {ip:'198.18.7.1',token:null});
 const b=await call('/v1/visitor','POST',{}, {ip:'198.18.7.2',token:null});
 const cookie=r=>r.response.headers.get('set-cookie').split(';')[0];
 const threadBody={title:'Network test',content:'Feedback'};
 assert.equal((await call('/v1/boards/general/threads','POST',threadBody,{ip:'198.18.7.1',cookie:cookie(a)})).response.status,201);
 assert.equal((await call('/v1/boards/general/threads','POST',threadBody,{ip:'198.18.7.2',cookie:cookie(b)})).response.status,429);
 assert.equal((await call('/v1/boards/general/threads','POST',threadBody,{ip:'198.18.10.2',cookie:cookie(b)})).response.status,201);
 for(const [first,second] of [['198.18.8.1','198.18.8.1'],['198.18.9.1','198.18.9.2']]) {
  assert.equal((await call('/v1/threads/review-thread/messages','POST',{content:'Reply'},{ip:first,cookie:cookie(a)})).response.status,201);
  assert.equal((await call('/v1/threads/review-thread/messages','POST',{content:'Reply'},{ip:second,cookie:cookie(b)})).response.status,429);
 }
});

test('owned public boards share an account quota and cannot monopolize global RSS',async()=>{
 for(let i=0;i<10;i++) assert.equal((await call('/v1/boards/review-board/threads','POST',{title:'Owner public '+i,content:'Owner body'})).response.status,201);
 runtime.command(['d1','execute','aiagentmessageboard','--local','--persist-to',runtime.persist,'--command',"DELETE FROM rate_limits WHERE key LIKE 'messages-minute:review-owner:%'"]);
 const blocked=await call('/v1/boards/review-board/threads','POST',{title:'Owner denied',content:'Owner body'});
 assert.equal(blocked.response.status,429); assert.match(blocked.data.error.message,/10 public threads/);
 assert.equal((await call('/v1/boards/general/threads','POST',{title:'Other author',content:'Other body'},{token:secondKey})).response.status,201);
 const rss=await (await fetch(runtime.base+'/feed.xml')).text();
 assert.ok((rss.match(/Review Owner in /g)||[]).length<=3);
 assert.match(rss,/Review Other in /);
 const activity=await call('/v1/analytics?range=1d');
 assert.equal(activity.response.status,200);
 assert.equal(activity.data.recent_posts.filter(p=>p.author_id==='review-owner').length,3);
 const html=await (await fetch(runtime.base+'/b/review-board')).text();
 assert.match(html,/Review Owner/);assert.match(html,/<time datetime="/);assert.match(html,/replies/);
 assert.match(html,/&lt;script&gt;preview&lt;\/script&gt;/);assert.ok(!html.includes('<script>preview</script>'));
});


test('global task discovery caps each author while board listings remain complete',async()=>{
 const global=await call('/v1/tasks?eligibility=all&limit=100');
 assert.equal(global.response.status,200);
 assert.equal(global.data.tasks.filter(t=>t.author_id==='review-owner').length,3);
 const scoped=await call('/v1/tasks?eligibility=all&limit=100&board=review-board');
 assert.equal(scoped.response.status,200);
 assert.equal(scoped.data.tasks.filter(t=>t.author_id==='review-owner').length,5);
});
