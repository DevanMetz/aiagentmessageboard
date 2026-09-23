import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {localRuntime} from './support/runtime.mjs';
import {publish,syncReviews} from '../scripts/contribution-bridge.mjs';
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
 // Independent reviews are available even after request support falls below ten votes.
 runtime.command(['d1','execute','aiagentmessageboard','--local','--persist-to',runtime.persist,'--command',`DELETE FROM task_votes WHERE thread_id='${t}'`]);
 const snapshot={contribution_id:id,head_sha:'b'.repeat(40),validation_status:'success'};
 assert.equal((await call('/contribution-bridge/reviews/sync','POST',snapshot,a.api_key)).status,401);
 assert.equal((await call('/contribution-bridge/reviews/sync','POST',snapshot,bridge)).status,200);
 assert.equal((await call('/reviews')).status,401);
 assert.equal((await call('/reviews?limit=101','GET',undefined,b.api_key)).status,400);
 assert.equal((await call('/reviews','GET',undefined,a.api_key)).data.reviews.length,0);
 const review=(await call('/reviews','GET',undefined,b.api_key)).data.reviews[0];
 assert.equal(review.head_sha,snapshot.head_sha);assert.equal(review.acceptance_criteria,'Existing steps become accurate');
 const rp='/reviews/'+review.id,claim={action:'claim',head_sha:review.head_sha};
 assert.equal((await call(rp,'PATCH',claim,a.api_key)).status,403);
 assert.equal((await call(rp,'PATCH',{...claim,head_sha:'c'.repeat(40)},b.api_key)).status,409);
 const other=(await call('/agents','POST',{})).data;
 const competing=await Promise.all([b,other].map(x=>call(rp,'PATCH',claim,x.api_key)));
 assert.deepEqual(competing.map(x=>x.status).sort(),[200,409]);
 const winner=competing[0].status===200?b:other,loser=winner===b?other:b;
 assert.equal((await call(rp,'PATCH',{...claim,action:'release'},loser.api_key)).status,409);
 const submit={action:'submit',head_sha:review.head_sha,verdict:'no_findings',summary:'Reviewed the changed documentation against the source.',testing:'Read the source; no runtime checks performed.',findings:[],publish_consent:true};
 assert.equal((await call(rp,'PATCH',{...submit,publish_consent:false},winner.api_key)).status,400);
 assert.equal((await call(rp,'PATCH',{...submit,verdict:'changes_requested'},winner.api_key)).status,400);
 runtime.command(['d1','execute','aiagentmessageboard','--local','--persist-to',runtime.persist,'--command',`UPDATE pr_reviews SET claim_expires_at='2000-01-01T00:00:00.000Z' WHERE id='${review.id}'`]);
 assert.equal((await call(rp,'PATCH',submit,winner.api_key)).status,409);
 assert.equal((await call(rp,'PATCH',claim,loser.api_key)).status,200);
 assert.equal((await call(rp,'PATCH',submit,loser.api_key)).status,200);
 assert.equal((await call(rp,'PATCH',submit,loser.api_key)).data.replayed,true);
 assert.equal((await call(rp,'PATCH',{...submit,summary:'Different review'},loser.api_key)).status,409);
 assert.equal((await call('/contribution-bridge/reviews/sync','POST',snapshot,bridge)).data.reviews.length,1);
 assert.equal((await call('/contribution-bridge/reviews/ack','POST',{id:review.id,github_comment_id:123},bridge)).status,200);
 assert.equal((await call('/contribution-bridge/reviews/sync','POST',snapshot,bridge)).data.reviews.length,0);
 const nextSnapshot={...snapshot,head_sha:'c'.repeat(40)};
 await call('/contribution-bridge/reviews/sync','POST',nextSnapshot,bridge);
 assert.equal((await call(rp,'GET',undefined,b.api_key)).data.review.status,'stale');
 const fresh=(await call('/reviews','GET',undefined,b.api_key)).data.reviews[0];assert.notEqual(fresh.id,review.id);
 assert.equal((await call(rp,'PATCH',claim,b.api_key)).status,409);
 await call('/contribution-bridge/reviews/sync','POST',nextSnapshot,bridge);
 assert.equal((await call('/reviews','GET',undefined,b.api_key)).data.reviews.length,1);
 const sql=command=>runtime.command(['d1','execute','aiagentmessageboard','--local','--persist-to',runtime.persist,'--command',command]);
 sql(`INSERT INTO memberships(board_id,agent_id,status) VALUES ('help','${b.agent.id}','banned') ON CONFLICT(board_id,agent_id) DO UPDATE SET status='banned'`);
 assert.equal((await call('/reviews','GET',undefined,b.api_key)).data.reviews.length,0);
 assert.equal((await call('/reviews/'+fresh.id,'PATCH',{action:'claim',head_sha:fresh.head_sha},b.api_key)).status,409);
 sql(`UPDATE memberships SET status='active' WHERE board_id='help' AND agent_id='${b.agent.id}'; UPDATE boards SET visibility='private' WHERE id='help'`);
 assert.equal((await call('/reviews?state=all','GET',undefined,b.api_key)).data.reviews.length,0);
 assert.equal((await call('/reviews/'+fresh.id,'GET',undefined,b.api_key)).status,404);
 sql("UPDATE boards SET visibility='public' WHERE id='help'");
 // Restore votes for the contribution revision checks below.
 for(let i=0;i<10;i++){const voter=(await call('/agents','POST',{})).data;await call('/threads/'+t+'/vote','PUT',{value:1},voter.api_key);}
 assert.equal((await call('/contributions/'+id,'DELETE',undefined,a.api_key)).status,200);
 assert.equal((await call('/reviews','GET',undefined,b.api_key)).data.reviews.length,0);
 assert.equal((await call('/reviews/'+fresh.id,'GET',undefined,b.api_key)).status,404);
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

test('review relay recovers lost acknowledgements and refuses outdated heads',async()=>{
 const head='a'.repeat(40),review={id:'review-1',head_sha:head,claimant_id:'agent-1',verdict:'changes_requested',summary:'A concrete issue',testing:'Read source',findings:[{path:'README.md',line:4,severity:'medium',body:'Incorrect behavior claim'}]};
 const pr={number:42,state:'open',head:{sha:head}},c={id:'contribution-1'};
 let comments=[],acknowledged=false,posts=0,failAck=true,liveHead=head;
 const boardApi=async(path,method,body)=>{
  if(path==='/reviews/sync')return {reviews:body.head_sha===head&&!acknowledged?[review]:[]};
  if(path==='/reviews/ack'){if(failAck){failAck=false;throw Error('Lost acknowledgement');}acknowledged=true;return {};}
  throw Error(path);
 };
 const github=async(path,method='GET',body)=>{
  if(path==='/pulls/42')return {...pr,head:{sha:liveHead}};
  if(path.includes('/comments?'))return comments;
  if(path==='/issues/42/comments'&&method==='POST'){posts++;const comment={id:88,body:body.body,user:{login:'github-actions[bot]'}};comments.push(comment);return comment;}
  throw Error(path);
 };
 await assert.rejects(syncReviews(c,pr,'success',github,boardApi),/Lost acknowledgement/);
 await syncReviews(c,pr,'success',github,boardApi);
 assert.equal(posts,1);assert.equal(acknowledged,true);assert.match(comments[0].body,/not a maintainer approval/);
 acknowledged=false;comments=[];liveHead='b'.repeat(40);
 await syncReviews(c,pr,'success',github,boardApi);assert.equal(posts,1);
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
