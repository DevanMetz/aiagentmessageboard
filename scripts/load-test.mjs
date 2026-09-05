import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { localRuntime } from "../tests/support/runtime.mjs";

const key = (i) => `local-load-agent-${i}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const agents = Array.from(
  { length: 1000 },
  (_, i) => `('load-${i}','Load ${i}','${hash(key(i))}')`,
).join(",");
const seed = `
INSERT INTO agents(id,name,key_hash) VALUES ${agents};
UPDATE agents SET key_hash='${hash("local-load-admin")}',is_admin=1 WHERE id='steward';
WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99)
INSERT INTO boards(id,slug,name,description,visibility,join_mode,owner_id)
SELECT 'load-board-'||x,'load-board-'||x,'Research board '||x,'Research collaboration',CASE WHEN x%5=0 THEN 'private' ELSE 'public' END,CASE WHEN x%5=0 THEN 'invite' ELSE 'open' END,'load-0' FROM n;
INSERT INTO memberships(board_id,agent_id) SELECT b.id,a.id FROM boards b CROSS JOIN agents a WHERE b.id LIKE 'load-board-%' AND a.id LIKE 'load-%';
WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<999)
INSERT INTO threads(id,board_id,author_id,title) SELECT 'load-thread-'||x,'load-board-'||(x%100),'load-'||x,'Research topic '||x FROM n;
WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99999)
INSERT INTO messages(thread_id,author_id,content) SELECT 'load-thread-'||(x%1000),'load-'||(x%1000),'Research observation '||x||' about collaborative planning and distributed agents. '||printf('%0500d',x) FROM n;
`;
const runtime = await localRuntime({ port: 8803, seed });
const samples = [];
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * p))
  ] || 0;
try {
  const usage = async () =>
    (
      await fetch(runtime.base + "/v1/admin/usage", {
        headers: { Authorization: "Bearer local-load-admin" },
      })
    ).json();
  const query = (sql) =>
    JSON.parse(
      runtime.command([
        "d1",
        "execute",
        "aiagentmessageboard",
        "--local",
        "--persist-to",
        runtime.persist,
        "--command",
        sql,
        "--json",
      ]),
    )[0];
  const oldPlan = query(
    "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE instr(lower(content),'observation 99999')>0 LIMIT 50",
  ).results;
  const newPlan = query(
    `EXPLAIN QUERY PLAN SELECT id FROM messages WHERE id IN (SELECT rowid FROM message_search WHERE message_search MATCH '"observation 99999"') LIMIT 50`,
  ).results;
  for (const count of [100, 500, 1000]) {
    console.log(
      `Starting ${count} agents at one request per 30 seconds (${(count / 30).toFixed(1)} requests/sec).`,
    );
    const startUsage = await usage();
    const start = performance.now();
    let cacheHits = 0;
    const results = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        await new Promise((resolve) =>
          setTimeout(resolve, (i * 30000) / count),
        );
        // Mix cached public reads, authenticated feeds, search, analytics and replies.
        const mode = i % 20;
        let path = "/v1/boards/load-board-1/messages?after=100001";
        const headers = {
          "cf-connecting-ip": `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`,
        };
        let method = "GET",
          body;
        if (mode < 5) {
          headers.Authorization = `Bearer ${key(i)}`;
          path = "/v1/boards/load-board-0/messages?after=100001";
        } else if (mode === 5)
          path = "/v1/search/messages?q=observation%2099999";
        else if (mode === 6) path = "/v1/analytics?range=1d";
        else if (mode === 8) path = "/v1/search/messages?q=distributed%20planning&group=thread&board=load-board-1&limit=5";
        else if (mode === 9) path = "/v1/search/messages?q=observation%2099999&mode=phrase";
        else if (mode === 7) {
          path = "/v1/threads/load-thread-1/messages";
          method = "POST";
          headers.Authorization = `Bearer ${key(i)}`;
          headers["Content-Type"] = "application/json";
          body = JSON.stringify({
            content: `Load test stage ${count} reply ${i}`,
          });
        }
        const begin = performance.now();
        try {
          const res = await fetch(runtime.base + path, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(15000),
          });
          await res.arrayBuffer();
          if (res.headers.get("x-cache") === "HIT") cacheHits++;
          return { path, status: res.status, ms: performance.now() - begin };
        } catch {
          return { path, status: 0, ms: performance.now() - begin };
        }
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const endUsage = await usage();
    const durations = results.map((r) => r.ms);
    const errors = results.filter((r) => r.status < 200 || r.status >= 300);
    const summary = {
      agents: count,
      elapsed_seconds: (performance.now() - start) / 1000,
      requests: count,
      errors: errors.length,
      statuses: Object.fromEntries(
        [...new Set(results.map((r) => r.status))].map((s) => [
          s,
          results.filter((r) => r.status === s).length,
        ]),
      ),
      p50_ms: percentile(durations, 0.5),
      p95_ms: percentile(durations, 0.95),
      p99_ms: percentile(durations, 0.99),
      cache_hits: cacheHits,
      slowest: [...results].sort((a, b) => b.ms - a.ms).slice(0, 5),
      d1_rows_read: endUsage.reads - startUsage.reads,
      d1_rows_written: endUsage.writes - startUsage.writes,
      conservative_estimated_usd: endUsage.spent - startUsage.spent,
    };
    samples.push(summary);
    console.log(JSON.stringify(summary));
  }
  mkdirSync("reports", { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    environment:
      "local Cloudflare workerd/D1 emulator; not production capacity certification",
    fixture: { agents: 1000, boards: 100, threads: 1000, messages: 100000 },
    old_search_plan: oldPlan,
    indexed_search_plan: newPlan,
    stages: samples,
  };
  writeFileSync(
    "reports/load-test.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  if (samples.some((s) => s.errors || s.p95_ms > 1000)) process.exitCode = 1;
} finally {
  runtime.stop();
}
