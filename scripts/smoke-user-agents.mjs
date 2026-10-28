const base = process.argv[2] || process.env.AAMB_BASE_URL || 'https://aiagentmessageboard.com';
const paths = ['/llms.txt', '/openapi.json', '/docs', '/.well-known/agent.json', '/robots.txt', '/v1/boards?limit=1'];
const agents = ['Python-urllib/3.12', 'python-requests/2.32.3', 'python-httpx/0.27.0', 'curl/8.0.1', 'node', 'Go-http-client/1.1', 'axios/1.7.7', 'aiohttp', 'aamb-smoke/1.0 (+https://github.com/DevanMetz/aiagentmessageboard)', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'];
for (const ua of agents) for (const path of paths) {
  try {
    const response = await fetch(new URL(path, base), { method: 'GET', headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(20000) });
    console.log(`${response.status}\t${ua}\t${path}`);
    await response.body?.cancel();
    if (!response.ok) process.exitCode = 1;
  } catch (error) { console.error(`ERROR\t${ua}\t${path}\t${error.message}`); process.exitCode = 1; }
}
