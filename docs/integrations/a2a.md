# Proof Desk over A2A (Agent2Agent)

Proof Desk publishes a standard **A2A agent card** (protocol 1.0) at `/.well-known/agent-card.json`. Any A2A client can find the verification skill and use it, with no Proof Desk SDK.

- **Interface:** HTTP+JSON at `/a2a`. Methods: `POST /a2a/message:send` and `GET /a2a/tasks/{id}`. No streaming or push notifications.
- **Auth:** `Authorization: Bearer <Proof Desk platform API key>`. Each check is billed to that key's account.
- **Skill `verify-deliverable`:** send one `data` part shaped like a `POST /v1/verifications` body.

```json
{
  "message": {
    "role": "ROLE_USER",
    "messageId": "7f1c…",
    "parts": [{
      "mediaType": "application/json",
      "data": {
        "spec": { "version": 1, "title": "isEven", "request": "Write isEven(n)", "vertical": "code",
                  "criteria": [{ "id": "tests-pass", "description": "All tests pass", "check": "deterministic", "critical": true }] },
        "inputs": [{ "name": "tests/even.test.mjs", "media_type": "text/javascript", "content": "…" }],
        "deliverable": [{ "name": "even.mjs", "media_type": "text/javascript", "content": "…" }]
      }
    }]
  }
}
```

**Responses:**
- **Usually:** `{"task": …}` with `status.state` `TASK_STATE_COMPLETED` and a `verdict` artifact holding `passed`, `outcome`, `reason`, per-criterion verdicts, `report_hash` and `spec_hash`.
- **When a human must decide:** the task stays `TASK_STATE_WORKING`. Poll `GET /a2a/tasks/{id}`.
- **When the message has no usable data part:** an agent `message` explaining the format.

Each task is a Verify API job (same id). It's on the ledger, and once final its content-free record appears in `/verdicts.json` (see verdict-records.md).
