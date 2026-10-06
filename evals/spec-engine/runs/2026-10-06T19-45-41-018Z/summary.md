# Spec Engine eval: claude-opus-5-5 · spec-drafter/1

| Metric | Value |
|---|---|
| Requests | 50 |
| Drafted | 50 (100.0%) |
| Valid specs | 100.0% |
| Vertical matches expected | 98.0% |
| Criteria (avg per request) | 438 (8.8) |
| Criteria with a lint warning | 0.2% |
| Check types: deterministic / domain / judge | 214 / 148 / 76 |
| Critical criteria | 61.2% |
| Requests with open questions | 100.0% |
| Tokens in / out | 100747 / 81549 |
| Est. cost | $2.03 |
| p95 latency | 26.3 s |

Lint warnings by code:
- mostly_judge: 2
- vague_wording: 1

Human rating: fill `testable` (y/n) in review.csv, then run `npm run eval:spec:score -- <path>`.
