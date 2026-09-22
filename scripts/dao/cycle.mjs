import assert from "node:assert/strict";
import { Contract, Interface, parseEther, formatEther, getAddress } from "ethers";
import { tokenInterface, evidenceDigest } from "../../shared/dao.ts";

// Used by both the integration test and the actual testnet demonstration.
// Only the local-EVM caller may supply time travel; live callers wait for real blocks.
export async function demonstrateCycle({ base, config, signers, advance, onStep = () => {}, onCheckpoint = () => {}, adversarial = false, resume = {} }) {
  let ip = 1;
  const receipts = resume.receipts || [], actors = resume.actors || {};
  let { thread, terms, proposal, message, submission, workerBalanceBefore, pending } = resume;
  const checkpoint = () => onCheckpoint({ actors, thread, terms, proposal, message, submission, workerBalanceBefore, pending, receipts });
  const done = label => receipts.some(r => r.step === label);
  async function request(path, method = "GET", body, role) {
    const r = await fetch(base + "/v1" + path, { method, headers: { "Content-Type": "application/json", "cf-connecting-ip": `198.51.100.${ip++ % 250 + 1}`, ...(role ? { Authorization: "Bearer " + actors[role].api_key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json();
    return { status: r.status, data };
  }
  async function call(path, method = "GET", body, role) {
    // These DAO writes only prepare transactions or synchronize state. Retrying
    // a transient RPC failure cannot send or duplicate an on-chain transaction.
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await request(path, method, body, role);
      if ([502, 503, 504].includes(r.status) && path.startsWith("/dao/") && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      if (r.status >= 400) throw Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
      return r.data;
    }
  }
  async function record(label, receipt) {
    assert.ok(receipt, `No receipt for ${label}; preserve the checkpoint and inspect the pending transaction.`);
    assert.equal(receipt.status, 1, `${label} reverted.`);
    receipts.push({ step: label, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, status: receipt.status });
    pending = undefined;
    checkpoint();
    onStep(label, receipts.at(-1));
    if (advance) await advance(1);
    else {
      // Wait until the board's latest-minus-one snapshot includes this receipt.
      while (Number(await signers.worker.provider.send("eth_blockNumber", [])) <= receipt.blockNumber) await new Promise(r => setTimeout(r, 1500));
    }
    return receipt;
  }
  async function sendPrepared(label, role, prepare) {
    if (done(label)) return;
    const response = await prepare();
    const tx = response.transaction;
    assert.equal(tx.chainId, config.chainId);
    assert.ok([config.token, config.governor, config.escrow].map(getAddress).includes(getAddress(tx.to)));
    assert.equal(tx.value, "0x0");
    const sent = await signers[role].sendTransaction({ to: tx.to, data: tx.data, value: 0 });
    pending = { step: label, transactionHash: sent.hash };
    checkpoint();
    return record(label, await sent.wait());
  }
  // Reconcile an interrupted run before preparing any new transaction.
  for (const previous of receipts) {
    const receipt = await signers.worker.provider.getTransactionReceipt(previous.transactionHash);
    assert.equal(receipt?.status, 1, `Recorded transaction ${previous.step} is not confirmed.`);
  }
  if (pending) await record(pending.step, await signers.worker.provider.waitForTransaction(pending.transactionHash, 1, 120000));
  for (const role of ["holder", "delegate", "worker", "reviewer"]) {
    actors[role] ||= await call("/agents", "POST", { name: `AAMB ${role} ${Date.now().toString(36)}` });
    checkpoint();
    const address = await signers[role].getAddress();
    const linked = (await call("/dao/wallet", "GET", undefined, role)).wallet;
    if (linked) { assert.equal(getAddress(linked.address), getAddress(address)); continue; }
    const challenge = await call("/dao/wallet/challenge", "POST", { address }, role);
    assert.ok(challenge.message.startsWith(base), "Wallet challenge must identify this board's origin.");
    if (adversarial && role === "holder") {
      const forged = await request("/dao/wallet", "PUT", { nonce: challenge.nonce, signature: await signers.worker.signMessage(challenge.message) }, role);
      assert.equal(forged.status, 401);
    }
    const signed = { nonce: challenge.nonce, signature: await signers[role].signMessage(challenge.message) };
    await call("/dao/wallet", "PUT", signed, role);
    if (adversarial) assert.equal((await request("/dao/wallet", "PUT", signed, role)).status, 401);
  }
  if (!thread) {
    const board = (await call("/boards", "POST", { name: `AAMB DAO Testnet ${Date.now().toString(36)}`, description: "AAMB testnet demonstration. No monetary value; this is a controlled prototype with separate signer roles operated by the developer.", visibility: "public", join_mode: "open" }, "delegate")).board;
    const spec = { goal: "Verify that AAMB governance can pay an agent for reviewed work.", deliverable: "A report linking the governance proposal, funded escrow, and task evidence.", acceptance_criteria: "The proposal executed, the escrow reserves 100 AAMB, the report names the correct contracts, and reviewer and claimant wallets differ." };
    thread = (await call(`/boards/${board.id}/threads`, "POST", { title: "AAMB: complete the first governed task", content: "Complete the testnet governance-to-reward cycle and provide verifiable evidence.", task: spec }, "delegate")).thread;
    checkpoint();
  }
  const path = `/dao/tasks/${thread.id}`;
  await sendPrepared("Delegate", "holder", async () => call("/dao/delegate", "POST", { delegate: await signers.delegate.getAddress() }, "holder"));
  terms ||= { reward: "100", reviewer: await signers.reviewer.getAddress(), deadline: Math.floor(Date.now() / 1000) + 86400 };
  if (adversarial) {
    const other = (await call(`/boards/${thread.board_id}/threads`, "POST", { title: "Concurrent claim and funding boundary", content: "Only one workflow can win.", task: { goal: "Check concurrency", deliverable: "One winning state", acceptance_criteria: "Claim and proposal cannot both succeed" } }, "delegate")).thread;
    const outcomes = await Promise.all([
      request(`/dao/tasks/${other.id}/proposal`, "POST", terms, "delegate"),
      request(`/threads/${other.id}/task`, "PATCH", { action: "claim" }, "worker"),
    ]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
  }
  if (adversarial) assert.equal((await request(path + "/proposal", "POST", terms, "worker")).status, 403);
  proposal ||= await call(path + "/proposal", "POST", terms, "delegate");
  checkpoint();
  const retry = await call(path + "/proposal", "POST", terms, "delegate");
  assert.deepEqual(retry.transaction, proposal.transaction);
  if (adversarial) {
    assert.ok(proposal.proposal.description.includes(base + "/t/"));
    assert.equal((await request(path + "/action", "POST", { action: "vote", support: true }, "delegate")).status, 400);
    assert.equal((await request(path + "/proposal", "POST", { ...terms, reward: "200" }, "delegate")).status, 409);
    assert.equal((await request(`/threads/${thread.id}/task`, "PATCH", { action: "claim" }, "worker")).status, 409);
    assert.equal((await request(path + "/sync", "POST", {})).status, 401);
  }
  await sendPrepared("Propose", "delegate", async () => proposal);
  async function until(label, predicate, seconds) {
    for (let i = 0; i < 180; i++) {
      const detail = await call(path, "GET", undefined, "delegate");
      if (predicate(detail.chain)) return detail;
      if (advance) await advance(seconds || 5);
      else await new Promise(r => setTimeout(r, 2500));
    }
    throw Error(`Timed out waiting for ${label}; inspect the existing proposal before retrying.`);
  }
  if (!done("Vote")) await until("active voting", s => s.proposalState === "Active", config.timings?.delay + 1);
  await sendPrepared("Vote", "delegate", () => call(path + "/action", "POST", { action: "vote", support: 1 }, "delegate"));
  if (!done("Queue")) await until("successful vote", s => s.proposalState === "Succeeded", config.timings?.period + 1);
  await sendPrepared("Queue", "delegate", () => call(path + "/action", "POST", { action: "queue" }, "delegate"));
  if (!done("Fund task")) await until("timelock", s => s.proposalState === "Queued" && s.executionAfter <= s.timestamp, config.timings?.timelock + 1);
  await sendPrepared("Fund task", "delegate", () => call(path + "/action", "POST", { action: "execute" }, "delegate"));
  await call(path + "/sync", "POST", {}, "delegate");
  if (!done("Claim")) assert.equal((await call(path)).chain.task.status, "Funded");
  await sendPrepared("Claim", "worker", () => call(path + "/action", "POST", { action: "claim", lease_seconds: 3600 }, "worker"));
  await call(path + "/sync", "POST", {}, "worker");
  assert.equal((await call(`/threads/${thread.id}/task`)).task.claimant_id, actors.worker.agent.id);
  const evidence = `Verified AAMB prototype report.\nChain ID: ${config.chainId}\nToken: ${config.token}\nGovernor: ${config.governor}\nEscrow: ${config.escrow}\nProposal: ${proposal.proposal.proposal_id}\nFunding transaction: ${receipts.find(r => r.step === "Fund task").transactionHash}\nThe funded reward is 100 AAMB. The named reviewer is distinct from the claimant. Contract tests check authorization, replay prevention, and expiry. Testnet tokens have no monetary value.`;
  const originNote = proposal.proposal.description.includes(base + "/t/") ? "" : `\nDemo hosting correction: this task exists at ${base}/t/${thread.id}. The original immutable proposal used a production-origin URL because the local Worker rewrote its host; no production task was created. The committed specification hash and on-chain terms are unchanged.`;
  message ||= (await call(`/threads/${thread.id}/messages`, "POST", { content: evidence + originNote }, "worker")).message;
  if (!message.content) message = (await call(`/threads/${thread.id}?after=${message.id - 1}`)).messages.find(m => m.id === message.id);
  assert.ok(message?.content, "Submitted evidence must be available for the review record.");
  checkpoint();
  submission ||= await call(path + "/action", "POST", { action: "submit", result_message_id: message.id }, "worker");
  assert.equal(evidenceDigest(thread.id, message.id, message.author_id, message.content), submission.evidenceHash);
  checkpoint();
  await sendPrepared("Submit work", "worker", async () => submission);
  await call(path + "/sync", "POST", {}, "worker");
  if (!done("Approve and pay")) assert.equal((await call(`/threads/${thread.id}/task`)).task.status, "needs_review");
  if (adversarial) {
    assert.equal((await request(path + "/action", "POST", { action: "approve", evidence_hash: submission.evidenceHash }, "worker")).status, 403);
    assert.equal((await request(path + "/action", "POST", { action: "approve", evidence_hash: "0x" + "0".repeat(64) }, "reviewer")).status, 409);
  }
  const token = new Contract(config.token, tokenInterface, signers.worker.provider);
  const workerAddress = await signers.worker.getAddress();
  workerBalanceBefore ??= (await token.balanceOf(workerAddress)).toString();
  checkpoint();
  const before = BigInt(workerBalanceBefore);
  await sendPrepared("Approve and pay", "reviewer", () => call(path + "/action", "POST", { action: "approve", evidence_hash: submission.evidenceHash }, "reviewer"));
  await call(path + "/sync", "POST", {}, "reviewer");
  const after = await token.balanceOf(workerAddress), task = (await call(`/threads/${thread.id}/task`)).task;
  assert.equal(after - before, parseEther("100"));
  assert.equal(task.status, "done");
  assert.equal(task.result_message_id, message.id);
  if (adversarial) assert.equal((await request(path + "/action", "POST", { action: "approve", evidence_hash: submission.evidenceHash }, "reviewer")).status, 403);
  const detail = await call(path);
  assert.equal(detail.chain.task.status, "Paid");
  const paid = await signers.worker.provider.getTransactionReceipt(receipts.find(r => r.step === "Approve and pay").transactionHash);
  const rewardABI = new Interface(["event RewardPaid(bytes32 indexed taskId,address indexed worker,uint256 reward,bytes32 evidenceHash)"]);
  const reward = paid.logs.filter(l => l.address.toLowerCase() === config.escrow.toLowerCase()).map(l => rewardABI.parseLog(l)).find(l => l?.name === "RewardPaid");
  assert.ok(reward);
  assert.equal(reward.args.taskId, proposal.proposal.task_id);
  assert.equal(reward.args.worker.toLowerCase(), workerAddress.toLowerCase());
  assert.equal(reward.args.reward, after - before);
  assert.equal(reward.args.evidenceHash, submission.evidenceHash);
  return { network: config.network, chainId: config.chainId, boardBase: base, boardId: thread.board_id, threadId: thread.id, taskId: proposal.proposal.task_id, proposalId: proposal.proposal.proposal_id, evidenceHash: submission.evidenceHash, evidenceMessageId: message.id, evidenceAuthorId: message.author_id, evidenceContent: message.content, originNote: originNote || null, workerAddress, reviewerAddress: await signers.reviewer.getAddress(), reward: formatEther(after - before), rewardEventVerified: true, symbol: "AAMB", workerBalanceBefore: before.toString(), workerBalanceAfter: after.toString(), taskStatus: task.status, chainStatus: detail.chain.task.status, confirmedBlock: detail.chain.blockNumber, receipts, completedAt: new Date().toISOString() };
}
