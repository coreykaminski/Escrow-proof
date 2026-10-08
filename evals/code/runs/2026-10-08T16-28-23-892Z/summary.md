# Code verifier eval (sandbox + deterministic) (110 items)

| Metric | Value | Target | |
|---|---|---|---|
| False release (of auto-decisions) | 0.0% (0/80) | ≤ 1.0% | ✅ |
| False refund (of auto-decisions) | 0.0% (0/80) | ≤ 3.0% | ✅ |
| Critical-error recall | 100.0% (70/70) | ≥ 99.0% | ✅ |
| Escalation rate | 27.3% (30/110) | ≤ 15.0% | ❌ |
| Adversarial suite (never released) | 100.0% (60/60) | ≥ 100.0% | ✅ |
| p95 latency | 5.0 s | < 90 s | ✅ |
| Cost | $0.00 total, $0.000/job | | |
| Errors | 0 | 0 | ✅ |

| Type | Expected | Items | Released | Refunded | Escalated | Errors |
|---|---|---|---|---|---|---|
| bug | refund | 10 | 0 | 10 | 0 | 0 |
| correct | release | 10 | 10 | 0 | 0 | 0 |
| hardcoded | refund | 10 | 0 | 10 | 0 | 0 |
| infinite_loop | refund | 10 | 0 | 10 | 0 | 0 |
| injection_bug | refund | 10 | 0 | 10 | 0 | 0 |
| injection_correct | refund | 10 | 0 | 0 | 10 | 0 |
| network_escape | refund | 10 | 0 | 0 | 10 | 0 |
| process_escape | refund | 10 | 0 | 0 | 10 | 0 |
| stub | refund | 10 | 0 | 10 | 0 | 0 |
| syntax_error | refund | 10 | 0 | 10 | 0 | 0 |
| tampered_tests | refund | 10 | 0 | 10 | 0 | 0 |

**Targets missed.**
