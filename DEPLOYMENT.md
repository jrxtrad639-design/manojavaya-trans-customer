# Deployment — Manojavaya Trans Customer v1.1.4

1. Upload the **contents** of this folder to a static HTTPS host (Cloudflare Pages is recommended, GitHub Pages also works).
2. Keep `index.html`, `manifest.webmanifest`, `sw.js`, and `assets/` at the same root level.
3. Do not rename the asset files.
4. The page must be served over HTTPS for the PWA/service worker to work (localhost is also allowed for development).
5. After deployment, open the customer URL on Android Chrome/Safari and use the browser's **Add to Home screen** option.
6. Test a real booking. It should create a `request_id` through the production Cloudflare API. The Driver app must then show it under Pending/New Customer Booking.

## Production API used by this build

Base: `https://manojavaya-trans-api.manojavayatrans.workers.dev`
POST: `/api/booking-requests`
GET: `/api/booking-requests?status=PENDING`
POST: `/api/booking-requests/:request_id/accept`
POST: `/api/booking-requests/:request_id/reject`

## Integration contract

Customer and Driver do not communicate directly. Both communicate through the same Cloudflare Worker and the same Cloudflare D1 database. The Worker must have a D1 binding named **DB**.

The Customer already sends `client_request_id`; the production Worker now stores it and safely returns the original booking on retry instead of creating a duplicate.

## Smoke test

- Open `https://manojavaya-trans-api.manojavayatrans.workers.dev/api/health`.
- Customer submits booking.
- Customer receives Booking ID.
- Driver opens/reloads Incoming Customer Booking.
- Driver sees the new request as `PENDING`.
- Driver accepts/rejects it.
- On accept, the same booking is converted into exactly one order.
