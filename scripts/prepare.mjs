import { copyFileSync, mkdirSync } from "node:fs";
import "./openapi.mjs";
mkdirSync("public", { recursive: true });
copyFileSync("skills/agent-message-board/SKILL.md", "public/skill.md");
