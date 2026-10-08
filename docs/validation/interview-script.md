# Discovery interview script (30 minutes)

**Purpose:** find out whether paying for work that has been *verified against agreed criteria* solves a problem they already pay to deal with, and whether they'd pilot it. Learn first; don't pitch until minute 20.

**Rules**
- Ask about what they did last time, not what they would do. ("Tell me about the last dispute" beats "Would you use…?")
- Get numbers: volume, dispute rate, cost per dispute, time to resolve.
- Let silences run. Write down their exact words for anything painful.
- One interviewer, one note-taker if possible. Log it in [tracker.csv](tracker.csv) the same day.

## 1. Context (5 min)
1. What does your platform (or agent) buy or sell, and who are the buyers and sellers?
2. Roughly how many paid jobs or transactions a month? Typical size ($)?
3. How does payment work today: upfront, escrow/milestones, pay-on-approval, or something else?

## 2. The problem (12 min)
4. Tell me about the last time a buyer said the work wasn't what they asked for. What happened, step by step?
5. How often does that happen? Out of 100 jobs, how many end in a complaint, rework, refund or dispute?
6. Who decides who's right today, and how long does it take? What does one dispute cost you (staff time, refunds, chargebacks, churn)?
7. How do buyers and sellers agree on what "done" means before the work starts? Is it written down? Is it checkable?
8. *(Agent builders)* When your agent pays for something, how do you know it got what it paid for? What happens when it didn't?
9. *(Translation, data, code)* What quality checks do you already run before paying? Which are automated? What slips through?
10. Have you tried to fix this? With what (internal tools, Escrow.com, a vendor, manual review)? Why didn't it stick?

## 3. Reaction (8 min). Now show the idea in one sentence.
> "Money is held; the deliverable is checked against criteria both sides approved up front, first by automated checks, a human expert for disputes; then it's released or refunded, with every step on a tamper-evident record."

11. Where does that help you, and where would it break for you?
12. Which part matters most: the agreed criteria, the automatic check, the held payment, or the audit trail?
13. What would it have to get right for you to trust its decision? What error rate is acceptable for paying for bad work? For refusing good work?
14. How would you want to integrate: API and webhooks, an SDK, MCP for agents, or a hosted page?
15. Pricing check: we're thinking ~2% of the held amount plus a small verification fee, and disputes paid by the losing side. How does that compare with what disputes cost you today?

## 4. Commitment (5 min)
16. If we ran a 2-week pilot on a slice of your real jobs (say, one job category, with automated decisions reviewed by a human in "shadow mode"), would you do it? Who else would need to say yes?
17. What would you need to see at the end of the pilot to keep using it?
18. Who else should I talk to?

## After the call: score it (1–5 each)
| | Score |
|---|---|
| **Pain:** disputes, refunds or QA cost them real money or time today | |
| **Volume:** enough paid jobs a month to matter (≥100) | |
| **Checkability:** their deliverables can be checked against written criteria | |
| **Will to pilot:** said yes to a 2-week pilot, with a named owner | |

A **design partner** = Pain ≥4, Will to pilot ≥4, and a named person committed to a pilot start date. The gate is 3 of them.
