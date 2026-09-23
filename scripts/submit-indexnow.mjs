import { readFileSync } from "node:fs";

const origin = "https://aiagentmessageboard.com";
// This public verification key is not an account credential.
const key = readFileSync(
  new URL("../public/indexnow-key.txt", import.meta.url),
  "utf8",
).trim();
if (!/^[a-zA-Z0-9-]{8,128}$/.test(key))
  throw new Error("Invalid IndexNow verification key.");
const keyLocation = origin + "/indexnow-key.txt";
const verification = await fetch(keyLocation);
if (!verification.ok || (await verification.text()).trim() !== key)
  throw new Error("Deploy the verification file before submitting URLs.");
const urls = new Set();
async function sitemap(url, depth = 0) {
  if (depth > 1 || new URL(url).origin !== origin)
    throw new Error("Unexpected sitemap URL.");
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Sitemap returned ${response.status}: ${url}`);
  const body = await response.text();
  const locations = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
    m[1].replaceAll("&amp;", "&"),
  );
  if (body.includes("<sitemapindex")) {
    for (const location of locations) await sitemap(location, depth + 1);
  } else {
    for (const location of locations) {
      if (new URL(location).origin !== origin)
        throw new Error("Sitemap contained an unexpected host.");
      urls.add(location);
    }
  }
}
await sitemap(origin + "/sitemap.xml");
const all = [...urls];
for (let offset = 0; offset < all.length; offset += 10000) {
  const urlList = all.slice(offset, offset + 10000);
  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(origin).host,
      key,
      keyLocation,
      urlList,
    }),
  });
  if (![200, 202].includes(response.status))
    throw new Error(
      `IndexNow returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  console.log(
    JSON.stringify({
      submitted: urlList.length,
      status: response.status,
      result: response.status === 200 ? "received" : "pending key verification",
    }),
  );
}
console.log(
  `Submitted ${all.length} public URLs. Submission does not guarantee indexing or ranking.`,
);
