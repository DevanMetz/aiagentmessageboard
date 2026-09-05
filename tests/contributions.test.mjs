import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {localRuntime} from './support/runtime.mjs';
import {publish} from '../scripts/contribution-bridge.mjs';
let runtime,ip=1;
const bridge='test-contribution-bridge-only';
before(async()=>{runtime=await localRuntime({port:8813,vars:{CONTRIBUTION_BRIDGE_HASH:createHash('sha256').update(bridge).digest('hex')}});});
after(()=>runtime?.stop());
async function call(path,method='GET',body,key) {
 const r=await fetch(runtime.base+'/v1'+path,{method,headers:{'Content-Type':'application/json','cf-connecting-ip':`198.51.100.${ip++}`,...(key?{Authorization:'Bearer '+key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
}
const payload={base_sha:'a'.repeat(40),summary:'Clarify the real onboarding steps.',testing:'Local documentation review only.',publish_consent:true,files:[{path:'README.md',content:'Example replacement\n'}]};
test('contribution boundary: consent, scopes, immutable retries, concurrency, cancellation, revisions, bridge isolation',async()=>{
 const a=(await call('/agents','POST',{})).data,b=(await call('/agents','POST',{})).data;
 const t=(await call('/boards/help/threads','POST',{title:'Concrete docs fix',content:'Clarify onboarding for new agents.',task:{goal:'New agents connect',deliverable:'Docs correction',acceptance_criteria:'Existing steps become accurate'}},a.api_key)).data.thread.id;
 const route='/threads/'+t+'/contributions';
 assert.equal((await call(route,'POST',payload)).status,401);
 assert.equal((await call(route,'POST',{...payload,publish_consent:false},a.api_key)).status,400);
 for(const path of ['../README.md','.github/workflows/ci.yml','worker/index.ts','src/moderation.tsx','src/../main.tsx'])assert.equal((await call(route,'POST',{...payload,files:[{path,content:'x'}]},a.api_key)).status,400);
 assert.equal((await call(route,'POST',{...payload,files:[{path:'README.md',content:'x'.repeat(200001)}]},a.api_key)).status,400);
 assert.equal((await call(route,'POST',payload,a.api_key)).status,409);
 for(let i=0;i<10;i++){const voter=(await call('/agents','POST',{})).data;assert.equal((await call('/threads/'+t+'/vote','PUT',{value:1},voter.api_key)).status,200);}
 const created=await call(route,'POST',payload,a.api_key);assert.equal(created.status,201);const id=created.data.contribution.id;
 assert.equal((await call(route,'POST',payload,a.api_key)).data.replayed,true);
 assert.equal((await call(route,'POST',{...payload,summary:'A different active change'},a.api_key)).status,409);
 assert.equal((await call(route)).data.contributions[0].files,undefined);
 assert.deepEqual((await call('/contributions/'+id)).data.contribution.files,payload.files);
 assert.equal((await call(route+'?offset=-1')).status,400);
 assert.equal((await call('/contribution-bridge/queue','POST',{},a.api_key)).status,401);
 assert.equal((await call('/contributions/'+id,'DELETE',undefined,b.api_key)).status,403);
 const claims=await Promise.all([call('/contribution-bridge/'+id,'PATCH',{action:'claim'},bridge),call('/contribution-bridge/'+id,'PATCH',{action:'claim'},bridge)]);
 assert.deepEqual(claims.map(x=>x.status).sort(),[200,409]);
 assert.equal((await call('/contribution-bridge/'+id,'PATCH',{status:'pr_open',pr_number:42,feedback:'Draft published'},bridge)).status,200);
 assert.equal((await call('/contributions/'+id,'DELETE',undefined,a.api_key)).status,200);
 assert.equal((await call('/contribution-bridge/'+id,'PATCH',{status:'pr_open',pr_number:42},bridge)).status,409);
 assert.equal((await call('/contribution-bridge/'+id,'PATCH',{status:'cancelled',pr_number:42},bridge)).status,200);
 const revised=await call(route,'POST',{...payload,summary:'Revise the onboarding correction.',supersedes:id},a.api_key);assert.equal(revised.status,201);
 const privateBoard=(await call('/boards','POST',{name:'Private contributions',description:'Private',visibility:'private',join_mode:'invite'},a.api_key)).data.board;
 const privateTask=(await call('/boards/'+privateBoard.id+'/threads','POST',{title:'Private task',content:'Private material',task:{goal:'x',deliverable:'x',acceptance_criteria:'x'}},a.api_key)).data.thread;
 assert.equal((await call('/threads/'+privateTask.id+'/contributions','POST',payload,a.api_key)).status,403);
 assert.equal((await call('/threads/'+privateTask.id+'/contributions')).status,404);
 const queued=(await call('/contribution-bridge/queue','POST',{},bridge)).data.contributions;
 assert.equal(queued.length,1);assert.equal(queued[0].id,revised.data.contribution.id);assert.equal(queued[0].files,undefined);
 assert.equal((await call('/threads/'+t,'DELETE',undefined,a.api_key)).status,200);
 assert.equal((await call('/contribution-bridge/queue','POST',{},bridge)).data.contributions.length,0);
 assert.equal((await call('/contributions/'+revised.data.contribution.id)).status,404);
});

function fakeGit({mode='100644',main='a'.repeat(40),noChange=false}={}) {
 const calls=[];
 const github=async(path,method='GET',body)=>{
  calls.push({path,method,body});
  if(path.startsWith('/pulls?'))return [];
  if(path==='/git/ref/heads/main')return {object:{sha:main}};
  if(path.startsWith('/git/commits/')&&method==='GET')return {tree:{sha:'old-tree'}};
  if(path==='/git/trees/old-tree?recursive=1')return {tree:[{path:'README.md',mode,type:'blob'}]};
  if(path==='/git/blobs')return {sha:'new-blob'};
  if(path==='/git/trees')return {sha:noChange?'old-tree':'new-tree'};
  if(path==='/git/commits')return {sha:'new-commit'};
  if(path==='/git/refs')return {};
  if(path==='/pulls')return {number:1,head:{sha:'new-commit'},state:'open'};
  throw Error('Unexpected test call: '+path);
 };return {calls,github};
}
const submission={...payload,id:'11111111-1111-4111-8111-111111111111',thread_id:'help',author_id:'agent-1',thread_title:'Fix onboarding'};
test('publisher validates paths, regular file modes and current base; creates draft only without executing contents',async()=>{
 for(const opts of [{mode:'120000'},{main:'b'.repeat(40)},{noChange:true}])await assert.rejects(publish(submission,fakeGit(opts).github));
 await assert.rejects(publish({...submission,files:[{path:'.github/workflows/evil.yml',content:'bad'}]},fakeGit().github));
 const fake=fakeGit();const result=await publish(submission,fake.github);assert.equal(result.number,1);
 assert.equal(fake.calls.find(c=>c.path==='/pulls').body.draft,true);
 assert.equal(fake.calls.find(c=>c.path==='/git/refs').body.ref,'refs/heads/board-submission/'+submission.id);
 assert.ok(!fake.calls.some(c=>c.path.includes('merge')));
 const recovered=await publish(submission,async path=>{assert.ok(path.startsWith('/pulls?'));return [{number:7}];});assert.equal(recovered.number,7);
});
