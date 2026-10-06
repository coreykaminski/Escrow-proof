# Rebate & Incentive Filer: Research, Verdict, and Master Build Plan

*Prepared October 6, 2026. Policy facts change quickly, so re-check the "Market reality" section before any major decision.*

---

## 1. The verdict (read this first)

**Yes, it's worth building, but not in the form of the original pitch.**

| Original assumption | What the research shows |
|---|---|
| "Big software firms don't bother" | Partly true for ServiceTitan, Housecall Pro and Jobber. But at least five funded startups and two HVAC manufacturers are already in this space (see §3). Rebate *discovery* is close to free now. |
| Serve HVAC, solar, insulation and heat-pump installers | **Leave solar out.** The federal residential solar credit (25D) ended Dec 31, 2025, and solar has few rebates you file per claim. Focus on **heat-pump/HVAC + insulation/air-sealing**. |
| Federal and government rebates are the big prize | The 25C/25D tax credits are gone (OBBBA, July 2025). The $8.8B DOE HEAR/HOMES rebates were frozen for about 16 months and resumed in **June 2026 with tighter rules**: no gas-to-electric switching, and insulation and air sealing required before HVAC. As of mid-2026 only about 12 states plus DC were live. That money is real but slow and political. |
| — | **Utility ratepayer-funded programs are the durable base.** They are regulated, run in multi-year cycles, and pay out billions a year. Examples: Mass Save, NYS Clean Heat, Energy Trust of Oregon, Xcel, California RENs. |

**What wins:** a **done-for-you rebate back office** for small and mid-size contractors (5–50 employees) in **one dense region first**. It owns the whole tedious loop (intake → chasing documents → validation → submission → tracking → fixing rejections → reconciling payment) and charges per claim. That's software plus a human ops person at first. It isn't a self-serve SaaS dashboard.

**Why there's still room:**
1. **The pain is documented and severe.** Contractors spend 4–5 admin hours per rebate. More than 40% of NYS Clean Heat submissions were rejected as incorrect or incomplete. Payouts take 6–8+ weeks. Some contractors stop offering rebates during busy season. ([Sealed](https://sealed.com/uncomfortable-truth-about-rebate-programs/))
2. **The competitors cluster in California** (Sealed, Eli and Rock Rabbit all started there) and lean toward either *discovery* (finding rebates) or *financing* (fronting cash for a 25% cut). Few own the "chase the missing document and get it accepted the first time" part.
3. **"Every program has different forms" is a moat, not just a pain point.** Whoever builds the deepest library of program rules, validations and rejection reasons in a region becomes hard to displace there.

**Biggest risks (and how we de-risk them):**
| Risk | Mitigation |
|---|---|
| Funded competitors expand into our region | Pick a region they're weak in. Win on first-pass acceptance rate and hands-on service. Build integrations into the contractor's existing field software. |
| Programs change rules or run out of money | Program-as-config architecture (§5) so a rule change is a data edit, not a code change. Track budget and reservation status per program and alert contractors. |
| Portal terms bar third-party submission or credential sharing | Before launch, confirm for each program whether delegate/sub-user access exists. Otherwise we prepare a "ready-to-submit packet" and the contractor clicks submit. |
| OEMs give rebate tools away (e.g., Daikin + Rock Rabbit) | Their tools are tied to their brand and focused on discovery. We're brand-agnostic and handle the full chase and resubmission loop. |
| Homeowner PII and income documents (HEAR) | Encryption, least-privilege access, audit log from day 1. SOC 2 by month 12. |

**Go/no-go gate (end of Week 3):** at least 3 contractors who will pay **≥ $75 per claim** (or a % of the rebate), and at least 15 real claims in hand. If we miss it, pivot (see §8).

---

## 2. Market reality (as of Oct 2026)

### Incentive landscape
- **Federal tax credits 25C (heat pumps, insulation) and 25D (solar, geothermal):** ended for property placed in service after **Dec 31, 2025** under the One Big Beautiful Bill Act (P.L. 119‑21). There's nothing to file for 2026 installs. ([Energy Rebate Calculator](https://energyrebatecalculator.com/guide/obbb-energy-changes), [Filterbuy](https://filterbuy.com/resources/heat-pumps/heat-pumps-basics/heat-pump-rebates-and-tax-incentives-in-2026/))
- **DOE Home Energy Rebates (HEAR/HEEHR + HOMES, $8.8B):** frozen from Jan 2025. Funding reopened with new guidance effective **May 29, 2026**:
  - HEEHR no longer covers fuel switching. It now covers only electric→more-efficient-electric upgrades.
  - Insulation and air sealing are required before HVAC upgrades unless the home is already tight.
  - HOMES dropped the Energy Star equipment requirement.
  - Live programs had **3 months to comply**.
  - About 12 states plus DC were live. More are launching late 2026 to 2027, e.g., Oregon contractor enrollment opens Oct 12, 2026 and Texas is targeting fall 2026.

  ([homepros.news](https://homepros.news/doe-unfreezes-home-energy-rebates-nixes-gas-to-electric-upgrades/), [Utility Dive](https://www.utilitydive.com/news/states-energy-efficiency-rebates-inflation-reduction-doe-trump/756981/), [Oregon DOE](https://energyinfo.oregon.gov/blog/2026/9/22/oregon-home-energy-rebate-programs-to-begin-contractor-enrollment), [NEEP](https://neep.org/blog/home-energy-rebates-roundup-across-northeast-and-mid-atlantic))
  - *Implication:* the new "weatherize first" rule makes **insulation and air-sealing contractors more important**, and it means more multi-trade, multi-document projects. That plays to our strengths.
- **Utility programs:** these are the most widely available incentives now. Heat-pump rebates run roughly $250–$8,500 by region. Many require an **enrolled/participating contractor** (Mass Save HPIN, NYS Clean Heat participating contractors), so the contractor is the natural filer. California alone invested about $795M in efficiency portfolios in 2025. Sealed estimates more than $2.5B a year in utility rebates nationally. ([Mass Save](https://www.masssave.com/residential/rebates-offers-services/heating-and-cooling/heat-pumps/air-source-heat-pumps), [Sealed/Pulse2](https://pulse2.com/sealed-reveals-sealed-pro-and-30-million-funding-round))
- **Demand side:** AHRI data shows US AC plus heat-pump shipments **down about 20% in 2025**, with heat pumps down about 11.6%. Contractors are under margin pressure. Rebates now decide more deals, and contractors have less spare admin time. ([IIR/AHRI](https://iifiir.org/en/news/united-states-december-2025-heating-and-cooling-equipment-shipment-data))

### What a typical claim needs (and why it gets rejected)
- **Usual documents:** signed rebate form, itemized paid invoice with make/model, AHRI certificate number that matches the installed equipment, indoor and outdoor model numbers, install date and address, total cost, proof of payment, sometimes photos, startup sheets, permits, and income verification (HEAR).
- **Why claims get rejected:** missing signature, AHRI mismatch, wrong model string, invoice missing required line items, past the deadline, unenrolled contractor, homeowner on the wrong utility, missing photo.
- **Every one of those is machine-checkable before submission.** That's the core product.

### Market size (rough, bottom-up)
- Target contractor in one region files 15–60 claims a month.
- Per-claim fee averages about $100 (or 5–8% of the rebate).
- 40 claims × $100 = **about $4,000 a month per contractor**, roughly $48K a year.
- **50 contractors ≈ $2.4M ARR.** That's realistic within one or two states.
- The national ceiling is bounded by roughly $2.5B a year in utility rebates plus HEAR. At a ~5% take rate that's a ~$125M+ revenue pool, which is enough for a strong regional-to-national company. It isn't a winner-take-all giant, so capital efficiency matters.

---

## 3. Competitors

| Company | What they do | Model / price | Where | Notes |
|---|---|---|---|---|
| **Sealed (Sealed Pro)** | Rebate paperwork plus fronting rebate cash in about 10 days | **25% of rebate** (includes financing) | CA, NY, expanding | $30M raised. Pivoted from consumer to B2B. Strong in measured-savings programs. |
| **Eli Technologies** | Rebate-management workflow software | **≤$500/mo + $100–$350 per project** | CA, NY | $6.8M seed (Feb 2024). Contractor-operated software. |
| **Rock Rabbit** | Discovery, applications, financing. White-labels for utilities and OEMs | Not public | CA → 37 states via Daikin | $3.1M seed. Powers the **Daikin Energy Rebate Center** (Mar 2026: 150+ programs, 37 states). Also Palo Alto Utilities and SVCE. |
| **Coral** | 60-second eligibility check, instant discount at signing, contractor paid in 24h | Not public (likely a % plus financing spread) | Northeast-leaning | Logos include Watsco and Mitsubishi Electric. Fronts cash. |
| **Rewiring America API** | Free incentive-eligibility data | Free / API key | National | Discovery only. **We should use it**, not compete with it. |
| **Rebate Bus** | Commercial rebate search database | From $50/mo | National | Commercial lighting and HVAC. Discovery only. |
| **Instafill.ai, RebateManager.ai** | Generic AI form-fill; distributor volume-rebate tracking | Varies | — | Shallow. Not program-specific. |
| **ServiceTitan / Housecall Pro / Jobber** | Field-service software | — | — | ServiceTitan's "rebates" handle *manufacturer/supplier* rebates, not utility claims. These are **integration partners, not competitors.** |
| **Program implementers** (CLEAResult, ICF, Franklin Energy, APTIM) | Run the program portals | Paid by utilities | — | They're the counterparty. Later, a possible channel ("preferred submitter"). |

**Positioning:** *"Your rebate department. Send us the job and we get it accepted on the first try, chase every missing document, and tell you exactly when the money lands. You pay only per accepted claim."*

**How we differ from each:**
- **Sealed and Coral:** we don't take 25%. Rebate advances come later as an *optional* add-on through a financing partner.
- **Eli:** we're done-for-you, not another tool your office manager has to learn.
- **Rock Rabbit and Daikin:** we're brand-agnostic and own the chase, fix and resubmit loop.

---

## 4. Ideal customer and beachhead

- **ICP:** independent residential HVAC/heat-pump contractors and insulation/air-sealing contractors. Revenue $1–15M, 5–50 staff, filing 15+ rebate claims a month, and either no dedicated rebate admin or one overloaded office manager.
- **Beachhead region (recommended): New York + Massachusetts.**
  - NYS Clean Heat has a documented 40%+ rejection rate, which is the clearest pain signal available.
  - Mass Save is the largest and most mature heat-pump program in the US. Both require enrolled contractors.
  - CT and RI are adjacent expansions. HEAR/HOMES layer on top as those states go live.
  - California is the most crowded (Sealed, Eli and Rock Rabbit all started there). Avoid it for now.
  - *Override:* if you have trade relationships somewhere else, pick the region where you can **physically visit 20 contractors**. Relationships beat the region choice.
- **First 3 programs to support:** e.g., NYS Clean Heat (one utility territory), Mass Save air-source heat pump rebate, and one weatherization/insulation program in the same area. Choose them based on which programs your first 3 customers actually file.

### Pricing
- **Default:** **$95 per accepted claim** (heat pump/HVAC) and **$150 per accepted claim** for weatherization/HOMES (more documents). Nothing is charged on a rejection we caused.
- **Alternative:** 6% of the rebate amount, with a $50 minimum and a $400 cap.
- **Volume plan:** $1,500/mo for up to 25 claims, then $60 per claim after that.
- **Later add-ons:** rebate advance (financing partner, ~3–5%), and a quote-time "net price" estimator.
- ⚠️ Check each program's rules on fees charged against the rebate. Charging the **contractor** a service fee is generally fine. Don't deduct fees from a homeowner's rebate.

---

## 5. Product architecture

### Core idea: programs are data, not code
Each program is a versioned **Program Spec** (JSON/YAML) containing:
- `eligibility`: utility territory, ZIP codes, equipment types, efficiency thresholds (HSPF2/SEER2/CEE tier), income tiers, prior-fuel rules (new HEAR rule), weatherize-first rule
- `required_fields`: field name, type, source (invoice, AHRI cert, homeowner, contractor profile)
- `required_documents`: type, how to recognize it, validation rules
- `validations`: e.g., "AHRI ref # model == invoice outdoor model", "install_date within program year", "submitted ≤ N days after install"
- `deadlines`: submission window, program year end, fund-exhaustion status
- `output`: PDF field mapping (AcroForm), a portal step script, or an email packet
- `known_rejection_reasons`: added every time something is rejected. **This is the moat.**

Adding a new program means writing a spec and adding fixtures. No new code.

### Tech stack (simple, fast, cheap)
- **App:** Next.js (TypeScript), Tailwind, deployed on Vercel
- **DB/Auth/Storage:** Supabase (Postgres + Row-Level Security + encrypted storage buckets)
- **ORM / validation:** Drizzle + Zod (Zod also validates Program Specs)
- **Document AI:** Claude API (`claude-sonnet-5-5`) to extract invoices, AHRI certs and nameplate photos into structured JSON. `claude-haiku-4-5` to classify document type.
- **Equipment verification:** AHRI Directory lookup (licensed data or a lookup service). Start with a manual lookup step.
- **PDF:** `pdf-lib` to fill AcroForms. E-signature via Dropbox Sign or Documenso.
- **Chasing:** Twilio SMS + Resend email. Magic-link upload pages so techs and homeowners never need a login.
- **Jobs/schedules:** Inngest or Supabase cron (reminders, deadline alerts, status polling)
- **Portal assist (later):** Playwright, human-in-the-loop only. It never submits on its own unless the program allows that.
- **Billing:** Stripe (metered per accepted claim)
- **Testing:** Vitest (unit), Playwright (E2E), plus a custom "golden set" extraction evaluation

### Data model (v1)
```
Organization (contractor) ─┬─ User (owner, office, tech)
                           ├─ ProgramEnrollment (program, contractor ID, status)
                           └─ Job ── Customer (homeowner, address, utility)
                                 └─ Claim (job × program, status, $ expected/paid)
                                      ├─ Document (type, file, extracted_json, confidence)
                                      ├─ Requirement (from spec: met / missing / invalid)
                                      ├─ Chase (who, channel, sent_at, responded_at)
                                      ├─ Submission (method, ref #, packet snapshot)
                                      └─ StatusEvent (submitted, needs-info, approved, paid, rejected+reason)
Program ── ProgramSpecVersion (JSON spec, effective dates)
```

### Claim state machine
`draft → collecting_docs → ready_for_review → submitted → (needs_info ↺ submitted) → approved → paid → billed`, plus `rejected → fixing → resubmitted`. Every transition is logged, which gives you the audit trail and the analytics.

---

## 6. Build order (first → last)

### Phase 0: Validate before code (Weeks 1–3)
1. Interview 25–30 target contractors (owners and office managers). Questions: claims per month, hours per claim, rejection rate, days to payment, who does the work today, what they'd pay.
2. **Concierge MVP:** file 10–20 real claims *by hand* for 2–3 contractors, using Google Drive, a spreadsheet and the program portals. Charge for it, even a discounted rate.
3. Collect every document and rejection reason. This becomes the **golden test set**, with homeowner PII redacted for fixtures.
4. Pick the first 3 programs and write their Program Specs by hand.
5. Confirm for each program whether third-party or delegate submission is allowed.
6. **Gate:** ≥3 paying contractors, ≥15 claims, a price of ≥$75 per claim confirmed.

### Phase 1: Internal ops engine (Weeks 4–8)
*Built for **you** (the ops person) to process claims 4× faster. Contractors only see upload links.*
1. Repo, CI, Supabase, auth, organizations and users, audit log
2. Program Spec schema + loader + the 3 specs
3. Job/Claim creation (manual entry or CSV)
4. Magic-link document upload (tech or homeowner on a phone, including photos)
5. Document classification and extraction (Claude) + a review screen to correct fields
6. Validation engine: spec rules → requirement checklist (met / missing / invalid)
7. Automated chasing: SMS and email for missing items, with escalating reminders
8. Packet generation: filled PDF + attachments zip + "portal cheat sheet" (field-by-field values to paste)
9. Manual submission logging + status tracking + deadline alerts

### Phase 2: Contractor-facing product (Weeks 9–14)
1. Contractor dashboard: claims by status, money expected vs. received, what's blocked and on whom
2. Homeowner e-signature flow for rebate forms and assignment-of-payment
3. Rejection workflow: capture the reason → map it to a spec rule → fix → resubmit (and update the spec)
4. Payment reconciliation: mark paid, match to deposits or remittance CSV, aging report
5. Stripe billing per accepted claim + monthly invoice
6. Weekly email digest to the contractor owner: "$X pending, $Y paid, Z blocked on your tech"

### Phase 3: Workflow integration and scale (Weeks 15–22)
1. Integrations: ServiceTitan, Housecall Pro and Jobber (auto-create a claim when a qualifying job closes), plus CompanyCam for photos
2. Quote-time eligibility and net-price estimator (Rewiring America API + our specs)
3. Program Spec editor UI, so non-engineers can add programs
4. Portal-assist automation (Playwright fills the form, a human reviews and submits) where allowed
5. Add 5–10 more programs in the region, including HEAR/HOMES as they launch (income verification flow)

### Phase 4: Expansion (Months 6–12)
1. Second region (CT/RI or a new HEAR state)
2. Optional rebate advance through a financing partner
3. Distributor and OEM channel partnerships, e.g., white-label for regional distributors
4. Analytics: acceptance rates by program, time-to-pay benchmarks (useful in sales)
5. SOC 2 Type I, and a hire for ops plus a second engineer

---

## 7. Daily execution and testing plan

### The daily loop (every build day)
| Time | What | Output |
|---|---|---|
| 0:00–0:15 | **Plan:** pick ONE vertical slice from the backlog. Write its acceptance criteria in `docs/daily/YYYY-MM-DD.md`. | Today's slice + definition of done |
| 0:15–0:45 | **Test first:** write the failing unit/E2E test(s) and add fixtures from the golden set | Red tests |
| 0:45–4:30 | **Build** with Claude Code. Small commits. | Green tests |
| 4:30–5:15 | **Verify against reality:** run the slice on 3+ real (redacted) claims from the golden set. Then run the full regression suite. | Pass/fail log |
| 5:15–5:45 | **Ship:** merge → auto-deploy to staging → smoke test → promote to prod | Live feature |
| 5:45–6:00 | **Log:** what shipped, what broke, metrics, tomorrow's slice | Daily note |

**Rules:**
- Nothing merges without tests.
- Nothing ships without running against real documents.
- Any rejection from a real program becomes a new validation rule plus a test that same day.

### Testing layers
1. **Unit (Vitest):** validation rules, spec parsing, state machine transitions, date and deadline math. Target: 100% of spec rules covered.
2. **Golden-set extraction evaluation:** about 100 real invoices, AHRI certs and nameplate photos with hand-labeled JSON. A script scores field-level accuracy. **CI fails if accuracy on key fields** (model #, AHRI #, install date, total cost) **drops below 97%.** Run it on every prompt or model change.
3. **PDF snapshot tests:** generate each program form from fixture data and diff the filled field values against the approved snapshot.
4. **E2E (Playwright):** the critical journeys are (a) create claim → upload via magic link → extraction → checklist green → packet generated, and (b) missing doc → SMS chase → upload → checklist updates.
5. **Live "shadow" test (weekly):** the ops person processes every real claim through the system *and* checks it manually. Any disagreement becomes a bug or rule.
6. **Production monitors:** error tracking (Sentry), stuck-claim alerts (no status change in X days), deadline-in-7-days alerts.

### North-star metrics (review every Friday)
- **First-pass acceptance rate:** target ≥95% (NYS Clean Heat baseline is roughly 60%)
- **Ops minutes per claim:** target <20 (contractor baseline is 4–5 hours)
- **Days from install to complete packet:** target <3
- **Days to payment**, **claims/week**, **$ rebates processed**, **revenue**, **contractor retention**

### Day-by-day: Weeks 1–8

**Week 1: Customer discovery**
- Day 1: Build a list of 100 target contractors from program "find a contractor" directories (Mass Save HPIN, NYS Clean Heat). Write the interview script.
- Day 2: Send 40 outreach messages (calls, LinkedIn, local ACCA/BPA chapters). Download all forms and rules for the candidate programs.
- Day 3: Interviews (aim for 4–5). Map each program's document checklist into a spreadsheet.
- Day 4: Interviews. Draft the Program Spec format on paper.
- Day 5: Interviews. Synthesize pains, prices and volumes. Pick the top 3 programs. **Friday review.**

**Week 2: Concierge filing**
- Day 6: Sign 2–3 contractors for a paid pilot (one-page agreement, data handling terms). Set up shared Drive folders.
- Days 7–9: File real claims by hand. Time every step. Log every missing document and why it was missing.
- Day 10: Write the first 3 Program Specs as JSON from what you learned. **Friday review.**

**Week 3: Concierge + foundations**
- Days 11–13: Keep filing. Redact and label documents into the golden set (target 50+ docs).
- Day 14: Ask about third-party submission rules for each program. Finalize pricing.
- Day 15: **GO/NO-GO gate.**

**Week 4: Skeleton**
- Day 16: Repo, Next.js, Supabase, CI (lint + typecheck + test), Vercel staging/prod, Sentry
- Day 17: Auth, organizations/users, row-level security tests (an org can't read another org's data)
- Day 18: Schema (Jobs, Claims, Documents, Requirements, StatusEvents) + audit log + state machine with unit tests
- Day 19: Program Spec Zod schema + loader + the 3 specs + spec validation tests
- Day 20: Claim creation UI (manual + CSV import). E2E: create a job → claims auto-generated per eligible program. **Friday review.**

**Week 5: Documents in**
- Day 21: Magic-link upload page (mobile-first, camera capture). E2E test.
- Day 22: Document type classifier (Haiku) + golden-set classification evaluation
- Day 23: Invoice extraction (Sonnet) + field-accuracy evaluation in CI
- Day 24: AHRI cert and nameplate photo extraction + evaluation
- Day 25: Human review/correction screen. Corrections get saved back as new golden data. **Friday review.**

**Week 6: Validation engine**
- Day 26: Rule engine runs spec validations → requirement checklist
- Day 27: Cross-document rules (AHRI model ↔ invoice model, dates, addresses) + tests from real past rejections
- Day 28: Eligibility rules (utility territory, ZIP, efficiency thresholds, deadlines)
- Day 29: Claim detail page: checklist with exact "what's missing / why invalid"
- Day 30: Run ALL concierge claims through the engine. It must catch every real rejection reason. **Friday review.**

**Week 7: Chasing**
- Day 31: Twilio + Resend setup, templates, opt-out handling
- Day 32: Auto-chase scheduler (escalating reminders: tech → office → owner)
- Day 33: Inbound replies: an SMS photo reply attaches to the claim automatically
- Day 34: Deadline alerts + stuck-claim alerts
- Day 35: E2E: missing doc → chase → upload → checklist goes green. **Friday review.**

**Week 8: Packets out + first live use**
- Day 36: PDF AcroForm filling for program #1 + snapshot tests
- Day 37: PDF for programs #2 and #3 + the "portal cheat sheet" generator
- Day 38: Submission logging, status updates, payment tracking
- Day 39: **Switch pilot contractors onto the system for all new claims** (keep the manual shadow check running)
- Day 40: Retro: compare minutes per claim and acceptance rate against the Week 2 baseline. Re-plan Phase 2.

**Weeks 9–22:** same daily loop. Each week = one item from the Phase 2/3 lists above, with a Friday demo to at least one pilot contractor and a metrics review. Keep selling at least 1 day a week from Week 9 onward. **Target: 10 paying contractors by Week 14, 25 by Week 22.**

---

## 8. If the gate fails: pivot options
1. **Commercial and small-business prescriptive rebates** (rooftop units, lighting, VFDs). Rebates are bigger per claim, there are fewer filers, and today's tools only do discovery (Rebate Bus).
2. **Sell to program implementers and utilities** as an intake and validation layer (the way Rock Rabbit works with Palo Alto and SVCE).
3. **Distributor channel:** white-label for regional HVAC distributors who want contractor loyalty (Coral works with Watsco).

---

## 9. Immediate next actions (this week)
1. Confirm the region (default NY + MA, or wherever you have relationships).
2. Build the 100-contractor target list and start outreach.
3. Download all forms and terms for the 3–5 candidate programs.
4. Book 10 interviews.
5. Draft the one-page paid-pilot agreement.
