import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { JsonRpcProvider, Contract, ContractFactory, ZeroAddress, ZeroHash, keccak256, parseEther } from "ethers";
import { evidenceDigest } from "../../shared/dao.ts";

const manifest = JSON.parse(readFileSync("deployments/robinhood-testnet.json", "utf8"));
const artifacts = JSON.parse(readFileSync("build/dao/artifacts.json", "utf8"));
const provider = new JsonRpcProvider(manifest.rpcUrl, undefined, { cacheTimeout: -1 });
try {
  assert.equal(Number((await provider.getNetwork()).chainId), 46630);
  const contracts = {};
  const constructors = {
    AAMBToken: [manifest.addresses.deployer],
    TimelockController: [manifest.timings.timelock, [], [], manifest.addresses.deployer],
    AAMBGovernor: [manifest.token, manifest.treasury, manifest.timings.delay, manifest.timings.period],
    AAMBTaskEscrow: [manifest.token, manifest.treasury],
  };
  for (const [name, address] of Object.entries(manifest.contracts)) {
    const recorded = manifest.deploymentTransactions[name];
    const receipt = await provider.getTransactionReceipt(recorded.hash);
    assert.equal(receipt.status, 1);
    assert.equal(receipt.contractAddress.toLowerCase(), address.toLowerCase());
    assert.equal(keccak256(await provider.getCode(address)), recorded.runtimeCodeHash);
    const creation = await provider.getTransaction(recorded.hash);
    const expected = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode).getDeployTransaction(...constructors[name]);
    assert.equal(creation.data, expected.data, `Recompiled creation bytecode and constructor arguments must match ${name}.`);
    contracts[name] = new Contract(address, artifacts[name].abi, provider);
  }
  const token = contracts.AAMBToken, governor = contracts.AAMBGovernor, treasury = contracts.TimelockController, escrow = contracts.AAMBTaskEscrow;
  assert.equal(await token.symbol(), "AAMB");
  assert.equal(await token.name(), "AI Agent Message Board");
  assert.equal(await token.totalSupply(), parseEther("1000000"));
  assert.equal(await token.CLOCK_MODE(), "mode=timestamp");
  assert.equal(await governor.votingDelay(), 30n);
  assert.equal(await governor.votingPeriod(), 120n);
  assert.equal(await governor.proposalThreshold(), parseEther("100"));
  assert.equal(await governor.quorumNumerator(), 10n);
  assert.equal((await governor.token()).toLowerCase(), manifest.token.toLowerCase());
  assert.equal((await governor.timelock()).toLowerCase(), manifest.treasury.toLowerCase());
  assert.equal(await treasury.getMinDelay(), 30n);
  assert.equal(await treasury.hasRole(ZeroHash, manifest.addresses.deployer), false);
  assert.equal(await treasury.hasRole(ZeroHash, manifest.treasury), true);
  assert.equal(await treasury.hasRole(await treasury.PROPOSER_ROLE(), manifest.governor), true);
  assert.equal(await treasury.hasRole(await treasury.CANCELLER_ROLE(), manifest.governor), true);
  assert.equal(await treasury.hasRole(await treasury.EXECUTOR_ROLE(), ZeroAddress), true);
  assert.equal((await escrow.treasury()).toLowerCase(), manifest.treasury.toLowerCase());
  assert.equal((await escrow.token()).toLowerCase(), manifest.token.toLowerCase());
  const prior = existsSync("reports/dao-testnet-verification.json") ? JSON.parse(readFileSync("reports/dao-testnet-verification.json", "utf8")) : {};
  const report = { chainId: 46630, checkedAt: new Date().toISOString(), blockNumber: await provider.getBlockNumber(), assertions: "All deployment receipts, recompiled creation bytecode plus constructor arguments, recorded runtime hashes, fixed supply, timestamp clock, governor settings, timelock ownership/roles, and escrow wiring passed.", contracts: manifest.contracts, sourceVerification: prior.sourceVerification || [], explorerVerificationNote: "Explorer submissions failed. Its verification UI on 2026-09-18 lists compilers only through 0.8.36; this deployment uses 0.8.37. Local bytecode comparison passes; public source verification remains outstanding." };
  if (existsSync("reports/dao-testnet-cycle.json")) {
    const cycle = JSON.parse(readFileSync("reports/dao-testnet-cycle.json", "utf8"));
    for (const step of cycle.receipts) assert.equal((await provider.getTransactionReceipt(step.transactionHash))?.status, 1);
    const receipt = await provider.getTransactionReceipt(cycle.receipts.find(r => r.step === "Approve and pay").transactionHash);
    const paid = receipt.logs.filter(l => l.address.toLowerCase() === manifest.escrow.toLowerCase()).map(l => escrow.interface.parseLog(l)).find(l => l?.name === "RewardPaid");
    assert.ok(paid);
    assert.equal(paid.args.taskId, cycle.taskId);
    assert.equal(paid.args.worker.toLowerCase(), cycle.workerAddress.toLowerCase());
    assert.equal(paid.args.reward, parseEther(cycle.reward));
    assert.equal(paid.args.evidenceHash, cycle.evidenceHash);
    const task = await escrow.tasks(cycle.taskId);
    assert.equal(task.status, 4n);
    assert.equal(await governor.state(cycle.proposalId), 7n);
    assert.equal(await token.balanceOf(cycle.workerAddress), BigInt(cycle.workerBalanceAfter));
    assert.equal(BigInt(cycle.workerBalanceAfter) - BigInt(cycle.workerBalanceBefore), paid.args.reward);
    if (!cycle.evidenceContent) {
      const response = await fetch(`${cycle.boardBase}/v1/threads/${cycle.threadId}?after=${cycle.evidenceMessageId - 1}`);
      const evidence = (await response.json()).messages.find(m => m.id === cycle.evidenceMessageId);
      cycle.evidenceContent = evidence.content;
      cycle.evidenceAuthorId = evidence.author_id;
    }
    assert.equal(evidenceDigest(cycle.threadId, cycle.evidenceMessageId, cycle.evidenceAuthorId, cycle.evidenceContent), cycle.evidenceHash);
    cycle.rewardEventVerified = true;
    cycle.reverifiedAt = new Date().toISOString();
    writeFileSync("reports/dao-testnet-cycle.json", JSON.stringify(cycle, null, 2) + "\n");
    report.cycleVerification = "Eight successful receipts, Executed proposal, Paid escrow, exact reward event and balance delta, and independently reconstructed evidence hash passed.";
  }
  if (process.argv.includes("--publish-source")) {
    report.sourceVerification = [];
    const input = readFileSync("build/dao/standard-input.json", "utf8");
    const compiler = JSON.parse(readFileSync("build/dao/compiler.json", "utf8")).version;
    for (const [name, address] of Object.entries(manifest.contracts)) {
      const file = name === "TimelockController" ? "@openzeppelin/contracts/governance/TimelockController.sol" : `contracts/${name}.sol`;
      const body = new URLSearchParams({ module: "contract", action: "verifysourcecode", codeformat: "solidity-standard-json-input", contractaddress: address, contractname: `${file}:${name}`, compilerversion: "v" + compiler.replace(/\.Emscripten.*$/, ""), sourceCode: input, autodetectConstructorArguments: "true" });
      const response = await fetch(manifest.explorerUrl + "/api", { method: "POST", body, signal: AbortSignal.timeout(45000) });
      const result = await response.json();
      report.sourceVerification.push({ name, address, submission: result });
      console.log(`${name}: ${JSON.stringify(result)}`);
    }
  }
  writeFileSync("reports/dao-testnet-verification.json", JSON.stringify(report, null, 2) + "\n");
  console.log(report.assertions);
} finally { provider.destroy(); }
