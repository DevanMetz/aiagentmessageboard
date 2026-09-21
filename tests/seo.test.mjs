import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { localRuntime } from "./support/runtime.mjs";

let runtime;
const origin = "https://aiagentmessageboard.com";
const markup =
  '</script><script>window.injected=true</script><img src=x onerror=alert(1)>&"';
const sql = (value) => "'" + value.replaceAll("'", "''") + "'";
before(async () => {
  const seed = [
    "INSERT INTO agents(id,name,bio,key_hash) VALUES ('seo-public','Discovery Agent','A public research agent.','seo-public-hash'),('seo-private','Secret account name','Private-only bio','seo-private-hash'),('seo-disabled','Disabled agent','','seo-disabled-hash');",
    "UPDATE agents SET disabled=1 WHERE id='seo-disabled';",
    "INSERT INTO agent_profiles(agent_id,capabilities) VALUES ('seo-public','[\"research\"]'),('seo-disabled','[]');",
    "INSERT INTO boards(id,slug,name,description,visibility,join_mode,owner_id) VALUES ('seo-board-id','seo-public-board','Public Discovery Board','Research conversations.','public','open','seo-public'),('seo-private-board','secret-discovery-board','Secret board name','Secret board description','private','invite','seo-private');",
    "INSERT INTO threads(id,board_id,author_id,title) VALUES ('seo-conversation','seo-board-id','seo-public','A discussion about agent discovery'),('seo-secret','seo-private-board','seo-private','Secret discussion title'),('seo-deleted','general','seo-public','Deleted discussion title');",
    "UPDATE threads SET deleted=1 WHERE id='seo-deleted';",
    ...Array.from(
      { length: 55 },
      (_, i) =>
        `INSERT INTO messages(id,thread_id,author_id,content) VALUES (${5000 + i},'seo-conversation','seo-public',${sql(i === 0 ? markup : "Public message " + i + (i === 54 ? "\u0001" : ""))});`,
    ),
    "INSERT INTO messages(id,thread_id,author_id,content) VALUES (9000,'seo-secret','seo-private','Secret post body'),(9001,'seo-deleted','seo-public','Deleted thread body'),(9002,'seo-conversation','seo-public','Deleted message body');",
    "UPDATE messages SET deleted=1 WHERE id=9002;",
    ...Array.from(
      { length: 1001 },
      (_, i) =>
        `INSERT INTO threads(id,board_id,author_id,title) VALUES ('seo-list-${String(i).padStart(4, "0")}','general','seo-public','Public thread ${i}');`,
    ),
    ...Array.from(
      { length: 12 },
      (_, i) =>
        `INSERT INTO agents(id,name,key_hash) VALUES ('seo-directory-${i}','Directory Agent ${i}','seo-key-${i}'); INSERT INTO agent_profiles(agent_id) VALUES ('seo-directory-${i}'); INSERT INTO resources(id,author_id,url,title,description,kind,tags,access) VALUES ('seo-resource-${i}','seo-public','https://example.com/resource-${i}','Discovery Resource ${i}','A resource description.','documentation','["testing"]','Public access');`,
    ),
  ].join("\n");
  runtime = await localRuntime({ port: 8814, seed });
});
after(() => runtime?.stop());
async function page(path, options) {
  const response = await fetch(runtime.base + path, options);
  return { response, html: await response.text() };
}
const locations = (xml) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
function schema(html) {
  const scripts = [
    ...html.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  assert.equal(scripts.length, 1);
  return JSON.parse(scripts[0][1])["@graph"];
}

test("public HTML contains useful page-specific content, metadata and valid structured data", async () => {
  for (const [path, content] of [
    ["/", "What is Agent Message Board?"],
    ["/analytics", "Public message 54"],
    ["/agents", "Directory Agent"],
    ["/resources", "Public access"],
    ["/docs", "OpenAPI"],
    ["/a/seo-public", "A public research agent."],
    ["/t/seo-conversation", "Public message 49"],
  ]) {
    const { response, html } = await page(path);
    assert.equal(response.status, 200, path);
    assert.ok(html.includes(content), path);
    assert.ok(html.includes(`href="${origin}${path}"`), path);
    assert.ok(
      html.includes(`property="og:url" content="${origin}${path}"`),
      path,
    );
    assert.ok(html.includes('href="/analytics"'), path);
    assert.ok(
      schema(html).some(
        (entity) =>
          entity["@type"] === "WebPage" && entity.url === origin + path,
      ),
    );
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(response.headers.get("link"), /feed.xml/);
  }
});

test("untrusted post text stays text in HTML and JSON-LD", async () => {
  const { html } = await page("/t/seo-conversation");
  assert.ok(html.includes("&lt;img"));
  assert.ok(
    !html.slice(html.indexOf("<body")).includes("<script>window.injected"),
  );
  const discussion = schema(html).find(
    (entity) => entity["@type"] === "CreativeWork",
  );
  assert.ok(discussion.text.startsWith(markup));
  assert.equal(discussion.creditText, "Discovery Agent");
  assert.ok(
    !html
      .slice(html.indexOf("<body"))
      .includes("</script><script>window.injected"),
  );
});

test("sitemap index covers every public thread across chunks and omits private/deleted accounts and content", async () => {
  const { html: index } = await page("/sitemap.xml");
  const maps = locations(index);
  assert.ok(maps.includes(origin + "/sitemaps/threads-2.xml"));
  const pages = [];
  for (const map of maps) {
    const { response, html } = await page(new URL(map).pathname);
    assert.equal(response.status, 200);
    pages.push(...locations(html));
    if (map.endsWith("threads-1.xml"))
      assert.match(html, /<lastmod>\d{4}-\d{2}-\d{2}T/);
  }
  for (const path of [
    "/analytics",
    "/agents",
    "/a/seo-public",
    "/t/seo-list-1000",
    "/b/seo-public-board",
  ])
    assert.ok(pages.includes(origin + path), path);
  assert.equal(pages.filter((path) => path.includes("/t/")).length, 1003);
  for (const privatePart of [
    "seo-private",
    "secret-discovery-board",
    "seo-secret",
    "seo-deleted",
    "seo-disabled",
    "/subscriptions",
    "/moderation",
  ])
    assert.ok(!pages.join(" ").includes(privatePart), privatePart);
  assert.equal((await page("/sitemaps/threads-999.xml")).response.status, 404);
});

test("HTML pagination is crawlable and agrees with the JSON API", async () => {
  for (const [path, api, field, idField] of [
    [
      "/b/general?offset=50",
      "/boards/general/threads?offset=50",
      "threads",
      "id",
    ],
    ["/agents?offset=10", "/agents?offset=10", "agents", "name"],
    ["/resources?offset=10", "/resources?offset=10", "resources", "title"],
  ]) {
    const { response, html } = await page(path);
    assert.equal(response.status, 200, path);
    const data = await (await fetch(runtime.base + "/v1" + api)).json();
    for (const row of data[field])
      assert.ok(html.includes(row[idField]), `${path}: ${row[idField]}`);
    assert.ok(html.includes(`href="${origin}${path}"`));
  }
  const first = await page("/t/seo-conversation");
  assert.ok(first.html.includes('href="/t/seo-conversation?after=5049"'));
  const next = await page("/t/seo-conversation?after=5049");
  assert.equal(next.response.status, 200);
  assert.ok(next.html.includes("Public message 50"));
  assert.ok(!next.html.includes("Public message 49"));
  const profile = await page("/a/seo-public?before=5045");
  assert.ok(profile.html.includes("Public message 44"));
  assert.ok(!profile.html.includes("Public message 45"));
});

test("private data stays out of all public discovery surfaces even with credentials attached", async () => {
  for (const path of [
    "/",
    "/agents",
    "/analytics",
    "/feed.xml",
    "/a/seo-public",
    "/a/seo-private",
    "/b/secret-discovery-board",
    "/t/seo-secret",
  ]) {
    const { response, html } = await page(path, {
      headers: {
        Authorization: "Bearer private-placeholder",
        Cookie: "session=private-placeholder",
      },
    });
    for (const secret of [
      "Secret account name",
      "Private-only bio",
      "Secret board name",
      "Secret board description",
      "Secret discussion title",
      "Secret post body",
      "Deleted thread body",
      "Deleted message body",
    ])
      assert.ok(!html.includes(secret), path + ": " + secret);
    if (
      ["/a/seo-private", "/b/secret-discovery-board", "/t/seo-secret"].includes(
        path,
      )
    ) {
      assert.equal(response.status, 404);
      assert.match(response.headers.get("x-robots-tag"), /noindex/);
    }
  }
});

test("RSS exposes recent public posts with stable URLs and parseable dates", async () => {
  const { response, html } = await page("/feed.xml");
  assert.match(response.headers.get("content-type"), /application\/rss\+xml/);
  assert.equal((html.match(/<item>/g) || []).length, 20);
  assert.ok(html.includes("#message-5054"));
  assert.ok(html.includes("Public message 54"));
  assert.ok(!html.includes("\u0001"), "XML must omit unsupported control characters");
  assert.ok(!html.includes("Invalid Date"));
  assert.match(html, /<atom:link[^>]+rel="self"/);
});

test("aliases redirect, missing pages return 404, account pages and API responses are noindex", async () => {
  for (const [path, to] of [
    ["/tasks", "/boards"],
    ["/analytics/", "/analytics"],
    ["/b/seo-board-id", "/b/seo-public-board"],
  ]) {
    const { response } = await page(path, { redirect: "manual" });
    assert.equal(response.status, 308);
    assert.equal(new URL(response.headers.get("location")).pathname, to);
  }
  for (const path of [
    "/not-a-real-page",
    "/b/no-such-board",
    "/a/no-such-agent",
    "/t/seo-deleted",
    "/boards?offset=-1",
    "/agents?offset=100000",
    "/t/seo-conversation?after=999999",
  ]) {
    const { response, html } = await page(path);
    assert.equal(response.status, 404, path);
    assert.match(html, /noindex/);
  }
  for (const path of ["/subscriptions", "/moderation", "/v1/boards"]) {
    const { response } = await page(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-robots-tag"), /noindex/);
  }
});

test("HEAD and bot requests preserve public content semantics", async () => {
  for (const path of [
    "/analytics",
    "/feed.xml",
    "/sitemap.xml",
    "/t/seo-conversation",
  ]) {
    const { response, html } = await page(path, { method: "HEAD" });
    assert.equal(response.status, 200, path);
    assert.equal(html, "");
  }
  for (const bot of [
    "OAI-SearchBot",
    "PerplexityBot",
    "Googlebot",
    "bingbot",
    "Claude-SearchBot",
  ]) {
    const { response, html } = await page("/t/seo-conversation", {
      headers: { "User-Agent": bot },
    });
    assert.equal(response.status, 200, bot);
    assert.ok(html.includes("Public message 49"), bot);
  }
});
