import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Wallet, JsonRpcProvider, NonceManager, Contract, formatEther, parseEther, keccak256 } from "ethers";
import { compile } from "./compile.mjs";
import { deployDAO, mined } from "./deploy.mjs";

const keyFile = ".secrets/aamb-testnet-wallets.json";
const manifestFile = "deployments/robinhood-testnet.json";
const rpcUrl = process.env.AAMB_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
mkdirSync(".secrets", { recursive: true });
mkdirSync("deployments", { recursive: true });
if (!existsSync(keyFile)) {
  const wallets = Object.fromEntries(["deployer", "holder", "delegate", "worker", "reviewer"].map(role => {
    const wallet = Wallet.createRandom(); return [role, { address: wallet.address, privateKey: wallet.privateKey }];
  }));
  writeFileSync(keyFile, JSON.stringify({ testnetOnly: true, chainId: 46630, wallets }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
const privateState = JSON.parse(readFileSync(keyFile, "utf8"));
if (!privateState.testnetOnly || privateState.chainId !== 46630) throw Error("Expected isolated testnet-only wallets.");
const addresses = Object.fromEntries(Object.entries(privateState.wallets).map(([k, v]) => [k, v.address]));
writeFileSync("deployments/testnet-wallets.json", JSON.stringify({ chainId: 46630, testnetOnly: true, addresses }, null, 2) + "\n");
const action = process.argv[2] || "wallets";
const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
try {
  if (Number((await provider.getNetwork()).chainId) !== 46630) throw Error("Refusing any network other than Robinhood Chain Testnet (46630).");
  const balance = await provider.getBalance(addresses.deployer);
  if (action === "wallets") {
    console.log(JSON.stringify({ chainId: 46630, addresses, deployerTestEth: formatEther(balance), faucet: "https://faucet.testnet.chain.robinhood.com" }, null, 2));
  } else if (action === "deploy") {
    // Never silently replace a partially deployed DAO after a timeout/interruption.
    if (existsSync(manifestFile)) throw Error(`Deployment record already exists at ${manifestFile}. Inspect it before any further deployment.`);
    if (balance < parseEther("0.003")) throw Error(`Fund ${addresses.deployer} with at least 0.003 TEST ETH from the faucet, then retry.`);
    const signers = Object.fromEntries(Object.entries(privateState.wallets).map(([k, v]) => [k, new NonceManager(new Wallet(v.privateKey, provider))]));
    for (const role of ["holder", "delegate", "worker", "reviewer"]) {
      const available = await provider.getBalance(addresses[role]);
      if (available < parseEther("0.0001")) await mined(signers.deployer.sendTransaction({ to: addresses[role], value: parseEther("0.0002") - available }));
    }
    const artifacts = compile();
    const manifest = { name: "AI Agent Message Board DAO", symbol: "AAMB", network: "Robinhood Chain Testnet", chainId: 46630, rpcUrl: "https://rpc.testnet.chain.robinhood.com", explorerUrl: "https://explorer.testnet.chain.robinhood.com", deployed: false, addresses, contracts: {}, deploymentTransactions: {}, createdAt: new Date().toISOString() };
    const save = () => writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    save();
    const dao = await deployDAO({ artifacts, deployer: signers.deployer, holder: signers.holder, onDeployment: async (name, contract, receipt) => {
      manifest.contracts[name] = contract.target;
      manifest.deploymentTransactions[name] = { hash: contract.deploymentTransaction().hash, blockNumber: receipt?.blockNumber ?? null, runtimeCodeHash: receipt ? keccak256(await provider.getCode(contract.target)) : null };
      save(); if (receipt) console.log(`${name}: ${contract.target} (${receipt.hash})`);
    } });
    manifest.configurationTransactions = dao.receipts.map(r => r.hash);
    manifest.timings = dao.timings;
    manifest.deployed = true;
    manifest.token = dao.token.target;
    manifest.governor = dao.governor.target;
    manifest.treasury = dao.treasury.target;
    manifest.escrow = dao.escrow.target;
    manifest.deploymentBlock = Math.min(...Object.values(manifest.deploymentTransactions).map(r => r.blockNumber));
    save();
    writeFileSync("shared/dao-deployment.json", JSON.stringify(manifest, null, 2) + "\n");
    console.log("Testnet deployment configured. Build the board to use this manifest.");
  } else if (action === "status") {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const token = new Contract(manifest.token, ["function balanceOf(address) view returns(uint256)"], provider);
    console.log(JSON.stringify({ deployment: manifest, workerRewardBalance: formatEther(await token.balanceOf(addresses.worker)) }, null, 2));
  } else throw Error("Use wallets, deploy, or status.");
} finally { provider.destroy(); }
