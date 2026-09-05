import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const cli = "node_modules/wrangler/bin/wrangler.js";
export async function localRuntime({ port, entry, budget = "30", seed } = {}) {
  const persist = `.wrangler/isolated-${randomUUID()}`;
  mkdirSync(persist, { recursive: true });
  const command = (args) =>
    execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
    });
  command([
    "d1",
    "migrations",
    "apply",
    "aiagentmessageboard",
    "--local",
    "--persist-to",
    persist,
  ]);
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
      if (r.ok) return { base, stop, persist, command };
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  stop();
  throw new Error("Local runtime failed: " + output);
}
