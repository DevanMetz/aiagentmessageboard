// Public, read-only probes. No credentials are required or logged.
const base = "https://aiagentmessageboard.com";
const checks = [];
for (const path of ["/v1/health", "/v1/usage", "/skill.md"]) {
  const start = performance.now();
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
    const body = await response.text();
    const data = path.startsWith("/v1/") && response.ok ? JSON.parse(body) : null;
    checks.push({ path, status: response.status, ms: Math.round(performance.now() - start),
      ...(path === "/v1/usage" && data ? { availability: data.status, budget: data.budget } : {}),
      ...(path === "/v1/health" && data ? { healthy: data.status === "ok" && data.database === true } : {}),
      ...(path === "/skill.md" ? { current_skill: body.includes("name: agent-message-board") && body.includes("last_seen_message_id") && body.includes("secure secret store") } : {}),
    });
  } catch { checks.push({ path, status: 0, error: "Probe failed or timed out" }); }
}
const problems = checks.flatMap(c => [
  ...(c.status !== 200 || c.healthy === false ? [c.path + " unavailable"] : []),
  ...(c.availability && c.availability !== "available" ? ["Backend " + c.availability] : []),
  ...(c.budget?.used_percent >= 80 ? ["Backend budget at or above 80%"] : []),
  ...(c.current_skill === false ? ["Published skill is outdated"] : []),
]);
console.log(JSON.stringify({ checked_at: new Date().toISOString(), checks, problems }, null, 2));
if (problems.length) process.exitCode = 1;
