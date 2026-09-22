import { test } from "node:test";
import { network } from "hardhat";
import { JsonRpcProvider } from "ethers";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { compile } from "../scripts/dao/compile.mjs";
import { deployDAO } from "../scripts/dao/deploy.mjs";
import { demonstrateCycle } from "../scripts/dao/cycle.mjs";
import { localRuntime } from "./support/runtime.mjs";

test("board accounts and actual contracts complete the full DAO cycle; signatures, immutable terms, and reviewer boundaries are enforced", { timeout: 180000 }, async () => {
  const server = await network.createServer("default", "127.0.0.1");
  const { port } = await server.listen();
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  let unavailableBlockInjected = false;
  const proxy = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      if (!unavailableBlockInjected && rpc.method === "eth_getBlockByNumber") {
        unavailableBlockInjected = true;
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: null }));
      } else {
        const upstream = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        res.end(await upstream.text());
      }
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  let runtime;
  try {
    const accounts = await Promise.all(Array.from({ length: 5 }, (_, i) => provider.getSigner(i)));
    const signers = Object.fromEntries(["deployer", "holder", "delegate", "worker", "reviewer"].map((role, i) => [role, accounts[i]]));
    const dao = await deployDAO({ artifacts: compile(), deployer: signers.deployer, holder: signers.holder, timings: { delay: 5, period: 20, timelock: 5 } });
    const config = { name: "AI Agent Message Board DAO", symbol: "AAMB", network: "Local EVM integration test", chainId: 31337, rpcUrl: `http://127.0.0.1:${proxy.address().port}`, explorerUrl: "", deployed: true, token: dao.token.target, governor: dao.governor.target, treasury: dao.treasury.target, escrow: dao.escrow.target, timings: dao.timings };
    runtime = await localRuntime({ port: 8817, vars: { AAMB_DEPLOYMENT: JSON.stringify({ ...config, boardOrigin: "http://127.0.0.1:8817" }), AAMB_LOCAL_TEST: "true" } });
    let checkpoint;
    const advance = async seconds => { await provider.send("evm_increaseTime", [seconds]); await provider.send("evm_mine", []); await provider.send("evm_mine", []); };
    const result = await demonstrateCycle({ base: runtime.base, config, signers, adversarial: true, advance, onCheckpoint: state => { checkpoint = structuredClone(state); } });
    assert.equal(unavailableBlockInjected, true);
    const resumed = await demonstrateCycle({ base: runtime.base, config, signers, advance, resume: checkpoint });
    assert.deepEqual(resumed.receipts, result.receipts, "Recovery must reuse confirmed transactions.");
    assert.equal(resumed.workerBalanceAfter, result.workerBalanceAfter, "Recovery must not pay twice.");
    writeFileSync("reports/dao-local-cycle.json", JSON.stringify({ ...result, note: "Real contracts on a local EVM plus isolated local Worker/D1. This is not Robinhood testnet evidence." }, null, 2) + "\n");
  } finally { runtime?.stop(); provider.destroy(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await server.close(); }
});
