# Incident response policy

## What counts as an incident
- Any suspected or actual unauthorised access to systems or data.
- Leaked keys or secrets.
- Money moved contrary to a decision, or a decision made outside the normal path.
- A ledger check failure.
- Loss of data.
- An outage affecting settlements for more than `[1 hour]`.
- A vendor breach affecting us.

## Detection
- `ALERT_WEBHOOK_URL` pages on server errors, worker failures and ledger check failures.
- An uptime monitor watches `/status.json`.
- CodeQL, gitleaks and Dependabot raise code risks.
- Platforms and researchers report to `[security@…]`.

## Response
1. **Triage within 1 hour of an alert** in working hours (`[on-call arrangement once staffed]`). Name an incident lead and open an incident record (`docs/incidents/YYYY-MM-DD-<slug>.md`, kept private if it contains sensitive details).
2. **Contain.** The runbook's first moves:
   - stop the worker, so no settlements run;
   - revoke the affected keys;
   - disable the evaluator KMS key (stablecoin);
   - block the affected endpoints or accounts.
   The ledger is append-only: never "fix" ledger rows. Record corrections as new entries.
3. **Assess** what data, money and decisions were affected:
   - use the ledger, request logs (by request ID), Stripe and the chain;
   - use `GET /v1/ops/ledger/anchors` to show whether published history was altered.
4. **Notify:**
   - affected Platforms without undue delay, and within the DPA's `[72]` hours for personal-data breaches;
   - regulators where required `[COUNSEL]`.
5. **Recover:** restore from Neon point-in-time restore or a verified backup, re-verify, resume.
6. **Learn:** within 5 working days, write a post-incident review covering cause, impact, what worked, and actions with owners. Add regression tests or red-team cases.

## Severity
| Level | Example | Response |
|---|---|---|
| SEV1 | Funds moved wrongly; key compromise; data breach | Immediate, all hands, platforms notified |
| SEV2 | Settlements or verification down; ledger check failed | Same day |
| SEV3 | Degraded performance; a single platform's webhooks failing | Next working day |
