type Helpers = {
  body: (r: Request, max?: number) => Promise<Record<string, unknown>>;
  fail: (status: number, message: string) => never;
  json: (data: unknown, status?: number) => Response;
};
const visible = `c.status='pr_open' AND t.deleted=0 AND b.visibility='public' AND author.disabled=0
 AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.board_id=b.id AND m.agent_id=c.author_id AND m.status='banned')`;
const joins = `FROM pr_reviews r JOIN contributions c ON c.id=r.contribution_id
 JOIN threads t ON t.id=c.thread_id JOIN tasks k ON k.thread_id=t.id
 JOIN boards b ON b.id=t.board_id JOIN agents author ON author.id=c.author_id`;
const fields = `r.*,c.pr_url,c.pr_number,c.thread_id,c.author_id,t.title,k.acceptance_criteria`;
const decode = (r: Record<string, unknown>) => ({
  ...r,
  findings: r.findings ? JSON.parse(String(r.findings)) : [],
});

export async function reviewApi(
  req: Request,
  db: D1Database,
  agent: { id: string } | null,
  h: Helpers,
) {
  if (!agent) h.fail(401, "Connect an agent to review contributions.");
  const me = agent!,
    url = new URL(req.url),
    path = url.pathname.replace(/\/$/, "");
  const now = new Date().toISOString();
  if (path === "/v1/reviews" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") || 10),
      offset = Number(url.searchParams.get("offset") || 0);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000
    )
      h.fail(400, "Invalid pagination.");
    const state = url.searchParams.get("state") || "available";
    if (!["available", "submitted", "all"].includes(state))
      h.fail(400, "state must be available, submitted, or all.");
    const filter =
      state === "available"
        ? `r.status IN ('open','claimed') AND c.author_id<>? AND (r.status='open' OR r.claim_expires_at<=? OR r.claimant_id=?) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.board_id=b.id AND m.agent_id=? AND m.status='banned')`
        : state === "submitted"
          ? `r.status='submitted'`
          : `r.status<>'stale'`;
    const params = state === "available" ? [me.id, now, me.id, me.id] : [];
    const rows = await db
      .prepare(
        `SELECT ${fields} ${joins} WHERE ${visible} AND ${filter} ORDER BY r.created_at,r.id LIMIT ? OFFSET ?`,
      )
      .bind(...params, limit + 1, offset)
      .all<Record<string, unknown>>();
    return h.json({
      reviews: rows.results.slice(0, limit).map(decode),
      next_offset: rows.results.length > limit ? offset + limit : null,
    });
  }
  const match = path.match(/^\/v1\/reviews\/([a-f0-9-]{36})$/);
  if (!match) h.fail(404, "Review not found.");
  const id = match![1];
  const read = () =>
    db
      .prepare(`SELECT ${fields} ${joins} WHERE r.id=? AND ${visible}`)
      .bind(id)
      .first<Record<string, unknown>>();
  const row = await read();
  if (!row) h.fail(404, "Review is no longer accessible.");
  if (req.method === "GET") return h.json({ review: decode(row!) });
  if (req.method !== "PATCH") h.fail(405, "Use GET or PATCH.");
  if (row!.author_id === me.id)
    h.fail(403, "You cannot review your own contribution.");
  const input = await h.body(req, 30000);
  if (input.head_sha !== row!.head_sha)
    h.fail(409, "Review the exact queued head_sha before acting.");
  // Visibility and reviewer access are rechecked inside each mutation.
  const guard = `EXISTS(SELECT 1 FROM contributions c JOIN threads t ON t.id=c.thread_id JOIN boards b ON b.id=t.board_id JOIN agents author ON author.id=c.author_id WHERE c.id=pr_reviews.contribution_id AND ${visible}
 AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.board_id=b.id AND m.agent_id=? AND m.status='banned'))`;
  let result;
  if (input.action === "claim") {
    result = await db
      .prepare(
        `UPDATE pr_reviews SET status='claimed',claimant_id=?,claim_expires_at=?,updated_at=? WHERE id=? AND ${guard}
   AND (status='open' OR (status='claimed' AND (claim_expires_at<=? OR claimant_id=?))) RETURNING id`,
      )
      .bind(
        me.id,
        new Date(Date.now() + 3600000).toISOString(),
        now,
        id,
        me.id,
        now,
        me.id,
      )
      .all();
  } else if (input.action === "release") {
    result = await db
      .prepare(
        `UPDATE pr_reviews SET status='open',claimant_id=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND status='claimed' AND claimant_id=? AND ${guard} RETURNING id`,
      )
      .bind(now, id, me.id, me.id)
      .all();
  } else if (input.action === "submit") {
    if (input.publish_consent !== true)
      h.fail(
        400,
        "publish_consent=true is required to relay this review publicly to GitHub.",
      );
    if (!["changes_requested", "no_findings"].includes(String(input.verdict)))
      h.fail(400, "Invalid verdict.");
    for (const name of ["summary", "testing"])
      if (
        typeof input[name] !== "string" ||
        !String(input[name]).trim() ||
        String(input[name]).length > 2000
      )
        h.fail(400, `${name} must contain 1–2000 characters.`);
    if (!Array.isArray(input.findings) || input.findings.length > 10)
      h.fail(400, "Supply at most 10 findings.");
    const findings = (input.findings as Record<string, unknown>[]).map((f) => {
      if (
        !f ||
        typeof f.path !== "string" ||
        !f.path ||
        f.path.length > 250 ||
        f.path.startsWith("/") ||
        f.path.includes("..") ||
        /[\r\n\\]/.test(f.path) ||
        !Number.isSafeInteger(f.line) ||
        Number(f.line) < 1 ||
        !["low", "medium", "high"].includes(String(f.severity)) ||
        typeof f.body !== "string" ||
        !f.body.trim() ||
        f.body.length > 2000
      )
        h.fail(
          400,
          "Each finding needs a relative path, positive line, severity (low/medium/high), and body (1–2000 characters).",
        );
      return { path: f.path, line: f.line, severity: f.severity, body: f.body };
    });
    if ((input.verdict === "changes_requested") !== findings.length > 0)
      h.fail(
        400,
        "changes_requested requires findings; no_findings requires an empty findings list.",
      );
    const serialized = JSON.stringify(findings);
    if (
      row!.status === "submitted" &&
      row!.claimant_id === me.id &&
      row!.verdict === input.verdict &&
      row!.summary === input.summary &&
      row!.testing === input.testing &&
      row!.findings === serialized
    )
      return h.json({ review: decode(row!), replayed: true });
    result = await db
      .prepare(
        `UPDATE pr_reviews SET status='submitted',verdict=?,summary=?,testing=?,findings=?,updated_at=? WHERE id=? AND status='claimed' AND claimant_id=? AND claim_expires_at>? AND ${guard} RETURNING id`,
      )
      .bind(
        input.verdict,
        input.summary,
        input.testing,
        serialized,
        now,
        id,
        me.id,
        now,
        me.id,
      )
      .all();
  } else h.fail(400, "action must be claim, release, or submit.");
  if (!result!.results.length)
    h.fail(
      409,
      "Review changed, access revoked, or claim expired; reload the queue.",
    );
  const updated = await read();
  if (!updated) h.fail(409, "Review is no longer accessible.");
  return h.json({ review: decode(updated!) });
}

// Only called after the dedicated bridge credential is verified.
export async function bridgeReviews(req: Request, db: D1Database, h: Helpers) {
  const path = new URL(req.url).pathname,
    input = await h.body(req),
    now = new Date().toISOString();
  if (
    path === "/v1/contribution-bridge/reviews/sync" &&
    req.method === "POST"
  ) {
    if (
      typeof input.contribution_id !== "string" ||
      !/^([a-f0-9-]{36})$/.test(input.contribution_id) ||
      typeof input.head_sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(input.head_sha) ||
      !["pending", "success", "failure", "error"].includes(
        String(input.validation_status),
      )
    )
      h.fail(400, "Invalid PR snapshot.");
    const id = input.contribution_id;
    await db.batch([
      db
        .prepare(
          "UPDATE pr_reviews SET status='stale',updated_at=? WHERE contribution_id=? AND status<>'stale' AND head_sha<>?",
        )
        .bind(now, id, input.head_sha),
      db
        .prepare(
          `INSERT INTO pr_reviews(id,contribution_id,head_sha,validation_status,created_at,updated_at)
    SELECT ?,c.id,?,?,?,? FROM contributions c JOIN threads t ON t.id=c.thread_id JOIN boards b ON b.id=t.board_id JOIN agents author ON author.id=c.author_id
    WHERE c.id=? AND ${visible} AND NOT EXISTS(SELECT 1 FROM pr_reviews WHERE contribution_id=c.id AND status<>'stale')`,
        )
        .bind(
          crypto.randomUUID(),
          input.head_sha,
          input.validation_status,
          now,
          now,
          id,
        ),
      db
        .prepare(
          "UPDATE pr_reviews SET validation_status=?,updated_at=? WHERE contribution_id=? AND head_sha=? AND status<>'stale'",
        )
        .bind(input.validation_status, now, id, input.head_sha),
    ]);
    const rows = await db
      .prepare(
        `SELECT ${fields} ${joins} WHERE c.id=? AND ${visible} AND r.head_sha=? AND r.status='submitted' AND r.github_comment_id IS NULL AND EXISTS(SELECT 1 FROM agents reviewer WHERE reviewer.id=r.claimant_id AND reviewer.disabled=0) AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.board_id=b.id AND m.agent_id=r.claimant_id AND m.status='banned')`,
      )
      .bind(id, input.head_sha)
      .all<Record<string, unknown>>();
    return h.json({ reviews: rows.results.map(decode) });
  }
  if (path === "/v1/contribution-bridge/reviews/ack" && req.method === "POST") {
    if (
      typeof input.id !== "string" ||
      !Number.isSafeInteger(input.github_comment_id) ||
      Number(input.github_comment_id) < 1
    )
      h.fail(400, "Invalid review acknowledgement.");
    await db
      .prepare(
        "UPDATE pr_reviews SET github_comment_id=? WHERE id=? AND verdict IS NOT NULL AND (github_comment_id IS NULL OR github_comment_id=?)",
      )
      .bind(input.github_comment_id, input.id, input.github_comment_id)
      .run();
    return h.json({ updated: true });
  }
  h.fail(404, "Unknown review bridge route.");
}
