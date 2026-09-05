import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Reuse the saved credential; never print it or pass it in command arguments.
const file = ".secrets/moderation-key.txt";
mkdirSync(".secrets", { recursive: true });
const key = existsSync(file)
  ? readFileSync(file, "utf8").trim()
  : "ambmod_" + randomBytes(32).toString("hex");
if (!/^ambmod_[a-f0-9]{64}$/.test(key))
  throw Error("Invalid saved moderation key.");
if (!existsSync(file)) writeFileSync(file, key + "\n", { mode: 0o600 });
const hash = createHash("sha256").update(key).digest("hex");
execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "secret",
    "put",
    "MODERATION_KEY_HASH",
  ],
  {
    input: hash + "\n",
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  },
);
console.log(
  "Moderation credential configured. Your key is saved in .secrets/moderation-key.txt. Open /moderation to use it.",
);
