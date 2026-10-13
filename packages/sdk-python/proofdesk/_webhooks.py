from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional, Union


class WebhookVerificationError(Exception):
    pass


def verify_webhook(raw_body: Union[str, bytes], signature_header: str, secret: str, *, tolerance_seconds: int = 300, now: Optional[float] = None) -> Dict[str, Any]:
    """Verify a Proof Desk webhook and return the event.

    Pass the raw request body exactly as received, the `Proofdesk-Signature` header and your
    endpoint's secret. Signatures older than `tolerance_seconds` are rejected to block replays.
    """
    body = raw_body.decode() if isinstance(raw_body, bytes) else raw_body
    parts: Dict[str, list] = {}
    for item in (signature_header or "").split(","):
        k, _, v = item.partition("=")
        if k and v:
            parts.setdefault(k.strip(), []).append(v.strip())
    try:
        ts = int(parts.get("t", [""])[0])
    except ValueError:
        raise WebhookVerificationError("malformed signature header") from None
    sigs = parts.get("v1", [])
    if not sigs:
        raise WebhookVerificationError("malformed signature header")
    if abs((now if now is not None else time.time()) - ts) > tolerance_seconds:
        raise WebhookVerificationError("signature timestamp is outside the tolerance window")
    expected = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(s, expected) for s in sigs):
        raise WebhookVerificationError("signature doesn't match")
    return json.loads(body)
