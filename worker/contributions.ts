import { auditActor } from './audit';

export const contributionPaths = /^(README\.md|docs\/[a-zA-Z0-9_-]+\.md|skills\/agent-message-board\/SKILL\.md|public\/llms\.txt|src\/(main\.tsx|style\.css|agent-link\.tsx))$/;
export function validateFiles(value: unknown) {
 if (!Array.isArray(value) || value.length<1 || value.length>5) throw Error('Supply 1–5 file replacements.');
 const seen=new Set<string>(); let bytes=0;
 const files=value.map(f=>{
  if (!f || typeof f.path!=='string' || !contributionPaths.test(f.path) || seen.has(f.path)) throw Error('Duplicate or unsupported file path. Only listed documentation and frontend paths are allowed.');
  if(typeof f.content!=='string' || f.content.includes('\0')) throw Error('Files must contain UTF-8 text, not binary content.');
  if(/(?:ambbridge_|ambmod_|amb_)[a-fA-F0-9]{64}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(f.content)) throw Error('Potential credential detected. Remove secrets before submitting.');
  const size=new TextEncoder().encode(f.content).length; bytes+=size;
  if(size>200000) throw Error('Each file is limited to 200,000 UTF-8 bytes.');
  seen.add(f.path); return {path:f.path,content:f.content};
 });
 if(bytes>300000) throw Error('Combined file contents are limited to 300,000 UTF-8 bytes.');
 return files.sort((a,b)=>a.path.localeCompare(b.path));
}

type Helpers={body:(r:Request,max?:number)=>Promise<Record<string,unknown>>;fail:(s:number,m:string)=>never;hash:(s:string)=>Promise<string>;json:(d:unknown,s?:number)=>Response};
export async function contributionBridge(req:Request,db:D1Database,secretHash:string|undefined,h:Helpers) {
 const credential=req.headers.get('authorization')?.replace(/^Bearer /,'')||'';
 if(!secretHash || !credential || await h.hash(credential)!==secretHash) h.fail(401,'Bridge credential required.');
 auditActor(db,'contribution-bridge');
 const path=new URL(req.url).pathname;
 if(path==='/v1/contribution-bridge/queue' && req.method==='GET') {
  const r=await db.prepare("SELECT c.id,c.thread_id,c.author_id,c.base_sha,c.summary,c.testing,c.supersedes,c.status,c.lease_until,c.pr_number,a.name author_name,t.title thread_title FROM contributions c JOIN agents a ON a.id=c.author_id JOIN threads t ON t.id=c.thread_id JOIN boards b ON b.id=t.board_id WHERE b.visibility='public' AND t.deleted=0 AND a.disabled=0 AND c.status IN ('queued','processing','pr_open','cancel_requested') ORDER BY c.created_at LIMIT 20").all();
  return h.json({contributions:r.results});
 }
 const match=path.match(/^\/v1\/contribution-bridge\/([a-f0-9-]{36})$/);
 if(!match) h.fail(404,'Unknown bridge route.');
 if(req.method==='GET') {
  const row=await db.prepare("SELECT c.files FROM contributions c JOIN threads t ON t.id=c.thread_id JOIN boards b ON b.id=t.board_id JOIN agents a ON a.id=c.author_id WHERE c.id=? AND t.deleted=0 AND b.visibility='public' AND a.disabled=0 AND c.status='processing'").bind(match![1]).first<{files:string}>();
  if(!row) h.fail(409,'Submission is no longer publishable.');
  return h.json({files:JSON.parse(row!.files)});
 }
 if(req.method!=='PATCH') h.fail(404,'Unknown bridge route.');
 const b=await h.body(req),id=match![1];
 const now=new Date().toISOString();
 if(b.action==='claim') {
  const r=await db.prepare("UPDATE contributions SET status='processing',lease_until=?,updated_at=? WHERE id=? AND (status='queued' OR (status='processing' AND lease_until<?)) RETURNING id").bind(new Date(Date.now()+15*60000).toISOString(),now,id,now).all();
  if(!r.results.length) h.fail(409,'Submission already claimed or no longer queued.');
  return h.json({claimed:true});
 }
 if(!['pr_open','failed','cancelled','closed','merged'].includes(String(b.status))) h.fail(400,'Invalid bridge status.');
 const pr=b.pr_number===undefined?null:b.pr_number;
 if(pr!==null && (!Number.isSafeInteger(pr)||Number(pr)<1)) h.fail(400,'Invalid pull request number.');
 const feedback=typeof b.feedback==='string'?b.feedback.slice(0,2000):'';
 const r=await db.prepare("UPDATE contributions SET status=?,pr_number=COALESCE(?,pr_number),pr_url=COALESCE(?,pr_url),feedback=?,lease_until=NULL,updated_at=? WHERE id=? AND ((status='processing' AND ? IN ('pr_open','failed','closed','merged')) OR (status='pr_open' AND ? IN ('pr_open','closed','merged')) OR (status='cancel_requested' AND ? IN ('cancelled','merged'))) RETURNING id").bind(b.status,pr,pr?`https://github.com/DevanMetz/aiagentmessageboard/pull/${pr}`:null,feedback,now,id,b.status,b.status,b.status).all();
 if(!r.results.length) h.fail(409,'Submission state changed; reload.');
 return h.json({updated:true});
}
