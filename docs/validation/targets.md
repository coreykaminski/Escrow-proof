# Design-partner targets (60)

**Goal (MASTER_PLAN go/no-go gate):** 3+ design partners commit to a pilot integration.

**Before contacting anyone:** this list comes from public knowledge up to mid-2026, not live research. Check each one is still operating, still in the space, and find the right person (founder, head of product, or head of trust & safety/payments). Mark `verified` in the tracker ([tracker.csv](tracker.csv)) once you've checked.

**Priority:** A = clear fit with live volume (contact first), B = good fit, C = longer shot or strategic.

## 1. Translation and localization platforms (14): the v1 vertical

Our verifier is built for translation first, so these are the best first conversations. They pay translators (human and machine) and handle quality disputes today.

| # | Organization | Why they might care | Pri |
|---|---|---|---|
| 1 | Gengo | Marketplace of freelance translators; quality complaints and rework are a cost | A |
| 2 | Unbabel | AI + human translation; would value automated, auditable QA on outputs | A |
| 3 | Lilt | AI-assisted enterprise translation; verification fits their quality story | B |
| 4 | Smartling | Translation management + vendor marketplace; pays many vendors | B |
| 5 | Lokalise | Localization platform with translation ordering | B |
| 6 | Crowdin | Localization platform with vendor marketplace | B |
| 7 | Phrase | Localization suite with integrated translation ordering | B |
| 8 | Translated (Matecat) | Large human + MT network; strong quality-measurement culture | B |
| 9 | ProZ.com | Largest freelance translator community; payment disputes are common | A |
| 10 | TextMaster | Translation and content marketplace | B |
| 11 | Rev | Transcription, captions and translation; output QA at volume | C |
| 12 | Straker | Translation with AI workflow; mid-size, may move fast | B |
| 13 | Welocalize | Large language-services provider managing many vendors; vendor QA at scale | C |
| 14 | Blend (formerly OneHourTranslation) | Localization marketplace with many freelancers | B |

## 2. Freelance, content and agent-task marketplaces (14)

| # | Organization | Why they might care | Pri |
|---|---|---|---|
| 15 | Contra | Commission-free freelance platform; payments are central | A |
| 16 | Fiverr (incl. AI agent offerings) | Escrow-style payments and dispute volume at scale; strategic | C |
| 17 | Upwork | Same, very large; strategic and slow | C |
| 18 | Toptal | High-value work with milestone payments | C |
| 19 | PeoplePerHour | Freelance marketplace with escrow and disputes | B |
| 20 | Freelancer.com | Milestone payments and disputes at scale | C |
| 21 | Malt | European freelance marketplace | B |
| 22 | Workana | Latin American freelance marketplace | B |
| 23 | Agent.ai | Marketplace and network for AI agents | A |
| 24 | Relevance AI | Agent platform; agents doing paid tasks | B |
| 25 | Fetch.ai Agentverse | Agent registry and marketplace with payments | B |
| 26 | Olas (Autonolas) Mech marketplace | Agents hiring agents for tasks, with payment | A |
| 27 | Replit (bounties) | Paid code bounties; code verification is our v2 vertical | B |
| 28 | Algora | Open-source bounties: pay when the PR is merged | B |

## 3. Data labeling, research and microtask platforms (8)

| # | Organization | Why they might care | Pri |
|---|---|---|---|
| 29 | Prolific | Pays participants for tasks; quality checks before payout | B |
| 30 | Toloka | Crowd data labeling; automated acceptance checks | B |
| 31 | Surge AI | High-quality labeling; QA is core | C |
| 32 | Appen | Large labeling workforce | C |
| 33 | Labelbox (Boost) | Labeling services marketplace | C |
| 34 | Mechanical Turk requesters (via tools like CloudResearch) | Approve/reject work before payout is exactly our flow | B |
| 35 | Clickworker | Microtask platform | C |
| 36 | Remotasks / Outlier | Task workforce for AI training data | C |

## 4. Agent builders and agent-payment infrastructure (14)

These either build agents that buy things, or move money for agents and would benefit from a "verify before release" layer.

| # | Organization | Why they might care | Pri |
|---|---|---|---|
| 37 | Payman | Payments for AI agents paying humans; verification is the missing step | A |
| 38 | Skyfire | Agent payments and identity network | A |
| 39 | Crossmint | Agent wallets and checkout | B |
| 40 | Nevermined | Payments and metering for AI agents | A |
| 41 | Natural | Agent payments infrastructure | B |
| 42 | Stripe (Agentic Commerce / MPP team) | Partner, not customer: list Proof Desk as an MPP service | C |
| 43 | Coinbase Developer Platform (x402 team) | Partner: an evaluator for x402 / agent commerce | C |
| 44 | Browserbase | Browser infrastructure for agents; customers' agents buy things | B |
| 45 | MultiOn | Agent that completes tasks and purchases on the web | B |
| 46 | Induced AI | Browser agents doing operational tasks | C |
| 47 | Lindy | No-code agents doing business tasks, sometimes hiring out | B |
| 48 | CrewAI | Multi-agent framework; agents delegating paid subtasks | B |
| 49 | LangChain (LangGraph Platform) | Agent infrastructure; partnership or integration listing | C |
| 50 | Composio | Tool integrations for agents; distribution partner for our MCP | B |

## 5. Crypto agent ecosystems (evaluator-for-hire) (10)

| # | Organization | Why they might care | Pri |
|---|---|---|---|
| 51 | Virtuals Protocol (ACP) | ERC-8183 jobs need a trustworthy evaluator; we can be one | A |
| 52 | ERC-8183 authors / Ethereum Foundation contributors | Standard-setting; get listed as a reference evaluator | B |
| 53 | Nava | Agent-transaction escrow; possible partner on deliverable verification | C |
| 54 | GenLayer / Internet Court | Dispute layer; we're first-line verification before disputes | C |
| 55 | Kleros | Decentralized disputes; complementary escalation path | C |
| 56 | ElizaOS (ai16z) ecosystem | Large agent-builder community | B |
| 57 | Olas ecosystem builders | Agents paying agents on-chain | B |
| 58 | Morpheus | Decentralized agent network | C |
| 59 | Bittensor subnet teams doing paid tasks | Output validation is a core problem | C |
| 60 | Base (Coinbase L2) ecosystem / Base Builders | Distribution for an on-chain evaluator on Base | C |

## Where to start

1. **Week 1, 15 messages:** every **A** above (1, 2, 9, 15, 23, 26, 37, 38, 40, 51) plus 5 **B** translation platforms. Use the matching template in [outreach.md](outreach.md).
2. Book **3 interviews** from the replies using [interview-script.md](interview-script.md).
3. After 15 interviews, look for the pattern: who has the pain, the volume, and a budget, and who would integrate in a 2-week pilot.
