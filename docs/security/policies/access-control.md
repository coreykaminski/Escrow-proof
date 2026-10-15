# Access control policy

## Production and vendor accounts
- **Named accounts only, with MFA.** No shared logins. Use SSO where the vendor supports it `[set up when the team grows beyond one]`.
- **Admin rights** on Fly.io, Neon, AWS, Stripe, GitHub and the domain registrar: the security lead plus one named backup at most.
- **Database:** production access goes through the application. Direct console access is for incidents only, and is logged in the incident record.

## API keys
- **Storage:** keys are random (192 bits) and stored only as hashes. Platforms manage their own keys in the dashboard or at `/v1/api-keys`.
- **Scopes:**
  - `platform`: a customer's full API.
  - `verify`: verification only.
  - `ops`: Proof Desk staff.
- **Proof Desk staff and reviewers** each have their own `ops` key. Reviewer decisions are attributed to the key in the ledger, and paid per key.
- **Leaked or suspect keys** are revoked immediately. A rotation uses roll, with an overlap of 24 hours at most.

## Signing keys (stablecoin rail)
On mainnet: KMS-held keys, one per role, and a multisig owner. See [evaluator-keys.md](../evaluator-keys.md). The server refuses to start otherwise.

## Reviews and offboarding
- **Quarterly:** list everyone with vendor admin rights and every active `ops` key (`GET /v1/api-keys`, per ops account). Remove anything not needed, and record the review in `docs/security/access-reviews.md`.
- **Offboarding, within 24 hours:**
  1. Revoke their `ops` keys. Their dashboard sessions end with the key.
  2. Remove their vendor accounts.
  3. Rotate any shared secret they could have seen (webhook signing secrets, Stripe keys) where practical.
