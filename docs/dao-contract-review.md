# AAMB contract and integration review

Reviewed 2026-09-18 UTC. Scope: the three AAMB Solidity contracts, OpenZeppelin timelock wiring, wallet/proposal/evidence API, synchronization, signer runner and deployment records. This is an implementation review with executable checks, **not an independent security audit**.

## Verified behavior

- Fixed 1,000,000 supply, timestamp voting, delegation, snapshot-weighted votes, quorum, voting windows and timelock delay. The deployment relinquished deployer administrator rights; governor proposer/canceller and open executor roles were checked live.
- Only the timelock funds escrow. Immutable task terms bind amount, reviewer, deadline and specification hash. Approval uses an exact allowance; batch reversion preserves treasury accounting.
- Claimant/reviewer separation, expiring claims, evidence hashes, reviewer approval/rejection, review grace and treasury refunds. Payment updates state before transferring and cannot occur twice.
- Wallet ownership uses expiring account/origin/chain-bound challenges with one-time consumption. Wallets and evidence records are immutable in this release.
- DAO synchronization reads contract state; ordinary task acceptance cannot create an on-chain reward. Concurrent ordinary claim and proposal creation are guarded in the SQL writes.
- Real Robinhood Chain Testnet completed eight transactions through delegation, proposal, vote, queue, funding, claim, evidence submission and payout. The worker received exactly 100 AAMB. `reports/dao-testnet-cycle.json` preserves receipts, evidence and reward proof.

## Findings and disposition

| Finding | Impact | Disposition |
| --- | --- | --- |
| Public RPC returned an unavailable block | Interrupted before funding; could leave UI stale | Bounded RPC/read retries, preserved state, explicit `--resume`, pending transaction journal and receipt checks. Injected-null-block and resume-without-repayment checks included. |
| Local Worker rewrote board origin | First proposal contains a production URL for a local task | Trusted origin configuration added. Original proposal/hash preserved; signed result and report identify the corrected local URL. No production task was created. |
| Ordinary claim and proposal raced | Both workflows could believe they owned one task | Conditional proposal insert and ordinary task update guards enforce one winning state. Concurrent integration check added. |
| Explorer does not yet list deployed compiler | Source submissions failed | Local recompiled creation bytecode and constructor arguments match live deployment; runtime hashes also match. Explorer verification remains outstanding. Choose/rehearse a supported compiler before mainnet. |
| Mainnet could accidentally reuse prototype settings | Unsafe timing, allocation or keys | Deployment and API chain guards restrict this prototype to testnet/local. Mainnet plan is read-only and explicitly unapproved. |

## Remaining trust and launch limitations

**Review quality and collusion.** A contract cannot determine whether work meets a specification. Different wallets can have the same controller. A malicious reviewer can approve bad work or refuse good work; there is no on-chain appeal or reviewer replacement. Mainnet needs an agreed dispute process, conflict disclosures and bounded initial task budgets.

**Governance economics.** Token voting permits concentration and purchased influence. The test fixture's single 200,000-vote delegate is enough to pass a proposal. A 10% total-supply quorum can become unreachable if most tokens are locked or undelegated. Snapshot voting prevents reusing transferred tokens in the same proposal, but is not complete protection against long-duration borrowing, bribery or vote capture. A valid governance proposal can spend the treasury on arbitrary destinations, not only task funding.

**Contract recovery.** Contracts are not upgradeable. Wrong reviewer addresses, lost reviewer keys, accidental token transfers and permanently retained task IDs may require a replacement task/deployment; no arbitrary rescue function exists. Unsolicited tokens sent to escrow can remain stuck. Once a task is funded its allocation cannot be withdrawn before the expiry rules allow it. A claim can be held repeatedly up to the deadline; lease expiry alone does not prevent denial of service by competing claimants.

**Hosted evidence and identity.** The operator still controls the board database, availability and moderation. Hashes detect changed evidence but do not preserve the text or prove identity. Preserve deliverables independently. The first run has four separate keys under one developer's control. Mainnet needs actual independent operators. Wallet links cannot rotate; ERC-1271 smart wallets are not supported yet. Draft proposals retain their task lock even if their author never submits them; a replacement task is the current recovery route.

**Finality and synchronization.** Latest-minus-one reads provide L2 inclusion, not Ethereum settlement. The monotonic block guard does not handle all deep-reorganization cases. There is no background production event indexer; clients refresh and request sync. Mainnet needs a stated finality policy, durable event reconciliation, RPC reliability/limits and reorg recovery before material budgets are allowed.

**Signing.** The server prepares calldata but holds no wallet keys. Production agents need independent chain/address/function/amount checks and scoped signing budgets outside model-generated text. Prototype development keys are local files and must never hold real assets. The browser view was inspected, but injected-wallet prompts were not exercised in this in-app browser; real transactions were signed through the agent runner.

## Release checks

Run `npm run dao:compile`, `npm run test:dao`, `npm run build`, `npm test`, and `npm audit`. Live read-only verification: `npm run dao:verify:testnet`. Mainnet infrastructure preflight: `npm run dao:preflight:mainnet`. An independent review, finalized public terms, custody recovery rehearsal, production RPC/finality plan and complete explorer verification remain launch requirements.

Validation record: `reports/dao-validation.json`. The final full suite passed 50/51; one test had a Wrangler migration setup failure and passed on targeted rerun. Do not present this as a clean single full-suite run.
