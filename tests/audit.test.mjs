import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { localRuntime } from "./support/runtime.mjs";

test("audit attributes concurrent writes, redacts secrets, and fails closed", async () => {
  const hash = s => createHash("sha256").update(s).digest("hex");
  const admin = "amb_" + "a".repeat(64), user = "amb_" + "b".repeat(64);
  const runtime = await localRuntime({ port: 8806, seed: `
    INSERT INTO agents(id,name,key_hash,is_admin) VALUES ('audit-admin','Audit Admin','${hash(admin)}',1),('audit-user','Audit User','${hash(user)}',0);
  ` });
  const sql = command => runtime.command(["d1", "execute", "aiagentmessageboard", "--local", "--persist-to", runtime.persist, "--command", command, "--json"]);
  let ip = 0;
  const call = async (path, method = "GET", body, key = admin) => {
    const r = await fetch(runtime.base + "/v1" + path, {
      method, headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "cf-connecting-ip": `192.0.2.${++ip}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.equal((await call("/admin/audit", "GET", undefined, user)).status, 403);
    const updates = await Promise.all([
      call("/me", "PATCH", { bio: "private-profile-marker" }, admin),
      call("/me", "PATCH", { bio: "other-private-marker" }, user),
    ]);
    updates.forEach(r => assert.equal(r.status, 200));
    const rotation = await call("/me/key", "POST", {}, user);
    assert.equal(rotation.status, 200);
    const events = (await call("/admin/audit?limit=100")).data.events;
    const updatesLogged = events.filter(e => e.action === "update" && e.target_type === "agents");
    assert.equal(updatesLogged.length, 3);
    for (const e of updatesLogged) {
      assert.equal(e.actor, e.target_id);
      assert.equal(e.outcome, "committed");
      assert.notEqual(e.request_id, "database-direct");
    }
    assert.equal(new Set(updatesLogged.map(e => e.request_id)).size, 3);
    assert.equal(JSON.parse(updatesLogged.at(-1).after_state).key_changed, 1);
    for (const secret of [admin, user, hash(user), rotation.data.api_key, "private-profile-marker", "other-private-marker"])
      assert.ok(!JSON.stringify(events).includes(secret));
    assert.throws(() => sql("DELETE FROM audit_events"), e => /append-only/.test(String(e.stdout) + String(e.stderr)));
    assert.throws(() => sql("UPDATE audit_events SET actor='fake'"), e => /append-only/.test(String(e.stdout) + String(e.stderr)));
    sql("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events WHEN NEW.actor='audit-admin' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
    assert.equal((await call("/me", "PATCH", { name: "Should Roll Back" })).status, 500);
    assert.equal((await call("/me")).data.agent.name, "Audit Admin");
    sql("DROP TRIGGER reject_audit");
    assert.equal((await call("/me", "PATCH", { name: "Audit Admin Updated" })).status, 200);
    const after = (await call("/admin/audit?limit=100")).data.events;
    assert.equal(after.length, events.length + 1);
    assert.equal(JSON.parse(sql("SELECT COUNT(*) n FROM audit_context"))[0].results[0].n, 0);
    const thread = await call("/boards/general/threads", "POST", { title: "Audit deletion", content: "secret-message-marker" });
    assert.equal(thread.status, 201);
    const threadId = thread.data.thread.id;
    assert.equal((await call("/threads/" + threadId, "DELETE")).status, 200);
    const deleted = (await call("/admin/audit?limit=100")).data.events;
    const deletion = deleted.find(e => e.target_type === "threads" && e.target_id === threadId && e.action === "update" && JSON.parse(e.after_state).deleted === 1);
    assert.equal(deletion.actor, "audit-admin");
    assert.equal(JSON.parse(deletion.before_state).deleted, 0);
    assert.ok(!JSON.stringify(deleted).includes("secret-message-marker"));
    sql("CREATE TRIGGER reject_message_audit BEFORE INSERT ON audit_events WHEN NEW.target_type='messages' BEGIN SELECT RAISE(ABORT,'test batch failure'); END");
    assert.equal((await call("/boards/general/threads", "POST", { title: "Batch must rollback", content: "failure" })).status, 500);
    assert.equal(JSON.parse(sql("SELECT COUNT(*) n FROM threads WHERE title='Batch must rollback'"))[0].results[0].n, 0);
    assert.equal((await call("/admin/audit?limit=100")).data.events.length, deleted.length);
  } finally { runtime.stop(); }
});
