# Information security policy

**Purpose.** Protect the confidentiality, integrity and availability of customer content, payment flows and decision records. Integrity matters most for a verifier: a decision must be traceable and impossible to change silently.

**Scope.** Everything listed below, plus everyone with access to any of it (staff, contractors, human reviewers):
- the API, worker and dashboard;
- the code sandbox host;
- the database and backups;
- the smart contracts and their keys;
- the source repository and CI;
- vendor accounts (Stripe, Anthropic, Fly.io, Neon, AWS, GitHub, the domain registrar).

**Principles**
1. **Least privilege.** Access is granted per role and removed when no longer needed (see the access-control policy).
2. **Untrusted input stays untrusted.** Deliverables are data, never instructions. Delivered code runs only in the isolated sandbox. Outbound requests pass the SSRF guard.
3. **No custody of funds.** Designs that would hold customer money outside the payment processor or the public contract need legal review first.
4. **Every decision is recorded.** State changes go through one code path that writes the append-only ledger in the same transaction. The ledger is anchored publicly every day.
5. **Secrets never enter git.** Secrets live in the hosting provider's secret store, a local `.env` (git-ignored) or a KMS. CI scans history for secrets.

**Risk assessment.** At least yearly, and before major launches:
1. Review the threat model ([review-2026-10.md](../review-2026-10.md), [audit-pack.md](../audit-pack.md)).
2. List new risks with an owner and a due date in `docs/security/risks.md` `[create at first assessment]`.
3. Commission outside testing before live money: a penetration test and a contract audit.

**People**
- Everyone with production or reviewer access reads these policies on joining and yearly, and acknowledges it (recorded in the onboarding checklist).
- Human reviewers also receive the reviewer guidelines: confidentiality, decide by the approved criteria only, and recuse yourself on any conflict of interest.

**Exceptions** need written approval from the security lead, with an expiry date. They're recorded in the risk list.
