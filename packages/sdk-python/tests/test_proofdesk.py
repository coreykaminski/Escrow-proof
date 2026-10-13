import hashlib
import hmac
import json
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from proofdesk import ProofDesk, ProofDeskError, WebhookVerificationError, verify_webhook


def sign(secret, body, ts):
    return f"t={ts},v1=" + hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()


class WebhookTests(unittest.TestCase):
    body = json.dumps({"id": "evt_1", "type": "agreement.settle", "agreement_id": "agr_x"})

    def test_valid_signature_returns_the_event(self):
        ts = int(time.time())
        event = verify_webhook(self.body, sign("whsec_1", self.body, ts), "whsec_1")
        self.assertEqual(event["type"], "agreement.settle")
        self.assertEqual(verify_webhook(self.body.encode(), sign("whsec_1", self.body, ts), "whsec_1")["id"], "evt_1")

    def test_rejects_wrong_secret_tampering_replay_and_garbage(self):
        ts = int(time.time())
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(self.body, sign("whsec_1", self.body, ts), "other")
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(self.body.replace("settle", "refund"), sign("whsec_1", self.body, ts), "whsec_1")
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(self.body, sign("whsec_1", self.body, ts - 3600), "whsec_1")
        with self.assertRaises(WebhookVerificationError):
            verify_webhook(self.body, "nonsense", "whsec_1")


class _Stub(BaseHTTPRequestHandler):
    script = []
    seen = []

    def _reply(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else None
        type(self).seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
        status, payload = type(self).script.pop(0)
        out = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_DELETE = _reply

    def log_message(self, *args):
        pass


class ClientTests(unittest.TestCase):
    def setUp(self):
        _Stub.script, _Stub.seen = [], []
        self.server = HTTPServer(("127.0.0.1", 0), _Stub)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.pd = ProofDesk(api_key="pd_test_abc", base_url=f"http://127.0.0.1:{self.server.server_port}")
        self.pd._sleep = staticmethod(lambda attempt: None)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_retries_server_errors_with_the_same_idempotency_key(self):
        _Stub.script = [(500, {"error": {"code": "internal_error", "message": "x"}}), (201, {"id": "agr_1"})]
        out = self.pd.agreements.create(buyer_ref="b", seller_ref="s", spec={"version": 1})
        self.assertEqual(out["id"], "agr_1")
        keys = {r["headers"].get("Idempotency-Key") for r in _Stub.seen}
        self.assertEqual(len(_Stub.seen), 2)
        self.assertEqual(len(keys), 1)
        self.assertEqual(_Stub.seen[0]["headers"]["Authorization"], "Bearer pd_test_abc")

    def test_client_errors_raise_with_code_and_details(self):
        _Stub.script = [(422, {"error": {"code": "terms_mismatch", "message": "nope", "details": {"a": 1}}})]
        with self.assertRaises(ProofDeskError) as ctx:
            self.pd.agreements.retrieve("agr/../x")
        self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.details), (422, "terms_mismatch", {"a": 1}))
        self.assertEqual(_Stub.seen[0]["path"], "/v1/agreements/agr%2F..%2Fx")

    def test_rejects_a_malformed_key(self):
        with self.assertRaises(ValueError):
            ProofDesk(api_key="sk_live_nope")


STATE = Path(__file__).resolve().parents[3] / "e2e" / ".state.json"


@unittest.skipUnless(STATE.exists() or os.environ.get("PROOFDESK_TEST_KEY"), "no Proof Desk test server (npm run test:e2e's server)")
class IntegrationTests(unittest.TestCase):
    def test_a_protected_purchase_end_to_end(self):
        state = json.loads(STATE.read_text()) if STATE.exists() else {}
        pd = ProofDesk(
            api_key=os.environ.get("PROOFDESK_TEST_KEY", state.get("platformKey", "")),
            base_url=os.environ.get("PROOFDESK_TEST_URL", state.get("base", "http://localhost:8799")),
        )
        ids = [t["id"] for t in pd.spec_templates.list()["data"]]
        self.assertIn("code.acceptance-tests", ids)
        agr = pd.agreements.create_from_template(
            template="research.cited-brief", params={"task": "Summarize battery costs.", "min_sources": 1},
            buyer_ref="py_buyer", seller_ref="py_seller",
            amount={"value": 1500, "currency": "usd"}, delivery_due_at="2030-01-01T00:00:00Z",
            appeal_window_hours=0,
        )
        self.assertEqual(agr["spec_source"]["kind"], "template")
        pd.agreements.approve_spec(agr["id"], agr["spec_hash"])
        funded = pd.agreements.fund(agr["id"], hold_ref="py_hold")
        self.assertEqual(funded["status"], "funded")
        delivered = pd.agreements.deliver(agr["id"], [{"name": "brief.md", "media_type": "text/markdown", "content": "Notes."}])
        self.assertEqual(delivered["agreement"]["status"], "delivered")
        decided = pd.test_helpers.decide(agr["id"], {"kind": "release"}, "looks right")
        self.assertEqual(decided["outcome"], {"kind": "release"})
        link = pd.agreements.create_report_link(agr["id"])
        self.assertIn("data-proofdesk-verdict", link["embed"]["html"])
        proof = pd.agreements.proof(agr["id"])
        self.assertEqual(proof["agreement_id"], agr["id"])
        with self.assertRaises(ProofDeskError) as ctx:
            pd.agreements.approve_spec(agr["id"], "0" * 64)
        self.assertEqual(ctx.exception.status, 409)
        # A verify-only key for an agent: it can list templates but not agreements.
        created = pd.api_keys.create(name="py-agent", scopes=["verify"])
        agent = ProofDesk(api_key=created["key"], base_url=pd.base_url)
        self.assertTrue(agent.spec_templates.list()["data"])
        with self.assertRaises(ProofDeskError) as denied:
            agent.agreements.list()
        self.assertEqual(denied.exception.code, "insufficient_scope")
        self.assertEqual(pd.api_keys.revoke(created["id"])["status"], "revoked")
        # The same events webhooks deliver, filtered and paged.
        events = pd.events.list(type="agreement.approve_spec", limit=200)
        self.assertIn(agr["id"], [e["agreement_id"] for e in events["data"]])


if __name__ == "__main__":
    unittest.main()
