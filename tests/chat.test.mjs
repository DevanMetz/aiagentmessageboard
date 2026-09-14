import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { ChatClient } from "../scripts/chat-client.mjs";
import { localRuntime } from "./support/runtime.mjs";
import { createChatKey, unlockChatKey, registrationFor, encryptChatMessage, decryptChatMessage,
  checkPinnedIdentities } from "../shared/chat-crypto.ts";

let runtime, counter = 0;
before(async () => { runtime = await localRuntime({ port: 8806 }); });
after(() => runtime?.stop());
async function call(path, method = "GET", data, actor) {
  const res = await fetch(runtime.base + "/v1" + path, { method,
    headers: { "cf-connecting-ip": `192.0.${Math.floor(++counter / 250)}.${counter % 250 + 1}`,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(actor ? { Authorization: "Bearer " + actor.apiKey } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: res.status, data: await res.json(), headers: res.headers };
}
async function actor() {
  const registered = await call("/agents", "POST", { name: "chat-test-" + randomUUID().slice(0, 8) });
  assert.equal(registered.status, 201);
  const id = registered.data.agent.id, passphrase = "local-only-encryption-test-" + randomUUID();
  const backup = await createChatKey(id, passphrase), key = await unlockChatKey(backup, passphrase, id);
  const user = { id, apiKey: registered.data.api_key, backup, key, passphrase };
  const enrolled = await call("/chat/keys/me", "POST", await registrationFor(key), user);
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.data));
  return user;
}
async function create(owner, targets, kind = "dm") {
  const r = await call("/chat/conversations", "POST", { kind, member_ids: targets.map(x => x.id) }, owner);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.conversation.id;
}
async function accept(cid, user) {
  const r = await call(`/chat/conversations/${cid}/accept`, "POST", {}, user);
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function envelope(cid, user, content, clientId) {
  const r = await call(`/chat/conversations/${cid}`, "GET", undefined, user);
  assert.equal(r.status, 200);
  return encryptChatMessage({ conversationId: cid, revision: r.data.conversation.revision, content,
    identities: r.data.members.filter(m => m.status === "active"), sender: user.key, clientId });
}

test("key ownership, immutable identities, local recovery, and authenticated discovery", async () => {
  for (const path of ["/chat/keys/me", "/chat/people?q=test", "/chat/conversations", "/chat/blocks"])
    assert.equal((await call(path)).status, 401);
  const a = await actor(), b = await actor();
  assert.equal((await call("/chat/keys/me", "POST", await registrationFor(a.key), a)).status, 200);
  assert.equal((await call("/chat/keys/me", "POST", { ...await registrationFor(b.key), agent_id: a.id }, a)).status, 400);
  const other = await createChatKey(a.id, "another-local-only-passphrase");
  const otherKey = await unlockChatKey(other, "another-local-only-passphrase", a.id);
  assert.equal((await call("/chat/keys/me", "POST", await registrationFor(otherKey), a)).status, 409);
  assert.equal((await call("/chat/keys/me", "POST", { ...await registrationFor(a.key), private_key: a.backup.private_key }, a)).status, 400);
  await assert.rejects(unlockChatKey(a.backup, "incorrect passphrase", a.id));
  await assert.rejects(unlockChatKey(a.backup, "any-passphrase", b.id));
  assert.throws(() => checkPinnedIdentities([other], { [a.id]: a.backup.fingerprint }), /key changed/);
  const directory = await call(`/chat/people?q=${b.id}`, "GET", undefined, a);
  assert.equal(directory.data.people[0].agent_id, b.id);
  assert.equal(directory.headers.get("cache-control"), "no-store");
});

test("DM request consent, ciphertext-only storage, signatures, unread state, pagination and retries", async () => {
  const a = await actor(), b = await actor(), outsider = await actor();
  const cid = await create(a, [b]);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "GET", undefined, b)).status, 403);
  assert.equal((await call(`/chat/conversations/${cid}`, "GET", undefined, outsider)).status, 404);
  runtime.command(["d1", "execute", "aiagentmessageboard", "--local", "--persist-to", runtime.persist,
    "--command", `UPDATE agents SET is_admin=1 WHERE id='${outsider.id}'`]);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "GET", undefined, outsider)).status, 404);
  await accept(cid, b);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", { content: "plaintext is forbidden" }, a)).status, 400);
  const secret = "This message must never be stored as plaintext.";
  const first = await envelope(cid, a, secret);
  const posted = await call(`/chat/conversations/${cid}/messages`, "POST", first, a);
  if (posted.status !== 201) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(posted.status, 201, JSON.stringify(posted.data) + runtime.output());
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", first, a)).data.message.id, posted.data.message.id);
  assert.equal(await decryptChatMessage(first, a.key.identity, b.key), secret);
  await assert.rejects(decryptChatMessage(first, a.key.identity, outsider.key));
  await assert.rejects(decryptChatMessage({ ...first, conversation_id: randomUUID() }, a.key.identity, b.key));
  const forged = { ...first, client_id: randomUUID() };
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", forged, a)).status, 400);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", first, b)).status, 403);
  const changed = await envelope(cid, a, "Different content", first.client_id);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", changed, a)).status, 409);
  let inbox = await call("/chat/conversations", "GET", undefined, b);
  assert.equal(inbox.data.conversations.find(x => x.id === cid).unread_count, 1);
  const read = await call(`/chat/conversations/${cid}/messages`, "GET", undefined, b);
  assert.equal(read.data.messages.length, 1);
  assert.ok(!JSON.stringify(read.data).includes(secret));
  const second = await call(`/chat/conversations/${cid}/messages`, "POST", await envelope(cid, b, "A signed reply"), b);
  assert.equal(second.status, 201);
  const page1 = await call(`/chat/conversations/${cid}/messages?limit=1`, "GET", undefined, b);
  assert.equal(page1.data.has_more, true);
  const page2 = await call(`/chat/conversations/${cid}/messages?after=${page1.data.next_after}&limit=1`, "GET", undefined, b);
  assert.equal(page2.data.messages[0].id, second.data.message.id);
  await call(`/chat/conversations/${cid}/read`, "POST", { after: page2.data.next_after }, b);
  inbox = await call("/chat/conversations", "GET", undefined, b);
  assert.equal(inbox.data.conversations.find(x => x.id === cid).unread_count, 0);
  const audit = await call("/admin/audit?limit=100", "GET", undefined, outsider);
  assert.ok(!JSON.stringify(audit.data).includes(secret));
  assert.ok(!JSON.stringify(audit.data).includes("BEGIN PGP"));
  const count = JSON.parse(runtime.command(["d1", "execute", "aiagentmessageboard", "--local", "--persist-to", runtime.persist,
    "--json", "--command", `SELECT count(*) found FROM chat_messages WHERE ciphertext LIKE '%This message must never%'`]))[0].results[0].found;
  assert.equal(count, 0);
});

test("groups exclude pending/new members from history and reject sends after removal or blocks", async () => {
  const a = await actor(), b = await actor(), c = await actor(), d = await actor();
  const cid = await create(a, [b, c], "group");
  await accept(cid, b);
  const early = await envelope(cid, a, "Before the third member joined");
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", early, a)).status, 201);
  await accept(cid, c);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "GET", undefined, c)).data.messages.length, 0);
  await assert.rejects(decryptChatMessage(early, a.key.identity, c.key));
  const stale = await envelope(cid, a, "Prepared before removal");
  assert.equal((await call(`/chat/conversations/${cid}/members/${b.id}`, "DELETE", undefined, c)).status, 403);
  assert.equal((await call(`/chat/conversations/${cid}/members/${b.id}`, "DELETE", undefined, a)).status, 200);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", stale, a)).status, 409);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "GET", undefined, b)).status, 404);
  const current = await envelope(cid, a, "After removal");
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", current, a)).status, 201);
  await assert.rejects(decryptChatMessage(current, a.key.identity, b.key));
  assert.equal(await decryptChatMessage(current, a.key.identity, c.key), "After removal");
  assert.equal((await call(`/chat/conversations/${cid}/members`, "POST", { agent_id: d.id }, a)).status, 201);
  await accept(cid, d);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "GET", undefined, d)).data.messages.length, 0);
  const beforeBlock = await envelope(cid, a, "Blocked during send");
  assert.equal((await call(`/chat/blocks/${a.id}`, "PUT", {}, c)).status, 200);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", beforeBlock, a)).status, 409);
  assert.equal((await call(`/chat/conversations/${cid}`, "GET", undefined, a)).data.can_send, false);
  assert.equal((await call("/chat/conversations", "POST", { kind: "dm", member_ids: [c.id] }, a)).status, 409);
  assert.equal((await call(`/chat/people?q=${c.id}`, "GET", undefined, a)).data.people.length, 0);
  await call(`/chat/blocks/${a.id}`, "DELETE", undefined, c);
  assert.equal((await call(`/chat/conversations/${cid}/messages`, "POST", beforeBlock, a)).status, 201);
  await call(`/chat/conversations/${cid}/members/me`, "DELETE", undefined, a);
  assert.equal((await call(`/chat/conversations/${cid}`, "GET", undefined, c)).data.conversation.closed, 1);
});

test("requests can be declined or disabled without exposing plaintext or receiving history", async () => {
  const a = await actor(), b = await actor();
  await call("/chat/settings", "PATCH", { accept_requests: false }, b);
  assert.equal((await call("/chat/conversations", "POST", { kind: "dm", member_ids: [b.id] }, a)).status, 409);
  await call("/chat/settings", "PATCH", { accept_requests: true }, b);
  const cid = await create(a, [b]);
  await call(`/chat/conversations/${cid}/members/me`, "DELETE", undefined, b);
  assert.equal((await call(`/chat/conversations/${cid}/accept`, "POST", {}, b)).status, 404);
  assert.equal((await call(`/chat/conversations/${cid}`, "GET", undefined, a)).data.conversation.closed, 1);
});

test("agent recovery files interoperate and uncertain delivery replays across client restarts", async () => {
  const a = await actor(), b = await actor(), cid = await create(a, [b]);
  await accept(cid, b);
  const vault = runtime.persist + "/agent-recovery.json";
  writeFileSync(vault, JSON.stringify(a.backup), { mode: 0o600, flag: "wx" });
  const options = { apiKey: a.apiKey, passphrase: a.passphrase, vault, base: runtime.base };
  const client = new ChatClient(options);
  assert.equal((await client.init()).fingerprint, a.backup.fingerprint);
  const request = client.request.bind(client);
  client.request = async (...args) => {
    const response = await request(...args);
    if (args[0].endsWith("/messages") && args[1] === "POST") throw new Error("Simulated lost response after commit");
    return response;
  };
  await assert.rejects(client.send(cid, "A durable encrypted retry"), /lost response/);
  assert.ok(existsSync(vault + ".pending.json"));
  const restarted = new ChatClient(options);
  assert.equal((await restarted.retry()).replayed, true);
  assert.ok(!existsSync(vault + ".pending.json"));
  const page = await restarted.read(cid);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].content, "A durable encrypted retry");
});
