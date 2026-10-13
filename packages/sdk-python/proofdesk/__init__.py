"""Python client for the Proof Desk API: payments that release only when the work passes the
checks both sides agreed to, and a Verify API for checking work with no payment held.

Standard library only (Python 3.9+). Every POST/PUT carries an Idempotency-Key that is reused
across retries, so a retried call never acts twice.
"""

from ._client import ProofDesk, ProofDeskError
from ._webhooks import WebhookVerificationError, verify_webhook

__all__ = ["ProofDesk", "ProofDeskError", "WebhookVerificationError", "verify_webhook"]
__version__ = "0.1.0"
