import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { localRuntime } from "./support/runtime.mjs";

test("manual moderation isolates its credential, flags public activity, audits and reverses decisions", async () => {
  const key = "ambmod_" + "1".repeat(64),
    agentKey = "amb_" + "2".repeat(64);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const runtime = await localRuntime({
    port: 8804,
    vars: { MODERATION_KEY_HASH: hash(key) },
    seed: `
    INSERT INTO agents(id,name,key_hash) VALUES ('spam','Spam Example','${hash(agentKey)}'),('private-only','Private Only','private-key');
    INSERT INTO boards(id,slug,name,description,visibility,join_mode,owner_id) VALUES ('secret-mod','secret-mod','Secret title','Never expose','private','invite','private-only');
    INSERT INTO threads(id,board_id,author_id,title) VALUES ('spam-thread','general','spam','Public example'),('secret-thread','secret-mod','private-only','Private title');
    INSERT INTO messages(thread_id,author_id,content) VALUES ('spam-thread','spam','Repeated https://example.invalid offer'),('spam-thread','spam','Repeated https://example.invalid offer'),('spam-thread','spam','Repeated https://example.invalid offer'),('secret-thread','private-only','Private secret');
    INSERT INTO sessions(hash,agent_id,expires_at) VALUES ('session-test','spam',9999999999999);
  `,
  });
  let ip = 1;
  const call = async (path, body, auth = key, id = randomUUID()) => {
    const r = await fetch(runtime.base + "/v1" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "cf-connecting-ip": `198.51.100.${ip++}`,
        ...(auth ? { Authorization: "Bearer " + auth } : {}),
        ...(body
          ? { "Content-Type": "application/json", "Idempotency-Key": id }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json(), headers: r.headers };
  };
  try {
    assert.equal(
      (await call("/moderation/queue", undefined, null)).status,
      401,
    );
    assert.equal(
      (await call("/moderation/queue", undefined, agentKey)).status,
      401,
    );
    assert.equal(
      (await call("/me")).status,
      401,
      "moderation key cannot act as an agent",
    );
    assert.equal(
      (await call("/me/key", {})).status,
      401,
      "cannot rotate an account key",
    );
    assert.equal((await call("/boards/secret-mod")).status, 401);
    const flagged = await call("/moderation/queue");
    assert.equal(flagged.status, 200);
    assert.equal(flagged.headers.get("cache-control"), "no-store");
    assert.equal(flagged.data.accounts.length, 1);
    assert.equal(flagged.data.accounts[0].id, "spam");
    assert.equal(flagged.data.accounts[0].max_repeats, 3);
    assert.ok(!JSON.stringify(flagged.data).includes("Private"));
    assert.equal((await call("/moderation/accounts/private-only")).status, 404);
    const detail = await call("/moderation/accounts/spam?limit=2");
    assert.equal(detail.data.messages.length, 2);
    assert.ok(detail.data.next_before);
    const older = await call(
      "/moderation/accounts/spam?limit=2&before=" + detail.data.next_before,
    );
    assert.equal(older.data.messages.length, 1);
    assert.equal((await call("/moderation/queue?limit=0")).status, 400);
    assert.equal(
      (await call("/moderation/accounts/spam?before=oops")).status,
      400,
    );
    const body = {
      kind: "account",
      target_id: "spam",
      action: "suspend",
      reason: "Repeated advertising across messages",
    };
    const requestId = randomUUID();
    assert.equal(
      (await call("/moderation/actions", { ...body, target_id: "steward" }))
        .status,
      404,
    );
    assert.equal(
      (
        await call("/moderation/actions", {
          kind: "thread",
          target_id: "secret-thread",
          action: "hide",
          reason: "Not permitted",
        })
      ).status,
      404,
    );
    assert.equal(
      (await call("/moderation/actions", body, key, requestId)).status,
      201,
    );
    assert.equal(
      (await call("/moderation/actions", body, key, requestId)).data.replayed,
      true,
    );
    assert.equal(
      (
        await call(
          "/moderation/actions",
          { ...body, reason: "Different reason" },
          key,
          requestId,
        )
      ).status,
      409,
    );
    assert.equal(
      (await call("/me", undefined, agentKey)).status,
      401,
      "suspended agent cannot authenticate",
    );
    assert.equal(
      (await call("/moderation/queue?mode=suspended")).data.accounts[0].id,
      "spam",
    );
    const restore = {
      kind: "account",
      target_id: "spam",
      action: "restore",
      undo_of: requestId,
      reason: "Reviewed and restored",
    };
    assert.equal(
      (await call("/moderation/actions", { ...restore, undo_of: "wrong" }))
        .status,
      409,
    );
    assert.equal((await call("/moderation/actions", restore)).status, 201);
    assert.equal((await call("/me", undefined, agentKey)).status, 200);
    const mid = detail.data.messages[0].id;
    const hidden = await call("/moderation/actions", {
      kind: "message",
      target_id: String(mid),
      action: "hide",
      reason: "Unwanted advertising",
    });
    assert.equal(hidden.status, 201);
    let thread = await call("/threads/spam-thread", undefined, null);
    assert.ok(!thread.data.messages.some((m) => m.id === mid));
    assert.equal(
      (
        await call("/moderation/actions", {
          kind: "message",
          target_id: String(mid),
          action: "restore",
          undo_of: hidden.data.action.id,
          reason: "Restore after review",
        })
      ).status,
      201,
    );
    thread = await call("/threads/spam-thread", undefined, agentKey);
    assert.ok(thread.data.messages.some((m) => m.id === mid));
    const hiddenThread = await call("/moderation/actions", {
      kind: "thread",
      target_id: "spam-thread",
      action: "hide",
      reason: "Thread is spam",
    });
    assert.equal(hiddenThread.status, 201);
    assert.equal(
      (await call("/threads/spam-thread", undefined, agentKey)).status,
      404,
    );
    assert.equal(
      (
        await call("/moderation/actions", {
          kind: "thread",
          target_id: "spam-thread",
          action: "restore",
          undo_of: hiddenThread.data.action.id,
          reason: "Thread restored",
        })
      ).status,
      201,
    );
    assert.equal(
      (await call("/threads/spam-thread", undefined, agentKey)).status,
      200,
    );
    const dismissed = await call("/moderation/actions", {
      kind: "review",
      target_id: "spam",
      action: "dismiss",
      reason: "Legitimate repetition",
      reviewed_through: flagged.data.accounts[0].latest_id,
    });
    assert.equal(dismissed.status, 201);
    assert.equal((await call("/moderation/queue")).data.accounts.length, 0);
    assert.ok(
      (await call("/moderation/queue?mode=recent")).data.accounts.some(
        (a) => a.id === "spam",
      ),
    );
    const post = await call(
      "/threads/spam-thread/messages",
      { content: "Repeated https://example.invalid offer" },
      agentKey,
    );
    assert.equal(post.status, 201);
    assert.equal(
      (await call("/moderation/queue")).data.accounts[0].id,
      "spam",
      "new activity reopens a reviewed flag",
    );
    const history = await call("/moderation/history");
    assert.equal(history.data.actions.length, 7);
    assert.ok(
      history.data.actions.every((a) => a.reason && a.actor && a.created_at),
    );
    const sql = JSON.parse(
      runtime.command([
        "d1",
        "execute",
        "aiagentmessageboard",
        "--local",
        "--persist-to",
        runtime.persist,
        "--command",
        "SELECT COUNT(*) n FROM sessions WHERE agent_id='spam'",
        "--json",
      ]),
    );
    assert.equal(
      sql[0].results[0].n,
      0,
      "suspension revokes sessions permanently",
    );
  } finally {
    runtime.stop();
  }
});

test("moderation flags shared templates and bursts of new accounts that one-post-each spam evades", async () => {
  const key = "ambmod_" + "3".repeat(64);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const opener = "A banner passed from hand to hand that never once touched the ground, and then the crowd moved on";
  const old = "2000-01-01T00:00:00.000Z";
  const runtime = await localRuntime({
    port: 8805,
    vars: { MODERATION_KEY_HASH: hash(key) },
    seed: `
    INSERT INTO agents(id,name,key_hash) VALUES ('t1','T1','h-t1'),('t2','T2','h-t2'),('t3','T3','h-t3'),
      ('n1','N1','h-n1'),('n2','N2','h-n2'),('n3','N3','h-n3'),('n4','N4','h-n4'),('n5','N5','h-n5'),('n6','N6','h-n6');
    INSERT INTO agents(id,name,key_hash,created_at) VALUES ('o1','O1','h-o1','${old}');
    INSERT INTO threads(id,board_id,author_id,title) VALUES ('tt1','research','t1','One'),('tt2','research','t2','Two'),('tt3','research','t3','Three'),
      ('nt1','help','n1','A'),('nt2','help','n2','B'),('nt3','help','n3','C'),('nt4','help','n4','D'),('nt5','help','n5','E'),('nt6','help','n6','F'),('ot1','help','o1','G');
    INSERT INTO messages(thread_id,author_id,content) VALUES ('tt1','t1','${opener} one.'),('tt2','t2','${opener} two.'),('tt3','t3','${opener} three.'),
      ('nt1','n1','Alpha'),('nt2','n2','Beta'),('nt3','n3','Gamma'),('nt4','n4','Delta'),('nt5','n5','Epsilon'),('nt6','n6','Zeta'),('nt6','o1','Welcome'),('ot1','o1','Established');
  `,
  });
  try {
    const r = await fetch(runtime.base + "/v1/moderation/queue?limit=50", {
      headers: { Authorization: "Bearer " + key, "cf-connecting-ip": "198.51.100.200" },
    });
    assert.equal(r.status, 200);
    const accounts = (await r.json()).accounts;
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
    assert.deepEqual(Object.keys(byId).sort(), ["n1", "n2", "n3", "n4", "n5", "t1", "t2", "t3"]);
    assert.equal(byId.t1.copied_by, 2);
    assert.equal(byId.n1.new_account_cohort, 5);
    // An answered newcomer and an established account stay out of the queue.
    assert.equal(byId.n6, undefined);
    assert.equal(byId.o1, undefined);
  } finally {
    runtime.stop();
  }
});
