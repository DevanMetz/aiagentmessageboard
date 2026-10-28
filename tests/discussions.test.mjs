import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { localRuntime } from "./support/runtime.mjs";

let runtime,
  n = 0;
const keys = Object.fromEntries(
  ["owner", "reader", "writer", "outsider", "auditor"].map((name) => [
    name,
    "discussion-test-" + name,
  ]),
);
before(async () => {
  const seed =
    Object.entries(keys)
      .map(
        ([name, key]) =>
          `INSERT INTO agents(id,name,key_hash,is_admin,created_at) VALUES ('discussion-${name}','Discussion ${name}','${createHash("sha256").update(key).digest("hex")}',${name === "auditor" ? 1 : 0},'2026-01-01T00:00:00.000Z');`,
      )
      .join("\n") +
    `INSERT INTO boards(id,slug,name,description,visibility,join_mode,owner_id) VALUES ('discussion-board','discussion-board','Feature discussions','','public','open','discussion-owner'),('discussion-private','discussion-private','Private features','','private','invite','discussion-owner');
 INSERT INTO memberships(board_id,agent_id,role,status) VALUES ('discussion-board','discussion-owner','owner','active'),('discussion-private','discussion-owner','owner','active'),('discussion-private','discussion-reader','member','active'),('discussion-private','discussion-writer','member','active');`;
  runtime = await localRuntime({ port: 8823, seed });
});
after(() => runtime?.stop());
async function call(path, method = "GET", data, person = "owner", extra = {}) {
  const r = await fetch(runtime.base + "/v1" + path, {
    method,
    headers: {
      "cf-connecting-ip": `203.0.113.${++n}`,
      ...(person
        ? { Authorization: "Bearer " + (keys[person] || person) }
        : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: r.status, data: await r.json() };
}
async function thread(
  title,
  tags = [],
  board = "discussion-board",
  content = "A feature discussion",
) {
  const r = await call(`/boards/${board}/threads`, "POST", {
    title,
    content,
    tags,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.thread.id;
}
async function reply(
  id,
  content = "A helpful answer",
  person = "writer",
  extra = {},
) {
  const r = await call(
    `/threads/${id}/messages`,
    "POST",
    { content, ...extra },
    person,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.message.id;
}
async function mcp(name, args, token) {
  const r = await fetch(runtime.base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "cf-connecting-ip": `203.0.113.${++n}`,
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: n,
      method: name === "tools/list" ? "tools/list" : "tools/call",
      params: name === "tools/list" ? {} : { name, arguments: args },
    }),
  });
  const text = await r.text();
  return {
    status: r.status,
    data: JSON.parse(
      text.startsWith("event:")
        ? text
            .split("\n")
            .find((l) => l.startsWith("data:"))
            .slice(5)
        : text,
    ),
  };
}

test("tags and accepted answers support filters, author controls, and visibility changes", async () => {
  const id = await thread("Feature acceptance", [
    "Coding",
    "research",
    "coding",
  ]);
  let details = await call("/threads/" + id);
  assert.deepEqual(details.data.thread.tags, ["coding", "research"]);
  const root = details.data.messages[0].id;
  const answer = await reply(id);
  assert.equal(
    (
      await call(
        `/threads/${id}/answer`,
        "PUT",
        { message_id: answer },
        "outsider",
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(`/threads/${id}/answer`, "PUT", { message_id: root })).status,
    400,
  );
  assert.equal(
    (await call(`/threads/${id}/answer`, "PUT", { message_id: answer })).status,
    200,
  );
  details = await call(`/threads/${id}?after=${answer}`);
  assert.equal(details.data.messages.length, 0);
  assert.equal(details.data.accepted_answer.id, answer);
  assert.equal(details.data.thread.resolved, true);
  assert.ok(
    (
      await call("/boards/discussion-board/threads?status=resolved&tag=coding")
    ).data.threads.some((t) => t.id === id),
  );
  assert.ok(
    !(
      await call("/boards/discussion-board/threads?status=unanswered")
    ).data.threads.some((t) => t.id === id),
  );
  assert.ok(
    (
      await call("/search/messages?q=helpful&status=resolved&tag=research")
    ).data.messages.some((m) => m.id === answer),
  );
  const html = await (await fetch(runtime.base + "/t/" + id)).text();
  assert.match(html, /Accepted answer/);
  assert.match(html, /#coding/);
  assert.match(html, /A helpful answer/);
  assert.equal((await call(`/threads/${id}/answer`, "DELETE")).status, 200);
  assert.equal(
    (await call(`/threads/${id}/answer`)).data.accepted_message_id,
    null,
  );
  assert.equal(
    (await call(`/threads/${id}/answer`, "PUT", { message_id: answer })).status,
    200,
  );
  assert.equal(
    (await call(`/threads/${id}/tags`, "PUT", { tags: ["updated"] }, "writer"))
      .status,
    403,
  );
  assert.equal(
    (await call(`/threads/${id}/tags`, "PUT", { tags: ["updated"] })).status,
    200,
  );
  assert.equal((await call(`/messages/${answer}`, "DELETE")).status, 200);
  assert.equal((await call(`/threads/${id}`)).data.accepted_answer, null);
  assert.equal((await call(`/threads/${id}`)).data.thread.resolved, false);
  assert.equal(
    (await call("/boards/discussion-board/threads?status=bad")).status,
    400,
  );
});

test("tagged thread idempotency preserves payload identity and reply context remains atomic", async () => {
  const request = { "Idempotency-Key": randomUUID() },
    payload = {
      title: "Tagged retry",
      content: "Original tags",
      tags: ["research"],
    };
  const first = await call(
    "/boards/discussion-board/threads",
    "POST",
    payload,
    "owner",
    request,
  );
  assert.equal(first.status, 201);
  const replay = await call(
    "/boards/discussion-board/threads",
    "POST",
    payload,
    "owner",
    request,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.data.thread.id, first.data.thread.id);
  assert.equal(
    (
      await call(
        "/boards/discussion-board/threads",
        "POST",
        { ...payload, tags: ["coding"] },
        "owner",
        request,
      )
    ).status,
    409,
  );
  const id = first.data.thread.id,
    root = (await call("/threads/" + id)).data.messages[0].id;
  await reply(id, "New reply");
  const stale = await call(
    `/threads/${id}/messages`,
    "POST",
    {
      content: "@{Discussion reader} stale mention",
      last_seen_message_id: root,
    },
    "outsider",
  );
  assert.equal(stale.status, 409);
  assert.ok(
    !(
      await call("/notifications", "GET", undefined, "reader")
    ).data.notifications.some((x) => x.thread_id === id),
  );
});

test("unified inbox deduplicates mentions, replies and follows and syncs monotonic read positions", async () => {
  const id = await thread("Unified inbox"),
    root = (await call("/threads/" + id)).data.messages[0].id;
  await call(`/threads/${id}/subscription`, "PUT", {}, "reader");
  const post = await reply(
    id,
    "@{Discussion reader} here is an update",
    "writer",
    { reply_to: root },
  );
  let box = await call("/notifications?unread=1", "GET", undefined, "reader");
  assert.equal(box.status, 200, JSON.stringify(box.data));
  assert.equal(box.data.notifications.filter((x) => x.id === post).length, 1);
  assert.equal(box.data.notifications.find((x) => x.id === post).is_mention, 1);
  assert.ok(
    (
      await call("/notifications", "GET", undefined, "owner")
    ).data.notifications.some((x) => x.id === post && x.is_reply),
  );
  assert.equal(
    (
      await call(
        `/threads/${id}/read-state`,
        "PUT",
        { through: post },
        "reader",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/threads/${id}/read-state`,
        "PUT",
        { through: root },
        "reader",
      )
    ).data.last_read_message_id,
    post,
  );
  assert.equal(
    (await call(`/threads/${id}/read-state`, "GET", undefined, "reader")).data
      .last_read_message_id,
    post,
  );
  assert.ok(
    !(
      await call("/notifications?unread=1", "GET", undefined, "reader")
    ).data.notifications.some((x) => x.id === post),
  );
  assert.ok(
    !(
      await call("/subscriptions/messages?unread=1", "GET", undefined, "reader")
    ).data.messages.some((x) => x.id === post),
  );
  assert.ok(
    (
      await call("/subscriptions/messages", "GET", undefined, "reader")
    ).data.messages.some((x) => x.id === post),
  );
  const next = await reply(id, "Another update");
  box = await call("/notifications?limit=1", "GET", undefined, "reader");
  assert.equal(box.data.notifications[0].id, next);
  assert.ok(box.data.next_before);
  assert.ok(
    !(
      await call(`/notifications?before=${next}`, "GET", undefined, "reader")
    ).data.notifications.some((x) => x.id === next),
  );
  assert.equal(
    (await call("/notifications/read", "PUT", { through: next }, "reader"))
      .status,
    200,
  );
  assert.equal(
    (await call("/notifications/read", "PUT", { through: root }, "reader")).data
      .last_read_message_id,
    next,
  );
  assert.ok(
    !(
      await call("/subscriptions/messages?unread=1", "GET", undefined, "reader")
    ).data.messages.some((x) => x.id === next),
  );
  assert.equal(
    (
      await call(
        "/notifications/read",
        "PUT",
        { through: Number.MAX_SAFE_INTEGER },
        "reader",
      )
    ).status,
    400,
  );
  const other = await thread("Other read state");
  assert.equal(
    (
      await call(
        `/threads/${other}/read-state`,
        "PUT",
        { through: next },
        "reader",
      )
    ).status,
    400,
  );
});

test("mention notifications skip code and unknown accounts; private feeds recheck membership", async () => {
  const id = await thread(
    "Private tagged thread",
    ["private-topic"],
    "discussion-private",
    "Hello @{Discussion reader}",
  );
  assert.ok(
    (
      await call("/notifications", "GET", undefined, "reader")
    ).data.notifications.some((x) => x.thread_id === id),
  );
  assert.ok(
    !(
      await call("/notifications", "GET", undefined, "outsider")
    ).data.notifications.some((x) => x.thread_id === id),
  );
  assert.ok(
    !(await call("/topics", "GET", undefined, null)).data.topics.some(
      (t) => t.tag === "private-topic",
    ),
  );
  await call("/me/topics/private-topic", "PUT", {}, "reader");
  assert.ok(
    (await call("/topics/feed", "GET", undefined, "reader")).data.threads.some(
      (t) => t.id === id,
    ),
  );
  assert.ok(
    (
      await call(
        "/topics/threads?tag=private-topic",
        "GET",
        undefined,
        "reader",
      )
    ).data.threads.some((t) => t.id === id),
  );
  assert.ok(
    !(await call("/topics/threads?tag=private-topic", "GET", undefined, null))
      .data.threads.length,
  );
  const publicId = await thread(
    "Code is not a mention",
    [],
    "discussion-board",
    "`@{Discussion reader}` and https://example.org/@reader",
  );
  assert.ok(
    !(
      await call("/notifications", "GET", undefined, "reader")
    ).data.notifications.some((x) => x.thread_id === publicId),
  );
  await call("/boards/discussion-private/members/discussion-reader", "PATCH", {
    status: "banned",
  });
  assert.ok(
    !(
      await call("/notifications", "GET", undefined, "reader")
    ).data.notifications.some((x) => x.thread_id === id),
  );
  assert.ok(
    !(await call("/topics/feed", "GET", undefined, "reader")).data.threads.some(
      (t) => t.id === id,
    ),
  );
  assert.equal(
    (await call(`/threads/${id}/read-state`, "GET", undefined, "reader"))
      .status,
    404,
  );
});

test("topic follows, public browsing and answer filters work without exposing private counts", async () => {
  await call("/me/topics/research", "PUT", {}, "outsider");
  assert.ok(
    (await call("/me/topics", "GET", undefined, "outsider")).data.tags.includes(
      "research",
    ),
  );
  assert.ok(
    (await call("/topics/feed", "GET", undefined, "outsider")).data.threads
      .length,
  );
  assert.ok(
    (await call("/topics/threads?tag=research", "GET", undefined, null)).data
      .threads.length,
  );
  assert.equal(
    (await call("/topics/feed", "GET", undefined, null)).status,
    401,
  );
  assert.equal(
    (await call("/me/topics/bad%20tag", "PUT", {}, "outsider")).status,
    400,
  );
  await call("/me/topics/research", "DELETE", undefined, "outsider");
  assert.equal(
    (await call("/topics/feed", "GET", undefined, "outsider")).data.threads
      .length,
    0,
  );
});

test("MCP tokens grant only selected tools, preserve post idempotency, and revoke immediately", async () => {
  const created = await call(
    "/me/mcp-tokens",
    "POST",
    {
      name: "Integration client",
      scopes: [
        "boards:read",
        "threads:create",
        "messages:write",
        "subscriptions:write",
      ],
      expires_in_days: 1,
    },
    "writer",
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const token = created.data.token;
  assert.ok(
    !JSON.stringify(
      (await call("/me/mcp-tokens", "GET", undefined, "writer")).data,
    ).includes(token),
  );
  assert.equal((await call("/me", "GET", undefined, token)).status, 401);
  const tools = await mcp("tools/list", {}, token);
  assert.ok(
    tools.data.result.tools.some(
      (t) => t.name === "create_thread" && !t.annotations.readOnlyHint,
    ),
  );
  assert.equal(
    (
      await mcp("create_thread", {
        board: "discussion-board",
        title: "No credential",
        content: "No auth",
        request_id: randomUUID(),
      })
    ).status,
    401,
  );
  const args = {
    board: "discussion-private",
    title: "MCP private thread",
    content: "Created through MCP",
    tags: ["mcp"],
    request_id: randomUUID(),
  };
  const first = await mcp("create_thread", args, token);
  assert.equal(first.status, 200);
  assert.ok(!first.data.result.isError, JSON.stringify(first.data));
  const id = first.data.result.structuredContent.thread.id;
  const retry = await mcp("create_thread", args, token);
  assert.equal(retry.data.result.structuredContent.thread.id, id);
  assert.equal(retry.data.result.structuredContent.replayed, true);
  const replied = await mcp(
    "reply_to_thread",
    { thread_id: id, content: "A scoped reply", request_id: randomUUID() },
    token,
  );
  assert.ok(!replied.data.result.isError, JSON.stringify(replied.data));
  const followed = await mcp("follow_thread", { thread_id: id }, token);
  assert.equal(followed.data.result.structuredContent.subscribed, true);
  const read = await mcp("read_thread", { thread_id: id }, token);
  assert.equal(read.data.result.structuredContent.messages.length, 2);
  const filtered = await mcp(
    "search_discussions",
    { query: "MCP", tag: "mcp", status: "unanswered" },
    token,
  );
  assert.ok(
    filtered.data.result.structuredContent.threads.some((t) => t.id === id),
  );
  await call("/boards/discussion-private/members/discussion-writer", "PATCH", {
    status: "banned",
  });
  assert.equal(
    (await mcp("read_thread", { thread_id: id }, token)).data.result.isError,
    true,
  );
  assert.equal(
    (
      await mcp(
        "reply_to_thread",
        {
          thread_id: id,
          content: "Membership was revoked",
          request_id: randomUUID(),
        },
        token,
      )
    ).data.result.isError,
    true,
  );
  const limited = await call("/me/mcp-tokens", "POST", {
    name: "Reply only",
    scopes: ["messages:write"],
  });
  assert.equal(
    (await mcp("create_thread", args, limited.data.token)).status,
    403,
  );
  assert.equal(
    (await mcp("read_thread", { thread_id: id }, limited.data.token)).data
      .result.isError,
    true,
  );
  assert.equal(
    (
      await call(
        "/me/mcp-tokens/" + created.data.id,
        "DELETE",
        undefined,
        "outsider",
      )
    ).status,
    404,
  );
  await call(
    "/me/mcp-tokens/" + created.data.id,
    "DELETE",
    undefined,
    "writer",
  );
  assert.equal((await mcp("tools/list", {}, token)).status, 401);
  const privateReply = await call(
    "/me/mcp-tokens",
    "POST",
    { name: "Outsider", scopes: ["messages:write"] },
    "outsider",
  );
  assert.equal(
    (
      await mcp(
        "reply_to_thread",
        { thread_id: id, content: "Not allowed", request_id: randomUUID() },
        privateReply.data.token,
      )
    ).data.result.isError,
    true,
  );
  const origin = await fetch(runtime.base + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + limited.data.token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Origin: "https://untrusted.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(origin.status, 403);
});

test("MCP expiration, account suspension, key rotation and audit redaction are enforced", async () => {
  assert.equal(
    (
      await call("/me/mcp-tokens", "POST", {
        name: "Invalid scope",
        scopes: ["admin"],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/me/mcp-tokens", "POST", {
        name: "Invalid expiry",
        scopes: ["boards:read"],
        expires_in_days: 0,
      })
    ).status,
    400,
  );
  const payload = { name: "PRIVATE-TOKEN-LABEL", scopes: ["boards:read"] };
  const expired = await call("/me/mcp-tokens", "POST", payload, "outsider");
  assert.equal(expired.status, 201);
  runtime.command([
    "d1",
    "execute",
    "aiagentmessageboard",
    "--local",
    "--persist-to",
    runtime.persist,
    "--command",
    `UPDATE mcp_tokens SET expires_at=0 WHERE id='${expired.data.id}';`,
  ]);
  assert.equal((await mcp("tools/list", {}, expired.data.token)).status, 401);
  const disabled = await call("/me/mcp-tokens", "POST", payload, "outsider");
  assert.equal(disabled.status, 201);
  runtime.command([
    "d1",
    "execute",
    "aiagentmessageboard",
    "--local",
    "--persist-to",
    runtime.persist,
    "--command",
    "UPDATE agents SET disabled=1 WHERE id='discussion-outsider';",
  ]);
  assert.equal((await mcp("tools/list", {}, disabled.data.token)).status, 401);
  runtime.command([
    "d1",
    "execute",
    "aiagentmessageboard",
    "--local",
    "--persist-to",
    runtime.persist,
    "--command",
    "UPDATE agents SET disabled=0 WHERE id='discussion-outsider';",
  ]);
  assert.equal((await mcp("tools/list", {}, disabled.data.token)).status, 200);
  const rotation = await call("/me/key", "POST", {}, "outsider");
  assert.equal(rotation.status, 200);
  keys.outsider = rotation.data.api_key;
  assert.equal((await mcp("tools/list", {}, disabled.data.token)).status, 401);
  assert.ok(
    (
      await call("/me/mcp-tokens", "GET", undefined, "outsider")
    ).data.tokens.every((t) => t.revoked),
  );
  let events = [],
    after = 0;
  for (let page = 0; page < 10; page++) {
    const audit = await call(
      `/admin/audit?after=${after}&limit=100`,
      "GET",
      undefined,
      "auditor",
    );
    assert.equal(audit.status, 200);
    events.push(...audit.data.events);
    if (audit.data.events.length < 100) break;
    after = audit.data.next_after;
  }
  assert.ok(
    events.some(
      (e) => e.target_type === "mcp_token" && e.target_id === disabled.data.id,
    ),
  );
  const serialized = JSON.stringify(events);
  for (const value of [
    payload.name,
    expired.data.token,
    disabled.data.token,
    createHash("sha256").update(disabled.data.token).digest("hex"),
  ])
    assert.ok(!serialized.includes(value));
});
