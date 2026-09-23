import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { BrowserProvider, parseEther, id, ZeroHash, ZeroAddress } from "ethers";
import { compile } from "../scripts/dao/compile.mjs";
import { deployDAO, mined } from "../scripts/dao/deploy.mjs";

let connection, provider, accounts, dao;
before(async () => {
  connection = await network.create("default");
  provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  accounts = await Promise.all(Array.from({ length: 7 }, (_, i) => provider.getSigner(i)));
  dao = await deployDAO({ artifacts: compile(), deployer: accounts[0], holder: accounts[1], timings: { delay: 5, period: 20, timelock: 5 } });
});
after(async () => { provider?.destroy(); await connection?.close(); });
async function advance(seconds) { await provider.send("evm_increaseTime", [seconds]); await provider.send("evm_mine", []); }
async function fund(taskId, { reviewer = accounts[4].address, deadline, reward = parseEther("100") } = {}) {
  const { token, governor, treasury, escrow } = dao;
  deadline ??= (await provider.getBlock("latest")).timestamp + 10000;
  const targets = [token.target, escrow.target], values = [0, 0];
  const calls = [token.interface.encodeFunctionData("approve", [escrow.target, reward]), escrow.interface.encodeFunctionData("fundTask", [taskId, reward, reviewer, deadline, id("immutable specification")])];
  const description = `AAMB task ${taskId}`, descriptionHash = id(description);
  await mined(token.connect(accounts[1]).delegate(accounts[2].address));
  await advance(1);
  await mined(governor.connect(accounts[2]).propose(targets, values, calls, description));
  const proposalId = await governor.hashProposal(targets, values, calls, descriptionHash);
  await assert.rejects(mined(governor.connect(accounts[2]).castVote(proposalId, 1)));
  await advance(6);
  await mined(governor.connect(accounts[2]).castVote(proposalId, 1));
  await assert.rejects(mined(governor.connect(accounts[2]).castVote(proposalId, 1)));
  await advance(21);
  assert.equal(await governor.state(proposalId), 4n);
  await mined(governor.queue(targets, values, calls, descriptionHash));
  await assert.rejects(mined(governor.execute(targets, values, calls, descriptionHash)));
  await advance(6);
  await mined(governor.execute(targets, values, calls, descriptionHash));
  assert.equal(await governor.state(proposalId), 7n);
  assert.equal((await escrow.tasks(taskId)).reward, reward);
  assert.equal(await token.allowance(treasury.target, escrow.target), 0n);
  return { proposalId, deadline, reward };
}

test("delegation → vote → timelock → escrow → independent review → exactly one wallet reward", async () => {
  const { token, treasury, governor, escrow } = dao;
  assert.equal(await token.totalSupply(), parseEther("1000000"));
  assert.equal(await token.CLOCK_MODE(), "mode=timestamp");
  assert.equal(await treasury.hasRole(ZeroHash, accounts[0].address), false);
  assert.equal(await treasury.hasRole(await treasury.PROPOSER_ROLE(), governor.target), true);
  assert.equal(await treasury.hasRole(await treasury.EXECUTOR_ROLE(), ZeroAddress), true);
  await assert.rejects(mined(treasury.grantRole(await treasury.PROPOSER_ROLE(), accounts[0].address)));
  await assert.rejects(mined(escrow.fundTask(id("unauthorized"), 1, accounts[4].address, 9999999999, id("spec"))));
  const taskId = id("board/task/full-cycle");
  const { reward } = await fund(taskId);
  await assert.rejects(mined(escrow.connect(accounts[4]).claimTask(taskId, 60)));
  await mined(escrow.connect(accounts[3]).claimTask(taskId, 60));
  await assert.rejects(mined(escrow.connect(accounts[5]).claimTask(taskId, 60)));
  const evidenceHash = id("verified deliverable with proof");
  await assert.rejects(mined(escrow.connect(accounts[3]).submitWork(taskId, ZeroHash)));
  await assert.rejects(mined(escrow.connect(accounts[5]).submitWork(taskId, evidenceHash)));
  await mined(escrow.connect(accounts[3]).submitWork(taskId, evidenceHash));
  await assert.rejects(mined(escrow.connect(accounts[3]).approveWork(taskId, evidenceHash)));
  await assert.rejects(mined(escrow.connect(accounts[4]).approveWork(taskId, id("different evidence"))));
  const before = await token.balanceOf(accounts[3].address);
  const receipt = await mined(escrow.connect(accounts[4]).approveWork(taskId, evidenceHash));
  assert.equal(await token.balanceOf(accounts[3].address) - before, reward);
  assert.equal((await escrow.tasks(taskId)).status, 4n);
  assert.ok(receipt.logs.some(l => { try { return escrow.interface.parseLog(l)?.name === "RewardPaid"; } catch { return false; } }));
  await assert.rejects(mined(escrow.connect(accounts[4]).approveWork(taskId, evidenceHash)));
  await assert.rejects(mined(escrow.refundExpired(taskId)));
});

test("expired claims, independent rejection, and unused-budget recovery preserve escrow accounting", async () => {
  const { token, escrow, treasury } = dao;
  const taskId = id("board/task/recovery");
  const { deadline, reward } = await fund(taskId);
  await mined(escrow.connect(accounts[3]).claimTask(taskId, 10));
  await advance(11);
  await assert.rejects(mined(escrow.connect(accounts[3]).submitWork(taskId, id("late"))));
  await mined(escrow.connect(accounts[5]).claimTask(taskId, 60));
  await mined(escrow.connect(accounts[5]).submitWork(taskId, id("first draft")));
  await assert.rejects(mined(escrow.connect(accounts[3]).rejectWork(taskId, id("first draft"))));
  await mined(escrow.connect(accounts[4]).rejectWork(taskId, id("first draft")));
  assert.equal((await escrow.tasks(taskId)).status, 1n);
  await mined(escrow.connect(accounts[3]).claimTask(taskId, 60));
  await mined(escrow.connect(accounts[3]).releaseTask(taskId));
  await assert.rejects(mined(escrow.refundExpired(taskId)));
  const before = await token.balanceOf(treasury.target);
  await provider.send("evm_setNextBlockTimestamp", [deadline + 1]); await provider.send("evm_mine", []);
  await mined(escrow.connect(accounts[6]).refundExpired(taskId));
  assert.equal(await token.balanceOf(treasury.target) - before, reward);
  await assert.rejects(mined(escrow.connect(accounts[3]).claimTask(taskId, 60)));
  await assert.rejects(mined(escrow.refundExpired(taskId)));
});

test("submitted work gets a bounded review window before governance receives the refund", async () => {
  const taskId = id("board/task/reviewer-offline"), { escrow, token, treasury } = dao;
  const { deadline, reward } = await fund(taskId);
  await mined(escrow.connect(accounts[3]).claimTask(taskId, 100));
  await mined(escrow.connect(accounts[3]).submitWork(taskId, id("awaiting review")));
  await provider.send("evm_setNextBlockTimestamp", [deadline + 1]); await provider.send("evm_mine", []);
  await assert.rejects(mined(escrow.refundExpired(taskId)));
  await advance(Number(await escrow.REVIEW_GRACE()) + 1);
  await assert.rejects(mined(escrow.connect(accounts[4]).approveWork(taskId, id("awaiting review"))));
  const before = await token.balanceOf(treasury.target);
  await mined(escrow.refundExpired(taskId));
  assert.equal(await token.balanceOf(treasury.target) - before, reward);
});

test("transferred tokens cannot vote twice and a proposal without quorum cannot spend", async () => {
  const { token, governor } = dao;
  const targets = [token.target], values = [0];
  const calls = [token.interface.encodeFunctionData("approve", [accounts[6].address, 1])];
  const description = "snapshot voting boundary", hash = id(description);
  await assert.rejects(mined(governor.connect(accounts[6]).propose(targets, values, calls, description)));
  await mined(governor.connect(accounts[2]).propose(targets, values, calls, description));
  const proposal = await governor.hashProposal(targets, values, calls, hash);
  await advance(6);
  await mined(token.connect(accounts[1]).transfer(accounts[5].address, parseEther("200000")));
  await mined(token.connect(accounts[5]).delegate(accounts[6].address));
  await mined(governor.connect(accounts[2]).castVote(proposal, 1));
  await mined(governor.connect(accounts[6]).castVote(proposal, 1));
  assert.equal((await governor.proposalVotes(proposal)).forVotes, parseEther("200000"));
  await mined(token.connect(accounts[5]).transfer(accounts[1].address, parseEther("200000")));
  await advance(21);
  assert.equal(await governor.state(proposal), 4n);
  const secondDescription = "no quorum boundary", secondHash = id(secondDescription);
  await mined(governor.connect(accounts[2]).propose(targets, values, calls, secondDescription));
  const second = await governor.hashProposal(targets, values, calls, secondHash);
  await advance(27);
  assert.equal(await governor.state(second), 3n);
  await assert.rejects(mined(governor.queue(targets, values, calls, secondHash)));
});

test("funding an existing task reverts the entire governance batch without leaking an allowance", async () => {
  const { token, treasury, escrow } = dao;
  const before = await token.balanceOf(treasury.target);
  await assert.rejects(fund(id("board/task/full-cycle")));
  assert.equal(await token.balanceOf(treasury.target), before);
  assert.equal(await token.allowance(treasury.target, escrow.target), 0n);
  assert.equal((await escrow.tasks(id("board/task/full-cycle"))).status, 4n);
});
