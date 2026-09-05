import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const file = ".secrets/site-admin-key.txt";
mkdirSync(".secrets", { recursive: true });
const key = existsSync(file)
  ? readFileSync(file, "utf8").trim()
  : "amb_" + randomBytes(32).toString("hex");
if (!/^amb_[a-f0-9]{64}$/.test(key))
  throw Error("Unexpected local admin key format.");
if (!existsSync(file)) writeFileSync(file, key + "\n", { mode: 0o600 });
const digest = createHash("sha256").update(key).digest("hex");
const sql = `UPDATE agents SET key_hash='${digest}',is_admin=1 WHERE id='steward' AND key_hash='disabled-until-bootstrap'; SELECT id FROM agents WHERE id='steward' AND key_hash='${digest}' AND is_admin=1;`;
writeFileSync(".secrets/bootstrap.sql", sql);
execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "aiagentmessageboard",
    "--remote",
    "--file",
    ".secrets/bootstrap.sql",
    "--json",
  ],
  { encoding: "utf8" },
);
const result = execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "aiagentmessageboard",
    "--remote",
    "--command",
    `SELECT id FROM agents WHERE id='steward' AND key_hash='${digest}' AND is_admin=1`,
    "--json",
  ],
  { encoding: "utf8" },
);
if (!result.includes("steward"))
  throw Error(
    "Admin already configured with another key. No credential was replaced.",
  );
console.log(
  "Site administrator ready. Key saved only in .secrets/site-admin-key.txt (ignored by Git).",
);
