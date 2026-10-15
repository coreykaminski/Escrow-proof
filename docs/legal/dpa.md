# Data Processing Agreement (DPA)

> **DRAFT for counsel review. Not legal advice. Not for signature.** Annex to the Proof Desk Platform Agreement.

## 1. Roles and scope
- The Platform is the controller, or the business, of personal information in the content and references it submits ("Platform Data").
- Proof Desk processes Platform Data only to provide the Service, on the Platform's documented instructions. The Agreement and the Platform's API calls are those instructions.

## 2. Processing details
| | |
|---|---|
| **Subject matter** | Conditional payments, verification of deliverables, dispute handling, record-keeping |
| **Duration** | The term of the Agreement plus the retention periods below |
| **Data subjects** | The Platform's buyers and sellers; people named in work content |
| **Categories** | Pseudonymous buyer and seller references; work content (which may contain any personal information the work does); payment status; wallet addresses; reasons and decisions |
| **Special categories** | Not intended. The Platform must not submit them without written agreement. |

## 3. Proof Desk's commitments
3.1 **Confidentiality:** staff and reviewers with access are bound by confidentiality.

3.2 **Security (Annex A):** appropriate technical and organisational measures.

3.3 **Subprocessors:**
- We use the subprocessors in Annex B.
- We give `[30]` days' notice of changes, and the Platform may object on reasonable grounds.
- We impose equivalent data-protection terms on each subprocessor.

3.4 **Assistance:** we help the Platform with data-subject requests, impact assessments and breach notifications, as far as the nature of the processing allows.

3.5 **Breaches:** we notify the Platform without undue delay, and within `[72]` hours, of becoming aware of a personal-data breach affecting Platform Data.

3.6 **Deletion:**
- Content (deliverables, inputs, quoted evidence) is deleted 90 days after an agreement is final, or as the Platform configures, or on request once final.
- On termination, the remaining content is deleted after the export period.
- Retained permanently, as described in the Agreement: hashes, pseudonymous decision records, the ledger, and anonymous public verdict records. `[COUNSEL: confirm this is compatible with erasure rights.]`

3.7 **Audits:** we make available the information needed to show compliance, including summaries of independent security testing, on reasonable notice.

## 4. International transfers
Transfers outside `[jurisdiction]` use appropriate safeguards `[COUNSEL: SCCs / adequacy / PIPEDA accountability]`.

## Annex A: Security measures (summary)
- TLS in transit.
- Encrypted storage at the provider.
- API keys and session and link tokens stored only as hashes.
- Every query scoped by account.
- CSRF protection, strict content security policy, rate limits.
- An isolated sandbox for executing delivered code: no network, unprivileged, resource-limited.
- An SSRF guard on outbound requests.
- Signing keys for the payment contract held in a managed key service (KMS).
- An append-only, tamper-evident ledger with daily public anchoring.
- Automated security scanning in development.
- Third-party penetration testing before launch.
- Staff and reviewers have least-privilege access, with individual keys.

## Annex B: Subprocessors `[confirm before signing]`
| Subprocessor | Purpose | Data | Location |
|---|---|---|---|
| Stripe | Card payments and payouts; billing | Payment data, payout accounts | `[US / CA]` |
| Anthropic | AI analysis of content for some checks | Work content sent for checking | `[US]` |
| Fly.io | Application hosting | All Platform Data in transit and processing | `[region]` |
| Neon | Database | Platform Data at rest | `[region]` |
| Amazon Web Services | Key management (signing keys only) | No Platform Data | `[region]` |
| `[Backup storage provider]` | Encrypted off-site backups | Platform Data at rest | `[region]` |
| Base (public blockchain) | Public anchoring of summary hashes; stablecoin settlement | Hashes; wallet addresses and amounts for stablecoin jobs | Public, global |
