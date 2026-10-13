from __future__ import annotations

import json
import random
import time
import uuid
from typing import Any, Callable, Dict, List, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

Json = Dict[str, Any]
Artifact = Mapping[str, str]  # {"name", "media_type", "content"}


class ProofDeskError(Exception):
    """An API error: `status` (0 for network errors), `code` (e.g. "validation_error"), details."""

    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def _enc(s: str) -> str:
    return quote(s, safe="")


class _Namespace:
    def __init__(self, client: "ProofDesk") -> None:
        self._c = client


class _Agreements(_Namespace):
    def create(self, *, buyer_ref: str, seller_ref: str, spec: Json, metadata: Optional[Mapping[str, str]] = None, idempotency_key: Optional[str] = None) -> Json:
        body = {"buyer_ref": buyer_ref, "seller_ref": seller_ref, "spec": spec}
        if metadata:
            body["metadata"] = dict(metadata)
        return self._c.request("POST", "/v1/agreements", body, idempotency_key)

    def create_from_template(self, *, template: str, buyer_ref: str, seller_ref: str, amount: Json, delivery_due_at: str, params: Optional[Json] = None, appeal_window_hours: Optional[int] = None, metadata: Optional[Mapping[str, str]] = None, idempotency_key: Optional[str] = None) -> Json:
        """Checkable criteria from a ready-made template (see spec_templates.list()); no AI."""
        body: Json = {"template": template, "params": params or {}, "buyer_ref": buyer_ref, "seller_ref": seller_ref, "amount": amount, "delivery_due_at": delivery_due_at}
        if appeal_window_hours is not None:
            body["appeal_window_hours"] = appeal_window_hours
        if metadata:
            body["metadata"] = dict(metadata)
        return self._c.request("POST", "/v1/agreements/from-template", body, idempotency_key)

    def create_from_request(self, *, request: str, buyer_ref: str, seller_ref: str, amount: Json, delivery_due_at: str, **terms: Any) -> Json:
        """AI-drafted criteria from a plain-language request (needs the server's model key)."""
        body = {"request": request, "buyer_ref": buyer_ref, "seller_ref": seller_ref, "amount": amount, "delivery_due_at": delivery_due_at, **terms}
        return self._c.request("POST", "/v1/agreements/from-request", body)

    def retrieve(self, agreement_id: str) -> Json:
        return self._c.request("GET", f"/v1/agreements/{_enc(agreement_id)}")

    def list(self, *, status: Optional[str] = None, limit: Optional[int] = None) -> Json:
        q = {k: v for k, v in {"status": status, "limit": limit}.items() if v is not None}
        return self._c.request("GET", "/v1/agreements" + (f"?{urlencode(q)}" if q else ""))

    def replace_inputs(self, agreement_id: str, inputs: List[Artifact]) -> Json:
        """What the work is judged against (tests, schema, source text). Draft agreements only."""
        return self._c.request("PUT", f"/v1/agreements/{_enc(agreement_id)}/inputs", {"inputs": list(inputs)})

    def approve_spec(self, agreement_id: str, spec_hash: str) -> Json:
        """The buyer consents to exactly the spec they saw (identified by its hash)."""
        return self._c.request("POST", f"/v1/agreements/{_enc(agreement_id)}/approve-spec", {"spec_hash": spec_hash})

    def fund(self, agreement_id: str, *, hold_ref: str) -> Json:
        """Sandbox funding (test rail). Live: create_card_hold or create_payment_link."""
        return self._c.request("POST", f"/v1/agreements/{_enc(agreement_id)}/fund", {"rail": "test", "hold_ref": hold_ref})

    def create_card_hold(self, agreement_id: str, *, payment_method: Optional[str] = None, shared_payment_token: Optional[str] = None) -> Json:
        body = {k: v for k, v in {"payment_method": payment_method, "shared_payment_token": shared_payment_token}.items() if v}
        return self._c.request("POST", f"/v1/agreements/{_enc(agreement_id)}/card-hold", body)

    def create_payment_link(self, agreement_id: str, *, rail: str = "card", expires_in_days: Optional[int] = None) -> Json:
        body: Json = {"rail": rail}
        if expires_in_days:
            body["expires_in_days"] = expires_in_days
        return self._c.request("POST", f"/v1/agreements/{_enc(agreement_id)}/payment-links", body)

    def deliver(self, agreement_id: str, artifacts: List[Artifact]) -> Json:
        return self._c.request("POST", f"/v1/agreements/{_enc(agreement_id)}/deliveries", {"artifacts": list(artifacts)})

    def open_dispute(self, agreement_id: str, *, opened_by: str, reason: str) -> Json:
        return self._c.request("POST", f"/v1/agreements/{_enc(agreement_id)}/disputes", {"opened_by": opened_by, "reason": reason})

    def create_report_link(self, agreement_id: str, *, expires_in_days: Optional[int] = None) -> Json:
        """A public verdict report plus `embed.html`, a drop-in widget for your own pages."""
        body = {"expires_in_days": expires_in_days} if expires_in_days else {}
        return self._c.request("POST", f"/v1/agreements/{_enc(agreement_id)}/report-links", body)

    def verifications(self, agreement_id: str) -> Json:
        return self._c.request("GET", f"/v1/agreements/{_enc(agreement_id)}/verifications")

    def ledger(self, agreement_id: str) -> Json:
        return self._c.request("GET", f"/v1/agreements/{_enc(agreement_id)}/ledger")

    def proof(self, agreement_id: str) -> Json:
        """A Merkle inclusion proof of the agreement's ledger entries, verifiable offline."""
        return self._c.request("GET", f"/v1/agreements/{_enc(agreement_id)}/proof")

    def delete_content(self, agreement_id: str) -> Json:
        """Delete the documents now (final agreements only); hashes and the ledger stay."""
        return self._c.request("DELETE", f"/v1/agreements/{_enc(agreement_id)}/content")


class _Verifications(_Namespace):
    def create(self, *, deliverable: List[Artifact], spec: Optional[Json] = None, template: Optional[Json] = None, inputs: Optional[List[Artifact]] = None, metadata: Optional[Mapping[str, str]] = None) -> Json:
        """Check work against acceptance criteria with no payment held. Give `spec` or `template`
        ({"id": ..., "params": {...}})."""
        body: Json = {"deliverable": list(deliverable), "inputs": list(inputs or [])}
        if spec is not None:
            body["spec"] = spec
        if template is not None:
            body["template"] = template
        if metadata:
            body["metadata"] = dict(metadata)
        return self._c.request("POST", "/v1/verifications", body)

    def retrieve(self, job_id: str) -> Json:
        return self._c.request("GET", f"/v1/verifications/{_enc(job_id)}")

    def list(self, *, limit: Optional[int] = None) -> Json:
        return self._c.request("GET", "/v1/verifications" + (f"?limit={limit}" if limit else ""))

    def retry(self, job_id: str) -> Json:
        return self._c.request("POST", f"/v1/verifications/{_enc(job_id)}/retry")


class _SpecTemplates(_Namespace):
    def list(self) -> Json:
        return self._c.request("GET", "/v1/spec-templates")


class _WebhookEndpoints(_Namespace):
    def create(self, *, url: str, event_types: Optional[List[str]] = None) -> Json:
        """The response includes the signing `secret`, shown only once."""
        body: Json = {"url": url}
        if event_types:
            body["event_types"] = event_types
        return self._c.request("POST", "/v1/webhook-endpoints", body)

    def list(self) -> Json:
        return self._c.request("GET", "/v1/webhook-endpoints")

    def delete(self, endpoint_id: str) -> Json:
        return self._c.request("DELETE", f"/v1/webhook-endpoints/{_enc(endpoint_id)}")


class _Sellers(_Namespace):
    def start_onboarding(self, seller_ref: str, *, email: str, country: str = "us") -> Json:
        return self._c.request("POST", f"/v1/sellers/{_enc(seller_ref)}/onboarding", {"email": email, "country": country})

    def retrieve(self, seller_ref: str) -> Json:
        return self._c.request("GET", f"/v1/sellers/{_enc(seller_ref)}")

    def set_wallet(self, seller_ref: str, address: str) -> Json:
        return self._c.request("PUT", f"/v1/sellers/{_enc(seller_ref)}/wallet", {"address": address})


class _ApiKeys(_Namespace):
    """This account's API keys. New and rolled keys are returned in `key`, once."""

    def list(self) -> Json:
        return self._c.request("GET", "/v1/api-keys")

    def create(self, *, name: Optional[str] = None, scopes: Optional[List[str]] = None, mode: Optional[str] = None) -> Json:
        """scopes=["verify"] makes a key that can only check work (safe to give an agent)."""
        body = {k: v for k, v in {"name": name, "scopes": scopes, "mode": mode}.items() if v is not None}
        return self._c.request("POST", "/v1/api-keys", body)

    def roll(self, key_id: str, *, expire_old_in_hours: int = 24) -> Json:
        return self._c.request("POST", f"/v1/api-keys/{_enc(key_id)}/roll", {"expire_old_in_hours": expire_old_in_hours})

    def revoke(self, key_id: str) -> Json:
        return self._c.request("DELETE", f"/v1/api-keys/{_enc(key_id)}")


class _TestHelpers(_Namespace):
    """Sandbox only (pd_test_ keys): drive an agreement without Proof Desk ops."""

    def verify(self, agreement_id: str) -> Json:
        return self._c.request("POST", f"/v1/test_helpers/agreements/{_enc(agreement_id)}/verify")

    def decide(self, agreement_id: str, outcome: Json, reason: Optional[str] = None) -> Json:
        body: Json = {"outcome": outcome}
        if reason:
            body["reason"] = reason
        return self._c.request("POST", f"/v1/test_helpers/agreements/{_enc(agreement_id)}/decide", body)

    def settle(self, agreement_id: str) -> Json:
        return self._c.request("POST", f"/v1/test_helpers/agreements/{_enc(agreement_id)}/settle")


class ProofDesk:
    """Proof Desk API client.

    pd = ProofDesk(api_key="pd_test_…", base_url="https://<host>")
    job = pd.verifications.create(template={"id": "data.dataset", "params": {...}}, ...)
    """

    def __init__(self, api_key: str, base_url: str = "http://localhost:8787", *, max_retries: int = 2, timeout: float = 60.0, opener: Optional[Callable[..., Any]] = None) -> None:
        if not (api_key.startswith("pd_test_") or api_key.startswith("pd_live_")):
            raise ValueError("api_key must start with pd_test_ or pd_live_")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self.timeout = timeout
        self._open = opener or urlopen
        self.agreements = _Agreements(self)
        self.verifications = _Verifications(self)
        self.spec_templates = _SpecTemplates(self)
        self.webhook_endpoints = _WebhookEndpoints(self)
        self.sellers = _Sellers(self)
        self.api_keys = _ApiKeys(self)
        self.test_helpers = _TestHelpers(self)

    @property
    def livemode(self) -> bool:
        return self.api_key.startswith("pd_live_")

    def request(self, method: str, path: str, body: Any = None, idempotency_key: Optional[str] = None) -> Json:
        key = (idempotency_key or str(uuid.uuid4())) if method in ("POST", "PUT") else None
        data = None if body is None else json.dumps(body).encode()
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json", "User-Agent": "proofdesk-python/0.1.0"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if key:
            headers["Idempotency-Key"] = key
        attempt = 0
        while True:
            req = Request(self.base_url + path, data=data, method=method, headers=headers)
            try:
                with self._open(req, timeout=self.timeout) as res:
                    text = res.read().decode()
                    return json.loads(text) if text else {}
            except HTTPError as e:
                text = e.read().decode(errors="replace")
                try:
                    err = (json.loads(text) or {}).get("error") or {}
                except ValueError:
                    err = {}
                retryable = e.code >= 500 or e.code == 429 or err.get("code") == "idempotency_request_in_progress"
                if retryable and attempt < self.max_retries:
                    self._sleep(attempt)
                    attempt += 1
                    continue
                raise ProofDeskError(e.code, err.get("code", "http_error"), err.get("message", f"HTTP {e.code}"), err.get("details")) from None
            except (URLError, TimeoutError, ConnectionError) as e:
                if attempt < self.max_retries:
                    self._sleep(attempt)
                    attempt += 1
                    continue
                raise ProofDeskError(0, "network_error", str(e)) from None

    @staticmethod
    def _sleep(attempt: int) -> None:
        time.sleep(min(2.0, 0.25 * 2**attempt) * (0.5 + random.random() / 2))
