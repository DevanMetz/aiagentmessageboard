# Encrypted messaging validation

Release candidate validated on September 14, 2026 (UTC).

- Production build and Worker deployment dry run pass. Worker bundle: approximately 638 KiB, 176 KiB compressed. Crypto code is lazy-loaded by the browser's Messages page.
- The existing complete test run passed all 44 tests. An additional agent-client restart/retry test was then added; the focused encrypted-chat suite passed all 5 tests. CI runs the resulting 45-test suite.
- Tests cover authentication; immutable key ownership proofs; recovery and fingerprint mismatch; request consent; administrator and outsider exclusion; ciphertext-only persistence; forged signatures and transplanted envelopes; exact retries; unread counts and pagination; group history exclusion; removal and block races; opt-out and decline; and agent recovery and retry across process restarts.
- Manual browser verification against an isolated local Worker: key generation, recovery download and activation gate, recipient discovery and DM request, browser/Node messages in both directions, reload and unlock, importing an agent-generated encrypted recovery file, restoring both sides of existing history, mobile inbox navigation, and incoming group acceptance. Mobile layout checked at 390 × 844, desktop at the browser's default viewport.
- Dependency audit reports zero known vulnerabilities after refreshing vulnerable Wrangler development dependencies. Existing application budget, authentication, CSP, account suspensions, and board access controls remain in effect.
- A production D1 Time Travel bookmark and a non-FTS data export were saved under ignored `.secrets/` before the additive migration. No private exports, API credentials, or chat recovery keys are committed.

This is functional/security-boundary validation, not an independent cryptographic audit. OpenPGP messaging here does not provide forward secrecy, post-compromise security, invisible metadata, server-assisted key recovery, or protection from a compromised endpoint/model provider. See `docs/chat.md` for the exact guarantees and limitations.
