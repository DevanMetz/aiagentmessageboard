import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Wallet, NonceManager, JsonRpcProvider } from "ethers";
import { localRuntime } from "../../tests/support/runtime.mjs";
import { demonstrateCycle } from "./cycle.mjs";

const checkpointFile = ".secrets/aamb-testnet-cycle.json";
const resume = existsSync(checkpointFile) ? JSON.parse(readFileSync(checkpointFile, "utf8")) : undefined;
if (resume && !process.argv.includes("--resume")) throw Error("A testnet cycle checkpoint already exists. Inspect its transactions and database, then use --resume for that same cycle.");
const config = JSON.parse(readFileSync("deployments/robinhood-testnet.json", "utf8"));
if (!config.deployed || config.chainId !== 46630) throw Error("A complete Robinhood testnet deployment is required.");
const privateState = JSON.parse(readFileSync(".secrets/aamb-testnet-wallets.json", "utf8"));
const provider = new JsonRpcProvider(process.env.AAMB_RPC_URL || config.rpcUrl, undefined, { cacheTimeout: -1 });
let runtime, completed = false;
try {
  if (Number((await provider.getNetwork()).chainId) !== 46630) throw Error("Wrong chain: refusing to sign.");
  const signers = Object.fromEntries(Object.entries(privateState.wallets).map(([role, value]) => [role, new NonceManager(new Wallet(value.privateKey, provider))]));
  if (resume && (resume.chainId !== 46630 || resume.proposal?.proposal.governor.toLowerCase() !== config.governor.toLowerCase())) throw Error("Checkpoint deployment does not match.");
  runtime = await localRuntime({ port: 8818, persist: resume?.database, vars: { AAMB_DEPLOYMENT: JSON.stringify({ ...config, boardOrigin: "http://127.0.0.1:8818" }) } });
  console.log(`Testnet-connected board: ${runtime.base}/dao`);
  const result = await demonstrateCycle({ base: runtime.base, config, signers, resume,
    onStep: (label, receipt) => console.log(`${label}: ${config.explorerUrl}/tx/${receipt.transactionHash}`),
    onCheckpoint: state => writeFileSync(checkpointFile, JSON.stringify({ ...state, chainId: 46630, database: runtime.persist, base: runtime.base }, null, 2) + "\n", { mode: 0o600 }),
  });
  writeFileSync("reports/dao-testnet-cycle.json", JSON.stringify({ ...result, database: runtime.persist, note: "Actual Robinhood testnet transactions, with board/API on an isolated local Worker. Demonstration roles have separate keys controlled by this developer; this is not proof of independent participants." }, null, 2) + "\n");
  completed = true;
  console.log(`Verified: ${result.reward} AAMB paid to ${result.workerAddress}. Task status: ${result.taskStatus}.`);
  console.log(`Review: ${runtime.base}/dao?task=${result.threadId}`);
  if (process.argv.includes("--serve")) {
    console.log("Keeping the board available for browser review. Ctrl+C stops the local server; testnet contracts and the local database remain.");
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} finally { runtime?.stop(); provider.destroy(); if (!completed) console.error("Cycle incomplete. Existing state was preserved in the private checkpoint; inspect it before recovery."); }
