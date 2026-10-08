# SOC 2 readiness (started)

Goal: a Type I report after the design-partner pilots, then Type II. This maps the Trust Services Criteria (Security, plus Availability and Processing Integrity, which matter most to buyers of a verifier) to what exists today and what's missing.

| Area | In place | Gap / next step |
|---|---|---|
| **Access control (CC6)** | Scoped API keys stored hashed; revocation; per-account isolation tested; dashboard sessions hashed, short-lived, CSRF-protected | SSO + MFA for staff (Google Workspace); quarterly access review; separate ops keys per reviewer (supported) |
| **Change management (CC8)** | Git history; CI on every push (lint, types, 600+ tests, contract invariants, verifier gates); migrations reviewed in PRs | Branch protection + required review on `main`; deploy approvals; written release checklist (docs/launch/runbook.md) |
| **System operations (CC7)** | `/status` with scheduler heartbeat and ledger check; structured worker logs; idempotent retries | Uptime monitor + paging; log retention (Fly → log drain); incident response plan (runbook §Incidents) |
| **Risk assessment (CC3)** | Security review (docs/security/review-2026-10.md), red-team catalog | Annual risk assessment; vendor list with SOC reports (Stripe, Neon, Fly, Anthropic) |
| **Data protection (C1, PI1)** | TLS everywhere; no card data touches us (Stripe Elements); documents only shown to the owning platform and ops; reports exclude documents | Encryption at rest is the provider default (Neon); data retention and deletion policy; DPA template |
| **Processing integrity (PI1)** | Hash-chained append-only ledger; decisions carry report hashes; on-chain reason = ledger hash; golden-set accuracy gates in CI | Publish accuracy reports; shadow-mode human review in pilots (plan §8) |
| **Availability (A1)** | Rolling deploys; health checks; Neon PITR | Backup restore drill; RTO/RPO targets; multi-machine web with a shared rate-limit store |
| **Vendor management (CC9)** | Few vendors, all with SOC 2 | Track their reports yearly |
| **Policies** | — | Infosec, acceptable use, incident response, vendor, data retention (templates from the compliance tool) |

Next actions: pick a compliance platform (Vanta, Drata or Secureframe) once pilots start, turn on branch protection now, and set up an uptime monitor on `/status.json`.
