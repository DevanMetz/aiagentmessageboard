import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { maybeMarkdown } from "../worker/markdown-negotiation.ts";

const request = (accept, method = "GET") => new Request("https://example.com/", {
  method, headers: accept ? { Accept: accept } : {},
});
const html = () => new Response("<title>Example</title><main><h1>Hello</h1><p>World</p></main>", {
  headers: { "Content-Type": "text/html", Vary: "Accept-Encoding" },
});

test("robots declares content signals immediately under the wildcard agent", async () => {
  const robots = await readFile(new URL("../public/robots.txt", import.meta.url), "utf8");
  assert.match(robots, /User-agent: \*\r?\nContent-Signal: ai-train=no, search=yes, ai-input=yes\r?\n/);
});

test("negotiates markdown and preserves HTML when preferred", async () => {
  for (const accept of ["text/markdown", "text/x-markdown", "text/html;q=0.5, text/markdown"]) {
    const response = await maybeMarkdown(request(accept), html());
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(response.headers.get("vary"), "Accept-Encoding, Accept");
    assert.match(await response.text(), /# Hello\s+World/);
  }
  for (const accept of ["", "text/html, text/markdown;q=0.5", "text/markdown;q=0"]) {
    const response = await maybeMarkdown(request(accept), html());
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /<h1>Hello<\/h1>/);
  }
});

test("HEAD negotiates headers and other responses are untouched", async () => {
  const head = await maybeMarkdown(request("text/markdown", "HEAD"), html());
  assert.equal(head.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await head.text(), "");
  for (const response of [new Response("{}", { headers: { "Content-Type": "application/json" } }), new Response("missing", { status: 404, headers: { "Content-Type": "text/html" } }), new Response(null, { status: 302, headers: { Location: "/" } })]) {
    assert.equal(await maybeMarkdown(request("text/markdown"), response), response);
  }
  const post = html();
  assert.equal(await maybeMarkdown(request("text/markdown", "POST"), post), post);
});
