# Data/research verifier eval (deterministic) (50 items)

| Metric | Value | Target | |
|---|---|---|---|
| False release (of auto-decisions) | 0.0% (0/44) | ≤ 1.0% | ✅ |
| False refund (of auto-decisions) | 0.0% (0/44) | ≤ 3.0% | ✅ |
| Critical-error recall | 100.0% (38/38) | ≥ 99.0% | ✅ |
| Escalation rate (honest deliveries) | 0.0% (0/38) | ≤ 15.0% | ✅ |
| Adversarial suite (never released) | 100.0% (12/12) | ≥ 100.0% | ✅ |
| Escalation rate (all items, incl. attacks) | 12.0% (6/50) | info | |
| p95 latency | 0.0 s | < 90 s | ✅ |
| Cost | $0.00 total, $0.000/job | | |
| Errors | 0 | 0 | ✅ |

| Type | Expected | Items | Released | Refunded | Escalated | Errors |
|---|---|---|---|---|---|---|
| dataset:bad_format | refund | 4 | 0 | 4 | 0 | 0 |
| dataset:duplicate | refund | 4 | 0 | 4 | 0 | 0 |
| dataset:empty | refund | 4 | 0 | 4 | 0 | 0 |
| dataset:injection | refund | 4 | 0 | 0 | 4 | 0 |
| dataset:missing_field | refund | 4 | 0 | 4 | 0 | 0 |
| dataset:too_few | refund | 4 | 0 | 4 | 0 | 0 |
| dataset:truncated | refund | 4 | 0 | 4 | 0 | 0 |
| dataset:valid | release | 4 | 4 | 0 | 0 | 0 |
| dataset:wrong_type | refund | 4 | 0 | 4 | 0 | 0 |
| research:dead_link | refund | 2 | 0 | 2 | 0 | 0 |
| research:fabricated_source | refund | 2 | 0 | 2 | 0 | 0 |
| research:injection | refund | 2 | 0 | 0 | 2 | 0 |
| research:misquote | refund | 2 | 0 | 2 | 0 | 0 |
| research:ssrf_citation | refund | 2 | 0 | 2 | 0 | 0 |
| research:too_few_sources | refund | 2 | 0 | 2 | 0 | 0 |
| research:valid | release | 2 | 2 | 0 | 0 | 0 |

**All targets met.**
