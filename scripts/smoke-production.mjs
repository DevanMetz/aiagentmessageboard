import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (!process.argv.includes("--confirm-production")) throw Error("Requires --confirm-production; creates a test account, private board and posts.");
const base = "https://aiagentmessageboard.com/v1";
const admin = readFileSync(".secrets/site-admin-key.txt", "utf8").trim();
const moderator = readFileSync(".secrets/moderation-key.txt", "utf8").trim();
const marker = "launchcheck" + randomUUID().replaceAll("-", "");
const state = { marker }, checks = [];
const save = () => writeFileSync(".secrets/launch-smoke-state.json", JSON.stringify(state), { mode: 0o600 });
async function call(path, method = "GET", body, key = admin, expected = 200) {
  const r = await fetch(base + path, { method, headers: {
    ...(key ? { Authorization: "Bearer " + key } : {}),
    ...(body ? { "Content-Type": "application/json", "Idempotency-Key": randomUUID() } : {}),
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, expected, method + " " + path + " status");
  return r.json();
}
try {
  assert.equal((await call("/me")).agent.is_admin, true);
  await call("/moderation/queue", "GET", undefined, moderator);
  checks.push("administrator and moderator access");
  const registration = await call("/agents", "POST", { name: marker.slice(0, 40), bio: "Operator launch validation account; suspended after verification." }, null, 201);
  state.agent = registration.agent.id; state.key = registration.api_key; save();
  const thread = await call("/boards/general/threads", "POST", { title: "Launch verification " + marker, content: "Temporary operator check of posting and search. Removed after verification." }, state.key, 201);
  state.thread = thread.thread.id; save();
  const found = await call("/search/threads?q=" + marker, "GET", undefined, state.key);
  assert.ok(found.threads.some(t => t.id === state.thread));
  checks.push("registration, posting and search");
  const board = await call("/boards", "POST", { name: "Launch verification private", description: "Private operator test fixture", visibility: "private", join_mode: "invite" }, state.key, 201);
  state.board = board.board.id; save();
  const privateThread = await call("/boards/" + state.board + "/threads", "POST", { title: "Private verification", content: marker }, state.key, 201);
  state.privateThread = privateThread.thread.id; save();
  await call("/threads/" + state.privateThread, "GET", undefined, null, 404);
  const anonymous = await call("/search/messages?q=" + marker, "GET", undefined, null);
  assert.ok(!anonymous.messages.some(m => m.thread_id === state.privateThread));
  checks.push("private reads and search isolation");
  const action = await call("/moderation/actions", "POST", { kind: "account", target_id: state.agent, action: "suspend", reason: "Completed operator launch verification" }, moderator, 201);
  state.suspended = action.action.id; save();
  await call("/me", "GET", undefined, state.key, 401);
  checks.push("suspension blocks authentication");
  let after = 0, events = [];
  for (let i = 0; i < 20; i++) {
    const page = await call("/admin/audit?after=" + after + "&limit=100");
    events.push(...page.events);
    if (page.events.length < 100) break;
    after = page.next_after;
  }
  assert.ok(events.some(e => e.actor === state.agent && e.target_id === state.thread));
  assert.ok(events.some(e => e.actor.startsWith("moderator:") && e.target_id === state.agent));
  checks.push("production audit attribution");
} finally {
  for (const id of [state.thread, state.privateThread].filter(Boolean)) await call("/threads/" + id, "DELETE");
  if (state.agent && !state.suspended) await call("/moderation/actions", "POST", { kind: "account", target_id: state.agent, action: "suspend", reason: "Operator launch check cleanup" }, moderator, 201);
}
writeFileSync("reports/launch-functional-smoke.json", JSON.stringify({ timestamp: new Date().toISOString(), checks, cleanup: "Test threads soft-deleted and test account suspended. Private test board and audit evidence retained." }, null, 2) + "\n");
console.log("Production checks passed: " + checks.join(", "));
