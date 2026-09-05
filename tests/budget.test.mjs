import { test } from "node:test";
import assert from "node:assert/strict";
import { localRuntime } from "./support/runtime.mjs";

test("budget reservations serialize concurrent requests and settle exactly once", async () => {
  const runtime = await localRuntime({
    port: 8801,
    entry: "tests/budget-worker.ts",
    budget: "0.02",
  });
  try {
    const call = async (body) => {
      const res = await fetch(runtime.base + "/v1/budget", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call({ action: "reserve", id: String(i) }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 2);
    const accepted = results.flatMap((r, i) =>
      r.status === 200 ? [String(i)] : [],
    );
    const first = {
      action: "settle",
      id: accepted[0],
      reads: 1000,
      writes: 10,
    };
    await call(first);
    const before = (await call({ action: "status" })).data;
    await call(first);
    const after = (await call({ action: "status" })).data;
    assert.equal(after.spent, before.spent);
    assert.equal(after.reads, 1000);
    assert.equal(after.writes, 10);
    assert.ok(after.spent >= 0.01, "unsettled reservation remains charged");
    await call({ action: "settle", id: accepted[1], reads: 0, writes: 0 });
    assert.equal(
      (await call({ action: "reserve", id: "after-refund" })).status,
      200,
    );
    await call({
      action: "settle",
      id: "after-refund",
      reads: 0,
      writes: 30000,
    });
    assert.equal(
      (await call({ action: "reserve", id: "over-budget" })).status,
      503,
    );
    assert.ok((await call({ action: "status" })).data.spent > 0.03);
  } finally {
    runtime.stop();
  }
});

test("application fails closed before writes when no request fits the budget", async () => {
  const runtime = await localRuntime({ port: 8802, budget: "0.001" });
  try {
    const response = await fetch(runtime.base + "/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "must-not-exist" }),
    });
    assert.equal(response.status, 503);
    assert.ok(response.headers.get("retry-after"));
    const result = runtime.command([
      "d1",
      "execute",
      "aiagentmessageboard",
      "--local",
      "--persist-to",
      runtime.persist,
      "--command",
      "SELECT count(*) n FROM agents WHERE name='must-not-exist'",
      "--json",
    ]);
    assert.equal(JSON.parse(result)[0].results[0].n, 0);
  } finally {
    runtime.stop();
  }
});
