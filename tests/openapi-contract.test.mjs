import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
export const doc = JSON.parse(
  readFileSync(new URL("../public/openapi.json", import.meta.url)),
);
const resolve = (ref) => {
  assert.ok(ref.startsWith("#/"), `External ref: ${ref}`);
  let value = doc;
  for (const key of ref.slice(2).split("/"))
    value = value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")];
  assert.ok(value, `Unresolved ${ref}`);
  return value;
};
export function validate(value, schema, at = "$") {
  if (schema.$ref) return validate(value, resolve(schema.$ref), at);
  if (schema.anyOf || schema.oneOf) {
    const matches = (schema.anyOf || schema.oneOf).filter((s) => {
      try {
        validate(value, s, at);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(
      schema.oneOf ? matches.length === 1 : matches.length > 0,
      `${at}: no matching union`,
    );
    return;
  }
  if (schema.allOf) for (const s of schema.allOf) validate(value, s, at);
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, at);
  if (schema.enum)
    assert.ok(
      schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)),
      `${at}: enum`,
    );
  const type =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number" && Number.isInteger(value)
          ? "integer"
          : typeof value;
  if (schema.type)
    assert.ok(
      [schema.type]
        .flat()
        .some((t) => t === type || (t === "number" && type === "integer")),
      `${at}: expected ${schema.type}, got ${type}`,
    );
  if (typeof value === "number") {
    if (schema.minimum !== undefined)
      assert.ok(value >= schema.minimum, `${at}: minimum`);
    if (schema.maximum !== undefined)
      assert.ok(value <= schema.maximum, `${at}: maximum`);
  }
  if (typeof value === "string") {
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), at);
    if (schema.minLength !== undefined)
      assert.ok([...value].length >= schema.minLength, at);
    if (schema.maxLength !== undefined)
      assert.ok([...value].length <= schema.maxLength, at);
    if (schema.format === "date-time")
      assert.ok(!Number.isNaN(Date.parse(value)), at);
    if (schema.format === "uuid")
      assert.match(value, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, at);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined)
      assert.ok(value.length >= schema.minItems, at);
    if (schema.maxItems !== undefined)
      assert.ok(value.length <= schema.maxItems, at);
    if (schema.uniqueItems)
      assert.equal(
        new Set(value.map((v) => JSON.stringify(v))).size,
        value.length,
        at,
      );
    value.forEach((v, i) => validate(v, schema.items, `${at}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const key of schema.required || [])
      assert.ok(Object.hasOwn(value, key), `${at}.${key}: required`);
    for (const [key, v] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validate(v, child, `${at}.${key}`);
      else if (schema.additionalProperties === false)
        assert.fail(`${at}.${key}: unexpected field`);
      else if (typeof schema.additionalProperties === "object")
        validate(v, schema.additionalProperties, `${at}.${key}`);
    }
  }
}
test("every success response has a precise schema and valid examples", () => {
  for (const [path, item] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(item)) {
      const successes = Object.entries(op.responses).filter(
        ([s]) => +s >= 200 && +s < 300,
      );
      assert.ok(successes.length, `${method} ${path}: no success`);
      for (const [status, response] of successes) {
        if (status === "204") {
          assert.ok(!response.content);
          continue;
        }
        assert.ok(
          response.content?.["application/json"],
          `${method} ${path} ${status}: JSON missing`,
        );
        for (const media of Object.values(response.content)) {
          assert.ok(media.schema, `${path}: schema missing`);
          assert.notEqual(media.schema.$ref, "#/components/schemas/Object");
          const schema = media.schema.$ref
            ? resolve(media.schema.$ref)
            : media.schema;
          assert.ok(
            schema.properties || schema.anyOf || schema.oneOf,
            `${path}: unstructured success`,
          );
          const examples = media.examples
            ? Object.values(media.examples).map((e) => e.value)
            : [media.example];
          assert.ok(
            examples.length && examples.every((e) => e !== undefined),
            `${path}: example missing`,
          );
          for (const example of examples)
            validate(example, media.schema, `${method} ${path} ${status}`);
        }
      }
    }
});
test("every reference resolves", () => {
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) resolve(value.$ref);
    Object.values(value).forEach(walk);
  }
  walk(doc);
});
test("validator rejects invalid types, required fields, unions and constraints", () => {
  for (const [value, schema] of [
    [{}, { type: "object", required: ["id"] }],
    [1, { type: "string" }],
    ["bad", { anyOf: [{ type: "integer" }, { type: "null" }] }],
    [2, { type: "integer", maximum: 1 }],
    ["x", { type: "string", pattern: "^amb_" }],
    [{ extra: 1 }, { type: "object", additionalProperties: false }],
  ])
    assert.throws(() => validate(value, schema));
});

// Internal/browser/operator surfaces intentionally absent from the agent contract.
const undocumented = [
  "/health",
  "/session",
  "/admin/usage",
  "/moderation/queue",
  "/moderation/accounts/{agent}",
  "/moderation/history",
  "/moderation/actions",
  "/contribution-bridge/queue",
  "/contribution-bridge/{id}",
  "/contribution-bridge/reviews/sync",
  "/contribution-bridge/reviews/ack",
  // GET /threads/{thread}/messages is an alias of the documented thread read.
  "/threads/{thread}/messages",
];
test("documented paths agree with worker route dispatchers", () => {
  const literals = new Set(),
    patterns = [];
  for (const file of [
    "index",
    "network",
    "chat",
    "dao",
    "moderation",
    "contributions",
    "reviews",
  ]) {
    const source = readFileSync(
      new URL(`../worker/${file}.ts`, import.meta.url),
      "utf8",
    );
    if (file === "chat")
      for (const m of source.matchAll(/path === "([^"]+)"/g))
        literals.add("/chat" + m[1]);
    for (const match of source.matchAll(/["'](\/v1\/[^"'\n]+)["']/g)) {
      if (!match[1].endsWith("/") && match[1] !== "/v1/chat")
        literals.add(match[1].slice(3));
    }
    for (const match of source.matchAll(
      /path\.match\(\s*(\/\^[\s\S]*?\$\/[a-z]*)\s*[,)]/g,
    )) {
      patterns.push({
        re: vm.runInNewContext(match[1]),
        prefix: file === "chat" ? "/v1/chat" : "",
      });
    }
  }
  const concrete = (path) =>
    path
      .replace(/\{message\}/g, "123")
      .replace(/\{[^}]+\}/g, "11111111-1111-4111-a111-111111111111");
  const handled = (path) =>
    literals.has(path) ||
    patterns.some(({ re, prefix }) =>
      re.test(("/v1" + concrete(path)).slice(prefix.length)),
    );
  const indexSource = readFileSync(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  const rewriteSource = indexSource.slice(
    indexSource.indexOf("function getWriteRequest("),
    indexSource.indexOf("async function router("),
  );
  const rewrite = vm.runInNewContext(
    stripTypeScriptTypes(rewriteSource) + ";getWriteRequest",
    {
      URL,
      Request,
      Headers,
      fail: (status, message) => {
        throw Error(`${status}: ${message}`);
      },
    },
  );
  for (const path of Object.keys(doc.paths)) {
    if (path.startsWith("/get/")) {
      const url = new URL("/v1" + concrete(path), "http://127.0.0.1:8830");
      if (path.endsWith("/threads") || path.endsWith("/messages"))
        url.searchParams.set("request_id", "amb_example_request");
      const request = rewrite(
        new Request(url, {
          headers: { authorization: "Bearer amb_example_do_not_use" },
        }),
      );
      const target = request.url
        .slice(new URL(request.url).origin.length)
        .split("?")[0]
        .slice(3);
      assert.ok(handled(target), `Unhandled compatibility target ${path}`);
      const template = Object.keys(doc.paths).find(
        (p) => concrete(p) === target,
      );
      assert.ok(
        doc.paths[template]?.[request.method.toLowerCase()],
        `Undocumented compatibility method ${request.method} ${target}`,
      );
    } else assert.ok(handled(path), `Unhandled documented path ${path}`);
  }
  for (const path of literals)
    assert.ok(
      Object.hasOwn(doc.paths, path) || undocumented.includes(path),
      `Undocumented literal route ${path}`,
    );
  // Every literal alternative in a dispatch family must also be represented.
  // This catches new suffixes added to an existing route regex.
  for (const { re, prefix } of patterns) {
    const candidates = [...Object.keys(doc.paths), ...undocumented].filter(
      (p) => re.test(("/v1" + concrete(p)).slice(prefix.length)),
    );
    for (const group of re.source.matchAll(
      /\((?:\?:)?([a-z]+(?:\|[a-z]+)+)\)/g,
    )) {
      for (const suffix of group[1].split("|"))
        assert.ok(
          candidates.some((p) => p.split("/").includes(suffix)),
          `Undocumented route alternative ${suffix} in ${re}`,
        );
    }
  }
  // Each route regex must have a documented or explicitly excluded representative;
  // new dispatch families therefore require a contract decision.
  for (const { re, prefix } of patterns)
    assert.ok(
      [...Object.keys(doc.paths), ...undocumented].some((p) =>
        re.test(("/v1" + concrete(p)).slice(prefix.length)),
      ),
      `Unaccounted dispatcher ${re}`,
    );
});
