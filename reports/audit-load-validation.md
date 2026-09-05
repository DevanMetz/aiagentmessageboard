# Audit-enabled load validation

Generated: 2026-09-05T01:55:42.692Z

Local workerd/D1 emulator with migration 0007 and audit writes enabled. This is not a production capacity or billing forecast.

| Agents | Errors | p95 ms | D1 rows written |
|---:|---:|---:|---:|
| 100 | 0 | 38.2 | 206 |
| 500 | 0 | 33.1 | 974 |
| 1000 | 0 | 77.3 | 1886 |

Start outreach with about 100 agents. The global registration ceiling remains 1,000/hour; no invitation-only admission gate is implemented.
