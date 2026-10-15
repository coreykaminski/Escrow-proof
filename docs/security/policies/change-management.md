# Change management and secure development policy

## How code reaches production
1. **Every change is a commit to git, explained in its message.** `main` is the deployable branch. `[Turn on branch protection: CI must pass; PR review required once a second engineer joins.]`
2. **CI runs on every push and must pass before deploy:**
   - lint and types;
   - unit and API tests on PGlite and on Postgres;
   - browser tests and Python SDK tests;
   - contract tests and invariants;
   - generated-ABI freshness;
   - verifier golden-set gates;
   - CodeQL, gitleaks, and a production dependency audit.
3. **Database migrations** are generated, reviewed in the diff, and run once per deploy as a release step.
4. **Deploys are rolling,** with health checks. A failed release step stops the deploy.
5. **Verifier changes** (prompts, models, thresholds, checks) must keep the golden-set targets. The eval results are committed and published (`npm run evals:publish`).
6. **Smart contracts** are immutable once deployed. Changes mean a new deployment, after an audit for anything holding live funds.

## Secure development rules
- **Every fixed bug or false verdict gets a regression test** (plan §8, rule 2). Security fixes cite the issue in the test.
- **Money paths** use idempotency keys and have replay tests.
- **Dependencies:** Dependabot opens updates weekly; production advisories block CI. GitHub Actions are pinned to commit SHAs.
- **No secrets in code, logs or test fixtures.** Logs record route patterns, never URLs carrying tokens.

## Emergency changes
Allowed during an incident with CI still passing. Tests may be added afterwards, within 2 working days, and recorded in the incident record.
