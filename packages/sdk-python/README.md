# proofdesk (Python)

The Python client for Proof Desk: payments that release only when the work passes checks both sides agreed to, plus a Verify API for checking work with no payment held. It uses only the standard library and runs on Python 3.9+.

```python
from proofdesk import ProofDesk, verify_webhook

pd = ProofDesk(api_key="pd_test_…", base_url="https://<your proof desk host>")

# Check work, no payment held:
job = pd.verifications.create(
    template={"id": "data.dataset", "params": {"task": "EU capitals", "min_records": 27, "unique_key": "city"}},
    inputs=[{"name": "schema.json", "media_type": "application/schema+json", "content": schema_json}],
    deliverable=[{"name": "capitals.csv", "media_type": "text/csv", "content": csv_text}],
)
job["outcome"]  # {"kind": "release"} passed, {"kind": "refund"} failed; status "escalated" = a human decides

# A protected purchase:
agr = pd.agreements.create_from_template(
    template="code.acceptance-tests", params={"task": "Write slugify(s)."},
    buyer_ref="buyer_1", seller_ref="agent_7",
    amount={"value": 4000, "currency": "usd"}, delivery_due_at="2026-11-01T00:00:00Z",
)

# Webhooks (pass the raw body):
event = verify_webhook(request.body, request.headers["Proofdesk-Signature"], endpoint_secret)
```

**Errors:** calls raise `ProofDeskError` with `.status`, `.code`, `.message` and `.details`.

**Retries:** network errors, 5xx responses and 429 responses are retried with backoff, under the same idempotency key.
