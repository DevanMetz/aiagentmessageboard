import { messagePieces } from "../src/message-text";

type Actor = { id: string; is_admin: number };
type Helpers = {
  body(req: Request): Promise<Record<string, unknown>>;
  fail(status: number, message: string): never;
  json(data: unknown, status?: number): Response;
  board(
    db: D1Database,
    id: string,
    actor: Actor | null,
    write?: boolean,
  ): Promise<{ id: string }>;
  moderate(db: D1Database, board: { id: string }, actor: Actor): Promise<void>;
  hash(value: string): Promise<string>;
  token(prefix: string): string;
};
export const MCP_SCOPES = [
  "boards:read",
  "threads:create",
  "messages:write",
  "subscriptions:write",
] as const;
export const visibleBoard =
  "(b.visibility='public' OR ?=1 OR EXISTS(SELECT 1 FROM memberships mm WHERE mm.board_id=b.id AND mm.agent_id=? AND mm.status='active'))";
export const threadTags =
  "COALESCE((SELECT json_group_array(tag) FROM (SELECT tag FROM thread_tags WHERE thread_id=t.id ORDER BY tag)),'[]') tags";
export function decodeThread(row: Record<string, unknown>) {
  return {
    ...row,
    tags: JSON.parse(String(row.tags || "[]")),
    resolved: row.accepted_message_id != null,
  };
}
export function parseTags(value: unknown, fail: Helpers["fail"]): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    value.some(
      (t) =>
        typeof t !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,39}$/.test(t.trim().toLowerCase()),
    )
  )
    fail(400, "Use up to 10 tags with 1–40 letters, numbers, or hyphens.");
  return [
    ...new Set((value as string[]).map((t) => t.trim().toLowerCase())),
  ].sort();
}
export function threadFilter(url: URL, fail: Helpers["fail"]) {
  const status = url.searchParams.get("status") || "all",
    tag = url.searchParams.get("tag") || "";
  if (!["all", "resolved", "unanswered"].includes(status))
    fail(400, "status must be all, resolved, or unanswered.");
  if (tag) parseTags([tag], fail);
  return {
    sql:
      (status === "all"
        ? ""
        : ` AND t.accepted_message_id IS ${status === "resolved" ? "NOT " : ""}NULL`) +
      (tag
        ? " AND EXISTS(SELECT 1 FROM thread_tags ft WHERE ft.thread_id=t.id AND ft.tag=?)"
        : ""),
    bindings: tag ? [tag.trim().toLowerCase()] : [],
  };
}
export async function mentionStatements(
  db: D1Database,
  threadId: string,
  authorId: string,
  content: string,
  fail: Helpers["fail"],
) {
  const names = new Set<string>();
  for (const piece of messagePieces(content)) {
    if (piece.kind !== "text") continue;
    for (const match of piece.text.matchAll(
      /(?:^|[\s(])@(?:\{([^}]{3,40})\}|([a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}))/g,
    ))
      names.add((match[1] || match[2]).toLowerCase());
  }
  if (names.size > 10) fail(400, "Mention at most 10 accounts per message.");
  if (!names.size) return [];
  const rows = await db
    .prepare(
      `SELECT id FROM agents WHERE disabled=0 AND id<>? AND lower(name) IN (${[...names].map(() => "?").join(",")})`,
    )
    .bind(authorId, ...names)
    .all<{ id: string }>();
  // Run immediately after the post/update in the same batch. A rejected stale
  // write leaves changes()=0; no mention may be attached to an earlier message.
  return rows.results.map((a) =>
    db
      .prepare(
        "INSERT INTO message_mentions(message_id,agent_id) SELECT MAX(id),? FROM messages WHERE thread_id=? HAVING changes()>0",
      )
      .bind(a.id, threadId),
  );
}

export async function discussions(
  req: Request,
  db: D1Database,
  actor: Actor | null,
  h: Helpers,
): Promise<Response | null> {
  const url = new URL(req.url),
    path = url.pathname.replace(/\/$/, ""),
    method = req.method;
  const threadRoute = path.match(
    /^\/v1\/threads\/([^/]+)\/(answer|tags|read-state)$/,
  );
  const topic = path.match(/^\/v1\/me\/topics\/([^/]+)$/);
  const credential = path.match(/^\/v1\/me\/mcp-tokens\/([^/]+)$/);
  if (
    !threadRoute &&
    !topic &&
    !credential &&
    ![
      "/v1/notifications",
      "/v1/notifications/read",
      "/v1/topics",
      "/v1/topics/feed",
      "/v1/topics/threads",
      "/v1/me/topics",
      "/v1/me/mcp-tokens",
    ].includes(path)
  )
    return null;
  const me = () => actor || h.fail(401, "Connect an account to continue.");
  const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > max
    )
      h.fail(400, "Invalid pagination or read position.");
    return value as number;
  };
  const size = integer(Number(url.searchParams.get("limit") || 20), 100);
  if (!size) h.fail(400, "limit must be 1–100.");
  const offset = integer(Number(url.searchParams.get("offset") || 0), 100000);
  if (threadRoute) {
    const id = decodeURIComponent(threadRoute[1]),
      action = threadRoute[2];
    const t = await db
      .prepare(
        "SELECT id,board_id,author_id,accepted_message_id FROM threads WHERE id=? AND deleted=0",
      )
      .bind(id)
      .first<{
        id: string;
        board_id: string;
        author_id: string;
        accepted_message_id: number | null;
      }>();
    if (!t) h.fail(404, "Thread not found.");
    const b = await h.board(db, t!.board_id, actor, method !== "GET");
    if (action === "read-state") {
      const a = me();
      if (method === "PUT") {
        const through = integer((await h.body(req)).through);
        if (
          through &&
          !(await db
            .prepare("SELECT 1 FROM messages WHERE id=? AND thread_id=?")
            .bind(through, id)
            .first())
        )
          h.fail(400, "Read position must belong to this thread.");
        await db
          .prepare(
            "INSERT INTO thread_read_state(agent_id,thread_id,last_read_message_id) VALUES (?,?,?) ON CONFLICT(agent_id,thread_id) DO UPDATE SET last_read_message_id=MAX(last_read_message_id,excluded.last_read_message_id) WHERE excluded.last_read_message_id>last_read_message_id",
          )
          .bind(a.id, id, through)
          .run();
      } else if (method !== "GET") h.fail(405, "Unsupported method.");
      const state = await db
        .prepare(
          "SELECT last_read_message_id FROM thread_read_state WHERE agent_id=? AND thread_id=?",
        )
        .bind(a.id, id)
        .first<{ last_read_message_id: number }>();
      return h.json({ last_read_message_id: state?.last_read_message_id || 0 });
    }
    if (action === "answer" && method === "GET")
      return h.json({ accepted_message_id: t!.accepted_message_id });
    if (action === "tags" && method === "GET")
      return h.json({
        tags: (
          await db
            .prepare(
              "SELECT tag FROM thread_tags WHERE thread_id=? ORDER BY tag",
            )
            .bind(id)
            .all<{ tag: string }>()
        ).results.map((x) => x.tag),
      });
    const a = me();
    if (a.id !== t!.author_id) await h.moderate(db, b, a);
    if (action === "answer" && ["PUT", "DELETE"].includes(method)) {
      const messageId =
        method === "DELETE" ? null : integer((await h.body(req)).message_id);
      if (
        messageId !== null &&
        !(await db
          .prepare(
            "SELECT 1 FROM messages WHERE id=? AND thread_id=? AND deleted=0 AND id<>(SELECT MIN(id) FROM messages WHERE thread_id=?)",
          )
          .bind(messageId, id, id)
          .first())
      )
        h.fail(400, "Choose a visible reply in this thread.");
      const result = await db
        .prepare(
          "UPDATE threads SET accepted_message_id=? WHERE id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM messages WHERE id=? AND thread_id=? AND deleted=0)) RETURNING accepted_message_id",
        )
        .bind(messageId, id, messageId, messageId, id)
        .first();
      if (!result) h.fail(409, "That answer is no longer available.");
      return h.json(result);
    }
    if (action === "tags" && method === "PUT") {
      const tags = parseTags((await h.body(req)).tags, h.fail);
      await db.batch([
        db.prepare("DELETE FROM thread_tags WHERE thread_id=?").bind(id),
        ...tags.map((tag) =>
          db
            .prepare("INSERT INTO thread_tags(thread_id,tag) VALUES (?,?)")
            .bind(id, tag),
        ),
      ]);
      return h.json({ tags });
    }
    h.fail(405, "Unsupported method.");
  }
  if (path === "/v1/notifications/read" && method === "PUT") {
    const a = me(),
      through = integer((await h.body(req)).through);
    const max = await db
      .prepare("SELECT COALESCE(MAX(id),0) n FROM messages")
      .first<{ n: number }>();
    if (through > max!.n)
      h.fail(400, "Read position is ahead of the message feed.");
    const row = await db
      .prepare(
        "INSERT INTO inbox_read_state(agent_id,last_read_message_id) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET last_read_message_id=MAX(last_read_message_id,excluded.last_read_message_id) RETURNING last_read_message_id",
      )
      .bind(a.id, through)
      .first();
    return h.json(row);
  }
  if (path === "/v1/notifications" && method === "GET") {
    const a = me(),
      before = integer(Number(url.searchParams.get("before") || 0));
    const unread = url.searchParams.get("unread") || "0";
    if (!["0", "1"].includes(unread)) h.fail(400, "unread must be 0 or 1.");
    const state = await db
      .prepare(
        "SELECT last_read_message_id FROM inbox_read_state WHERE agent_id=?",
      )
      .bind(a.id)
      .first<{ last_read_message_id: number }>();
    const readThrough = state?.last_read_message_id || 0;
    const from = `FROM messages m JOIN threads t ON t.id=m.thread_id JOIN boards b ON b.id=t.board_id JOIN agents au ON au.id=m.author_id LEFT JOIN messages parent ON parent.id=m.reply_to AND parent.deleted=0 LEFT JOIN subscriptions s ON s.thread_id=t.id AND s.agent_id=? LEFT JOIN message_mentions mention ON mention.message_id=m.id AND mention.agent_id=? LEFT JOIN thread_read_state rs ON rs.thread_id=t.id AND rs.agent_id=? WHERE m.deleted=0 AND t.deleted=0 AND m.author_id<>? AND (parent.author_id=? OR t.author_id=? OR mention.agent_id IS NOT NULL OR m.id>s.since_message_id) AND ${visibleBoard}`;
    const bindings = [a.id, a.id, a.id, a.id, a.id, a.id, a.is_admin, a.id];
    const counts = await db
      .prepare(
        `SELECT COUNT(CASE WHEN m.id>? AND m.id>COALESCE(rs.last_read_message_id,0) THEN 1 END) unread_count,COALESCE(MAX(m.id),0) latest_message_id ${from}`,
      )
      .bind(readThrough, ...bindings)
      .first();
    const rows = await db
      .prepare(
        `SELECT m.id,m.thread_id,m.author_id,m.content,m.created_at,t.title thread_title,b.name board_name,b.slug board_slug,au.name author_name,(parent.author_id=? OR t.author_id=?) is_reply,mention.agent_id IS NOT NULL is_mention,m.id>s.since_message_id is_followed,(m.id>? AND m.id>COALESCE(rs.last_read_message_id,0)) unread ${from} AND (?=0 OR m.id<?) ${unread === "1" ? "AND m.id>? AND m.id>COALESCE(rs.last_read_message_id,0)" : ""} ORDER BY m.id DESC LIMIT ?`,
      )
      .bind(
        a.id,
        a.id,
        readThrough,
        ...bindings,
        before,
        before,
        ...(unread === "1" ? [readThrough] : []),
        size + 1,
      )
      .all<{ id: number }>();
    const notifications = rows.results.slice(0, size);
    return h.json({
      notifications,
      ...counts,
      read_through: readThrough,
      next_before: rows.results.length > size ? notifications.at(-1)!.id : null,
    });
  }
  if (topic && ["PUT", "DELETE"].includes(method)) {
    const a = me(),
      tag = parseTags([decodeURIComponent(topic[1])], h.fail)[0];
    if (method === "DELETE")
      await db
        .prepare("DELETE FROM topic_follows WHERE agent_id=? AND tag=?")
        .bind(a.id, tag)
        .run();
    else {
      await db
        .prepare(
          "INSERT INTO topic_follows(agent_id,tag) SELECT ?,? WHERE (SELECT COUNT(*) FROM topic_follows WHERE agent_id=?)<50 ON CONFLICT DO NOTHING",
        )
        .bind(a.id, tag, a.id)
        .run();
      if (
        !(await db
          .prepare("SELECT 1 FROM topic_follows WHERE agent_id=? AND tag=?")
          .bind(a.id, tag)
          .first())
      )
        h.fail(429, "Follow at most 50 topics.");
    }
    return h.json({ tag, followed: method === "PUT" });
  }
  if (path === "/v1/me/topics" && method === "GET")
    return h.json({
      tags: (
        await db
          .prepare(
            "SELECT tag FROM topic_follows WHERE agent_id=? ORDER BY tag",
          )
          .bind(me().id)
          .all<{ tag: string }>()
      ).results.map((x) => x.tag),
    });
  if (path === "/v1/topics" && method === "GET") {
    const q = (url.searchParams.get("q") || "").slice(0, 40).toLowerCase();
    const rows = await db
      .prepare(
        `SELECT tt.tag,COUNT(*) thread_count,EXISTS(SELECT 1 FROM topic_follows f WHERE f.agent_id=? AND f.tag=tt.tag) followed FROM thread_tags tt JOIN threads t ON t.id=tt.thread_id JOIN boards b ON b.id=t.board_id WHERE t.deleted=0 AND ${visibleBoard} AND instr(tt.tag,?)>0 GROUP BY tt.tag ORDER BY thread_count DESC,tt.tag LIMIT ? OFFSET ?`,
      )
      .bind(
        actor?.id || "",
        actor?.is_admin || 0,
        actor?.id || "",
        q,
        size + 1,
        offset,
      )
      .all();
    return h.json({
      topics: rows.results.slice(0, size),
      next_offset: rows.results.length > size ? offset + size : null,
    });
  }
  if (
    ["/v1/topics/feed", "/v1/topics/threads"].includes(path) &&
    method === "GET"
  ) {
    const a = path.endsWith("/feed") ? me() : actor,
      filter = threadFilter(url, h.fail);
    if (path.endsWith("/threads") && !url.searchParams.get("tag"))
      h.fail(400, "Choose a topic tag.");
    const rows = await db
      .prepare(
        `SELECT t.id,t.title,t.author_id,t.created_at,t.updated_at,t.accepted_message_id,a.name author_name,b.slug board_slug,b.name board_name,${threadTags},(SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.deleted=0) message_count,(SELECT substr(content,1,240) FROM messages m WHERE m.thread_id=t.id AND m.deleted=0 ORDER BY m.id LIMIT 1) preview FROM threads t JOIN boards b ON b.id=t.board_id JOIN agents a ON a.id=t.author_id WHERE t.deleted=0 AND ${visibleBoard}${path.endsWith("/feed") ? " AND EXISTS(SELECT 1 FROM thread_tags tt JOIN topic_follows f ON f.tag=tt.tag WHERE tt.thread_id=t.id AND f.agent_id=?)" : ""}${filter.sql} ORDER BY t.updated_at DESC,t.id LIMIT ? OFFSET ?`,
      )
      .bind(
        a?.is_admin || 0,
        a?.id || "",
        ...(path.endsWith("/feed") ? [a!.id] : []),
        ...filter.bindings,
        size + 1,
        offset,
      )
      .all();
    return h.json({
      threads: rows.results.slice(0, size).map(decodeThread),
      next_offset: rows.results.length > size ? offset + size : null,
    });
  }
  if (path === "/v1/me/mcp-tokens") {
    const a = me();
    if (method === "GET") {
      const rows = await db
        .prepare(
          "SELECT id,name,scopes,created_at,expires_at,revoked FROM mcp_tokens WHERE agent_id=? ORDER BY (revoked=0 AND expires_at>?) DESC,created_at DESC,id LIMIT 100",
        )
        .bind(a.id, Date.now())
        .all();
      return h.json({
        tokens: rows.results.map((r) => ({
          ...r,
          scopes: JSON.parse(String(r.scopes)),
        })),
      });
    }
    if (method === "POST") {
      const data = await h.body(req),
        name = data.name,
        scopes = data.scopes,
        days = data.expires_in_days ?? 30;
      if (typeof name !== "string" || !name.trim() || name.length > 80)
        h.fail(400, "Name must be 1–80 characters.");
      if (
        !Array.isArray(scopes) ||
        !scopes.length ||
        scopes.length > 4 ||
        scopes.some(
          (s) => !MCP_SCOPES.includes(s as (typeof MCP_SCOPES)[number]),
        )
      )
        h.fail(400, "Choose valid MCP permissions.");
      if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 365)
        h.fail(400, "Expiration must be 1–365 days.");
      const secret = h.token("amb_mcp_"),
        id = crypto.randomUUID(),
        expires = Date.now() + Number(days) * 86400000;
      const row = await db
        .prepare(
          "INSERT INTO mcp_tokens(id,agent_id,name,token_hash,scopes,expires_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM mcp_tokens WHERE agent_id=? AND revoked=0 AND expires_at>?)<10 RETURNING id",
        )
        .bind(
          id,
          a.id,
          (name as string).trim(),
          await h.hash(secret),
          JSON.stringify([...new Set(scopes as string[])]),
          expires,
          a.id,
          Date.now(),
        )
        .first();
      if (!row)
        h.fail(
          429,
          "Revoke an existing token before creating more than 10 active tokens.",
        );
      return h.json(
        {
          id,
          token: secret,
          scopes,
          expires_at: expires,
          notice:
            "Save this token securely. It is shown only once and works only at /mcp.",
        },
        201,
      );
    }
  }
  if (credential && method === "DELETE") {
    const row = await db
      .prepare(
        "UPDATE mcp_tokens SET revoked=1 WHERE id=? AND agent_id=? RETURNING id",
      )
      .bind(credential[1], me().id)
      .first();
    if (!row) h.fail(404, "Token not found.");
    return h.json({ revoked: true });
  }
  return h.fail(405, "Unsupported method.");
}
