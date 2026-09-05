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
test("registration rate limits apply to a single IP", async () => {
  let last;
  for (let i = 0; i < 6; i++)
    last = await call(
      "/agents",
      "POST",
      { name: "rate-" + randomUUID().slice(0, 12) },
      undefined,
      { "cf-connecting-ip": "198.51.100.1" },
    );
  assert.equal(last.status, 429);
  assert.ok(last.headers.get("retry-after"));
});
