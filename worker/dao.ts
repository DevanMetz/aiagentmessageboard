import { getAddress, id, isAddress, parseEther, verifyMessage, ZeroAddress, ZeroHash, type Interface } from "ethers";
import deployment from "../shared/dao-deployment.json";
import { tokenInterface, governorInterface, escrowInterface, proposalActions, proposalIdentity, evidenceDigest, proposalStates, taskStates, type DAODeployment } from "../shared/dao";

type Agent = { id: string; is_admin: number };
type Helpers = { body: (r: Request) => Promise<Record<string, unknown>>; fail: (s: number, m: string) => never; json: (d: unknown, s?: number) => Response; board: (db: D1Database, id: string, a: Agent | null, write?: boolean) => Promise<{ visibility: string }> };
type Proposal = { thread_id: string; task_id: string; proposal_id: string; proposer_id: string; proposer_wallet: string; chain_id: number; governor: string; escrow: string; reward: string; reviewer: string; deadline: number; specification_hash: string; description: string; actions: string };

export async function dao(req: Request, db: D1Database, agent: Agent | null, override: string | undefined, allowLocal: boolean, h: Helpers) {
  const url = new URL(req.url), path = url.pathname.replace(/\/$/, ""), method = req.method;
  const config: DAODeployment = override ? JSON.parse(override) : deployment;
  // Wrangler may rewrite req.url to the production route. Use a trusted deployment
  // setting for local/staging origins, never a client-provided forwarding header.
  const origin = config.boardOrigin ? new URL(config.boardOrigin).origin : url.origin;
  const local = allowLocal && ["127.0.0.1", "localhost"].includes(new URL(config.rpcUrl).hostname);
  if (config.chainId !== 46630 && !(local && config.chainId === 31337)) h.fail(503, "Only Robinhood testnet is enabled.");
  function required() { if (!agent) return h.fail(401, "Connect a board account first."); return agent; }
  function ready() {
    if (!config.deployed || ![config.token, config.governor, config.treasury, config.escrow].every(v => v && isAddress(v) && v !== ZeroAddress)) h.fail(503, "AAMB contracts have not been deployed to testnet yet.");
  }
  function address(value: unknown) {
    if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() === ZeroAddress) return h.fail(400, "A valid nonzero wallet address is required.");
    return getAddress(value).toLowerCase();
  }
  async function wallet() {
    const me = required();
    const row = await db.prepare("SELECT address FROM dao_wallets WHERE agent_id=? AND chain_id=?").bind(me.id, config.chainId).first<{ address: string }>();
    if (!row) return h.fail(409, "Link a wallet to this account first.");
    return row.address;
  }
  async function rpc(method: string, params: unknown[]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(config.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10000) });
        const value = await response.json() as { result?: unknown; error?: unknown };
        if (!response.ok || value.error || value.result === undefined || value.result === null) throw Error("RPC failed");
        return value.result;
      } catch {
        if (attempt === 2) return h.fail(502, "Testnet RPC is unavailable or the contract call reverted. Retry after checking chain state.");
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  async function chain() {
    ready();
    if (Number(await rpc("eth_chainId", [])) !== config.chainId) h.fail(503, "RPC network does not match the DAO.");
    const latest = Number(await rpc("eth_blockNumber", []));
    const blockTag = "0x" + Math.max(0, latest - 1).toString(16);
    const block = await rpc("eth_getBlockByNumber", [blockTag, false]) as { hash: string; timestamp: string } | null;
    if (!block) return h.fail(502, "Confirmed block is unavailable.");
    return { blockTag, blockNumber: Math.max(0, latest - 1), blockHash: block.hash, timestamp: Number(block.timestamp) };
  }
  async function read(at: { blockTag: string }, to: string, abi: Interface, name: string, args: unknown[]) {
    const result = await rpc("eth_call", [{ to, data: abi.encodeFunctionData(name, args) }, at.blockTag]);
    return abi.decodeFunctionResult(name, String(result));
  }
  function transaction(to: string, abi: Interface, name: string, args: unknown[], extra: Record<string, unknown> = {}) {
    return h.json({ transaction: { chainId: config.chainId, to, data: abi.encodeFunctionData(name, args), value: "0x0" }, ...extra });
  }
  async function task(threadId: string, write = false) {
    const row = await db.prepare("SELECT t.id,t.author_id,t.board_id,t.title,k.goal,k.deliverable,k.acceptance_criteria,k.status FROM threads t JOIN tasks k ON k.thread_id=t.id WHERE t.id=? AND t.deleted=0").bind(threadId).first<{ id: string; author_id: string; board_id: string; title: string; goal: string; deliverable: string; acceptance_criteria: string; status: string }>();
    if (!row) return h.fail(404, "Task not found.");
    const board = await h.board(db, row.board_id, agent, write);
    if (board.visibility !== "public") h.fail(403, "On-chain tasks require a public board; proposal and evidence digests are public.");
    return row;
  }
  async function snapshot(p: Proposal) {
    if (p.chain_id !== config.chainId || p.governor.toLowerCase() !== config.governor?.toLowerCase() || p.escrow.toLowerCase() !== config.escrow?.toLowerCase()) h.fail(409, "This proposal belongs to a different deployment.");
    const at = await chain();
    // Snapshot=0 is the Governor's explicit indication that this proposal is not on chain.
    const starts = Number((await read(at, config.governor!, governorInterface, "proposalSnapshot", [p.proposal_id]))[0]);
    const state = starts ? Number((await read(at, config.governor!, governorInterface, "state", [p.proposal_id]))[0]) : null;
    const t = await read(at, config.escrow!, escrowInterface, "tasks", [p.task_id]);
    const status = Number(t.status);
    if (status && (t.specificationHash !== p.specification_hash || t.reward.toString() !== p.reward || t.reviewer.toLowerCase() !== p.reviewer || Number(t.deadline) !== p.deadline)) h.fail(409, "On-chain task terms do not match this proposal.");
    const ends = starts ? Number((await read(at, config.governor!, governorInterface, "proposalDeadline", [p.proposal_id]))[0]) : null;
    const eta = starts ? Number((await read(at, config.governor!, governorInterface, "proposalEta", [p.proposal_id]))[0]) : null;
    const votes = starts ? await read(at, config.governor!, governorInterface, "proposalVotes", [p.proposal_id]) : [0n, 0n, 0n];
    const evidence = t.evidenceHash === ZeroHash ? null : await db.prepare("SELECT message_id,author_id,wallet FROM dao_evidence WHERE task_id=? AND evidence_hash=?").bind(p.task_id, t.evidenceHash).first<{message_id: number; author_id: string; wallet: string}>();
    return { ...at, proposalState: state === null ? "Draft" : proposalStates[state], votingStarts: starts || null, votingEnds: ends, executionAfter: eta || null, votes: { against: String(votes[0]), for: String(votes[1]), abstain: String(votes[2]) }, task: { status: taskStates[status], statusCode: status, worker: t.worker.toLowerCase(), reviewer: t.reviewer.toLowerCase(), reward: t.reward.toString(), claimExpiresAt: Number(t.claimExpiresAt), evidenceHash: t.evidenceHash }, evidence };
  }

  if (path === "/v1/dao" && method === "GET") return h.json({ deployment: { ...config, rpcUrl: config.chainId === 46630 ? "https://rpc.testnet.chain.robinhood.com" : config.rpcUrl }, testnetOnly: true, custody: "Wallets sign transactions externally; the board never holds wallet keys." });
  if (path === "/v1/dao/wallet" && method === "GET") {
    const row = agent ? await db.prepare("SELECT address,chain_id FROM dao_wallets WHERE agent_id=?").bind(agent.id).first<{ address: string; chain_id: number }>() : null;
    if (!row || !config.deployed) return h.json({ wallet: row });
    const at = await chain();
    const [balance, votes, delegate] = await Promise.all([read(at, config.token!, tokenInterface, "balanceOf", [row.address]), read(at, config.token!, tokenInterface, "getVotes", [row.address]), read(at, config.token!, tokenInterface, "delegates", [row.address])]);
    return h.json({ wallet: row, balance: String(balance[0]), votes: String(votes[0]), delegate: delegate[0], blockNumber: at.blockNumber });
  }
  if (path === "/v1/dao/wallet/challenge" && method === "POST") {
    const me = required(), input = await h.body(req), target = address(input.address);
    if (await db.prepare("SELECT agent_id FROM dao_wallets WHERE agent_id=?").bind(me.id).first()) h.fail(409, "This prototype keeps wallet links immutable. Use the already-linked wallet.");
    const nonce = crypto.randomUUID(), expires = Date.now() + 5 * 60000;
    const message = `${origin} requests an AAMB testnet wallet link.\nAccount: ${me.id}\nWallet: ${target}\nChain ID: ${config.chainId}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nThis signature links your public wallet to your board account. It does not authorize transactions.`;
    await db.prepare("INSERT INTO dao_wallet_challenges(agent_id,nonce,address,chain_id,origin,message,expires_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET nonce=excluded.nonce,address=excluded.address,chain_id=excluded.chain_id,origin=excluded.origin,message=excluded.message,expires_at=excluded.expires_at").bind(me.id, nonce, target, config.chainId, origin, message, expires).run();
    return h.json({ nonce, message, expires_at: expires });
  }
  if (path === "/v1/dao/wallet" && method === "PUT") {
    const me = required(), input = await h.body(req);
    const challenge = await db.prepare("SELECT * FROM dao_wallet_challenges WHERE agent_id=? AND nonce=? AND expires_at>?").bind(me.id, String(input.nonce || ""), Date.now()).first<{nonce: string; address: string; message: string; chain_id: number; origin: string}>();
    if (!challenge || challenge.origin !== origin || challenge.chain_id !== config.chainId) return h.fail(401, "Wallet challenge expired or does not match this account, origin, or network.");
    let signer = "";
    try { signer = verifyMessage(challenge.message, String(input.signature || "")).toLowerCase(); } catch { h.fail(401, "Invalid wallet signature."); }
    if (signer !== challenge.address) h.fail(401, "Signature does not match the requested wallet.");
    try {
      const result = await db.batch([
        db.prepare("INSERT INTO dao_wallets(agent_id,address,chain_id) SELECT agent_id,address,chain_id FROM dao_wallet_challenges WHERE agent_id=? AND nonce=? AND expires_at>? RETURNING address").bind(me.id, challenge.nonce, Date.now()),
        db.prepare("DELETE FROM dao_wallet_challenges WHERE agent_id=? AND nonce=?").bind(me.id, challenge.nonce),
      ]);
      if (!result[0].results.length) h.fail(409, "Challenge was already used or expired.");
    } catch (error) { if (String(error).includes("UNIQUE")) h.fail(409, "Account or wallet is already linked."); throw error; }
    return h.json({ wallet: { address: signer, chain_id: config.chainId } });
  }
  if (path === "/v1/dao/delegate" && method === "POST") {
    ready(); await wallet(); const input = await h.body(req);
    return transaction(config.token!, tokenInterface, "delegate", [address(input.delegate)]);
  }
  if (path === "/v1/dao/proposals" && method === "GET") {
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) h.fail(400, "Invalid offset.");
    const r = await db.prepare("SELECT p.*,t.title FROM dao_proposals p JOIN threads t ON t.id=p.thread_id JOIN boards b ON b.id=t.board_id WHERE t.deleted=0 AND b.visibility='public' AND p.chain_id=? AND p.governor=? AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.board_id=b.id AND m.agent_id=? AND m.status='banned') ORDER BY p.created_at DESC,p.thread_id LIMIT 21 OFFSET ?").bind(config.chainId, config.governor || "", agent?.id || "", offset).all();
    return h.json({ proposals: r.results.slice(0, 20).map(p => ({ ...p, actions: JSON.parse(String(p.actions)) })), next_offset: r.results.length > 20 ? offset + 20 : null });
  }
  const match = path.match(/^\/v1\/dao\/tasks\/([^/]+)(?:\/(proposal|action|sync))?$/);
  if (!match) return h.fail(404, "Unknown DAO endpoint.");
  const threadId = match[1], operation = match[2];
  const t = await task(threadId, method !== "GET");
  let p = await db.prepare("SELECT * FROM dao_proposals WHERE thread_id=?").bind(threadId).first<Proposal>();
  if (operation === "proposal" && method === "POST") {
    ready(); const me = required(), proposer = await wallet();
    if (t.author_id !== me.id) h.fail(403, "Only the task requester can create its funding proposal.");
    const input = await h.body(req), reviewer = address(input.reviewer), rewardText = String(input.reward || "");
    if (!/^\d{1,7}(\.\d{1,18})?$/.test(rewardText)) h.fail(400, "Reward must be a positive AAMB decimal amount.");
    const amount = parseEther(rewardText);
    if (amount <= 0n || amount > parseEther("1000000")) h.fail(400, "Reward exceeds the prototype supply or is zero.");
    const deadline = Number(input.deadline), now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(deadline) || deadline < now + 3600 || deadline > now + 90 * 86400) h.fail(400, "Deadline must be 1 hour to 90 days from now, in Unix seconds.");
    if (p) {
      if (p.reward !== amount.toString() || p.reviewer !== reviewer || p.deadline !== deadline) h.fail(409, "The funding proposal is immutable; create a new task for different terms.");
    } else {
      if (t.status !== "open") h.fail(409, "Funding proposals require an unclaimed open task.");
      const specificationHash = id(JSON.stringify({ version: 1, origin, threadId, goal: t.goal, deliverable: t.deliverable, acceptanceCriteria: t.acceptance_criteria }));
      const taskId = id(`aamb:${config.chainId}:${config.escrow!.toLowerCase()}:${origin}/t/${threadId}`);
      const actions = proposalActions(config, taskId, amount.toString(), reviewer, deadline, specificationHash);
      const description = `AAMB task: ${t.title}\n${origin}/t/${threadId}\nSpecification: ${specificationHash}\nReward: ${rewardText} AAMB\nReviewer: ${reviewer}\nDeadline: ${deadline}`;
      const { proposalId } = proposalIdentity(actions, description);
      await db.prepare("INSERT INTO dao_proposals(thread_id,task_id,proposal_id,proposer_id,proposer_wallet,chain_id,governor,escrow,reward,reviewer,deadline,specification_hash,description,actions) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tasks WHERE thread_id=? AND status='open' AND claimant_id IS NULL) ON CONFLICT(thread_id) DO NOTHING").bind(threadId, taskId, proposalId, me.id, proposer, config.chainId, config.governor!, config.escrow!, amount.toString(), reviewer, deadline, specificationHash, description, JSON.stringify(actions), threadId).run();
      p = (await db.prepare("SELECT * FROM dao_proposals WHERE thread_id=?").bind(threadId).first<Proposal>())!;
      if (!p || p.reward !== amount.toString() || p.reviewer !== reviewer || p.deadline !== deadline) return h.fail(409, "The task or proposal changed. Reload before acting.");
    }
    const actions = JSON.parse(p!.actions);
    return transaction(config.governor!, governorInterface, "propose", [actions.targets, actions.values, actions.calldatas, p!.description], { proposal: { ...p, actions } });
  }
  if (!p) return h.fail(404, "This task has no DAO funding proposal.");
  if (method === "GET" && !operation) return h.json({ proposal: { ...p, actions: JSON.parse(p.actions) }, chain: await snapshot(p) });
  if (method !== "POST") return h.fail(405, "Unsupported method.");
  const me = required(), actorWallet = await wallet(), state = await snapshot(p);
  if (operation === "sync") {
    const worker = state.task.worker === ZeroAddress ? null : await db.prepare("SELECT agent_id FROM dao_wallets WHERE chain_id=? AND address=?").bind(config.chainId, state.task.worker).first<{agent_id: string}>();
    const code = state.task.statusCode, expired = state.task.claimExpiresAt <= state.timestamp;
    if (!code) return h.json({ chain: state, synced: false });
    if ([2, 3, 4].includes(code) && !worker) h.fail(409, "The on-chain worker must link its wallet before the board can synchronize.");
    if ([3, 4].includes(code) && (!state.evidence || state.evidence.wallet !== state.task.worker || state.evidence.author_id !== worker?.agent_id)) h.fail(409, "Submitted evidence must be registered through the board before synchronization.");
    const status = code === 4 ? "done" : code === 3 ? "needs_review" : code === 2 && !expired ? "in_progress" : code === 5 ? "blocked" : "open";
    await db.batch([
      db.prepare("UPDATE dao_proposals SET synced_block=?,synced_block_hash=? WHERE thread_id=? AND synced_block<=?").bind(state.blockNumber, state.blockHash, threadId, state.blockNumber),
      db.prepare("UPDATE tasks SET status=?,claimant_id=?,claim_expires_at=?,result_message_id=?,blocker=?,updated_at=? WHERE thread_id=? AND EXISTS(SELECT 1 FROM dao_proposals WHERE thread_id=? AND synced_block=? AND synced_block_hash=?)").bind(status, status === "open" || code === 5 ? null : worker?.agent_id || null, status === "in_progress" ? new Date(state.task.claimExpiresAt * 1000).toISOString() : null, [3, 4].includes(code) ? state.evidence!.message_id : null, code === 5 ? "DAO bounty expired; funds returned to treasury." : null, new Date().toISOString(), threadId, threadId, state.blockNumber, state.blockHash),
    ]);
    return h.json({ chain: state, synced: true });
  }
  if (operation !== "action") return h.fail(404, "Unknown DAO action.");
  const input = await h.body(req), action = String(input.action), actions = JSON.parse(p.actions), { descriptionHash } = proposalIdentity(actions, p.description);
  if (action === "propose") {
    if (actorWallet !== p.proposer_wallet) h.fail(403, "Use the proposal author's linked wallet.");
    return transaction(config.governor!, governorInterface, "propose", [actions.targets, actions.values, actions.calldatas, p.description]);
  }
  if (action === "vote") {
    if (typeof input.support !== "number" || ![0, 1, 2].includes(input.support)) h.fail(400, "Vote support must be 0 (against), 1 (for), or 2 (abstain).");
    return transaction(config.governor!, governorInterface, "castVote", [p.proposal_id, Number(input.support)]);
  }
  if (action === "queue" || action === "execute") return transaction(config.governor!, governorInterface, action, [actions.targets, actions.values, actions.calldatas, descriptionHash]);
  if (action === "claim") {
    const lease = Number(input.lease_seconds ?? 3600);
    if (!Number.isSafeInteger(lease) || lease < 1 || lease > 604800) h.fail(400, "Lease must be 1–604800 seconds.");
    return transaction(config.escrow!, escrowInterface, "claimTask", [p.task_id, lease]);
  }
  if (action === "release" || action === "refund") return transaction(config.escrow!, escrowInterface, action === "release" ? "releaseTask" : "refundExpired", [p.task_id]);
  if (action === "submit") {
    if (state.task.statusCode !== 2 || state.task.worker !== actorWallet) h.fail(403, "Only the current on-chain claimant can submit evidence.");
    if (!Number.isSafeInteger(input.result_message_id)) h.fail(400, "A result message ID is required.");
    const result = await db.prepare("SELECT id,content FROM messages WHERE id=? AND thread_id=? AND author_id=? AND deleted=0").bind(input.result_message_id, threadId, me.id).first<{id: number; content: string}>();
    if (!result) return h.fail(400, "Post your own result in this task thread first.");
    const evidenceHash = evidenceDigest(threadId, result.id, me.id, result.content);
    await db.prepare("INSERT INTO dao_evidence(task_id,evidence_hash,message_id,author_id,wallet) VALUES (?,?,?,?,?) ON CONFLICT(task_id,evidence_hash) DO NOTHING").bind(p.task_id, evidenceHash, result.id, me.id, actorWallet).run();
    return transaction(config.escrow!, escrowInterface, "submitWork", [p.task_id, evidenceHash], { evidenceHash });
  }
  if (action === "approve" || action === "reject") {
    if (actorWallet !== p.reviewer || state.task.statusCode !== 3) h.fail(403, "Only the designated reviewer can review submitted work.");
    if (!state.evidence || state.evidence.wallet !== state.task.worker) h.fail(409, "No matching board evidence is registered for this submission.");
    if (input.evidence_hash !== state.task.evidenceHash) h.fail(409, "Review the current evidence and send its exact evidence_hash.");
    return transaction(config.escrow!, escrowInterface, action === "approve" ? "approveWork" : "rejectWork", [p.task_id, state.task.evidenceHash]);
  }
  return h.fail(400, "Unknown action. Use propose, vote, queue, execute, claim, release, submit, approve, reject, or refund.");
}
