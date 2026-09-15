# Manojavaya Trans Customer v1.1.4 — Ready to Deploy

## What is included
- `index.html` — customer booking page.
- `manifest.webmanifest` — PWA manifest for Add to Home Screen.
- `sw.js` — same-origin offline shell cache; booking API is never cached.
- `assets/` — official Manojavaya Trans logo/icons used by the Driver package.
- `DEPLOYMENT.md` — deployment and integration notes.

## Customer → Driver integration
The customer app posts to the same production API used by the Manojavaya Trans Driver v1.1.4 package:

`https://manojavaya-trans-api.manojavaya-trans.workers.dev/api/booking-requests`

The customer sends `client_request_id` for retry/idempotency. The Driver package polls `GET /api/booking-requests?status=PENDING` and uses the same API's accept/reject endpoints. The API/Cloudflare Worker is therefore the required bridge between the two apps.

## Important
This ZIP contains the complete **Customer frontend/PWA**, not the Cloudflare Worker source. The Worker must already be deployed and must implement the booking API contract expected by both Customer and Driver. No API secrets are embedded in this customer frontend.
