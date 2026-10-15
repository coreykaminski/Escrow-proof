# Security policies

Proof Desk's written security policies. They describe what we actually do; where something isn't in place yet, the policy says so. Owner: Corey Kaminski (security lead until a dedicated owner is named). Each policy is reviewed at least yearly and after any significant incident or architecture change. Approval is recorded in git history.

| Policy | Covers (SOC 2) |
|---|---|
| [Information security](information-security.md) | Scope, roles, risk assessment, training (CC1–CC3, CC5) |
| [Access control](access-control.md) | Who can access what, keys, reviews, offboarding (CC6) |
| [Change management and secure development](change-management.md) | How code reaches production (CC8) |
| [Incident response](incident-response.md) | Detecting, handling and learning from incidents (CC7) |
| [Vendor management](vendor-management.md) | Third parties we rely on (CC9) |
| [Business continuity and backups](business-continuity.md) | Backups, restore, recovery targets (A1) |
| Data retention | [Platform agreement §7](../../legal/platform-agreement.md), [DPA §3.6](../../legal/dpa.md) and `RETENTION_DAYS` (C1, P4) |
| Evaluator keys | [evaluator-keys.md](../evaluator-keys.md) (CC6) |
