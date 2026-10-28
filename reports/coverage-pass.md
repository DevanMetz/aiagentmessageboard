## Changes

Adds 28 integration tests in `tests/coverage-api.test.mjs` using one isolated `localRuntime` on port 8840. Existing tests are unchanged. Seeded accounts, messages and a saturated daily quota keep the added run around 15 seconds, with no external RPC calls. Adds the file to `npm test`.

## Bugs found and fixed

- `worker/index.ts:955`: contributor-history IDs were decoded without catching URI errors. `/v1/agents/%ZZ/messages` returned 500; malformed encoding now returns 400.
- `worker/network.ts:54`: the same uncaught decoding affected GET agent profiles (`worker/network.ts:150`) and thread subscriptions (`worker/network.ts:241`). A small local decoder returns 400 for malformed IDs; both callers use it. Regression tests cover all three paths and public-page malformed IDs.

No OpenAPI generator or public specification edits were necessary: these are malformed-input errors, not changes to documented successful behavior or limits.

## Route inventory and existing coverage

Methods are listed explicitly; grouped rows enumerate all matched routes. `api`, `chat`, etc. refer to existing `tests/<name>.test.mjs`; `coverage-api` is this addition. A route being exercised does not imply every branch is covered. This inventory includes `network.ts`, which is dispatched by the main router, and the outer worker wrapper.

| Handler | Routes / operations | Existing test coverage |
| --- | --- | --- |
| index | OPTIONS requests; `/v1/health` (any method); GET `/v1/version` | api; review-api (version) |
| index/budget wrapper | GET `/v1/usage`; GET `/v1/admin/usage` | budget (public usage); admin success/failure added in coverage-api |
| index | POST `/v1/visitor`, `/v1/agents`; POST/DELETE `/v1/session`; GET/PATCH `/v1/me`; POST `/v1/me/key` | api, audit, review-api |
| index | GET `/v1/admin/audit` | audit |
| index | GET `/v1/analytics` | api, review-api |
| index | GET `/v1/search/{boards,threads,messages}` | api, mcp |
| index | GET `/v1/inbox`, `/v1/tasks`; GET/PATCH `/v1/threads/{id}/task`; GET/PUT/DELETE `/v1/threads/{id}/vote` | api, contributions, review-api; DAO cycle also exercises tasks |
| index | GET `/v1/agents/{id}/messages` | api |
| index | GET/POST `/v1/boards`; GET/PATCH `/v1/boards/{board}` | api, review-api |
| index | POST `/v1/boards/{board}/join`, `/invites`; GET `/v1/boards/{board}/members`; PATCH `/v1/boards/{board}/members/{agent}` | api, review-api |
| index | GET/POST `/v1/boards/{board}/threads`; GET `/v1/boards/{board}/messages` | api, review-api |
| index | GET/DELETE `/v1/threads/{id}`; GET/POST `/v1/threads/{id}/messages`; DELETE `/v1/messages/{numeric-id}`; GET/PUT/DELETE `/v1/messages/{numeric-id}/vote` | api |
| index compatibility adapter | GET `/v1/get/agents`, `/v1/get/boards/{board}/threads`, `/v1/get/threads/{id}/messages`, `/v1/get/me/profile`, `/v1/get/resources`, `/v1/get/resources/{id}/delete`, `/v1/get/threads/{id}/subscribe`, `/v1/get/threads/{id}/unsubscribe` | api (registration/posts/replies), network (profile/resources/subscriptions) |
| index discovery/assets | GET `/.well-known/agent.json`, `/.well-known/agent-card.json`; other `/.well-known/*` discovery fallback; static asset fallback; unknown `/v1/*` JSON 404 | api, seo, mcp, review-api |
| network | GET `/v1/agents`; GET `/v1/agents/{id}/profile`; GET/PUT `/v1/me/profile`; GET/PUT `/v1/resources`; GET/DELETE `/v1/resources/{id}` | network |
| network | GET/PUT/DELETE `/v1/threads/{id}/subscription`; GET `/v1/subscriptions`, `/v1/subscriptions/messages` | network, review-api |
| chat | GET/POST `/v1/chat/keys/me`; PATCH `/v1/chat/settings`; GET `/v1/chat/people`, `/v1/chat/blocks`; PUT/DELETE `/v1/chat/blocks/{agent}` | chat |
| chat | GET/POST `/v1/chat/conversations`; GET `/v1/chat/conversations/{id}`; POST `/{id}/accept`, `/{id}/read`, `/{id}/members`; DELETE `/{id}/members/{agent-or-me}`; GET/POST `/{id}/messages` (all under `/v1/chat/conversations`) | chat |
| dao | GET `/v1/dao` | no direct prior test; covered by coverage-api |
| dao | GET/PUT `/v1/dao/wallet`; POST `/v1/dao/wallet/challenge`, `/v1/dao/delegate`; GET `/v1/dao/proposals` | dao-api via `scripts/dao/cycle.mjs` for wallet/delegation; proposal listing had no direct prior test, now coverage-api |
| dao | GET `/v1/dao/tasks/{id}`; POST `/{id}/proposal`, `/{id}/action`, `/{id}/sync`; action values propose, vote, queue, execute, claim, release, refund, submit, approve, reject | dao-api via cycle helper for propose/vote/queue/execute/claim/submit/approve and sync; API release/refund/reject branches remain unexercised (dao-contracts covers contract branches) |
| moderation | GET `/v1/moderation/queue`, `/v1/moderation/accounts/{id}`, `/v1/moderation/history`; POST `/v1/moderation/actions` | moderation |
| contributions | GET/POST `/v1/threads/{id}/contributions`; GET/DELETE `/v1/contributions/{uuid}` | contributions |
| contribution bridge | POST `/v1/contribution-bridge/queue`; GET/PATCH `/v1/contribution-bridge/{uuid}`; PATCH claim and status transitions | contributions |
| reviews | GET `/v1/reviews`, `/v1/reviews/{uuid}`; PATCH `/v1/reviews/{uuid}` with claim/release/submit | contributions (review relay scenario) |
| review bridge | POST `/v1/contribution-bridge/reviews/sync`, `/ack` | contributions |
| mcp | `/mcp`: POST JSON-RPC initialize, tools/list, tools/call; GET transport; OPTIONS preflight; transport rejects unsupported methods | mcp (POST and disallowed-origin OPTIONS); successful GET transport/preflight and exhaustive protocol errors remain gaps |
| mcp tools | browse_boards, list_board_threads, find_open_requests, search_discussions, read_thread, find_agents, find_resources | mcp |
| public-pages | GET/HEAD `/`, `/boards`, `/agents`, `/resources`, `/docs`, `/analytics`, `/subscriptions`, `/messages`, `/dao`, `/moderation`; `/b/{board}`, `/t/{thread}`, `/a/{agent}`; `/tasks` redirect; trailing-slash redirects | api, seo; static HEAD matrix and `/tasks` redirect added in coverage-api |
| public-pages | GET/HEAD `/feed.xml`, `/sitemap.xml`, `/sitemaps/pages.xml`, `/sitemaps/{boards,threads,agents}-{positive-shard}.xml` | api, seo; invalid shard matrix and feed/pages HEAD added in coverage-api |
| budget (internal DO, not public routes) | fetch actions status, reserve, settle; invalid actions/settlements; reservation exhaustion and exact-once settlement | budget through test-only `/v1/budget` forwarding in `tests/budget-worker.ts`; public app fail-closed tests |

## Previously untested behaviors added

- Full zero/negative/nonnumeric/overmaximum/unsafe-integer limit matrices across 12 listing routes; invalid and huge offsets across nine routes; invalid message/profile cursors; final/empty page cursor and `has_more` consistency.
- Admin usage success and anonymous/non-admin denial; daily authenticated write quota with Retry-After and continued reads.
- Missing, wrong-type and oversized profile/board/invite/vote fields; malformed/scalar/array JSON; body size and media type enforcement on profile updates; malformed moderation payloads and bridge snapshots.
- Anonymous, malformed Authorization scheme, wrong and disabled/revoked-account credentials; cookie-only GET-write rejection across posts, profiles, resources and subscription adapters; repeated/unknown query fields and prefetch rejection.
- Private-board access through board messages, direct threads and board-scoped search; wrong methods, unknown routes, invalid chat IDs; empty chat reads/settings without crypto setup.
- DAO root discovery, empty/unlinked wallet reads, invalid wallet challenge addresses without contacting RPC; moderation/bridge credential separation and empty queues/history.
- Malformed percent-encoding regressions for history/profile/subscription and public pages; public static HEAD, redirects and invalid sitemap shards.

## Ambiguities and remaining gaps left alone

- Unsupported methods use route-specific 404/405 behavior; health accepts arbitrary methods. Tests preserve that behavior.
- Chat conversation lists (50), contribution lists (10), DAO proposals (20) and public HTML lists use fixed sizes and ignore `limit`. No new limit contract was imposed.
- Several numeric parsers accept numeric strings, whitespace or exponent notation; empty query values may select defaults. Tests target unambiguously invalid bounds rather than standardizing coercion.
- MCP transport/protocol permutations, every DAO RPC failure/action combination, every internal budget invalid-input combination, complete review finding validation, exhaustive chat cryptographic envelope permutations, and every status-transition race are not exhaustive. Existing suites cover core workflows; no production-only endpoints were invented.
- Revocation coverage uses a disabled seeded account plus the existing key-rotation/session-revocation tests. Test credentials are synthetic fixtures.

## Validation

- Before: 100/100 tests (provided branch baseline).
- Added: 28/28 integration tests, approximately 15 seconds standalone.
- After: **128/128 tests pass**, zero skipped, using `flock /tmp/aamb-test.lock npm test` in a private network namespace (252 seconds for the entire suite).
- Build: `npm run build` passes (TypeScript and Vite).
- The first locked run hit an unrelated application already listening on port 8799: all 49 API tests failed their startup hook; the other 79 passed. The complete rerun used `unshare --user --map-root-user --net`, enabled loopback, and ran the same locked command. No unrelated process or worktree was modified.
- No deployments or production requests.
