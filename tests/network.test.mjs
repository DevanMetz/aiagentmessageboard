import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localRuntime } from "./support/runtime.mjs";
let runtime,
  ip = 0;
before(async () => {
  runtime = await localRuntime({ port: 8812 });
});
after(() => runtime?.stop());
async function call(path, method = "GET", body, key, headers = {}) {
  const res = await fetch(runtime.base + "/v1" + path, {
    method,
    headers: {
      "cf-connecting-ip": "198.51.100." + ++ip,
      ...(key ? { Authorization: "Bearer " + key } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}
async function agent() {
  const r = await call("/agents", "POST", {
    name: "network-" + randomUUID().slice(0, 25),
  });
  assert.equal(r.status, 201);
  return { id: r.data.agent.id, key: r.data.api_key };
}
async function thread(a, board = "general") {
  const r = await call(
    "/boards/" + board + "/threads",
    "POST",
    { title: "Network thread", content: "Original message" },
    a.key,
  );
  assert.equal(r.status, 201);
  return r.data.thread.id;
}

test("profiles are opt-in, searchable, bounded and never expose credentials", async () => {
  const a = await agent();
  assert.equal(
    (await call("/agents")).data.agents.some((p) => p.id === a.id),
    false,
  );
  assert.equal((await call("/me/profile")).status, 401);
  const profile = {
    capabilities: ["Databases", "Testing"],
    interests: ["SQLite"],
    website: "https://example.com/",
    contact_url: "https://example.com/agent",
  };
  const saved = await call("/me/profile", "PUT", profile, a.key);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.profile.capabilities, ["databases", "testing"]);
  const found = await call("/agents?q=sqlite&limit=1");
  assert.equal(found.status, 200);
  assert.ok(found.data.agents.some((p) => p.id === a.id));
  assert.ok(!JSON.stringify(found.data).includes(a.key));
  assert.ok(!JSON.stringify(found.data).includes("key_hash"));
  assert.equal(
    (await call("/agents/" + a.id + "/profile")).data.profile.contact_url,
    profile.contact_url,
  );
  assert.equal(
    (
      await call(
        "/me/profile",
        "PUT",
        { ...profile, website: "javascript:alert(1)" },
        a.key,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/me/profile",
        "PUT",
        { capabilities: Array(11).fill("x") },
        a.key,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/me/profile", "PUT", { capabilities: "not-an-array" }, a.key))
      .status,
    400,
  );
  const getSaved = await call(
    "/get/me/profile?capabilities=search,testing&interests=web&website=https%3A%2F%2Fexample.com",
    "GET",
    undefined,
    a.key,
  );
  assert.equal(getSaved.status, 200);
  assert.deepEqual(getSaved.data.profile.capabilities, ["search", "testing"]);
  assert.equal(getSaved.headers.get("cache-control"), "no-store");
  assert.equal((await call("/get/me/profile?capabilities=x")).status, 401);
  const visitor = await call("/visitor", "POST", {});
  const cookie = visitor.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await call("/me/profile", "PUT", profile, undefined, { Cookie: cookie }))
      .status,
    403,
  );
  assert.equal((await call("/agents?limit=0")).status, 400);
});

test("resource sharing upserts per author and URL, filters and enforces ownership", async () => {
  const a = await agent(),
    b = await agent();
  const payload = {
    url: "https://example.com/dataset",
    title: "Sample dataset",
    description: "A useful collection",
    kind: "dataset",
    tags: ["Science"],
    access: "API key required",
  };
  assert.equal((await call("/resources", "PUT", payload)).status, 401);
  const first = await call("/resources", "PUT", payload, a.key);
  assert.equal(first.status, 200);
  const id = first.data.resource.id;
  const replay = await call(
    "/resources",
    "PUT",
    { ...payload, title: "Updated dataset" },
    a.key,
  );
  assert.equal(replay.data.resource.id, id);
  assert.equal(
    (await call("/resources/" + id)).data.resource.title,
    "Updated dataset",
  );
  const found = await call("/resources?q=science&kind=dataset");
  assert.ok(found.data.resources.some((r) => r.id === id));
  assert.equal(found.data.resources[0].verified, false);
  assert.equal(
    (await call("/resources/" + id, "DELETE", undefined, b.key)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/resources",
        "PUT",
        { ...payload, url: "https://user:secret@example.com" },
        a.key,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/resources", "PUT", { ...payload, kind: "bad" }, a.key))
      .status,
    400,
  );
  assert.equal((await call("/resources?kind=bad")).status, 400);
  const q = new URLSearchParams({
    ...payload,
    tags: "science,open",
    url: "https://example.com/second",
  });
  const viaGet = await call("/get/resources?" + q, "GET", undefined, a.key);
  assert.equal(viaGet.status, 200);
  assert.equal(viaGet.headers.get("cache-control"), "no-store");
  assert.equal(
    (await call("/get/resources?" + q, "GET", undefined, a.key)).data.resource
      .id,
    viaGet.data.resource.id,
  );
  const page = await call("/resources?limit=1");
  assert.equal(page.data.resources.length, 1);
  assert.notEqual(page.data.next_offset, null);
  assert.equal(
    (await call("/resources/" + id, "DELETE", undefined, a.key)).status,
    200,
  );
  assert.equal((await call("/resources/" + id)).status, 404);
  assert.equal(
    (await call("/resources?q=Updated")).data.resources.some(
      (r) => r.id === id,
    ),
    false,
  );
  assert.equal(
    (
      await call(
        "/get/resources/" + viaGet.data.resource.id + "/delete",
        "GET",
        undefined,
        a.key,
      )
    ).status,
    200,
  );
});

test("subscriptions deliver only new accessible messages, paginate and retain positions on retries", async () => {
  const a = await agent(),
    b = await agent(),
    id = await thread(a),
    path = "/threads/" + id + "/subscription";
  assert.equal((await call("/subscriptions")).status, 401);
  assert.equal((await call("/subscriptions/messages")).status, 401);
  assert.equal((await call(path)).status, 401);
  assert.equal(
    (await call(path, "GET", undefined, b.key)).data.subscribed,
    false,
  );
  const followed = await call(
    "/get/threads/" + id + "/subscribe",
    "GET",
    undefined,
    b.key,
  );
  assert.equal(followed.status, 200);
  assert.equal(followed.data.subscribed, true);
  assert.equal(
    (await call("/subscriptions/messages", "GET", undefined, b.key)).data
      .messages.length,
    0,
  );
  const one = await call(
    "/threads/" + id + "/messages",
    "POST",
    { content: "New one" },
    a.key,
  );
  const two = await call(
    "/threads/" + id + "/messages",
    "POST",
    { content: "New two" },
    a.key,
  );
  const again = await call(path, "PUT", {}, b.key);
  assert.equal(
    again.data.subscription.since_message_id,
    followed.data.subscription.since_message_id,
  );
  const first = await call(
    "/subscriptions/messages?limit=1",
    "GET",
    undefined,
    b.key,
  );
  assert.equal(first.data.messages[0].id, one.data.message.id);
  assert.equal(first.data.has_more, true);
  const second = await call(
    "/subscriptions/messages?after=" + first.data.next_cursor,
    "GET",
    undefined,
    b.key,
  );
  assert.deepEqual(
    second.data.messages.map((m) => m.id),
    [two.data.message.id],
  );
  assert.equal(
    (await call("/subscriptions/messages", "GET", undefined, a.key)).data
      .messages.length,
    0,
  );
  assert.equal(
    (await call("/subscriptions", "GET", undefined, b.key)).data.subscriptions
      .length,
    1,
  );
  await call("/messages/" + two.data.message.id, "DELETE", undefined, a.key);
  assert.equal(
    (
      await call(
        "/subscriptions/messages?after=" + one.data.message.id,
        "GET",
        undefined,
        b.key,
      )
    ).data.messages.length,
    0,
  );
  const board = await call(
    "/boards",
    "POST",
    {
      name: "Private network",
      description: "Private",
      visibility: "private",
      join_mode: "invite",
    },
    a.key,
  );
  const privateId = await thread(a, board.data.board.id);
  assert.equal(
    (await call("/threads/" + privateId + "/subscription", "PUT", {}, b.key))
      .status,
    404,
  );
  const invite = await call(
    "/boards/" + board.data.board.id + "/invites",
    "POST",
    {},
    a.key,
  );
  assert.equal(
    (
      await call(
        "/boards/" + board.data.board.id + "/join",
        "POST",
        { invite_token: invite.data.invite_token },
        b.key,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/threads/" + privateId + "/subscription", "PUT", {}, b.key))
      .status,
    200,
  );
  await call(
    "/threads/" + privateId + "/messages",
    "POST",
    { content: "Private update" },
    a.key,
  );
  assert.ok(
    (
      await call("/subscriptions/messages", "GET", undefined, b.key)
    ).data.messages.some((m) => m.thread_id === privateId),
  );
  await call(
    "/boards/" + board.data.board.id + "/members/" + b.id,
    "PATCH",
    { status: "banned" },
    a.key,
  );
  assert.ok(
    !(
      await call("/subscriptions/messages", "GET", undefined, b.key)
    ).data.messages.some((m) => m.thread_id === privateId),
  );
  assert.ok(
    !(
      await call("/subscriptions", "GET", undefined, b.key)
    ).data.subscriptions.some((s) => s.thread_id === privateId),
  );
  assert.equal(
    (
      await call(
        "/threads/" + privateId + "/subscription",
        "DELETE",
        undefined,
        b.key,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/get/threads/" + id + "/unsubscribe", "GET", undefined, b.key))
      .data.subscribed,
    false,
  );
  assert.equal(
    (await call("/subscriptions/messages", "GET", undefined, b.key)).data
      .messages.length,
    0,
  );
  assert.equal(
    (await call("/subscriptions/messages?after=-1", "GET", undefined, b.key))
      .status,
    400,
  );
});
