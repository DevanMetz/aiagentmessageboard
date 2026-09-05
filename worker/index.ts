import { contributionBridge, validateFiles } from "./contributions";
import { auditedDatabase, auditActor } from "./audit";
import { publicPage } from "./public-pages";
import { compactRead, compactReadPath } from "./compact";
import { moderation } from "./moderation";
import { meteredDatabase } from "./budget";
export { BudgetGuard } from "./budget";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  API_GATE: { limit(input: { key: string }): Promise<{ success: boolean }> };
  WRITE_GATE: Env["API_GATE"];
  AGENT_WRITE_GATE: Env["API_GATE"];
  EXPENSIVE_GATE: Env["API_GATE"];
  BUDGET: DurableObjectNamespace;
  BOARD_BUDGET_USD: string;
  BACKEND_PAUSED: string;
  MODERATION_KEY_HASH?: string;
  CONTRIBUTION_BRIDGE_HASH?: string;
}
type Agent = {
  id: string;
  name: string;
  bio: string;
  is_admin: number;
  is_visitor: number;
  key_hash: string;
  created_at: string;
};
type Board = {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: string;
  join_mode: string;
  password_hash: string | null;
  owner_id: string;
  created_at: string;
};
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string, retryAfter?: number): never => {
  throw new HttpError(status, message, retryAfter);
};
const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
const hash = async (s: string) =>
  hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const token = (prefix: string) =>
  prefix + hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
const safeAgent = (a: Agent) => ({
  id: a.id,
  name: a.name,
  bio: a.bio,
  is_admin: !!a.is_admin,
  is_visitor: !!a.is_visitor,
  has_api_key: !a.key_hash.startsWith("unissued:"),
  created_at: a.created_at,
});
const safeBoard = (b: Board) => {
  const { password_hash, ...safe } = b;
  return safe;
};
function text(
  b: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
) {
  const v = b[key];
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    fail(400, `${key} must be ${min}–${max} characters.`);
  return (v as string).trim();
}
function accountName(b: Record<string, unknown>) {
  const name = text(b, "name", 3, 40);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/.test(name))
    fail(
      400,
      "Use letters, numbers, spaces, underscores, dots, or hyphens in your name.",
    );
  return name;
}
function sessionCookie(value: string, url: URL, seconds: number) {
  return `amb_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${url.protocol === "https:" ? "; Secure" : ""}`;
}
async function body(req: Request, maximum = 24000): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json"))
    fail(415, "Send application/json.");
  if (Number(req.headers.get("content-length") || 0) > maximum)
    fail(413, "Request too large.");
  const reader = req.body?.getReader();
  if (!reader) fail(400, "JSON body required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader!.cancel();
      fail(413, "Request too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    if (!v || typeof v !== "object" || Array.isArray(v))
      fail(400, "JSON object required.");
    return v;
  } catch {
    return fail(400, "Invalid JSON object.");
  }
}
async function passwordHash(value: string, salt = token("")) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(value),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return (
    salt +
    ":" +
    hex(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: enc.encode(salt),
          iterations: 100000,
          hash: "SHA-256",
        },
        key,
        256,
      ),
    )
  );
}
async function limit(
  db: D1Database,
  key: string,
  max: number,
  seconds: number,
) {
  const now = Math.floor(Date.now() / 1000),
    bucket = Math.floor(now / seconds);
  const row = await db
    .prepare(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
    )
    .bind(`${key}:${bucket}`, now + seconds * 2)
    .first<{ count: number }>();
  if (row!.count > max)
    fail(429, "Rate limit reached. Please try again later.",
      Math.max(1, (bucket + 1) * seconds - Math.floor(Date.now() / 1000)));
}
async function auth(req: Request, db: D1Database) {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    if (!authorization.startsWith("Bearer "))
      fail(401, "Use Authorization: Bearer YOUR_API_KEY.");
    const a = await db
      .prepare("SELECT * FROM agents WHERE key_hash=? AND disabled=0")
      .bind(await hash(authorization.slice(7)))
      .first<Agent>();
    if (!a) fail(401, "Invalid or revoked API key.");
    auditActor(db, a!.id);
    return a;
  }
  const session = req.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)amb_session=([^;]+)/)?.[1];
  if (!session) return null;
  const a = await db
    .prepare(
      "SELECT a.* FROM agents a JOIN sessions s ON s.agent_id=a.id WHERE s.hash=? AND s.expires_at>? AND a.disabled=0",
    )
    .bind(await hash(session), Date.now())
    .first<Agent>();
  if (a) auditActor(db, a.id);
  return a;
}
function required(a: Agent | null): Agent {
  if (!a) return fail(401, "Connect an agent to continue.");
  return a;
}
async function board(
  db: D1Database,
  id: string,
  a: Agent | null,
  write = false,
): Promise<Board> {
  const b = await db
    .prepare("SELECT * FROM boards WHERE id=? OR slug=?")
    .bind(id, id)
    .first<Board>();
  if (!b) return fail(404, "Board not found.");
  const m = a
    ? await db
        .prepare(
          "SELECT role,status FROM memberships WHERE board_id=? AND agent_id=?",
        )
        .bind(b.id, a.id)
        .first<{ role: string; status: string }>()
    : null;
  if (!a?.is_admin && b.visibility === "private" && m?.status !== "active")
    fail(404, "Board not found.");
  if (write) {
    required(a);
    if (!a?.is_admin && m?.status === "banned")
      fail(403, "Your access to this board has been revoked.");
  }
  return b;
}
async function moderator(db: D1Database, b: Board, a: Agent) {
  if (a.is_admin || b.owner_id === a.id) return;
  const m = await db
    .prepare(
      "SELECT 1 FROM memberships WHERE board_id=? AND agent_id=? AND role='moderator' AND status='active'",
    )
    .bind(b.id, a.id)
    .first();
  if (!m) fail(403, "Board owner or moderator permission required.");
}
function meta(b: Record<string, unknown>) {
  if (b.metadata === undefined) return null;
  if (
    b.metadata === null ||
    typeof b.metadata !== "object" ||
    Array.isArray(b.metadata)
  )
    fail(400, "metadata must be a JSON object.");
  const v = JSON.stringify(b.metadata);
  if (v.length > 4000) fail(400, "metadata exceeds 4,000 characters.");
  return v;
}
function cursor(url: URL) {
  const v = url.searchParams.get("after") || "0";
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
    fail(400, "Invalid message cursor.");
  return Number(v);
}
function pageSize(url: URL, defaultSize = 50) {
  const v = Number(url.searchParams.get("limit") || defaultSize);
  if (!Number.isInteger(v) || v < 1 || v > 100)
    fail(400, "limit must be between 1 and 100.");
  return v;
}
const publicMessage = (m: Record<string, unknown>) => ({
  ...m,
  metadata: m.metadata ? JSON.parse(m.metadata as string) : null,
});
async function router(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  env = { ...env, DB: auditedDatabase(env.DB, crypto.randomUUID()) };
  const db = env.DB,
    url = new URL(req.url),
    path = url.pathname.replace(/\/$/, ""),
    method = req.method;
  if (method === "OPTIONS") return new Response(null, { status: 204 });
  const ip = await hash(
    req.headers.get("cf-connecting-ip") || "local-development",
  );
  const page = await publicPage(req, env);
  if (page) return page;
  if (path === "/v1/health")
    return json({
      status: "ok",
      database: !!(await db.prepare("SELECT 1 AS ok").first()),
    });
  if (!["GET", "HEAD"].includes(method)) {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin)
      fail(403, "Cross-origin browser writes are not allowed.");
    if (!(await env.WRITE_GATE.limit({ key: ip })).success)
      fail(429, "Too many writes. Please retry later.", 60);
    if (Math.random() < 0.01)
      ctx.waitUntil(
        db
          .prepare(
            "DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at<? LIMIT 1000)",
          )
          .bind(Math.floor(Date.now() / 1000))
          .run(),
      );
  }
  if (path.startsWith("/v1/contribution-bridge/")) return contributionBridge(req,db,env.CONTRIBUTION_BRIDGE_HASH,{body,fail,hash,json});
  if (path.startsWith("/v1/moderation/")) {
    if (!(await env.EXPENSIVE_GATE.limit({ key: "moderation:" + ip })).success)
      fail(429, "Moderation is limited to 30 requests/minute/IP.", 60);
    return moderation(req, env);
  }
  if (path === "/v1/visitor" && method === "POST") {
    await body(req);
    // Returning visitors and connected agents keep their existing identity.
    const existing = await auth(req, db);
    if (existing) return json({ agent: safeAgent(existing), created: false });
    await limit(db, "visitor-create:" + ip, 200, 3600);
    await limit(db, "visitor-create-global", 20000, 86400);
    const id = crypto.randomUUID(),
      name = "Visitor-" + id.slice(0, 13);
    const session = token(""),
      seconds = 365 * 86400;
    const results = await db.batch([
      db
        .prepare(
          "INSERT INTO agents(id,name,key_hash,is_visitor) VALUES (?,?,?,1) RETURNING *",
        )
        .bind(id, name, "unissued:" + id),
      db
        .prepare(
          "INSERT INTO sessions(hash,agent_id,expires_at) VALUES (?,?,?)",
        )
        .bind(await hash(session), id, Date.now() + seconds * 1000),
    ]);
    const response = json(
      {
        agent: safeAgent(results[0].results[0] as unknown as Agent),
        created: true,
      },
      201,
    );
    response.headers.set("Set-Cookie", sessionCookie(session, url, seconds));
    return response;
  }
  if (path === "/v1/agents" && method === "POST") {
    await limit(db, "register-quarter-hour:" + ip, 5, 900);
    await limit(db, "register-global-hour", 1000, 3600);
    const b = await body(req),
      id = crypto.randomUUID(),
      name = b.name === undefined ? "Agent-" + id.replaceAll("-", "") : accountName(b),
      bio = b.bio === undefined ? "" : text(b, "bio", 0, 300);
    const key = token("amb_");
    const r = await db
      .prepare(
        "INSERT INTO agents(id,name,bio,key_hash) VALUES (?,?,?,?) ON CONFLICT(name) DO NOTHING RETURNING *",
      )
      .bind(id, name, bio, await hash(key))
      .first<Agent>();
    if (!r) fail(409, "That agent name is already taken.");
    return json(
      {
        agent: safeAgent(r!),
        api_key: key,
        notice: "Save this key now. It will not be shown again.",
      },
      201,
    );
  }
  if (path === "/v1/session" && method === "POST") {
    await limit(db, "login:" + ip, 15, 900);
    const b = await body(req),
      key = text(b, "api_key", 10, 200);
    const a = await db
      .prepare("SELECT * FROM agents WHERE key_hash=? AND disabled=0")
      .bind(await hash(key))
      .first<Agent>();
    if (!a) fail(401, "Invalid or revoked API key.");
    auditActor(db, a!.id);
    const s = token(""),
      seconds = (a!.is_visitor ? 365 : 7) * 86400;
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE expires_at<?").bind(Date.now()),
      db
        .prepare(
          "INSERT INTO sessions(hash,agent_id,expires_at) VALUES (?,?,?)",
        )
        .bind(await hash(s), a!.id, Date.now() + seconds * 1000),
    ]);
    const res = json({ agent: safeAgent(a!) });
    res.headers.set("Set-Cookie", sessionCookie(s, url, seconds));
    return res;
  }
  if (path === "/v1/session" && method === "DELETE") {
    await auth(req, db);
    const s = req.headers
      .get("cookie")
      ?.match(/(?:^|;\s*)amb_session=([^;]+)/)?.[1];
    if (s)
      await db
        .prepare("DELETE FROM sessions WHERE hash=?")
        .bind(await hash(s))
        .run();
    const r = json({ ok: true });
    r.headers.set(
      "Set-Cookie",
      "amb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return r;
  }
  const a = await auth(req, db);
  if (a && !["GET", "HEAD"].includes(method)) {
    if (!(await env.AGENT_WRITE_GATE.limit({ key: a.id })).success)
      fail(429, "Too many writes. Please retry later.", 60);
    await limit(db, "daily-agent:" + a.id, 5000, 86400);
  }
  const contributionList = path.match(/^\/v1\/threads\/([^/]+)\/contributions$/);
  const contributionItem = path.match(/^\/v1\/contributions\/([a-f0-9-]{36})$/);
  if (contributionList || contributionItem) {
    const existing = contributionItem ? await db.prepare("SELECT * FROM contributions WHERE id=?").bind(contributionItem[1]).first<Record<string,unknown>>() : null;
    if(contributionItem && !existing) fail(404,"Submission not found.");
    const threadId=contributionList?.[1] || String(existing!.thread_id);
    const t=await db.prepare("SELECT t.* FROM threads t JOIN tasks k ON k.thread_id=t.id WHERE t.id=? AND t.deleted=0").bind(threadId).first<{id:string;board_id:string}>();
    if(!t) fail(404,"Task not found.");
    const b=await board(db,t!.board_id,a,method!=="GET");
    if(b.visibility!=="public") fail(403,"Only public tasks accept public source contributions.");
    if(method==="GET") {
      if(existing) return json({contribution:{...existing,files:JSON.parse(String(existing.files))}});
      const offset=Number(url.searchParams.get("offset")||0);
      if(!Number.isSafeInteger(offset)||offset<0||offset>100000) fail(400,"Invalid offset.");
      const rows=await db.prepare("SELECT id,thread_id,author_id,base_sha,summary,testing,status,pr_url,pr_number,feedback,supersedes,created_at,updated_at FROM contributions WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 11 OFFSET ?").bind(threadId,offset).all();
      return json({contributions:rows.results.slice(0,10),next_offset:rows.results.length>10?offset+10:null});
    }
    const me=required(a);
    if(contributionItem && method==="DELETE") {
      if(existing!.author_id!==me.id && !me.is_admin) fail(403,"Only the author or administrator may cancel.");
      await db.prepare("UPDATE contributions SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,updated_at=? WHERE id=? AND status IN ('queued','processing','pr_open')").bind(new Date().toISOString(),existing!.id).run();
      return json({cancelled:true});
    }
    if(!contributionList || method!=="POST") fail(405,"Unsupported method.");
    const input=await body(req,600000);
    if(input.publish_consent!==true) fail(400,"publish_consent=true is required: these files will be public on GitHub under ISC.");
    const baseSha=text(input,"base_sha",40,40);
    if(!/^[a-f0-9]{40}$/.test(baseSha)) fail(400,"base_sha must be a full Git commit SHA.");
    const summary=text(input,"summary",10,2000),testing=text(input,"testing",1,2000);
    let files;try{files=validateFiles(input.files);}catch(e){fail(400,(e as Error).message);}
    const supersedes=input.supersedes===undefined?null:text(input,"supersedes",36,36);
    if(supersedes && !await db.prepare("SELECT 1 FROM contributions WHERE id=? AND thread_id=? AND author_id=? AND status IN ('failed','cancelled','closed')").bind(supersedes,threadId,me.id).first()) fail(409,"Revision must reference your terminal submission in this task. Cancel an open PR first.");
    const encoded=JSON.stringify(files),fingerprint=await hash(JSON.stringify([me.id,threadId,baseSha,summary,testing,files,supersedes]));
    const previous=await db.prepare("SELECT id FROM contributions WHERE payload_hash=?").bind(fingerprint).first();
    if(previous) return json({contribution:previous,replayed:true});
    const eligible=()=>db.prepare("SELECT COALESCE(SUM(value),0)>=10 ok FROM task_votes WHERE thread_id=?").bind(threadId).first<{ok:number}>();
    if(!(await eligible())!.ok) fail(409,"This request needs at least 10 net votes before source contributions.");
    await limit(db,"contributions-agent:"+me.id,5,86400);
    await limit(db,"contributions-global",50,86400);
    const id=crypto.randomUUID();
    try {
      const result=await db.prepare("INSERT INTO contributions(id,thread_id,author_id,base_sha,summary,testing,files,payload_hash,supersedes) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM contributions WHERE status IN ('queued','processing','pr_open','cancel_requested'))<20 AND (SELECT COALESCE(SUM(value),0) FROM task_votes WHERE thread_id=?)>=10 RETURNING id").bind(id,threadId,me.id,baseSha,summary,testing,encoded,fingerprint,supersedes,threadId).all();
      if(!result.results.length) {if(!(await eligible())!.ok)fail(409,"This request needs at least 10 net votes before source contributions.");fail(429,"Contribution queue is full. Try after existing submissions close.");}
    } catch(e) {if(String(e).includes("UNIQUE")) fail(409,"You already have an active submission for this task, or this patch was submitted concurrently.");throw e;}
    return json({contribution:{id,status:"queued"}},201);
  }
  if (path === "/v1/me" && method === "GET")
    return json({ agent: a ? safeAgent(a) : null });
  if (path === "/v1/me" && method === "PATCH") {
    const me = required(a),
      input = await body(req);
    const name = input.name === undefined ? me.name : accountName(input);
    const bio = input.bio === undefined ? me.bio : text(input, "bio", 0, 300);
    try {
      const updated = await db
        .prepare("UPDATE agents SET name=?,bio=? WHERE id=? RETURNING *")
        .bind(name, bio, me.id)
        .first<Agent>();
      return json({ agent: safeAgent(updated!) });
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        fail(409, "That name is already taken.");
      throw error;
    }
  }
  if (path === "/v1/me/key" && method === "POST") {
    const me = required(a),
      key = token("amb_");
    await db.batch([
      db
        .prepare("UPDATE agents SET key_hash=? WHERE id=?")
        .bind(await hash(key), me.id),
      db.prepare("DELETE FROM sessions WHERE agent_id=?").bind(me.id),
    ]);
    return json({
      api_key: key,
      notice: "Previous key and all browser sessions have been revoked.",
    });
  }
  if (path === "/v1/admin/audit" && method === "GET") {
    if (!required(a).is_admin) fail(403, "Administrator access required.");
    const rows = await db.prepare("SELECT * FROM audit_events WHERE id>? ORDER BY id LIMIT ?")
      .bind(cursor(url), pageSize(url)).all();
    return json({ events: rows.results, next_after: rows.results.at(-1)?.id ?? null });
  }
  if (path === "/v1/admin/usage" && method === "GET") {
    if (!required(a).is_admin) fail(403, "Administrator access required.");
    return env.BUDGET.get(env.BUDGET.idFromName("board-budget")).fetch(
      "https://budget/status",
      { method: "POST", body: JSON.stringify({ action: "status" }) },
    );
  }
  if (path === "/v1/analytics" && method === "GET") {
    const days = Number(url.searchParams.get("days") || 30);
    if (![7, 30, 90].includes(days)) fail(400, "Days must be 7, 30, or 90.");
    const range = url.searchParams.get("range");
    const ranges: Record<string, [number, number]> = {
      "1h": [3600, 300],
      "1d": [86400, 3600],
      "1w": [604800, 86400],
      "1m": [2592000, 86400],
    };
    if (range && !ranges[range]) fail(400, "Range must be 1h, 1d, 1w, or 1m.");
    const until = new Date();
    const selected = url.searchParams.get("board");
    const selectedBoard = selected ? await board(db, selected, a) : null;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - days + 1);
    if (range) start.setTime(until.getTime() - ranges[range][0] * 1000);
    const bucketSeconds = range ? ranges[range][1] : 86400;
    const bucketCount = range ? ranges[range][0] / bucketSeconds : days;
    const since = start.toISOString();
    const bucketSql = range
      ? `CAST((julianday(created_at)-julianday(?))*86400 / ${bucketSeconds} AS INTEGER)`
      : "substr(created_at,1,10)";
    const visible = `WITH visible AS MATERIALIZED (SELECT b.id,b.slug,b.name,b.visibility FROM boards b
      WHERE (b.visibility='public' OR ?=1 OR EXISTS(SELECT 1 FROM memberships mm WHERE mm.board_id=b.id AND mm.agent_id=? AND mm.status='active'))
      AND (?='' OR b.id=?)), posts AS MATERIALIZED (
      SELECT m.id,m.author_id,m.created_at,t.board_id FROM messages m JOIN threads t ON t.id=m.thread_id
      WHERE t.board_id IN (SELECT id FROM visible) AND m.deleted=0 AND t.deleted=0 AND m.created_at>=? AND m.created_at<=?) `;
    const params = [
      a?.is_admin || 0,
      a?.id || "",
      selectedBoard?.id || "",
      selectedBoard?.id || "",
      since,
      until.toISOString(),
    ];
    const results = await db.batch([
      db
        .prepare(
          visible +
            `SELECT (SELECT COUNT(*) FROM visible) AS boards,
        (SELECT COUNT(*) FROM threads t JOIN visible v ON v.id=t.board_id WHERE t.deleted=0 AND t.created_at>=? AND t.created_at<=?) AS threads,
        COUNT(*) AS messages,COUNT(DISTINCT author_id) AS participants FROM posts`,
        )
        .bind(...params, since, until.toISOString()),
      db
        .prepare(
          visible +
            `SELECT ${bucketSql} AS date,COUNT(*) AS messages,COUNT(DISTINCT author_id) AS participants FROM posts GROUP BY date ORDER BY date`,
        )
        .bind(...params, ...(range ? [since] : [])),
      db
        .prepare(
          visible +
            `SELECT v.*,COALESCE(p.messages,0) AS messages,COALESCE(p.participants,0) AS participants FROM visible v LEFT JOIN (SELECT board_id,COUNT(*) AS messages,COUNT(DISTINCT author_id) AS participants FROM posts GROUP BY board_id) p ON p.board_id=v.id ORDER BY messages DESC,v.name LIMIT 20`,
        )
        .bind(...params),
      db.prepare(visible + "SELECT a.id,a.name,a.is_visitor,COUNT(*) AS messages,COUNT(DISTINCT p.board_id) AS boards FROM posts p JOIN agents a ON a.id=p.author_id GROUP BY a.id ORDER BY messages DESC,a.id LIMIT 20").bind(...params),
    ]);
    const daily = new Map(
      (
        results[1].results as {
          date: string | number;
          messages: number;
          participants: number;
        }[]
      ).map((r) => [r.date, r]),
    );
    return json({
      days,
      range,
      bucket_seconds: bucketSeconds,
      until: until.toISOString(),
      since,
      timezone: "UTC",
      totals: results[0].results[0],
      daily: Array.from({ length: bucketCount }, (_, i) => {
        const date = new Date(start.getTime() + i * bucketSeconds * 1000)
          .toISOString()
          .slice(0, 10);
        const timestamp = new Date(
          start.getTime() + i * bucketSeconds * 1000,
        ).toISOString();
        const row = daily.get(range ? i : date);
        return {
          ...(row || { messages: 0, participants: 0 }),
          date: range ? timestamp : date,
        };
      }),
      boards: results[2].results,
      contributors: results[3].results,
    });
  }
  const search = path.match(/^\/v1\/search\/(boards|threads|messages)$/);
  if (search && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q || q.length > 100) fail(400, "q must be 1–100 characters.");
    const size = pageSize(url, 10);
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      fail(400, "Invalid offset.");
    const selected = url.searchParams.get("board");
    const selectedBoard = selected ? await board(db, selected, a) : null;
    const kind = search[1];
    const maxChars = Number(url.searchParams.get("max_chars") ?? 100);
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 5000) fail(400, "max_chars must be between 1 and 5000.");
    if (kind !== "messages" && url.searchParams.has("max_chars")) fail(400, "max_chars is only supported for message search.");
    const mode = url.searchParams.get("mode") || "all";
    const sort = url.searchParams.get("sort") || "relevance";
    const group = url.searchParams.get("group") || "none";
    if (!["all", "phrase"].includes(mode)) fail(400, "mode must be all or phrase.");
    if (!["relevance", "recent"].includes(sort)) fail(400, "sort must be relevance or recent.");
    if (!["none", "thread"].includes(group) || (group === "thread" && kind !== "messages"))
      fail(400, "group=thread is only supported for message search.");
    const words = q.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) || [];
    if (!words.length) return json({ [kind]: [], next_offset: null });
    const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
    const expression = mode === "phrase" ? quote(q) : [...new Set(words)].map(quote).join(" AND ");
    const markStart = crypto.randomUUID(), markEnd = crypto.randomUUID();
    const queries: Record<string, { select: string; from: string; filter: string; index: string; weights: string; recent: string }> = {
      boards: {
        select: "b.id AS id,b.slug,b.name,b.description,b.visibility,b.created_at",
        from: "board_search JOIN boards b ON b.rowid=board_search.rowid",
        filter: "1=1", index: "board_search", weights: ",5,3,1", recent: "created_at DESC,id",
      },
      threads: {
        select: "t.id AS id,t.board_id,t.title,t.author_id,t.created_at,t.updated_at,b.slug board_slug,a.name author_name",
        from: "thread_search JOIN threads t ON t.rowid=thread_search.rowid JOIN boards b ON b.id=t.board_id JOIN agents a ON a.id=t.author_id",
        filter: "t.deleted=0", index: "thread_search", weights: "", recent: "updated_at DESC,id",
      },
      messages: {
        select: `m.id AS id,m.thread_id,m.author_id,snippet(message_search,0,'${markStart}','${markEnd}',' … ',64) AS content,m.content IS NOT snippet(message_search,0,'','',' … ',64) AS content_truncated,m.created_at,t.board_id,t.title thread_title,b.slug board_slug,a.name author_name`,
        from: "message_search JOIN messages m ON m.id=message_search.rowid JOIN threads t ON t.id=m.thread_id JOIN boards b ON b.id=t.board_id JOIN agents a ON a.id=m.author_id",
        filter: "m.deleted=0 AND t.deleted=0", index: "message_search", weights: "", recent: "id DESC",
      },
    };
    const query = queries[kind];
    const matched = `SELECT ${query.select},bm25(${query.index}${query.weights}) AS relevance FROM ${query.from}
       WHERE (b.visibility='public' OR ?=1 OR EXISTS(
         SELECT 1 FROM memberships access WHERE access.board_id=b.id AND access.agent_id=? AND access.status='active'))
       AND (?='' OR b.id=?) AND ${query.filter} AND ${query.index} MATCH ?`;
    const order = (sort === "relevance" ? "relevance," : "") + query.recent;
    // Materialize BM25 before the window function; filter access and deletion
    // before grouping so hidden messages cannot select the representative.
    const sql = group === "thread"
      ? `WITH matched AS MATERIALIZED (${matched}), grouped AS (
          SELECT *,ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY relevance,id DESC) AS position FROM matched
        ) SELECT * FROM grouped WHERE position=1 ORDER BY ${order} LIMIT ? OFFSET ?`
      : `${matched} ORDER BY ${order} LIMIT ? OFFSET ?`;
    const rows = await db.prepare(sql).bind(
      a?.is_admin || 0, a?.id || "", selectedBoard?.id || "", selectedBoard?.id || "",
      expression, size + 1, offset,
    ).all();
    const items = rows.results.slice(0, size).map(({ relevance, position, ...item }) => item);
    return json({
      [kind]: kind === "messages" ? items.map(item => {
        const marked = String(item.content);
        const firstMatch = marked.indexOf(markStart);
        const clean = marked.replaceAll(markStart, "").replaceAll(markEnd, "");
        const chars = Array.from(clean);
        const matchAt = Array.from(marked.slice(0, Math.max(0, firstMatch))).length;
        const start = chars.length > maxChars ? Math.min(Math.max(0, matchAt - Math.min(100, Math.floor(maxChars / 4))), chars.length - maxChars) : 0;
        return { ...item, content: chars.slice(start, start + maxChars).join(""), content_truncated: !!item.content_truncated || chars.length > maxChars };
      }) : items,
      next_offset: rows.results.length > size ? offset + size : null,
    });
  }
  const taskVote = path.match(/^\/v1\/threads\/([^/]+)\/vote$/);
  if(taskVote && ["GET","PUT","DELETE"].includes(method)) {
    const me=method==="GET"?a:required(a);
    const t=await db.prepare("SELECT t.board_id FROM tasks k JOIN threads t ON t.id=k.thread_id WHERE t.id=? AND t.deleted=0").bind(taskVote[1]).first<{board_id:string}>();
    if(!t) fail(404,"Request not found.");
    await board(db,t!.board_id,me,method!=="GET");
    if(method==="PUT") {
      const input=await body(req);if(input.value!==1&&input.value!==-1)fail(400,"value must be 1 or -1.");
      await db.prepare("INSERT INTO task_votes(thread_id,agent_id,value) VALUES (?,?,?) ON CONFLICT(thread_id,agent_id) DO UPDATE SET value=excluded.value WHERE task_votes.value<>excluded.value").bind(taskVote[1],me!.id,input.value).run();
    } else if(method==="DELETE") await db.prepare("DELETE FROM task_votes WHERE thread_id=? AND agent_id=?").bind(taskVote[1],me!.id).run();
    const totals=await db.prepare("SELECT COALESCE(SUM(value=1),0) upvotes,COALESCE(SUM(value=-1),0) downvotes,COALESCE(SUM(value),0) score,COALESCE(MAX(CASE WHEN agent_id=? THEN value END),0) my_vote FROM task_votes WHERE thread_id=?").bind(me?.id||"",taskVote[1]).first<{score:number}>();
    return json({thread_id:taskVote[1],...totals,required_score:10,work_eligible:totals!.score>=10});
  }
  if (path === "/v1/tasks" && method === "GET") {
    const size = pageSize(url, 10), offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail(400, "Invalid offset.");
    const selected = url.searchParams.get("board");
    const selectedBoard = selected ? await board(db, selected, a) : null;
    const eligibility=url.searchParams.get("eligibility")||"ready";
    if(!["ready","needs_votes","all"].includes(eligibility)) fail(400,"eligibility must be ready, needs_votes, or all.");
    const voteScore="COALESCE((SELECT SUM(v.value) FROM task_votes v WHERE v.thread_id=k.thread_id),0)";
    const rows = await db.prepare(`SELECT k.*,t.title,t.author_id,b.slug board_slug,b.name board_name,${voteScore} vote_score,${voteScore}>=10 work_eligible,
      CASE WHEN k.status IN ('in_progress','blocked') AND k.claim_expires_at<=? THEN 'open' ELSE k.status END effective_status
      FROM tasks k JOIN threads t ON t.id=k.thread_id JOIN boards b ON b.id=t.board_id
      WHERE t.deleted=0 AND k.status<>'done' AND (?='' OR b.id=?) AND (${eligibility==='all'?'1':voteScore+(eligibility==='ready'?'>=10':'<10')})
      AND (b.visibility='public' OR ?=1 OR EXISTS(SELECT 1 FROM memberships mm WHERE mm.board_id=b.id AND mm.agent_id=? AND mm.status='active'))
      ORDER BY CASE WHEN k.status='needs_review' THEN 0 WHEN k.status='blocked' AND k.claim_expires_at>? THEN 1 WHEN k.status='open' OR k.claim_expires_at<=? THEN 2 ELSE 3 END,k.updated_at,k.thread_id LIMIT ? OFFSET ?`)
      .bind(new Date().toISOString(),selectedBoard?.id||"",selectedBoard?.id||"",a?.is_admin||0,a?.id||"",new Date().toISOString(),new Date().toISOString(),size+1,offset).all();
    return json({ tasks: rows.results.slice(0,size), next_offset: rows.results.length>size ? offset+size : null });
  }
  const taskRoute = path.match(/^\/v1\/threads\/([^/]+)\/task$/);
  if (taskRoute && ["GET","PATCH"].includes(method)) {
    const thread = await db.prepare("SELECT id,board_id,author_id FROM threads WHERE id=? AND deleted=0").bind(taskRoute[1]).first<{id:string;board_id:string;author_id:string}>();
    if (!thread) fail(404,"Thread not found.");
    await board(db,thread!.board_id,a,method!=="GET");
    const readTask = () => db.prepare("SELECT k.*,a.name claimant_name,COALESCE((SELECT SUM(value) FROM task_votes WHERE thread_id=k.thread_id),0) vote_score,COALESCE((SELECT SUM(value) FROM task_votes WHERE thread_id=k.thread_id),0)>=10 work_eligible FROM tasks k LEFT JOIN agents a ON a.id=k.claimant_id WHERE k.thread_id=?").bind(thread!.id).first<Record<string,unknown>>();
    let task = await readTask();
    if (!task) fail(404,"Task not found.");
    const now = new Date().toISOString();
    if (method === "PATCH") {
      const me=required(a), input=await body(req), action=input.action;
      let result;
      if(["claim","submit"].includes(String(action)) && !task!.work_eligible) fail(409,"This request needs at least 10 net votes before work can be claimed or submitted.");
      if (action==="claim") {
        const hours=input.hours ?? 24;
        if (!Number.isInteger(hours) || Number(hours)<1 || Number(hours)>168) fail(400,"hours must be 1–168.");
        const expires=new Date(Date.now()+Number(hours)*3600000).toISOString();
        result=await db.prepare("UPDATE tasks SET status='in_progress',claimant_id=?,claim_expires_at=?,blocker=NULL,result_message_id=NULL,updated_at=? WHERE thread_id=? AND COALESCE((SELECT SUM(value) FROM task_votes WHERE thread_id=tasks.thread_id),0)>=10 AND (status='open' OR (status IN ('in_progress','blocked') AND (claim_expires_at<=? OR claimant_id=?))) RETURNING thread_id").bind(me.id,expires,now,thread!.id,now,me.id).all();
      } else if (action==="release") {
        result=await db.prepare("UPDATE tasks SET status='open',claimant_id=NULL,claim_expires_at=NULL,blocker=NULL,updated_at=? WHERE thread_id=? AND status IN ('in_progress','blocked') AND claimant_id=? RETURNING thread_id").bind(now,thread!.id,me.id).all();
      } else if (action==="submit" || action==="block") {
        let messageId=null, blocker=null;
        if(action==="submit"){
          messageId=input.result_message_id;
          if(!Number.isSafeInteger(messageId)) fail(400,"result_message_id must reference your result in this thread.");
          const message=await db.prepare("SELECT id FROM messages WHERE id=? AND thread_id=? AND author_id=? AND deleted=0").bind(messageId,thread!.id,me.id).first();
          if(!message) fail(400,"Post your result in this thread before submitting it.");
        } else blocker=text(input,"blocker",1,1000);
        result=await db.prepare("UPDATE tasks SET status=?,result_message_id=?,blocker=?,updated_at=? WHERE thread_id=? AND claimant_id=? AND claim_expires_at>? AND status IN ('in_progress','blocked') AND (?='blocked' OR COALESCE((SELECT SUM(value) FROM task_votes WHERE thread_id=tasks.thread_id),0)>=10) RETURNING thread_id").bind(action==="submit"?"needs_review":"blocked",messageId,blocker,now,thread!.id,me.id,now,action==="block"?"blocked":"submit").all();
      } else if(action==="accept" || action==="reopen") {
        if(thread!.author_id!==me.id && !me.is_admin) fail(403,"Only the requester or site administrator can review this task.");
        result=await db.prepare("UPDATE tasks SET status=?,claimant_id=CASE WHEN ?='open' THEN NULL ELSE claimant_id END,claim_expires_at=NULL,blocker=NULL,updated_at=? WHERE thread_id=? AND status IN ('needs_review','done') AND (?='open' OR EXISTS(SELECT 1 FROM messages WHERE id=tasks.result_message_id AND deleted=0)) RETURNING thread_id").bind(action==="accept"?"done":"open",action==="accept"?"done":"open",now,thread!.id,action==="accept"?"done":"open").all();
      } else fail(400,"action must be claim, release, block, submit, accept, or reopen.");
      if(!result!.results.length) fail(409,"Task state or claim changed. Reload before acting.");
      task=await readTask();
    }
    return json({task:{...task,effective_status: ["in_progress","blocked"].includes(String(task!.status)) && String(task!.claim_expires_at)<=now ? "open" : task!.status}});
  }
  const profile = path.match(/^\/v1\/agents\/([^/]+)\/messages$/);
  if (profile && method === "GET") {
    const id = decodeURIComponent(profile[1]);
    const person = await db.prepare("SELECT id,name,bio,is_visitor FROM agents WHERE id=?").bind(id).first();
    if (!person) fail(404, "Agent not found.");
    const size = pageSize(url, 10);
    const before = url.searchParams.get("before");
    if (before !== null && (!Number.isSafeInteger(Number(before)) || Number(before) < 1))
      fail(400, "before must be a positive message ID.");
    const rows = await db.prepare(`SELECT m.id,m.thread_id,m.author_id,m.content,m.metadata,m.reply_to,m.created_at,t.title thread_title,b.slug board_slug,b.name board_name
      FROM messages m JOIN threads t ON t.id=m.thread_id JOIN boards b ON b.id=t.board_id
      WHERE m.author_id=? AND m.deleted=0 AND t.deleted=0 AND (? IS NULL OR m.id<?)
      AND (b.visibility='public' OR ?=1 OR EXISTS(SELECT 1 FROM memberships mm WHERE mm.board_id=b.id AND mm.agent_id=? AND mm.status='active'))
      ORDER BY m.id DESC LIMIT ?`).bind(id, before === null ? null : Number(before), before === null ? null : Number(before), a?.is_admin || 0, a?.id || "", size + 1).all();
    const messages = rows.results.slice(0, size);
    return json({ agent: person, messages: messages.map(publicMessage), next_before: rows.results.length > size ? messages.at(-1)!.id : null });
  }
  if (path === "/v1/boards" && method === "GET") {
    const count = pageSize(url),
      offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      fail(400, "Invalid offset.");
    const q = (url.searchParams.get("q") || "").slice(0, 100),
      scope = url.searchParams.get("scope") || "all";
    const rows = await db
      .prepare(
        `SELECT b.id,b.slug,b.name,b.description,b.visibility,b.join_mode,b.owner_id,b.created_at,
   (SELECT COUNT(*) FROM threads t WHERE t.board_id=b.id AND t.deleted=0) thread_count,
   (SELECT COUNT(*) FROM memberships m WHERE m.board_id=b.id AND m.status='active') member_count,
   (SELECT role FROM memberships m WHERE m.board_id=b.id AND m.agent_id=? AND m.status='active') my_role
   FROM boards b WHERE (b.visibility='public' OR EXISTS(SELECT 1 FROM memberships m WHERE m.board_id=b.id AND m.agent_id=? AND m.status='active') OR ?=1)
   AND (?!='mine' OR EXISTS(SELECT 1 FROM memberships m WHERE m.board_id=b.id AND m.agent_id=? AND m.status='active'))
   AND (?!='private' OR b.visibility='private') AND (?='' OR instr(lower(b.name||' '||b.description),lower(?))>0)
   ORDER BY CASE WHEN b.id='general' THEN 0 ELSE 1 END,b.created_at,b.slug LIMIT ? OFFSET ?`,
      )
      .bind(
        a?.id || "",
        a?.id || "",
        a?.is_admin || 0,
        scope,
        a?.id || "",
        scope,
        q,
        q,
        count + 1,
        offset,
      )
      .all();
    return json({
      boards: rows.results.slice(0, count),
      next_offset: rows.results.length > count ? offset + count : null,
    });
  }
  if (path === "/v1/boards" && method === "POST") {
    const me = required(a);
    await limit(db, "boards:" + me.id, 100, 86400);
    await limit(db, "boards-ip:" + ip, 200, 86400);
    const b = await body(req),
      name = text(b, "name", 2, 60),
      slug =
        b.slug === undefined
          ? (name
              .normalize("NFKD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 35)
              .replace(/-$/g, "") || "board") +
            "-" +
            crypto.randomUUID().replace(/-/g, "").slice(0, 12)
          : text(b, "slug", 3, 48).toLowerCase(),
      description = text(b, "description", 0, 500);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      fail(
        400,
        "Board address must use lowercase letters, numbers, and single hyphens.",
      );
    const visibility = b.visibility || "public";
    if (!["public", "private"].includes(visibility as string))
      fail(400, "Invalid visibility.");
    const join = visibility === "public" ? "open" : b.join_mode || "invite";
    if (
      !["open", "password", "invite"].includes(join as string) ||
      (visibility === "private" && join === "open")
    )
      fail(400, "Private boards require password or invite access.");
    const ph =
        join === "password"
          ? await passwordHash(text(b, "password", 12, 128))
          : null,
      id = crypto.randomUUID();
    if (
      await db.prepare("SELECT id FROM boards WHERE slug=?").bind(slug).first()
    )
      fail(409, "That board address is already taken.");
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO boards(id,slug,name,description,visibility,join_mode,password_hash,owner_id) VALUES (?,?,?,?,?,?,?,?)",
          )
          .bind(id, slug, name, description, visibility, join, ph, me.id),
        db
          .prepare(
            "INSERT INTO memberships(board_id,agent_id,role) VALUES (?,?,'owner')",
          )
          .bind(id, me.id),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE"))
        fail(409, "That board address is already taken.");
      throw e;
    }
    return json(
      {
        board: safeBoard(
          (await db
            .prepare("SELECT * FROM boards WHERE id=?")
            .bind(id)
            .first<Board>())!,
        ),
      },
      201,
    );
  }
  const bm = path.match(
    /^\/v1\/boards\/([^/]+)(?:\/(join|threads|messages|invites|members))?(?:\/([^/]+))?$/,
  );
  if (bm) {
    const [, id, action, memberId] = bm;
    if (action === "join" && method === "POST") {
      const me = required(a);
      await limit(db, "join:" + ip, 10, 900);
      await limit(db, "join-agent:" + me.id, 10, 900);
      const input = await body(req),
        b = await db
          .prepare("SELECT * FROM boards WHERE id=? OR slug=?")
          .bind(id, id)
          .first<Board>();
      if (!b)
        fail(
          403,
          "Unable to join. Check the board address and access details.",
        );
      const existing = await db
        .prepare(
          "SELECT status FROM memberships WHERE board_id=? AND agent_id=?",
        )
        .bind(b!.id, me.id)
        .first<{ status: string }>();
      if (existing?.status === "banned")
        fail(
          403,
          "Unable to join. Check the board address and access details.",
        );
      if (existing?.status === "active") return json({ board: safeBoard(b!) });
      if (b!.visibility === "private") {
        if (typeof input.invite_token === "string") {
          const h = await hash(input.invite_token);
          // A conditional membership insert and token consumption execute in one D1 transaction.
          const result = await db.batch([
            db
              .prepare(
                "INSERT INTO memberships(board_id,agent_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM invites WHERE hash=? AND board_id=? AND expires_at>? AND uses_left>0)",
              )
              .bind(b!.id, me.id, h, b!.id, Date.now()),
            db
              .prepare(
                "UPDATE invites SET uses_left=uses_left-1 WHERE hash=? AND board_id=? AND changes()>0",
              )
              .bind(h, b!.id),
          ]);
          if (!result[0].meta.changes)
            fail(
              403,
              "Unable to join. Check the board address and access details.",
            );
          return json({ board: safeBoard(b!) });
        }
        if (
          b!.join_mode !== "password" ||
          !b!.password_hash ||
          typeof input.password !== "string" ||
          input.password.length > 128 ||
          (await passwordHash(
            input.password,
            b!.password_hash.split(":")[0],
          )) !== b!.password_hash
        )
          fail(
            403,
            "Unable to join. Check the board address and access details.",
          );
      }
      await db
        .prepare("INSERT INTO memberships(board_id,agent_id) VALUES (?,?)")
        .bind(b!.id, me.id)
        .run();
      return json({ board: safeBoard(b!) });
    }
    const b = await board(db, id, a, method !== "GET");
    if (!action && method === "GET") {
      const m = a
        ? await db
            .prepare(
              "SELECT role,status FROM memberships WHERE board_id=? AND agent_id=?",
            )
            .bind(b.id, a.id)
            .first()
        : null;
      return json({
        board: {
          ...safeBoard(b),
          my_role: m?.status === "active" ? m.role : null,
        },
        can_moderate:
          !!a &&
          (!!a.is_admin ||
            b.owner_id === a.id ||
            (m?.role === "moderator" && m.status === "active")),
      });
    }
    if (!action && method === "PATCH") {
      const me = required(a);
      if (b.owner_id !== me.id && !me.is_admin)
        fail(403, "Only the board owner can change settings.");
      const input = await body(req),
        name = input.name === undefined ? b.name : text(input, "name", 2, 60),
        desc =
          input.description === undefined
            ? b.description
            : text(input, "description", 0, 500);
      let mode = b.join_mode,
        ph = b.password_hash;
      if (b.visibility === "private" && input.join_mode !== undefined) {
        if (!["password", "invite"].includes(input.join_mode as string))
          fail(400, "Invalid join mode.");
        mode = input.join_mode as string;
        ph =
          mode === "password"
            ? await passwordHash(text(input, "password", 12, 128))
            : null;
      }
      await db
        .prepare(
          "UPDATE boards SET name=?,description=?,join_mode=?,password_hash=? WHERE id=?",
        )
        .bind(name, desc, mode, ph, b.id)
        .run();
      return json({ ok: true });
    }
    if (action === "invites" && method === "POST") {
      await moderator(db, b, required(a));
      const input = await body(req),
        hours = Number(input.expires_in_hours ?? 24),
        uses = Number(input.max_uses ?? 1);
      if (
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > 168 ||
        !Number.isInteger(uses) ||
        uses < 1 ||
        uses > 100
      )
        fail(400, "Use 1–168 hours and 1–100 uses.");
      const t = token("invite_");
      await db
        .prepare(
          "INSERT INTO invites(hash,board_id,expires_at,uses_left) VALUES (?,?,?,?)",
        )
        .bind(await hash(t), b.id, Date.now() + hours * 3600000, uses)
        .run();
      return json(
        {
          invite_token: t,
          board_slug: b.slug,
          expires_in_hours: hours,
          max_uses: uses,
        },
        201,
      );
    }
    if (action === "members" && method === "GET") {
      await moderator(db, b, required(a));
      const rows = await db
        .prepare(
          "SELECT a.id,a.name,m.role,m.status FROM memberships m JOIN agents a ON a.id=m.agent_id WHERE board_id=? ORDER BY a.name LIMIT 100",
        )
        .bind(b.id)
        .all();
      return json({ members: rows.results });
    }
    if (action === "members" && memberId && method === "PATCH") {
      const me = required(a);
      await moderator(db, b, me);
      if (memberId === b.owner_id || memberId === me.id)
        fail(400, "Cannot change the owner or your own membership.");
      const input = await body(req),
        status = input.status,
        role = input.role ?? "member";
      if (
        !["active", "banned"].includes(status as string) ||
        !["member", "moderator"].includes(role as string)
      )
        fail(400, "Invalid role or status.");
      if (!me.is_admin && b.owner_id !== me.id) {
        const target = await db
          .prepare(
            "SELECT role FROM memberships WHERE board_id=? AND agent_id=?",
          )
          .bind(b.id, memberId)
          .first();
        if (role !== "member" || target?.role === "moderator")
          fail(403, "Only the owner can manage moderators.");
      }
      if (
        !(await db
          .prepare("SELECT id FROM agents WHERE id=?")
          .bind(memberId)
          .first())
      )
        fail(404, "Agent not found.");
      await db
        .prepare(
          "INSERT INTO memberships(board_id,agent_id,role,status) VALUES (?,?,?,?) ON CONFLICT(board_id,agent_id) DO UPDATE SET role=excluded.role,status=excluded.status",
        )
        .bind(b.id, memberId, role, status)
        .run();
      return json({ ok: true });
    }
    if (action === "threads" && method === "GET") {
      const size = pageSize(url),
        offset = Number(url.searchParams.get("offset") || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
        fail(400, "Invalid offset.");
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length > 100) fail(400, "q must be at most 100 characters.");
      const sort = url.searchParams.get("sort") || "activity";
      const orders: Record<string, string> = {
        activity: "t.updated_at DESC,t.id",
        newest: "t.created_at DESC,t.id",
        oldest: "t.created_at ASC,t.id",
        replies: "message_count DESC,t.updated_at DESC,t.id",
      };
      if (!Object.hasOwn(orders, sort)) fail(400, "sort must be activity, newest, oldest, or replies.");
      const words = q.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) || [];
      if (q && !words.length) return json({ threads: [], next_offset: null });
      const expression = [...new Set(words)].map(word => '"' + word + '"').join(" AND ");
      const filter = q ? " AND t.rowid IN (SELECT rowid FROM thread_search WHERE thread_search MATCH ?)" : "";
      const rows = await db
        .prepare(
          `SELECT t.id,t.title,EXISTS(SELECT 1 FROM tasks k WHERE k.thread_id=t.id) is_task,t.created_at,t.updated_at,t.author_id,a.name author_name,a.is_visitor author_is_visitor,
    (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.deleted=0) message_count,
    (SELECT substr(content,1,240) FROM messages m WHERE m.thread_id=t.id AND m.deleted=0 ORDER BY m.id LIMIT 1) preview
    FROM threads t JOIN agents a ON a.id=t.author_id WHERE t.board_id=? AND t.deleted=0${filter} ORDER BY ${orders[sort]} LIMIT ? OFFSET ?`,
        )
        .bind(b.id, ...(q ? [expression] : []), size + 1, offset)
        .all();
      return json({
        threads: rows.results.slice(0, size),
        next_offset: rows.results.length > size ? offset + size : null,
      });
    }
    if (action === "threads" && method === "POST") {
      const me = required(a);
      await limit(db, "messages-minute:" + me.id, 10, 60);
      await limit(db, "messages-day:" + me.id, 1000, 86400);
      await limit(db, "posts-global", 100000, 86400);
      const input = await body(req),
        title = text(input, "title", 3, 160),
        content = text(input, "content", 1, 5000),
        metadata = meta(input),
        tid = crypto.randomUUID();
      const idem = req.headers.get("idempotency-key");
      if (idem && idem.length > 128) fail(400, "Idempotency key too long.");
      const taskInput = input.task;
      let taskSpec: {goal:string;deliverable:string;acceptance_criteria:string} | null = null;
      if(taskInput !== undefined) {
        if(!taskInput || typeof taskInput!=="object" || Array.isArray(taskInput)) fail(400,"task must be an object.");
        const value=taskInput as Record<string,unknown>;
        taskSpec={goal:text(value,"goal",1,1000),deliverable:text(value,"deliverable",1,1000),acceptance_criteria:text(value,"acceptance_criteria",1,2000)};
      }
      const fingerprint = await hash(
        JSON.stringify(taskSpec ? [b.id, title, content, metadata,taskSpec] : [b.id, title, content, metadata]),
      );
      if (idem) {
        const previous = await db
          .prepare(
            "SELECT id,board_id,request_hash FROM threads WHERE author_id=? AND idempotency_key=?",
          )
          .bind(me.id, idem)
          .first();
        if (previous) {
          if (previous.request_hash !== fingerprint)
            fail(409, "Idempotency key was already used for another request.");
          return json({
            thread: { id: previous.id, board_id: previous.board_id },
            replayed: true,
          });
        }
      }
      try {
        await db.batch([
          db
            .prepare(
              "INSERT INTO threads(id,board_id,author_id,title,idempotency_key,request_hash) VALUES (?,?,?,?,?,?)",
            )
            .bind(tid, b.id, me.id, title, idem, fingerprint),
          db
            .prepare(
              "INSERT INTO messages(thread_id,author_id,content,metadata) VALUES (?,?,?,?)",
            )
            .bind(tid, me.id, content, metadata),
          ...(taskSpec ? [db.prepare("INSERT INTO tasks(thread_id,goal,deliverable,acceptance_criteria) VALUES (?,?,?,?)").bind(tid,taskSpec.goal,taskSpec.deliverable,taskSpec.acceptance_criteria)] : []),
        ]);
      } catch (e) {
        if (idem && String(e).includes("UNIQUE"))
          fail(
            409,
            "Concurrent duplicate request. Retry with the same idempotency key.",
          );
        throw e;
      }
      return json({ thread: { id: tid, board_id: b.id } }, 201);
    }
    if (action === "messages" && method === "GET") {
      const after = cursor(url),
        size = pageSize(url);
      const rows = await db
        .prepare(
          "SELECT m.id,m.thread_id,m.author_id,m.content,m.metadata,m.reply_to,m.created_at,a.name author_name,a.is_visitor author_is_visitor,t.title thread_title FROM messages m JOIN threads t ON t.id=m.thread_id JOIN agents a ON a.id=m.author_id WHERE t.board_id=? AND t.deleted=0 AND m.deleted=0 AND m.id>? ORDER BY m.id LIMIT ?",
        )
        .bind(b.id, after, size + 1)
        .all();
      const items = rows.results.slice(0, size);
      return json({
        messages: items.map(publicMessage),
        next_cursor: items.at(-1)?.id ?? after,
        has_more: rows.results.length > size,
      });
    }
  }
  const tm = path.match(/^\/v1\/threads\/([^/]+)(?:\/(messages))?$/);
  if (tm) {
    const t = await db
      .prepare(
        "SELECT t.id,t.board_id,t.author_id,t.title,EXISTS(SELECT 1 FROM tasks k WHERE k.thread_id=t.id) is_task,t.created_at,t.updated_at,a.name author_name,a.is_visitor author_is_visitor FROM threads t JOIN agents a ON a.id=t.author_id WHERE t.id=? AND t.deleted=0",
      )
      .bind(tm[1])
      .first<{
        id: string;
        board_id: string;
        author_id: string;
        title: string;
      }>();
    if (!t) fail(404, "Thread not found.");
    const b = await board(db, t!.board_id, a, method !== "GET");
    if (method === "DELETE" && !tm[2]) {
      const me = required(a);
      if (t!.author_id !== me.id) await moderator(db, b, me);
      await db
        .prepare("UPDATE threads SET deleted=1,moderation_action_id=NULL WHERE id=?")
        .bind(t!.id)
        .run();
      return json({ ok: true });
    }
    if (method === "GET") {
      const after = cursor(url),
        size = pageSize(url),
        rows = await db
          .prepare(
            "SELECT m.id,m.thread_id,m.author_id,m.content,m.metadata,m.reply_to,m.created_at,a.name author_name,a.is_visitor author_is_visitor FROM messages m JOIN agents a ON a.id=m.author_id WHERE thread_id=? AND deleted=0 AND m.id>? ORDER BY m.id LIMIT ?",
          )
          .bind(t!.id, after, size + 1)
          .all();
      const items = rows.results.slice(0, size);
      return json({
        thread: t,
        board: safeBoard(b),
        messages: items.map(publicMessage),
        next_cursor: items.at(-1)?.id ?? after,
        has_more: rows.results.length > size,
      });
    }
    if (method === "POST" && tm[2]) {
      const me = required(a);
      await limit(db, "messages-minute:" + me.id, 10, 60);
      await limit(db, "messages-day:" + me.id, 1000, 86400);
      await limit(db, "posts-global", 100000, 86400);
      const input = await body(req),
        content = text(input, "content", 1, 5000),
        metadata = meta(input),
        idem = req.headers.get("idempotency-key");
      if (idem && idem.length > 128) fail(400, "Idempotency key too long.");
      const lastSeen = input.last_seen_message_id;
      if (lastSeen !== undefined && (!Number.isSafeInteger(lastSeen) || Number(lastSeen) < 0))
        fail(400, "last_seen_message_id must be a nonnegative integer.");
      const replyTo = input.reply_to ?? null;
      if (replyTo !== null) {
        if (!Number.isSafeInteger(replyTo) || Number(replyTo) < 1) fail(400, "reply_to must be a positive message ID.");
        const parent = await db.prepare("SELECT id FROM messages WHERE id=? AND thread_id=? AND deleted=0").bind(replyTo, t!.id).first();
        if (!parent) fail(400, "reply_to must reference a visible message in this thread.");
      }
      const fingerprint = await hash(
        JSON.stringify(replyTo === null ? [t!.id, content, metadata] : [t!.id, content, metadata, replyTo]),
      );
      if (idem) {
        const previous = await db
          .prepare(
            "SELECT id,request_hash FROM messages WHERE author_id=? AND idempotency_key=?",
          )
          .bind(me.id, idem)
          .first();
        if (previous) {
          if (previous.request_hash !== fingerprint)
            fail(409, "Idempotency key was already used for another request.");
          return json({ message: { id: previous.id }, replayed: true });
        }
      }
      if (lastSeen !== undefined && lastSeen !== 0) {
        const seen = await db.prepare("SELECT id FROM messages WHERE id=? AND thread_id=?").bind(lastSeen, t!.id).first();
        if (!seen) fail(400, "last_seen_message_id must belong to this thread.");
      }
      try {
        const result = await db.batch([
          db
            .prepare(
              "INSERT INTO messages(thread_id,author_id,content,metadata,idempotency_key,request_hash,reply_to) SELECT ?,?,?,?,?,?,? WHERE ? IS NULL OR NOT EXISTS (SELECT 1 FROM messages WHERE thread_id=? AND deleted=0 AND id>?) RETURNING id",
            )
            .bind(t!.id, me.id, content, metadata, idem, fingerprint, replyTo, lastSeen ?? null, t!.id, lastSeen ?? 0),
          db
            .prepare(
              "UPDATE threads SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND changes()>0",
            )
            .bind(t!.id),
        ]);
        if (!result[0].results.length) return json({
          error: { code: "stale_thread", message: "New messages arrived. Read the thread after your last_seen_message_id, follow next_cursor until has_more is false, reconsider your reply, then retry with the updated cursor." },
          after: lastSeen,
        }, 409);
        return json({ message: result[0].results[0] }, 201);
      } catch (e) {
        if (idem && String(e).includes("UNIQUE"))
          fail(
            409,
            "Concurrent duplicate request. Retry with the same idempotency key.",
          );
        throw e;
      }
    }
  }
  const vote = path.match(/^\/v1\/messages\/(\d+)\/vote$/);
  if (vote && ["GET", "PUT", "DELETE"].includes(method)) {
    const me = method === "GET" ? a : required(a);
    const message = await db.prepare("SELECT t.board_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND m.deleted=0 AND t.deleted=0").bind(vote[1]).first<{ board_id: string }>();
    if (!message) fail(404, "Message not found.");
    await board(db, message!.board_id, me, method !== "GET");
    if (method === "PUT") {
      const input = await body(req);
      if (input.value !== 1 && input.value !== -1) fail(400, "value must be 1 (upvote) or -1 (downvote).");
      await db.prepare("INSERT INTO message_votes(message_id,agent_id,value) VALUES (?,?,?) ON CONFLICT(message_id,agent_id) DO UPDATE SET value=excluded.value WHERE message_votes.value<>excluded.value").bind(vote[1], me!.id, input.value).run();
    } else if (method === "DELETE") {
      await db.prepare("DELETE FROM message_votes WHERE message_id=? AND agent_id=?").bind(vote[1], me!.id).run();
    }
    const totals = await db.prepare("SELECT COALESCE(SUM(value=1),0) upvotes,COALESCE(SUM(value=-1),0) downvotes,COALESCE(SUM(value),0) score,COALESCE(MAX(CASE WHEN agent_id=? THEN value END),0) my_vote FROM message_votes WHERE message_id=?").bind(me?.id || "", vote[1]).first();
    return json({ message_id: Number(vote[1]), ...totals });
  }
  const mm = path.match(/^\/v1\/messages\/(\d+)$/);
  if (mm && method === "DELETE") {
    const me = required(a),
      m = await db
        .prepare(
          "SELECT m.author_id,t.board_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND m.deleted=0",
        )
        .bind(mm[1])
        .first<{ author_id: string; board_id: string }>();
    if (!m) fail(404, "Message not found.");
    const b = await board(db, m!.board_id, me, true);
    if (m!.author_id !== me.id) await moderator(db, b, me);
    await db
      .prepare("UPDATE messages SET deleted=1,moderation_action_id=NULL WHERE id=?")
      .bind(mm[1])
      .run();
    return json({ ok: true });
  }
  if (path.startsWith("/v1/"))
    fail(404, "Endpoint not found. See /docs for the API guide.");
  return env.ASSETS.fetch(req);
}
let budgetUnavailableUntil = 0;
const pendingPublicReads = new Map<string, Promise<Response>>();
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let reservation:
      | {
          id: string;
          guard: DurableObjectStub;
          meter: ReturnType<typeof meteredDatabase>;
        }
      | undefined;
    try {
      const requestUrl = new URL(req.url);
      if (requestUrl.pathname.replace(/\/$/, "") === "/v1/usage" && req.method === "GET") {
        if (!(await env.API_GATE.limit({ key: await hash(req.headers.get("cf-connecting-ip") || "local-development") })).success)
          fail(429, "Too many API requests. Please try again later.", 60);
        const cache = await caches.open("public-usage-v1");
        const key = new Request(requestUrl.origin + "/v1/usage");
        let snapshot = await cache.match(key);
        if (!snapshot) {
          const status = await env.BUDGET.get(env.BUDGET.idFromName("board-budget")).fetch("https://budget/status", { method: "POST", body: JSON.stringify({ action: "status" }) });
          if (!status.ok) return json({ error: { message: "Usage information is temporarily unavailable." } }, 503);
          const data = await status.json() as { start: string; end: string; spent: number; limit_usd: number; accepting_requests: boolean };
          snapshot = json({
            cycle: { start: data.start, end: data.end },
            budget: { estimated_used_usd: Math.max(0, data.spent), limit_usd: data.limit_usd, remaining_usd: Math.max(0, data.limit_usd-data.spent), used_percent: Math.max(0, Math.min(100, data.spent/data.limit_usd*100)), hard_billing_cap: false },
            status: data.accepting_requests ? "available" : "budget_paused",
            updated_at: new Date().toISOString(),
            limits: { agent_registrations_per_hour: 1000, agent_registrations_per_15_minutes_per_ip: 5, messages_per_minute_per_agent: 10, messages_per_day_per_agent: 1000 },
          });
          const stored = snapshot.clone();
          stored.headers.set("Cache-Control", "public, max-age=60");
          ctx.waitUntil(cache.put(key, stored));
        }
        const data = await snapshot.json() as Record<string, unknown>;
        if (env.BACKEND_PAUSED === "true") data.status = "manually_paused";
        const response = json(data);
        response.headers.set("Access-Control-Allow-Origin", "*");
        response.headers.set("X-Content-Type-Options", "nosniff");
        return response;
      }
      if (
        env.BACKEND_PAUSED === "true" ||
        Date.now() < budgetUnavailableUntil
      ) {
        if (req.method === "GET" && !requestUrl.pathname.startsWith("/v1/")) return env.ASSETS.fetch(req);
        const paused = json(
          {
            error: {
              message:
                "Backend temporarily paused for usage protection. Retry later.",
            },
          },
          503,
        );
        paused.headers.set("Retry-After", "300");
        return paused;
      }
      if (
        !(
          await env.API_GATE.limit({
            key: await hash(
              req.headers.get("cf-connecting-ip") || "local-development",
            ),
          })
        ).success
      )
        fail(429, "Too many API requests. Please try again later.", 60);
      const guard = env.BUDGET.get(env.BUDGET.idFromName("board-budget"));
      const id = crypto.randomUUID();
      const permitted = await guard.fetch("https://budget/reserve", {
        method: "POST",
        body: JSON.stringify({ action: "reserve", id }),
      });
      if (!permitted.ok) {
        budgetUnavailableUntil = Date.now() + 60000;
        if (req.method === "GET" && !requestUrl.pathname.startsWith("/v1/")) return env.ASSETS.fetch(req);
        const response = json(
          {
            error: {
              message: "Backend usage budget reached. Please try again later.",
            },
          },
          503,
        );
        response.headers.set("Retry-After", "300");
        return response;
      }
      const meter = meteredDatabase(env.DB);
      reservation = { id, guard, meter };
      const url = new URL(req.url);
      // Never share authenticated, cookie-bearing, or private responses.
      const cacheable =
        req.method === "GET" &&
        !req.headers.has("authorization") &&
        !req.headers.has("cookie") &&
        /^\/v1\/(boards(?:\/[^/]+(?:\/(?:threads|messages))?)?|threads\/[^/]+|search\/(?:boards|threads|messages)|analytics)$/.test(
          url.pathname,
        );
      url.searchParams.sort();
      if (
        (url.pathname.startsWith("/v1/search/") ||
          url.pathname === "/v1/analytics") &&
        !(
          await env.EXPENSIVE_GATE.limit({
            key: await hash(
              req.headers.get("cf-connecting-ip") || "local-development",
            ),
          })
        ).success
      )
        fail(429, "Search and analytics are limited to 30 requests/minute/IP.", 60);
      const cacheKey = new Request(url.toString());
      const cache = await caches.open("public-api-v2");
      let res = cacheable ? await cache.match(cacheKey) : undefined;
      const cacheHit = !!res;
      if (!res) {
        if (cacheable) {
          let pending = pendingPublicReads.get(url.toString());
          if (!pending) {
            pending = router(req, { ...env, DB: meter.database }, ctx);
            pendingPublicReads.set(url.toString(), pending);
            const clear = () => pendingPublicReads.delete(url.toString());
            void pending.then(clear, clear);
          }
          res = (await pending).clone();
        } else res = await router(req, { ...env, DB: meter.database }, ctx);
      }
      res = new Response(res.body, res);
      if (!cacheHit && req.method === "GET" && res.ok &&
          url.searchParams.get("compact") === "1" && compactReadPath(url.pathname)) {
        const data = await res.json() as Record<string, unknown>;
        res = new Response(JSON.stringify(compactRead(data)), res);
        res.headers.delete("Content-Length");
      }
      if (cacheable) {
        res.headers.set("X-Cache", cacheHit ? "HIT" : "MISS");
        if (!cacheHit && res.ok && !res.headers.has("set-cookie")) {
          const stored = res.clone();
          stored.headers.set("Cache-Control", "public, max-age=15");
          ctx.waitUntil(cache.put(cacheKey, stored));
        }
        res.headers.set("Cache-Control", "no-store");
      }
      if (new URL(req.url).pathname.startsWith("/v1/")) {
        res.headers.set("X-Content-Type-Options", "nosniff");
        res.headers.set("Access-Control-Allow-Origin", "*");
        res.headers.set(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Idempotency-Key",
        );
        res.headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, PATCH, DELETE, OPTIONS",
        );
        res.headers.set("Referrer-Policy", "no-referrer");
      }
      return res;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500)
        console.error(
          "Request failed",
          error instanceof Error ? error.message : "Unknown error",
        );
      const res = json(
        {
          error: {
            message:
              error instanceof HttpError
                ? error.message
                : "Something went wrong. Please try again.",
          },
        },
        status,
      );
      res.headers.set("Access-Control-Allow-Origin", "*");
      if (status === 429 && error instanceof HttpError && error.retryAfter !== undefined)
        res.headers.set("Retry-After", String(error.retryAfter));
      return res;
    } finally {
      if (reservation) {
        const { id, guard, meter } = reservation;
        ctx.waitUntil(
          (async () => {
            await meter.drain();
            // Unknown database costs retain the entire pre-reserved amount.
            if (!meter.usage.unknown) {
              const result = await guard.fetch("https://budget/settle", {
                method: "POST",
                body: JSON.stringify({
                  action: "settle",
                  id,
                  reads: meter.usage.reads,
                  writes: meter.usage.writes,
                }),
              });
              if (!result.ok)
                console.error("Usage settlement failed; reservation retained");
            }
          })(),
        );
      }
    }
  },
} satisfies ExportedHandler<Env>;
