# Effective EduHub — Recorded Class Access Control API

Implements exactly the endpoints from the design doc. Tested locally — all endpoints confirmed working (lock/unlock, tier-based access checks, promo scheduling).

## Run locally
```
npm install
npm start
```
Server starts on `http://localhost:4000` (or `$PORT`).

## Deploy (pick one — all have free tiers)
- **Railway / Render**: connect this folder as a repo, it auto-detects `npm start`. Set `PORT` env var if required by the platform (most auto-inject it).
- **A VPS you already have**: `pm2 start server.js` behind Nginx, or just `node server.js` in a systemd service.

## Connect the frontend
In `effective-v14.html`, near the top of the main `<script>` block (or in a small inline `<script>` right before it), set:
```html
<script>window.VOD_API_BASE = 'https://your-deployed-api-url.com';</script>
```
Once this is set, the admin lock/unlock buttons and promo scheduler in the SPA will call the real API automatically. Until you set it, the SPA keeps working in local demo mode (no errors, just no persistence across page reloads).

## What's real vs. what's still a stub
| Piece | Status |
|---|---|
| Lock/unlock, access-rule, schedule-promo endpoints | ✅ Real, tested |
| `canAccess()` tier logic (public/batch/paid/promo) | ✅ Real, tested |
| Data storage | ⚠️ In-memory — resets on server restart. Swap for Postgres using the schema in the design doc when ready (the function signatures won't need to change) |
| `playback-url` signed URL | ⚠️ Returns a placeholder URL shaped like the real thing. Replace with actual Cloudflare Stream / Mux signed-URL generation once you pick a video host |
| Push/SMS/WhatsApp/Email dispatch on promo schedule | ⚠️ Logs the job (`console.log`), doesn't actually send anything yet. Wire in Firebase Admin SDK / SSL Wireless / WhatsApp Business Cloud API / SES where marked `TODO` in `server.js` |
| Auth (identifying which user is asking) | ⚠️ Demo accepts `user_id`/`batch_id` as query params for testing. Replace with your real session/JWT middleware before going live — right now anyone could pass any `batch_id` |

## Next security step before real deployment
The demo `playback-url` endpoint trusts `batch_id` from the query string, which isn't safe for production — swap it for your real auth middleware so `req.user` comes from a verified session/token, not a client-supplied parameter.
