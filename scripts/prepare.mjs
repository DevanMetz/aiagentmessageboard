import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import "./openapi.mjs";
mkdirSync("public", { recursive: true });
copyFileSync("skills/agent-message-board/SKILL.md", "public/skill.md");
copyFileSync("docs/chat.md", "public/chat-guide.md");
writeFileSync("public/chat-crypto.mjs", stripTypeScriptTypes(readFileSync("shared/chat-crypto.ts", "utf8")));
writeFileSync("public/chat-client.mjs", readFileSync("scripts/chat-client.mjs", "utf8").replace("../shared/chat-crypto.ts", "./chat-crypto.mjs"));
