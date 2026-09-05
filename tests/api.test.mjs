import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

const base = "http://127.0.0.1:8799",
  persist = ".wrangler/test-" + randomUUID();
let server,
  output = "",
  ipCounter = 0;
const wrangler = "node_modules/wrangler/bin/wrangler.js";
before(async () => {
  mkdirSync(persist, { recursive: true });
  execFileSync(
    process.execPath,
    [
      wrangler,
      "d1",
      "migrations",
      "apply",
      "aiagentmessageboard",
      "--local",
      "--persist-to",
      persist,
    ],
    { stdio: "pipe" },
  );
  server = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--port",
      "8799",
      "--ip",
      "127.0.0.1",
      "--persist-to",
      persist,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (d) => (output += d));
  server.stderr.on("data", (d) => (output += d));
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(base + "/v1/health");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Test server did not start: " + output);
});
after(() => {
  if (server) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {}
    } else server.kill();
  }
});
async function call(path, method = "GET", body, key, extra = {}) {
  const res = await fetch(base + "/v1" + path, {
    method,
    headers: {
      "cf-connecting-ip": `192.0.2.${++ipCounter}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key ? { Authorization: "Bearer " + key } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}
let n = 0;
async function agent() {
  const r = await call("/agents", "POST", { name: "test-agent-" + ++n });
  assert.equal(r.status, 201);
  return { key: r.data.api_key, id: r.data.agent.id };
}
async function makeBoard(a, mode = "invite") {
  const r = await call(
    "/boards",
    "POST",
    {
      name: "Private lab",
      slug: "lab-" + randomUUID(),
      description: "Test space",
      visibility: "private",
      join_mode: mode,
      ...(mode === "password" ? { password: "a-long-test-password" } : {}),
    },
    a.key,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.board;
}
test("public reads work; posting and board creation require authentication", async () => {
  const r = await call("/boards");
  assert.equal(r.status, 200);
  assert.equal(r.data.boards.length, 4);
  assert.ok(r.data.boards.every((b) => !("password_hash" in b)));
  assert.equal(
    (
      await call("/boards/general/threads", "POST", {
        title: "Hello",
        content: "World",
      })
    ).status,
    401,
  );
  assert.equal((await call("/boards", "POST", {})).status, 401);
  assert.equal((await call("/me", "GET", undefined, "invalid")).status, 401);
});
test("registration enforces unique names and does not reveal key hashes", async () => {
  const a = await agent();
  assert.match(a.key, /^amb_[a-f0-9]{64}$/);
  const me = await call("/me", "GET", undefined, a.key);
  assert.ok(!("key_hash" in me.data.agent));
  const dup = await call("/agents", "POST", {
    name: me.data.agent.name.toUpperCase(),
  });
  assert.equal(dup.status, 409);
});
test("private boards are absent from listings, search, direct reads, threads and feeds for outsiders", async () => {
  const owner = await agent(),
    other = await agent(),
    b = await makeBoard(owner);
  const t = await call(
    `/boards/${b.id}/threads`,
    "POST",
    { title: "Secret title", content: "Secret content" },
    owner.key,
  );
  assert.equal(t.status, 201);
  for (const key of [undefined, other.key]) {
    const list = await call("/boards?q=Private", "GET", undefined, key);
    assert.ok(!list.data.boards.some((x) => x.id === b.id));
    for (const path of [
      `/boards/${b.id}`,
      `/boards/${b.id}/threads`,
      `/boards/${b.id}/messages`,
      `/threads/${t.data.thread.id}`,
    ])
      assert.equal((await call(path, "GET", undefined, key)).status, 404, path);
  }
  assert.equal(
    (await call(`/boards/${b.id}`, "GET", undefined, owner.key)).status,
    200,
  );
});
test("password joining, wrong secrets, revocation, and attempted rejoining", async () => {
  const owner = await agent(),
    member = await agent(),
    b = await makeBoard(owner, "password");
  assert.equal(
    (
      await call(
        `/boards/${b.id}/join`,
        "POST",
        { password: "wrong" },
        member.key,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/boards/${b.id}/join`,
        "POST",
        { password: "a-long-test-password" },
        member.key,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/boards/${b.id}/messages`, "GET", undefined, member.key))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        `/boards/${b.id}/members/${member.id}`,
        "PATCH",
        { status: "banned" },
        owner.key,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/boards/${b.id}/messages`, "GET", undefined, member.key))
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        `/boards/${b.id}/join`,
        "POST",
        { password: "a-long-test-password" },
        member.key,
      )
    ).status,
    403,
  );
});
test("single-use invitation admits exactly one member, including concurrent joins", async () => {
  const owner = await agent(),
    m1 = await agent(),
    m2 = await agent(),
    b = await makeBoard(owner);
  const invite = await call(`/boards/${b.id}/invites`, "POST", {}, owner.key);
  assert.equal(invite.status, 201);
  const results = await Promise.all(
    [m1, m2].map((m) =>
      call(
        `/boards/${b.id}/join`,
        "POST",
        { invite_token: invite.data.invite_token },
        m.key,
      ),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
  const members = await call(
    `/boards/${b.id}/members`,
    "GET",
    undefined,
    owner.key,
  );
  assert.equal(members.data.members.length, 2);
});
test("posting supports idempotency and ordered pagination without duplicates", async () => {
  const a = await agent(),
    b = await makeBoard(a),
    payload = {
      title: "A new thread",
      content: "First",
      metadata: { kind: "finding" },
    },
    header = { "Idempotency-Key": "thread-1" };
  const t = await call(
    `/boards/${b.id}/threads`,
    "POST",
    payload,
    a.key,
    header,
  );
  assert.equal(t.status, 201);
  const replay = await call(
    `/boards/${b.id}/threads`,
    "POST",
    payload,
    a.key,
    header,
  );
  assert.equal(replay.data.thread.id, t.data.thread.id);
  assert.equal(
    (
      await call(
        `/boards/${b.id}/threads`,
        "POST",
        { ...payload, content: "Different" },
        a.key,
        header,
      )
    ).status,
    409,
  );
  const path = `/threads/${t.data.thread.id}/messages`,
    h = { "Idempotency-Key": "reply-1" };
  const r = await call(path, "POST", { content: "Second" }, a.key, h);
  assert.equal(r.status, 201);
  assert.equal(
    (await call(path, "POST", { content: "Second" }, a.key, h)).data.message.id,
    r.data.message.id,
  );
  const page = await call(
    `/boards/${b.id}/messages?limit=1`,
    "GET",
    undefined,
    a.key,
  );
  assert.equal(page.data.has_more, true);
  assert.equal(page.data.messages[0].content, "First");
  assert.deepEqual(page.data.messages[0].metadata, { kind: "finding" });
  const next = await call(
    `/boards/${b.id}/messages?after=${page.data.next_cursor}`,
    "GET",
    undefined,
    a.key,
  );
  assert.equal(next.data.messages.length, 1);
  assert.equal(next.data.messages[0].content, "Second");
  assert.equal(
    (await call(`/boards/${b.id}/messages?after=-1`, "GET", undefined, a.key))
      .status,
    400,
  );
});
test("member cannot moderate or change settings; owner soft-deletes content", async () => {
  const owner = await agent(),
    member = await agent(),
    b = await makeBoard(owner, "password");
  await call(
    `/boards/${b.id}/join`,
    "POST",
    { password: "a-long-test-password" },
    member.key,
  );
  for (const [p, method] of [
    [`/boards/${b.id}`, "PATCH"],
    [`/boards/${b.id}/invites`, "POST"],
    [`/boards/${b.id}/members`, "GET"],
  ])
    assert.equal(
      (await call(p, method, method === "GET" ? undefined : {}, member.key))
        .status,
      403,
    );
  const t = await call(
    `/boards/${b.id}/threads`,
    "POST",
    { title: "Moderate me", content: "Message" },
    member.key,
  );
  assert.equal(
    (await call(`/threads/${t.data.thread.id}`, "DELETE", undefined, owner.key))
      .status,
    200,
  );
  assert.equal(
    (await call(`/threads/${t.data.thread.id}`, "GET", undefined, member.key))
      .status,
    404,
  );
  assert.equal(
    (await call(`/boards/${b.id}/messages`, "GET", undefined, member.key)).data
      .messages.length,
    0,
  );
});
test("sessions use HttpOnly cookies; rotation revokes old key and sessions", async () => {
  const a = await agent(),
    s = await call("/session", "POST", { api_key: a.key });
  assert.equal(s.status, 200);
  const cookie = s.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const header = { cookie: cookie.split(";")[0] };
  assert.equal(
    (await call("/me", "GET", undefined, undefined, header)).data.agent.id,
    a.id,
  );
  const rotated = await call("/me/key", "POST", {}, a.key);
  assert.equal(rotated.status, 200);
  assert.equal((await call("/me", "GET", undefined, a.key)).status, 401);
  assert.equal(
    (await call("/me", "GET", undefined, undefined, header)).data.agent,
    null,
  );
  assert.equal(
    (await call("/me", "GET", undefined, rotated.data.api_key)).status,
    200,
  );
});
test("cross-origin browser writes, invalid JSON, huge payloads, and SQL injection fail safely", async () => {
  const a = await agent();
  assert.equal(
    (
      await call(
        "/boards/general/threads",
        "POST",
        { title: "Blocked", content: "Test" },
        a.key,
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/boards/general/threads",
        "POST",
        { title: "Huge", content: "x".repeat(25000) },
        a.key,
      )
    ).status,
    413,
  );
  const r = await fetch(base + "/v1/boards/general/threads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + a.key,
    },
    body: "{invalid",
  });
  assert.equal(r.status, 400);
  assert.equal(
    (await call("/boards?q=" + encodeURIComponent("' OR 1=1 --"))).data.boards
      .length,
    0,
  );
});
test("message allowance is shared by new threads and replies without blocking reads", async () => {
  const a = await agent();
  const first = await call(
    "/boards/general/threads",
    "POST",
    {
      title: "Message allowance",
      content: "First message",
    },
    a.key,
  );
  assert.equal(first.status, 201);
  const path = `/threads/${first.data.thread.id}/messages`;
  for (let i = 0; i < 9; i++) {
    assert.equal(
      (await call(path, "POST", { content: `Reply ${i}` }, a.key)).status,
      201,
    );
  }
  const blocked = await call(
    path,
    "POST",
    { content: "Over allowance" },
    a.key,
  );
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
  assert.equal(
    (await call(`/threads/${first.data.thread.id}`, "GET", undefined, a.key))
      .status,
    200,
  );
});

test("search paginates and protects private and deleted content", async () => {
  const owner = await agent(),
    outsider = await agent();
  const b = await makeBoard(owner);
  const term = "needle" + randomUUID();
  await call(`/boards/${b.id}`, "PATCH", { name: term }, owner.key);
  const first = await call(
    `/boards/${b.id}/threads`,
    "POST",
    { title: term, content: term, metadata: { found: true } },
    owner.key,
  );
  const tid = first.data.thread.id;
  const reply = await call(
    `/threads/${tid}/messages`,
    "POST",
    { content: term },
    owner.key,
  );
  for (const kind of ["boards", "threads", "messages"]) {
    const path = `/search/${kind}?q=${term.toUpperCase()}`;
    assert.equal((await call(path)).data[kind].length, 0);
    assert.equal(
      (await call(path, "GET", undefined, outsider.key)).data[kind].length,
      0,
    );
    assert.ok(
      (await call(path, "GET", undefined, owner.key)).data[kind].length > 0,
    );
    assert.equal((await call(path + `&board=${b.id}`)).status, 404);
    assert.equal((await call(`/search/${kind}?q=`)).status, 400);
    assert.equal((await call(path + "&offset=-1")).status, 400);
  }
  const path = `/search/messages?q=${term}&board=${b.id}&limit=1`;
  const page = await call(path, "GET", undefined, owner.key);
  assert.equal(page.data.messages[0].id, reply.data.message.id);
  assert.equal(page.data.next_offset, 1);
  const next = await call(path + "&offset=1", "GET", undefined, owner.key);
  assert.deepEqual(next.data.messages[0].metadata, { found: true });
  assert.equal(next.data.next_offset, null);
  await call(
    `/messages/${reply.data.message.id}`,
    "DELETE",
    undefined,
    owner.key,
  );
  assert.equal(
    (await call(path, "GET", undefined, owner.key)).data.next_offset,
    null,
  );
  await call(`/threads/${tid}`, "DELETE", undefined, owner.key);
  assert.equal(
    (await call(path, "GET", undefined, owner.key)).data.messages.length,
    0,
  );
  assert.equal(
    (await call(`/search/threads?q=${term}`, "GET", undefined, owner.key)).data
      .threads.length,
    0,
  );
  assert.equal((await call("/search/boards?q=%25")).data.boards.length, 0);
});

test("board addresses are generated from names and distinguish duplicate names", async () => {
  const a = await agent();
  const create = (name) =>
    call("/boards", "POST", { name, description: "" }, a.key);
  const first = await create("Café Research!");
  const second = await create("Café Research!");
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.match(first.data.board.slug, /^cafe-research-[a-f0-9]{12}$/);
  assert.notEqual(first.data.board.slug, second.data.board.slug);
  assert.equal((await call(`/boards/${first.data.board.slug}`)).status, 200);
  assert.equal((await create("研究")).status, 201);
});

test("anonymous read cache is never reused for authenticated or cookie-bearing requests", async () => {
  const a = await agent();
  const path = `/boards/general?cache-test=${randomUUID()}`;
  const first = await call(path);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-cache"), "MISS");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await call(path);
  assert.equal(second.headers.get("x-cache"), "HIT");
  assert.equal(second.headers.get("cache-control"), "no-store");
  const authenticated = await call(path, "GET", undefined, a.key);
  assert.equal(authenticated.headers.get("x-cache"), null);
  const cookie = await call(path, "GET", undefined, undefined, {
    cookie: "amb_session=invalid",
  });
  assert.equal(cookie.headers.get("x-cache"), null);
  assert.equal(
    (await call("/admin/usage", "GET", undefined, a.key)).status,
    403,
  );
});

test("registration rate limits apply to a single IP", async () => {
  let last;
  for (let i = 0; i < 51; i++) {
    last = await call(
      "/agents",
      "POST",
      { name: "rate-" + randomUUID().slice(0, 12) },
      undefined,
      { "cf-connecting-ip": "198.51.100.1" },
    );
    if (i < 50) assert.equal(last.status, 201);
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"));
});

test("visitors automatically receive persistent accounts and returning cookies retain identity", async () => {
  const first = await call("/visitor", "POST", {});
  assert.equal(first.status, 201);
  assert.equal(first.data.created, true);
  assert.equal(first.data.agent.is_visitor, true);
  assert.equal(first.data.agent.has_api_key, false);
  assert.equal(first.data.agent.is_admin, false);
  assert.ok(!("api_key" in first.data));
  assert.ok(!("key_hash" in first.data.agent));
  const cookie = first.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=31536000/);
  const headers = { cookie: cookie.split(";")[0] };
  const again = await call("/visitor", "POST", {}, undefined, headers);
  assert.equal(again.status, 200);
  assert.equal(again.data.created, false);
  assert.equal(again.data.agent.id, first.data.agent.id);
  const separate = await call("/visitor", "POST", {});
  assert.notEqual(separate.data.agent.id, first.data.agent.id);
  assert.equal(
    (await call("/me", "GET", undefined, undefined, headers)).data.agent.id,
    first.data.agent.id,
  );
});

test("automatic visitor initialization preserves connected agent accounts", async () => {
  const a = await agent();
  const login = await call("/session", "POST", { api_key: a.key });
  const r = await call("/visitor", "POST", {}, undefined, {
    cookie: login.headers.get("set-cookie").split(";")[0],
  });
  assert.equal(r.data.created, false);
  assert.equal(r.data.agent.id, a.id);
  assert.equal(r.data.agent.is_visitor, false);
  assert.equal(r.headers.get("set-cookie"), null);
});

test("visitor cookies can post and create private boards without registration", async () => {
  const visitor = await call("/visitor", "POST", {});
  const headers = { cookie: visitor.headers.get("set-cookie").split(";")[0] };
  const b = await call(
    "/boards",
    "POST",
    {
      name: "Visitor Lab",
      slug: "visitor-" + randomUUID(),
      description: "Private visitor space",
      visibility: "private",
      join_mode: "invite",
    },
    undefined,
    headers,
  );
  assert.equal(b.status, 201);
  const t = await call(
    `/boards/${b.data.board.id}/threads`,
    "POST",
    { title: "Visitor conversation", content: "No signup required." },
    undefined,
    headers,
  );
  assert.equal(t.status, 201);
  const detail = await call(
    `/threads/${t.data.thread.id}`,
    "GET",
    undefined,
    undefined,
    headers,
  );
  assert.equal(detail.data.messages[0].author_is_visitor, 1);
  assert.equal((await call(`/threads/${t.data.thread.id}`)).status, 404);
});

test("visitors can rename and save an access key to restore the same account", async () => {
  const visitor = await call("/visitor", "POST", {});
  const headers = { cookie: visitor.headers.get("set-cookie").split(";")[0] };
  const name = "Named visitor " + randomUUID().slice(0, 8);
  const profile = await call(
    "/me",
    "PATCH",
    { name, bio: "About me", is_admin: 1 },
    undefined,
    headers,
  );
  assert.equal(profile.status, 200);
  assert.equal(profile.data.agent.name, name);
  assert.equal(profile.data.agent.is_admin, false);
  const key = await call("/me/key", "POST", {}, undefined, headers);
  assert.equal(key.status, 200);
  assert.equal(
    (await call("/me", "GET", undefined, undefined, headers)).data.agent,
    null,
  );
  const restored = await call("/session", "POST", {
    api_key: key.data.api_key,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.agent.id, visitor.data.agent.id);
  assert.equal(restored.data.agent.name, name);
  assert.equal(restored.data.agent.has_api_key, true);
});

test("public HTML and sitemap expose public content but never private names or messages", async () => {
  const a = await agent(),
    b = await makeBoard(a);
  const privateThread = await call(
    `/boards/${b.id}/threads`,
    "POST",
    { title: "Secret crawl title", content: "Hidden crawl content" },
    a.key,
  );
  const sitemap = await (await fetch(base + "/sitemap.xml")).text();
  assert.ok(sitemap.includes("/b/general"));
  assert.ok(sitemap.includes("/t/welcome"));
  assert.ok(!sitemap.includes(b.slug));
  assert.ok(!sitemap.includes(privateThread.data.thread.id));
  const publicHtml = await (await fetch(base + "/t/welcome")).text();
  assert.ok(publicHtml.includes("This is a shared space for AI agents"));
  assert.ok(publicHtml.includes('rel="canonical"'));
  for (const path of ["/b/" + b.slug, "/t/" + privateThread.data.thread.id]) {
    const response = await fetch(base + path, {
      headers: { Authorization: "Bearer " + a.key },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
    const html = await response.text();
    assert.ok(!html.includes("Secret crawl title"));
    assert.ok(!html.includes("Hidden crawl content"));
    assert.ok(!html.includes(b.name));
  }
});

test("skill is publicly readable without creating an account and public HTML escapes message markup", async () => {
  const skill = await fetch(base + "/skill.md");
  assert.equal(skill.status, 200);
  assert.equal(skill.headers.get("set-cookie"), null);
  assert.match(await skill.text(), /^---\s+name: agent-message-board/);
  const a = await agent();
  const t = await call(
    "/boards/general/threads",
    "POST",
    {
      title: "A <script>bad()</script> title",
      content: "<img src=x onerror=alert(1)>",
    },
    a.key,
  );
  const html = await (await fetch(base + "/t/" + t.data.thread.id)).text();
  assert.ok(html.includes("&lt;img"));
  // Angle brackets are valid inside a quoted meta-description attribute;
  // the visible message must never turn into an actual image element.
  assert.ok(!html.slice(html.indexOf("<body")).includes("<img src=x"));
  assert.ok(!html.includes("<script>bad()"));
});

test("analytics counts activity, fills missing days, and isolates private boards", async () => {
  const owner = await agent(),
    outsider = await agent();
  const b = await makeBoard(owner);
  const empty = await call(
    `/analytics?board=${b.id}&days=7`,
    "GET",
    undefined,
    owner.key,
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.data.daily.length, 7);
  assert.deepEqual(empty.data.totals, {
    boards: 1,
    threads: 0,
    messages: 0,
    participants: 0,
  });
  const post = await call(
    `/boards/${b.id}/threads`,
    "POST",
    { title: "Metrics check", content: "Opening message" },
    owner.key,
  );
  assert.equal(post.status, 201);
  const stats = await call(
    `/analytics?board=${b.slug}&days=30`,
    "GET",
    undefined,
    owner.key,
  );
  assert.deepEqual(stats.data.totals, {
    boards: 1,
    threads: 1,
    messages: 1,
    participants: 1,
  });
  assert.equal(
    stats.data.daily.reduce((sum, d) => sum + d.messages, 0),
    1,
  );
  assert.equal(stats.data.boards[0].id, b.id);
  for (const key of [undefined, outsider.key]) {
    assert.equal(
      (await call(`/analytics?board=${b.id}`, "GET", undefined, key)).status,
      404,
    );
    const global = await call("/analytics", "GET", undefined, key);
    assert.ok(!global.data.boards.some((row) => row.id === b.id));
  }
  assert.equal((await call("/analytics?days=100000")).status, 400);
  assert.equal((await call("/analytics?days=no")).status, 400);
});

test("analytics supports hourly through monthly graphs with consistent private counts", async () => {
  const owner = await agent();
  const b = await makeBoard(owner);
  await call(
    `/boards/${b.id}/threads`,
    "POST",
    { title: "Graph counts", content: "One" },
    owner.key,
  );
  await call(
    `/boards/${b.id}/threads`,
    "POST",
    { title: "Graph counts two", content: "Two" },
    owner.key,
  );
  for (const [range, buckets, seconds] of [
    ["1h", 12, 300],
    ["1d", 24, 3600],
    ["1w", 7, 86400],
    ["1m", 30, 86400],
  ]) {
    const r = await call(
      `/analytics?range=${range}&board=${b.id}`,
      "GET",
      undefined,
      owner.key,
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.daily.length, buckets);
    assert.equal(r.data.bucket_seconds, seconds);
    assert.equal(
      Date.parse(r.data.until) - Date.parse(r.data.since),
      buckets * seconds * 1000,
    );
    assert.equal(r.data.totals.messages, 2);
    assert.equal(r.data.totals.participants, 1);
    assert.equal(
      r.data.daily.reduce((sum, row) => sum + row.messages, 0),
      2,
    );
    assert.equal(r.data.daily.at(-1).participants, 1);
    assert.equal(
      (await call(`/analytics?range=${range}&board=${b.id}`)).status,
      404,
    );
  }
  assert.equal((await call("/analytics?range=1year")).status, 400);
});
