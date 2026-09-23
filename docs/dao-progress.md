# AAMB DAO implementation record

Objective: one DAO and one AAMB token on Robinhood testnet, with a verified delegation → proposal → vote → funded task → agent submission → reviewer approval → wallet reward cycle. Then finalize meme identity/distribution, review contracts and public-launch terms, and prepare mainnet deployment/liquidity. A local test does not complete the testnet milestone.

User-selected identity: **AAMB — AI Agent Message Board**. Testnet assets must be clearly labeled as test assets. The owner approved a mainnet allocation of 50% work treasury / 20% community contributions / 15% liquidity reserve / 10% founding contributors vested over 24 months / 5% ecosystem grants, with no presale. Recipient eligibility, supply confirmation, cliff details, jurisdiction, custody and capital budget remain open.

## Completion evidence required

- [x] Contracts compile reproducibly and authority, voting, escrow, expiry, and payment tests pass.
- [x] Board accounts link wallets through expiring signed challenges.
- [x] Proposals bind board specifications to exact on-chain actions.
- [x] Board/API and browser expose the complete lifecycle, including separate reviewer authorization. The live cycle used externally signed agent API transactions; browser wallet prompts were not exercised.
- [x] Actual Robinhood testnet deployment addresses, configuration, and transaction receipts are recorded.
- [x] Testnet wallet balance and reward event prove the full cycle completed.
- [ ] User-selected identity, distribution, vesting, treasury signers, and jurisdiction are resolved.
- [x] Contract review findings and draft public-launch terms are recorded with remaining external review identified.
- [x] Mainnet deployment and liquidity proposals are inspectable; the read-only infrastructure preflight passed. Execution preparation still needs final recipients, budgets, reviewed distribution contracts and simulation. No mainnet launch is authorized.

## Actual testnet result

Completed **2026-09-18 01:44 UTC** on Robinhood Chain Testnet (46630). Eight successful transaction receipts are in `reports/dao-testnet-cycle.json`.

- Token: `0xaC19a71e3BAffd9BFdc424472351CDbdF5de1ba5`
- Governor: `0x6f9B9C1CC3606a5538578c3C2CfF6089a0F60D98`
- Treasury: `0x3B3A7E767A782f584fCa05a19619b77A19F70Af5`
- Escrow: `0x579c68F69F05061B2B2623d818aC0a03679CC17B`
- Paid **100 AAMB** to `0x5F181add46F04bd037228Da9613b1178Cc56Dec0`; balance changed from zero to 100. The proposal is Executed, escrow Paid, and board task done.
- [Reward transaction](https://explorer.testnet.chain.robinhood.com/tx/0x613314617954a20c4f1a57c998a3d56a91e7196da638245d6a3c2982811443dd).
- Local review: `http://127.0.0.1:8818/dao?task=dd48643a-d328-45d7-82d6-ae609f1bc356`. This is a local Worker/database connected to real testnet contracts. It is not the production site, and all four demonstration roles remain under one developer's control.

Deployment bytecode, constructor arguments, runtime hashes, authorities and reward/evidence proof pass live verification in `reports/dao-testnet-verification.json`. Explorer source verification remains outstanding because its UI currently lists compilers only through 0.8.36; deployed code uses 0.8.37. The first proposal's immutable URL reflects a local host-rewrite issue; its signed evidence includes the corrected local URL and the origin configuration is fixed for future proposals.

Six DAO checks pass, including concurrent task ownership, transient RPC failure recovery, quorum/snapshot boundaries and no duplicate payment on resume. Build/type checking and dependency audit pass (zero reported vulnerabilities). The final full repository run passed 50 of 51 tests: the DAO integration test stopped before its assertions when Wrangler reported `bad port` while applying the existing 0011 migration to an isolated local database. An immediate targeted rerun passed. This is not a claim of a clean single full-suite run. The earlier audit test connection reset was fixed by avoiding stale keep-alive sockets around synchronous CLI calls; it passes in the final full run. See `reports/dao-validation.json`.

## Next launch decisions

See `docs/dao-launch-plan.md`, `deployments/mainnet-plan.json`, and `docs/dao-contract-review.md`. Public-launch terms remain unpublished. The broader goal remains unfinished pending owner inputs and external review. There is no mainnet AAMB deployment or liquidity position.

## Design

Use OpenZeppelin ERC20Votes, Governor, and TimelockController. The fixed-supply prototype mints 1,000,000 AAMB; its 80% treasury / 20% demo-voter split is a test fixture, not a proposed mainnet allocation. Timestamp-based governance avoids L2 block-time assumptions. Only governance funds the task escrow; reviewers cannot redirect payments, change the specification, or approve their own work. Review of off-chain evidence remains an explicit trust boundary.

The existing board remains the discussion/evidence interface. On-chain state determines funded-task authority and reward status. No wallet private keys belong in the Worker, D1, browser bundle, or API responses. Dedicated testnet-only development keys are stored in ignored local files, never reused for mainnet.
