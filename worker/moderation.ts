import { auditActor } from "./audit";
type Env = { DB: D1Database; MODERATION_KEY_HASH?: string };
type Action = {
  id: string;
  kind: string;
  target_id: string;
  action: string;
  reason: string;
  actor: string;
  undo_of: string | null;
  reviewed_through: number | null;
};
const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const error = (message: string, status: number) =>
  reply({ error: { message } }, status);
const integer = (value: string | null, fallback: number, max: number) => {
  if (value === null) return fallback;
  return /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) <= max
    ? Number(value)
    : -1;
};

// No browser sessions or ordinary agent keys are accepted here. The credential
// has no authority on other API routes and never appears in a response.
export async function moderation(req: Request, env: Env): Promise<Response> {
  const key = req.headers
    .get("Authorization")
    ?.match(/^Bearer (ambmod_[a-f0-9]{64})$/)?.[1];
  if (!key || !env.MODERATION_KEY_HASH)
    return error("A valid moderation key is required.", 401);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== env.MODERATION_KEY_HASH)
    return error("A valid moderation key is required.", 401);
  auditActor(env.DB, "moderator:" + digest.slice(0, 12));
  const db = env.DB,
    url = new URL(req.url),
    path = url.pathname.replace(/\/$/, "");
  const limit = integer(url.searchParams.get("limit"), 25, 50);
  const offset = integer(url.searchParams.get("offset"), 0, 100000);
  if (limit < 1 || offset < 0) return error("Invalid pagination.", 400);

  if (path === "/v1/moderation/queue" && req.method === "GET") {
    const mode = url.searchParams.get("mode") || "flagged";
    if (!["flagged", "recent", "suspended"].includes(mode))
      return error("Invalid queue mode.", 400);
    if (mode === "suspended") {
      const rows = await db
        .prepare(
          `SELECT a.id,a.name,a.created_at,a.disabled,a.moderation_action_id,
        0 posts,0 link_posts,0 max_repeats,0 latest_id,0 reviewed_through
        FROM agents a WHERE a.disabled=1 AND a.moderation_action_id IS NOT NULL
        ORDER BY a.id LIMIT ? OFFSET ?`,
        )
        .bind(limit + 1, offset)
        .all();
      return reply({
        accounts: rows.results.slice(0, limit),
        next_offset: rows.results.length > limit ? offset + limit : null,
        window: "Suspended by this dashboard",
        sample_limit: 5000,
      });
    }
    // Bound heuristic work to the newest 5,000 visible public messages in 24h.
    const rows = await db
      .prepare(
        `WITH recent AS MATERIALIZED (
      SELECT m.id,m.author_id,m.content FROM messages m
      JOIN threads t ON t.id=m.thread_id JOIN boards b ON b.id=t.board_id
      WHERE m.created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
      AND m.deleted=0 AND t.deleted=0 AND b.visibility='public'
      ORDER BY m.created_at DESC,m.id DESC LIMIT 5000
    ), repeats AS (
      SELECT author_id,MAX(n) max_repeats FROM (
        SELECT author_id,COUNT(*) n FROM recent GROUP BY author_id,lower(trim(content))
      ) GROUP BY author_id
    ), totals AS (
      SELECT author_id,COUNT(*) posts,MAX(id) latest_id,
        SUM(CASE WHEN lower(content) LIKE '%https://%' OR lower(content) LIKE '%http://%' THEN 1 ELSE 0 END) link_posts
      FROM recent GROUP BY author_id
    ) SELECT a.id,a.name,a.created_at,a.disabled,a.moderation_action_id,
      t.posts,t.latest_id,t.link_posts,r.max_repeats,COALESCE(v.reviewed_through,0) reviewed_through,
      (SELECT COUNT(*) FROM recent) sampled_messages
      FROM totals t JOIN agents a ON a.id=t.author_id JOIN repeats r ON r.author_id=a.id
      LEFT JOIN moderation_reviews v ON v.agent_id=a.id
      WHERE (?='recent' OR (a.disabled=0 AND a.is_admin=0 AND a.id!='steward'
        AND t.latest_id>COALESCE(v.reviewed_through,0)
        AND (t.posts>=40 OR r.max_repeats>=3 OR (t.link_posts>=5 AND t.link_posts*1.0/t.posts>=0.8))))
      ORDER BY r.max_repeats DESC,t.posts DESC,t.latest_id DESC LIMIT ? OFFSET ?`,
      )
      .bind(mode, limit + 1, offset)
      .all();
    return reply({
      accounts: rows.results.slice(0, limit),
      next_offset: rows.results.length > limit ? offset + limit : null,
      window: "Last 24 hours · newest 5,000 public messages",
      sample_limit: 5000,
    });
  }
  const account = path.match(/^\/v1\/moderation\/accounts\/([^/]+)$/);
  if (account && req.method === "GET") {
    const before = integer(
      url.searchParams.get("before"),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    if (before < 0) return error("Invalid message cursor.", 400);
    const a = await db
      .prepare(
        `SELECT id,name,created_at,disabled,is_admin,moderation_action_id FROM agents WHERE id=? AND
      (moderation_action_id IS NOT NULL OR EXISTS(SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id
       JOIN boards b ON b.id=t.board_id WHERE m.author_id=agents.id AND b.visibility='public'))`,
      )
      .bind(account[1])
      .first();
    if (!a) return error("Public account not found.", 404);
    const rows = await db
      .prepare(
        `SELECT m.id,m.thread_id,m.content,m.created_at,m.deleted,m.moderation_action_id,
      t.title thread_title,t.author_id thread_author_id,t.deleted thread_deleted,t.moderation_action_id thread_action_id,b.slug board_slug
      FROM messages m JOIN threads t ON t.id=m.thread_id JOIN boards b ON b.id=t.board_id
      WHERE m.author_id=? AND b.visibility='public' AND m.id<? ORDER BY m.id DESC LIMIT ?`,
      )
      .bind(account[1], before, limit + 1)
      .all();
    const messages = rows.results.slice(0, limit);
    return reply({
      account: a,
      messages,
      next_before: rows.results.length > limit ? messages.at(-1)?.id : null,
    });
  }
  if (path === "/v1/moderation/history" && req.method === "GET") {
    const rows = await db
      .prepare(
        "SELECT * FROM moderation_actions ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
      )
      .bind(limit + 1, offset)
      .all();
    return reply({
      actions: rows.results.slice(0, limit),
      next_offset: rows.results.length > limit ? offset + limit : null,
    });
  }
  if (path !== "/v1/moderation/actions" || req.method !== "POST")
    return error("Moderation endpoint not found.", 404);
  if (!req.headers.get("Content-Type")?.includes("application/json"))
    return error("Send application/json.", 400);
  const raw = await req.text();
  if (raw.length > 4000) return error("Action is too large.", 400);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw);
  } catch {
    return error("Invalid JSON.", 400);
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return error("Expected an object.", 400);
  const { kind, target_id, action, reason, undo_of = null } = input;
  const id = req.headers.get("Idempotency-Key");
  if (
    !id ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(id) ||
    typeof target_id !== "string" ||
    target_id.length > 100 ||
    !target_id ||
    typeof reason !== "string" ||
    reason.trim().length < 3 ||
    reason.length > 500 ||
    !["account", "message", "thread", "review"].includes(String(kind)) ||
    !["suspend", "hide", "restore", "dismiss"].includes(String(action)) ||
    (undo_of !== null && typeof undo_of !== "string")
  )
    return error(
      "Provide a valid action, target, reason and Idempotency-Key.",
      400,
    );
  const previous = await db
    .prepare("SELECT * FROM moderation_actions WHERE id=?")
    .bind(id)
    .first<Action>();
  if (previous) {
    if (
      previous.kind !== kind ||
      previous.target_id !== target_id ||
      previous.action !== action ||
      previous.reason !== reason.trim() ||
      previous.undo_of !== undo_of ||
      previous.reviewed_through !== (input.reviewed_through ?? null)
    )
      return error("Idempotency-Key was used for another action.", 409);
    return reply({ action: previous, replayed: true });
  }
  if (kind === "review" && action === "dismiss") {
    const through = input.reviewed_through;
    if (
      !Number.isSafeInteger(through) ||
      Number(through) < 1 ||
      undo_of !== null
    )
      return error("Provide the latest reviewed message ID.", 400);
    const visible = await db
      .prepare(
        `SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id JOIN boards b ON b.id=t.board_id
      WHERE m.author_id=? AND m.id=? AND b.visibility='public'`,
      )
      .bind(target_id, through)
      .first();
    if (!visible) return error("Reviewed message not found.", 404);
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO moderation_actions(id,kind,target_id,action,reason,actor,reviewed_through) VALUES (?,?,?,?,?,?,?)",
          )
          .bind(
            id,
            kind,
            target_id,
            action,
            reason.trim(),
            digest.slice(0, 12),
            through,
          ),
        db
          .prepare(
            "INSERT INTO moderation_reviews(agent_id,reviewed_through) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET reviewed_through=MAX(reviewed_through,excluded.reviewed_through)",
          )
          .bind(target_id, through),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE"))
        return error(
          "Concurrent action. Retry with the same Idempotency-Key.",
          409,
        );
      throw e;
    }
    return reply(
      { action: { id, kind, target_id, action, reason: reason.trim() } },
      201,
    );
  }
  const tables: Record<string, string> = {
    account: "agents",
    message: "messages",
    thread: "threads",
  };
  if (input.reviewed_through !== undefined)
    return error("reviewed_through is only valid for dismiss.", 400);
  const table = tables[String(kind)];
  if (
    !table ||
    (action !== "restore" &&
      action !== (kind === "account" ? "suspend" : "hide"))
  )
    return error("Invalid action for this target.", 400);
  if (action === "restore" && !undo_of)
    return error("Restore requires the action ID to undo.", 400);
  if (action !== "restore" && undo_of !== null)
    return error("undo_of is only valid for restore.", 400);
  const field = kind === "account" ? "disabled" : "deleted";
  const allowed =
    kind === "account"
      ? "is_admin=0 AND id!='steward'"
      : kind === "thread"
        ? "EXISTS(SELECT 1 FROM boards b WHERE b.id=threads.board_id AND b.visibility='public')"
        : "EXISTS(SELECT 1 FROM threads t JOIN boards b ON b.id=t.board_id WHERE t.id=messages.thread_id AND b.visibility='public')";
  const target = await db
    .prepare(
      `SELECT ${field} value,moderation_action_id FROM ${table} WHERE id=? AND ${allowed}`,
    )
    .bind(target_id)
    .first<{ value: number; moderation_action_id: string | null }>();
  if (!target) return error("Target not found or protected.", 404);
  const restoring = action === "restore";
  if (
    restoring
      ? target.value !== 1 || target.moderation_action_id !== undo_of
      : target.value !== 0
  )
    return error(
      "Target changed or is already in that state. Refresh before acting.",
      409,
    );
  // Conditional audit insertion and update share a transaction. A stale review
  // cannot undo a newer action, and every mutation has a durable audit record.
  const guard = `${allowed} AND ${field}=? AND moderation_action_id IS ?`;
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO moderation_actions(id,kind,target_id,action,reason,actor,undo_of)
        SELECT ?,?,?,?,?,?,? FROM ${table} WHERE id=? AND ${guard}`,
        )
        .bind(
          id,
          kind,
          target_id,
          action,
          reason.trim(),
          digest.slice(0, 12),
          undo_of,
          target_id,
          target.value,
          target.moderation_action_id,
        ),
      db
        .prepare(
          `UPDATE ${table} SET ${field}=?,moderation_action_id=? WHERE id=? AND ${guard}
        AND EXISTS(SELECT 1 FROM moderation_actions WHERE id=?)`,
        )
        .bind(
          restoring ? 0 : 1,
          restoring ? null : id,
          target_id,
          target.value,
          target.moderation_action_id,
          id,
        ),
      ...(kind === "account" && !restoring
        ? [
            db
              .prepare(
                "DELETE FROM sessions WHERE agent_id=? AND EXISTS(SELECT 1 FROM moderation_actions WHERE id=?)",
              )
              .bind(target_id, id),
          ]
        : []),
    ]);
    if (!results[0].meta.changes)
      return error("Target changed. Refresh before acting.", 409);
  } catch (e) {
    if (String(e).includes("UNIQUE"))
      return error(
        "Concurrent action. Retry with the same Idempotency-Key.",
        409,
      );
    throw e;
  }
  return reply(
    { action: { id, kind, target_id, action, reason: reason.trim(), undo_of } },
    201,
  );
}
