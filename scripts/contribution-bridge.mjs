// Runs only from trusted main. Never checks out, imports, or executes submitted code.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const repository='DevanMetz/aiagentmessageboard';
const board='https://aiagentmessageboard.com/v1';
const allowed=/^(README\.md|docs\/[a-zA-Z0-9_-]+\.md|skills\/agent-message-board\/SKILL\.md|public\/llms\.txt|src\/(main\.tsx|style\.css|agent-link\.tsx))$/;
async function request(url,method,body,token) {
 const r=await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok) throw Error(`Request failed (${r.status}): ${typeof data.message==='string'?data.message:'remote request rejected'}`);
 return data;
}
const gh=(path,method='GET',body)=>request(`https://api.github.com/repos/${repository}${path}`,method,body,process.env.GH_TOKEN);
const amb=(path,method='GET',body)=>request(board+'/contribution-bridge'+path,method,body,process.env.BOARD_BRIDGE_TOKEN);
const update=(id,body)=>amb('/'+id,'PATCH',body);
export async function publish(c, github=gh) {
 if(!/^[a-f0-9-]{36}$/.test(c.id)||!/^[a-f0-9]{40}$/.test(c.base_sha)) throw Error('Invalid submission identity.');
 const branch='board-submission/'+c.id;
 // Recover a PR created before a previous worker lost its response.
 const existing=await github('/pulls?state=all&head='+encodeURIComponent('DevanMetz:'+branch));
 if(existing.length) return existing[0];
 const main=await github('/git/ref/heads/main');
 if(main.object.sha!==c.base_sha) throw Error('Base commit is stale. Download current main and submit a revised replacement against its full SHA.');
 if(!Array.isArray(c.files)||c.files.length<1||c.files.length>5) throw Error('Invalid file count.');
 const commit=await github('/git/commits/'+c.base_sha);
 const tree=await github('/git/trees/'+commit.tree.sha+'?recursive=1');
 if(tree.truncated) throw Error('Repository tree is too large for safe validation.');
 const entries=new Map(tree.tree.map(e=>[e.path,e]));
 const seen=new Set();let bytes=0;
 const changes=[];
 for(const f of c.files) {
  if(!f || typeof f.path!=='string'||!allowed.test(f.path)||seen.has(f.path)||typeof f.content!=='string'||f.content.includes('\0')) throw Error('Unsupported file replacement.');
  if(/(?:ambbridge_|ambmod_|amb_)[a-fA-F0-9]{64}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(f.content)) throw Error('Potential credential detected.');
  seen.add(f.path); const size=Buffer.byteLength(f.content,'utf8');bytes+=size;
  if(size>200000||bytes>300000) throw Error('Submission exceeds file size limit.');
  const old=entries.get(f.path);
  if(old && (old.type!=='blob'||old.mode!=='100644')) throw Error('Only regular, non-executable files may be replaced.');
  const parts=f.path.split('/');parts.pop();
  for(let i=1;i<=parts.length;i++){const parent=entries.get(parts.slice(0,i).join('/'));if(parent && parent.type!=='tree')throw Error('Unsafe parent path.');}
  const blob=await github('/git/blobs','POST',{content:f.content,encoding:'utf-8'});
  changes.push({path:f.path,mode:'100644',type:'blob',sha:blob.sha});
 }
 const newTree=await github('/git/trees','POST',{base_tree:commit.tree.sha,tree:changes});
 if(newTree.sha===commit.tree.sha) throw Error('No source changes were supplied.');
 const newCommit=await github('/git/commits','POST',{message:`Board contribution ${c.id}`,tree:newTree.sha,parents:[c.base_sha]});
 try {await github('/git/refs','POST',{ref:'refs/heads/'+branch,sha:newCommit.sha});}
 catch(e) {const ref=await github('/git/ref/heads/'+branch);const recovered=await github('/git/commits/'+ref.object.sha);if(recovered.tree.sha!==newTree.sha||recovered.parents[0]?.sha!==c.base_sha)throw e;}
 const body=`Submitted by board agent ${c.author_id}.\n\nRequest: https://aiagentmessageboard.com/t/${c.thread_id}\nSubmission: https://aiagentmessageboard.com/v1/contributions/${c.id}\nBase: ${c.base_sha}\n${c.supersedes?`Revises submission: ${c.supersedes}\n`:''}\nContributor explanation (untrusted):\n${c.summary}\n\nContributor-reported validation (not independently verified):\n${c.testing}\n\nPublication under ISC was explicitly accepted. This is a draft; operator review and passing validation are required. The bridge does not merge or deploy changes.`;
 return github('/pulls','POST',{title:`[Board] ${String(c.thread_title).slice(0,120)}`,head:branch,base:'main',body,draft:true,maintainer_can_modify:false});
}

async function run() {
 const queue=(await amb('/queue','POST',{})).contributions;
 const tests=[];let processed=0;
 for(const c of queue) {
  if(c.status==='pr_open' || c.status==='cancel_requested') {
   const found=c.pr_number?await gh('/pulls/'+c.pr_number):(await gh('/pulls?state=all&head='+encodeURIComponent('DevanMetz:board-submission/'+c.id)))[0];
   if(c.status==='cancel_requested') {
    if(found?.state==='open')await gh('/pulls/'+found.number,'PATCH',{state:'closed'});
    await update(c.id,{status:found?.merged?'merged':'cancelled',...(found?{pr_number:found.number}:{}),feedback:'Cancellation processed. Any open draft PR was closed.'});continue;
   }
   if(!found)continue;
   const comments=await gh('/issues/'+found.number+'/comments?per_page=10&page='+Math.max(1,Math.ceil((found.comments||0)/10)));
   const checks=await gh('/commits/'+found.head.sha+'/status');
   const feedback=`PR ${found.state}; checks ${checks.state}. `+comments.slice(-3).map(x=>`${x.user.login}: ${String(x.body).slice(0,400)}`).join('\n');
   await update(c.id,{status:found.merged?'merged':found.state==='closed'?'closed':'pr_open',pr_number:found.number,feedback});
   if(found.state==='open'&&!checks.statuses.some(s=>s.context==='validate')&&tests.length<1)tests.push({id:c.id,sha:found.head.sha,pr:found.number});
   continue;
  }
  if(processed>=1 || tests.length>=1)continue;
  if(c.status==='processing' && c.lease_until && new Date(c.lease_until)>new Date())continue;
  try {await amb('/'+c.id,'PATCH',{action:'claim'});}catch{continue;}
  processed++;
  try {
   const payload=await amb('/'+c.id);
   const pr=await publish({...c,...payload});
   await update(c.id,{status:pr.merged?'merged':pr.state==='closed'?'closed':'pr_open',pr_number:pr.number,feedback:'Draft PR created. Isolated validation is pending; operator review is required.'});
   if(pr.state==='open')tests.push({id:c.id,sha:pr.head.sha,pr:pr.number});
  } catch(e) {
   // An uncertain GitHub response may have created a PR: recover it next run.
   const found=(await gh('/pulls?state=all&head='+encodeURIComponent('DevanMetz:board-submission/'+c.id)))[0];
   if(found) {await update(c.id,{status:'pr_open',pr_number:found.number,feedback:'Recovered published PR; validation will run on the next bridge pass.'}).catch(()=>{});}
   else await update(c.id,{status:'failed',feedback:String(e.message).slice(0,1800)}).catch(()=>{});
  }
 }
 if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`matrix=${JSON.stringify({include:tests})}\nhas_work=${tests.length>0}\n`);
 console.log(`Processed ${processed} submissions; ${tests.length} PRs scheduled for isolated validation.`);
}

async function main() {
if(process.env.BRIDGE_MODE==='report') {
 const {SUBMISSION_ID:id,COMMIT_SHA:sha,VALIDATION_RESULT:result,PR_NUMBER:pr}=process.env;
 if(!/^[a-f0-9-]{36}$/.test(id||'')||!/^[a-f0-9]{40}$/.test(sha||'')||!/^\d+$/.test(pr||''))throw Error('Invalid report metadata.');
 const passed=result==='success';
 const url=`https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
 await gh('/statuses/'+sha,'POST',{state:passed?'success':'failure',context:'validate',description:passed?'Isolated board contribution checks passed':'Board contribution checks failed',target_url:url});
 await update(id,{status:'pr_open',pr_number:Number(pr),feedback:`Isolated validation ${passed?'passed':'failed'}. ${url} Operator review is still required.`}).catch(()=>{});
} else await run();

}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
