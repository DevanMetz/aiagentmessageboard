import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { localRuntime } from "./support/runtime.mjs";

let runtime;
const secret = "amb_mcp_private_test_key";
const hash = createHash("sha256").update(secret).digest("hex");

before(async () => {
  const seed = [
    `INSERT INTO agents(id,name,key_hash) VALUES ('mcp-owner','MCP Owner','${hash}');`,
    "INSERT INTO agent_profiles(agent_id,capabilities,interests) VALUES ('mcp-owner','[\"research\"]','[\"MCP\"]');",
    "INSERT INTO resources(id,author_id,url,title,kind,tags) VALUES ('mcp-resource','mcp-owner','https://example.com/mcp-guide','MCP Guide','documentation','[\"mcp\"]');",
    "INSERT INTO boards(id,slug,name,description,visibility,join_mode,owner_id) VALUES ('mcp-private','mcp-private','Private board','Do not disclose','private','invite','mcp-owner');",
    "INSERT INTO memberships(board_id,agent_id,role) VALUES ('mcp-private','mcp-owner','owner');",
    "INSERT INTO threads(id,board_id,author_id,title) VALUES ('mcp-public-thread','general','steward','Public MCP research'),('mcp-private-thread','mcp-private','mcp-owner','Private MCP research');",
    "INSERT INTO messages(thread_id,author_id,content) VALUES ('mcp-public-thread','steward','Public MCP finding'),('mcp-private-thread','mcp-owner','private-mcp-secret');",
    "INSERT INTO tasks(thread_id,goal,deliverable,acceptance_criteria) VALUES ('mcp-public-thread','Investigate MCP access','A useful finding','Report the evidence');",
    ...Array.from({ length: 10 }, (_, i) => `INSERT INTO agents(id,name,key_hash) VALUES ('mcp-voter-${i}','MCP Voter ${i}','mcp-voter-hash-${i}'); INSERT INTO task_votes(thread_id,agent_id,value) VALUES ('mcp-public-thread','mcp-voter-${i}',1);`),
  ].join("\n");
  runtime = await localRuntime({ port: 8826, seed });
});
after(() => runtime?.stop());

async function mcp(method, params, extraHeaders = {}) {
  const response = await fetch(runtime.base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "board-test", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? body.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6)
    : body;
  return { response, body: data ? JSON.parse(data) : null };
}

test("older Streamable HTTP clients can initialize", async () => {
  const response = await fetch(runtime.base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1.0.0" } },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /2025-11-25/);
});

test("MCP lists public read-only tools and serves board, task, search, thread, agent, and resource data", async () => {
  const listed = await mcp("tools/list", {});
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), [
    "browse_boards", "list_board_threads", "find_open_requests", "search_discussions", "read_thread", "find_agents", "find_resources",
  ]);
  assert.ok(listed.body.result.tools.every((tool) => tool.annotations.readOnlyHint));

  const boards = await mcp("tools/call", { name: "browse_boards", arguments: {} });
  assert.equal(boards.response.status, 200);
  assert.ok(boards.body.result.structuredContent.boards.some((board) => board.slug === "general"));
  assert.ok(!boards.body.result.structuredContent.boards.some((board) => board.id === "mcp-private"));
  assert.equal(boards.body.result.structuredContent.boards[0].url, "https://aiagentmessageboard.com/b/general");

  const recent = await mcp("tools/call", { name: "list_board_threads", arguments: { board: "general" } });
  assert.equal(recent.response.status, 200);
  assert.ok(recent.body.result.structuredContent.threads.some((thread) => thread.id === "mcp-public-thread"));
  assert.equal(recent.body.result.structuredContent.threads.find((thread) => thread.id === "mcp-public-thread").url, "https://aiagentmessageboard.com/t/mcp-public-thread");

  const tasks = await mcp("tools/call", { name: "find_open_requests", arguments: {} });
  assert.equal(tasks.response.status, 200);
  assert.ok(tasks.body.result.structuredContent.tasks.some((task) => task.thread_id === "mcp-public-thread"));
  assert.equal(tasks.body.result.structuredContent.tasks[0].url, "https://aiagentmessageboard.com/t/mcp-public-thread");

  const search = await mcp("tools/call", { name: "search_discussions", arguments: { query: "MCP" } });
  assert.equal(search.response.status, 200, JSON.stringify(search.body));
  assert.ok(search.body.result.structuredContent.threads.some((thread) => thread.id === "mcp-public-thread"));
  assert.ok(search.body.result.structuredContent.messages.some((message) => message.thread_id === "mcp-public-thread"));
  assert.ok(!JSON.stringify(search.body).includes("private-mcp-secret"));

  const thread = await mcp("tools/call", { name: "read_thread", arguments: { thread_id: "mcp-public-thread" } });
  assert.equal(thread.response.status, 200);
  assert.equal(thread.body.result.structuredContent.messages[0].content, "Public MCP finding");
  assert.equal(thread.body.result.structuredContent.has_more, false);
  assert.equal(thread.body.result.structuredContent.url, "https://aiagentmessageboard.com/t/mcp-public-thread");

  const agents = await mcp("tools/call", { name: "find_agents", arguments: { query: "MCP" } });
  assert.equal(agents.response.status, 200);
  assert.equal(agents.body.result.structuredContent.agents[0].id, "mcp-owner");
  assert.equal(agents.body.result.structuredContent.agents[0].url, "https://aiagentmessageboard.com/a/mcp-owner");

  const resources = await mcp("tools/call", { name: "find_resources", arguments: { query: "MCP", kind: "documentation" } });
  assert.equal(resources.response.status, 200);
  assert.equal(resources.body.result.structuredContent.resources[0].id, "mcp-resource");
});

test("the public guide and agent card advertise anonymous MCP discovery", async () => {
  const docs = await (await fetch(runtime.base + "/docs")).text();
  assert.ok(docs.indexOf("Start with a public read") < docs.indexOf("Register once"));
  assert.match(docs, /codex mcp add agent-message-board --url https:\/\/aiagentmessageboard\.com\/mcp/);
  const card = await (await fetch(runtime.base + "/.well-known/agent.json")).json();
  assert.equal(card.mcp.url, "https://aiagentmessageboard.com/mcp");
});

test("MCP ignores credentials and never exposes private content", async () => {
  const credentials = { Authorization: `Bearer ${secret}`, Cookie: "amb_session=placeholder" };
  const boards = await mcp("tools/call", { name: "browse_boards", arguments: {} }, credentials);
  assert.equal(boards.response.status, 200);
  assert.ok(!boards.body.result.structuredContent.boards.some((board) => board.id === "mcp-private"));
  const recent = await mcp("tools/call", { name: "list_board_threads", arguments: { board: "mcp-private" } }, credentials);
  assert.equal(recent.response.status, 200);
  assert.equal(recent.body.result.isError, true);
  const search = await mcp("tools/call", { name: "search_discussions", arguments: { query: "secret" } }, credentials);
  assert.equal(search.response.status, 200);
  assert.ok(!JSON.stringify(search.body).includes("private-mcp-secret"));
  const thread = await mcp("tools/call", { name: "read_thread", arguments: { thread_id: "mcp-private-thread" } }, credentials);
  assert.equal(thread.response.status, 200);
  assert.equal(thread.body.result.isError, true);
  assert.ok(!JSON.stringify(thread.body).includes("private-mcp-secret"));
});

test("MCP rejects browser Origins outside its allowlist", async () => {
  const response = await fetch(runtime.base + "/mcp", {
    method: "OPTIONS",
    headers: { Origin: "https://unrelated.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(response.status, 403);
});
