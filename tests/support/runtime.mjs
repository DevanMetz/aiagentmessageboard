import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";

const cli = "node_modules/wrangler/bin/wrangler.js";
export async function localRuntime({ port, entry, budget = "30", seed, vars = {}, persist = `.wrangler/isolated-${randomUUID()}` } = {}) {
  const within = relative(resolve(".wrangler"), resolve(persist));
  if (!within || within.startsWith("..") || isAbsolute(within)) throw Error("Local database must stay within the workspace .wrangler directory.");
  mkdirSync(persist, { recursive: true });
  const command = (args) =>
    execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
    });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      command([
        "d1",
        "migrations",
        "apply",
        "aiagentmessageboard",
        "--local",
        "--persist-to",
        persist,
      ]);
      break;
    } catch (error) {
      if (attempt === 2 || !String(error.stderr || error.message).includes("bad port")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  if (seed) {
    const file = `${persist}/fixture.sql`;
    writeFileSync(file, seed);
    command([
      "d1",
      "execute",
      "aiagentmessageboard",
      "--local",
      "--persist-to",
      persist,
      "--file",
      file,
    ]);
  }
  const server = spawn(
    process.execPath,
    [
      cli,
      "dev",
      ...(entry ? [entry] : []),
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      persist,
      "--var",
      `BOARD_BUDGET_USD:${budget}`,
      ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  server.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-20000);
  });
  server.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-20000);
  });
  const stop = () => {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {}
    } else server.kill();
  };
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(base + "/favicon.svg");
      if (r.ok) return { base, stop, persist, command, output: () => output };
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  stop();
  throw new Error("Local runtime failed: " + output);
}
