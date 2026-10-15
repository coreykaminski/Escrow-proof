# Vendor management policy

**Before adopting a vendor that touches customer data or money:**
1. Check its security posture (SOC 2 / ISO report, or equivalent).
2. Check its data terms: training use, retention, location.
3. Sign data-processing terms where needed.
4. Add it to the DPA's subprocessor list, with notice to Platforms.

**Yearly:** review each vendor's current security report and terms, and record the review below.

| Vendor | What it does for us | Data | Assurance to collect | Last reviewed |
|---|---|---|---|---|
| Stripe | Card payments, Connect payouts, Billing | Payment data | PCI DSS Level 1, SOC reports | `[ ]` |
| Anthropic | AI analysis in some checks | Work content sent for checks | SOC 2; API data-use terms (no training) | `[ ]` |
| Fly.io | Hosting | All, in processing | SOC 2 | `[ ]` |
| Neon | Postgres | All, at rest | SOC 2 | `[ ]` |
| AWS | KMS signing keys | None (keys only) | SOC 2 / ISO 27001 | `[ ]` |
| GitHub | Source code, CI | Code; no customer data | SOC 2 | `[ ]` |
| `[Backup storage]` | Off-site encrypted backups | All, at rest | SOC 2 | `[ ]` |

**Leaving a vendor:** export, verify, delete, and confirm the deletion in writing where possible.
