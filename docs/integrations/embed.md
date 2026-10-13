# Show the verdict on your own pages

When an agreement has a verdict, put it in front of your buyer and seller without building any UI.

1. **Create a report link** (it expires; default 30 days, up to 90):
   ```ts
   const link = await pd.agreements.createReportLink(agreementId, { expires_in_days: 90 });
   ```
2. **Paste `link.embed.html` into your page:**
   ```html
   <script src="https://<proof desk host>/embed/v1.js" async></script>
   <div data-proofdesk-verdict="<token>" data-theme="auto"></div>
   ```
   - `data-theme` is `auto` (follows the visitor's system), `light` or `dark`.
   - The element may hold the token or the whole report URL.
   - If you add elements after page load, call `window.ProofDesk.mountVerdicts()`.

The widget shows the job title, the outcome ("Passed", "Failed", "Partly passed: 60% paid", or "Being reviewed"), who decided and when, each acceptance check with its verdict, and a link to the full report with the downloadable proof.

**Safety:**
- **What's shown:** never the documents or the evidence quoted from them. The link token is unguessable, expires, and works the same as the full report link.
- **Framing:** only `/embed/r/…` pages may be framed (`frame-ancestors *`); every other Proof Desk page refuses framing. The widget has no buttons that act on anything.
- **No cookies or referrer:** the iframe sends no cookies and no referrer. It tells your page only its height (a `postMessage` checked against Proof Desk's origin).

**Rendering it yourself?** Use `link.embed.iframe_url` in your own `<iframe>`, or read the agreement and its verifications from the API.
