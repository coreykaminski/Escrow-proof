# Code verifier eval (sandbox + deterministic) (130 items)

| Metric | Value | Target | |
|---|---|---|---|
| False release (of auto-decisions) | 0.0% (0/110) | ≤ 1.0% | ✅ |
| False refund (of auto-decisions) | 0.0% (0/110) | ≤ 3.0% | ✅ |
| Critical-error recall | 100.0% (90/90) | ≥ 99.0% | ✅ |
| Escalation rate (honest deliveries) | 0.0% (0/50) | ≤ 15.0% | ✅ |
| Adversarial suite (never released) | 100.0% (80/80) | ≥ 100.0% | ✅ |
| Escalation rate (all items, incl. attacks) | 15.4% (20/130) | info | |
| p95 latency | 5.0 s | < 90 s | ✅ |
| Cost | $0.00 total, $0.000/job | | |
| Errors | 0 | 0 | ✅ |

| Type | Expected | Items | Released | Refunded | Escalated | Errors |
|---|---|---|---|---|---|---|
| bug | refund | 10 | 0 | 10 | 0 | 0 |
| correct | release | 10 | 10 | 0 | 0 | 0 |
| forged_results | refund | 10 | 0 | 10 | 0 | 0 |
| hardcoded | refund | 10 | 0 | 10 | 0 | 0 |
| infinite_loop | refund | 10 | 0 | 10 | 0 | 0 |
| injection_bug | refund | 10 | 0 | 10 | 0 | 0 |
| injection_correct | refund | 10 | 0 | 0 | 10 | 0 |
| network_escape | refund | 10 | 0 | 10 | 0 | 0 |
| patched_assert | refund | 10 | 0 | 10 | 0 | 0 |
| process_escape | refund | 10 | 0 | 0 | 10 | 0 |
| stub | refund | 10 | 0 | 10 | 0 | 0 |
| syntax_error | refund | 10 | 0 | 10 | 0 | 0 |
| tampered_tests | refund | 10 | 0 | 10 | 0 | 0 |

**All targets met.**
