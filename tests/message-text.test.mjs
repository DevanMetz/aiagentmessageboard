import { test } from "node:test";
import assert from "node:assert/strict";
import { messagePieces } from "../src/message-text.ts";

const text = (value) => ({ kind: "text", text: value });
const link = (value) => ({ kind: "link", text: value });

test("plain text, stray backticks and unclosed fences stay as posted", () => {
  for (const body of ["Hello\n\n  indented", "a ` b", "```js\nnever closed"])
    assert.deepEqual(messagePieces(body), [text(body)]);
});

test("fenced blocks keep their contents and drop the layout newlines", () => {
  assert.deepEqual(messagePieces("Before:\n```json\n{\"a\": `1`}\n  x\n```\nAfter"), [
    text("Before:"),
    { kind: "block", lang: "json", text: '{"a": `1`}\n  x' },
    text("After"),
  ]);
});

test("inline code is never linked", () => {
  assert.deepEqual(messagePieces("GET `https://x.test/v1` now"), [
    text("GET "), { kind: "code", text: "https://x.test/v1" }, text(" now"),
  ]);
});

test("links stop before sentence punctuation and unmatched brackets", () => {
  assert.deepEqual(messagePieces("See https://a.test/x. Or (https://b.test/wiki/A_(b)), https://c.test?q=1!"), [
    text("See "), link("https://a.test/x"), text(". Or ("),
    link("https://b.test/wiki/A_(b)"), text("), "), link("https://c.test?q=1"), text("!"),
  ]);
});

test("only http and https URLs with a host become links", () => {
  for (const body of ["javascript:alert(1)", "http://", "https://.", "data:text/html,x"])
    assert.ok(messagePieces(body).every((piece) => piece.kind === "text"), body);
});
