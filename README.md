# Effective Education Hub — API

> **v2.0 update:** this repo now includes a real Postgres-backed database,
> login (JWT), and a full Admin API (overview stats, course/teacher
> approval, payouts, reports) — replacing the hardcoded numbers that were
> previously only in the frontend HTML. See **"v2.0 — Database + Admin API"**
> below for setup. The original VOD access-control API (section below) is
> unchanged and still works the same way.

## v2.0 — Database + Admin API

### 1. Create a Postgres database on Render
Render Dashboard → **New +** → **PostgreSQL** → pick the free plan → create.
Once it's up, copy the **Internal Database URL** shown on its page.

### 2. Set environment variables on this service
On this web service's **Environment** tab, add (see `.env.example` for the full list):
- `DATABASE_URL` — the Internal Database URL from step 1
- `JWT_SECRET` — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `CORS_ORIGINS` — `https://effectiveeducationhub.com,https://effectiveeduhub.com`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — used once by the seed script, then you can remove `ADMIN_PASSWORD`

### 3. Create the tables and the first admin login
Render doesn't give you a shell on the free plan by default, so run these
**from your own computer** with `DATABASE_URL` pointed at Render's
**External Database URL** (shown on the same Postgres page):
```bash
git clone https://github.com/mohiuddin-effective/vod-backend.git
cd vod-backend
npm install
DATABASE_URL="<external-url-from-render>" JWT_SECRET=x ADMIN_EMAIL=admin@effectiveeducationhub.com ADMIN_PASSWORD="<pick-a-strong-password>" npm run migrate
DATABASE_URL="<external-url-from-render>" ADMIN_PASSWORD="<same-password>" npm run seed
```
`migrate` creates the tables (`users`, `courses`, `enrollments`, `orders`, `payouts`, `activity_log`).
`seed` creates your admin login plus a few sample teachers/courses/payouts so the dashboard isn't empty.

### 4. Log in
```
POST /auth/login
{ "email": "admin@effectiveeducationhub.com", "password": "<your password>" }
```
Returns a `token` — send it as `Authorization: Bearer <token>` on every `/admin/*` request.

### 5. New endpoints
| Method & path | What it replaces in the frontend mock |
|---|---|
| `GET /admin/overview` | The 4 metric cards + "সাম্প্রতিক কার্যক্রম" feed |
| `GET /admin/courses/pending` | The AI অ্যাপ্রুভাল table |
| `POST /admin/courses/:id/approve` `.../reject` | The ✅ অ্যাপ্রুভ button |
| `GET /admin/teachers/pending` | Teacher verification queue |
| `POST /admin/teachers/:id/verify` | Teacher verify action |
| `GET /admin/payouts` | The পেআউট table |
| `POST /admin/payouts/:id/pay` `.../pay-all` | The পেআউট buttons |
| `GET /admin/report` | The রিপোর্ট tab breakdown |

All of the above, plus the existing `/admin/videos/*` VOD routes, now require
`Authorization: Bearer <token>` from an admin login — they were previously
open to anyone who knew the URL.

### 6. Teacher / Publisher / Seller dashboards (v2.1)
Same pattern as Admin: log in via `/auth/login`, get a JWT, send it as
`Authorization: Bearer <token>`. Each role only ever sees its own data.

| Role | Endpoints | Backed by |
|---|---|---|
| Teacher | `GET /teacher/overview`, `GET /teacher/courses`, `POST /teacher/courses` | `courses` table, filtered by `teacher_id` |
| Publisher | `GET /publisher/overview`, `GET /publisher/products`, `POST /publisher/products`, `PUT /publisher/products/:id` | `products` table, `type='book'`, filtered by `owner_id` |
| Seller | same shape as Publisher, mounted at `/seller/*` | `products` table, `type='mart'` |

Seed data includes one sample login per role (see `db/seed.js`):
`farhana@example.com` (teacher), `publisher@example.com`, `seller@example.com`
— all with password `ChangeMe123!`. **Change these before going live** —
either update the passwords via your own `PUT` route later, or delete/re-seed.

The corresponding sections of `index.html` (Dashboard → Teacher / Publisher /
Seller) now have their own login gates and pull live data from these
endpoints, the same way the Admin dashboard does.

### 7. AI proxy — `/ai/ask` (v2.2)
The live site has ~9 different "AI features" (AI Tutor, News Brief, Study
Plan, Fact-Check, Exam Evaluator, etc.). All of them used to call
`https://api.anthropic.com` **directly from the browser with no API key** —
every one of those calls was silently failing and falling back to a canned
error message. `routes/ai.js` fixes that: one endpoint, key held server-side.

```
POST /ai/ask
{ "messages": [{ "role": "user", "content": "..." }], "max_tokens": 800 }
→ { "text": "...", "content": [...] }   // `content` kept for older call sites
```

- No login required (it's a public site feature) but **rate-limited to
  30 requests/hour per IP** — in-memory, fine for one Render instance.
- Set `ANTHROPIC_API_KEY` in your environment (see `.env.example`) or every
  call returns `503 ai_not_configured` — a clear error instead of a silent
  failure, so you'll know immediately if it's missing.
- `index.html`'s 9 call sites were all repointed at this endpoint, and
  `escapeHtml()` was added and applied everywhere AI-generated (and
  user-submitted, e.g. community posts/comments) text gets inserted via
  `innerHTML` — that was a real stored-XSS gap before this pass.

### 8. Kids Learning Wing content API — `/kids/*` (v2.3, public/read-only)
The frontend's Kids Wing (Dashboard → 🧸 Kids) currently ships all 11
modules' content directly in `index.html` (real interactive JS — Phonics,
Tracing, CVC, Math, Sensory, Science, Rhymes, Arabic/Ethics, Abacus, Brain
Games, Worksheets). These tables + endpoints exist so that content can move
to the database later (e.g. if you want non-developers to add new modules
via an admin UI) without a frontend rewrite:

```
GET /kids/categories                         → the 11 category rows (seeded)
GET /kids/modules?lang=bn&category=phonics    → modules for a category (empty until you add rows)
GET /kids/modules/:id/contents                → a module's content items
```

No modules/contents are seeded yet — only the 11 categories (`db/seed.js`).
`kids_modules.language` supports `bn`/`en`/`ar` for the trilingual content
requested, and `kids_contents.game_payload` is a flexible `jsonb` column for
game configs (CVC word pairs, Abacus starting values, tracing stroke
coordinates, etc.) without needing schema changes per module type.

### 9. Multi-wing content + personalized feed — `/contents`, `/feed` (v2.4)
```
GET    /contents?wing=kids&category=phonics&page=1   → wing-isolated list (public)
GET    /feed?page=1                                    → personalized ranked feed (public, personalizes if logged in)
POST   /contents/:id/view                              → log a view (no-op if not logged in)
POST   /contents/:id/like    DELETE /contents/:id/like  → toggle like (requires login)
```
New tables: `wings`, `contents` (generic — one row per video/game/article/post
across every wing, isolated by `wing_type`), `user_activities` (the raw
view/like/share log everything else aggregates from). `users` gained
`interests text[]` and `preferred_wings text[]`.

**The `/feed` ranking**, tested end-to-end against real data (see the worked
example below) — each content's score is:
```
score = (matching interest tags × 15)
       + (20 if wing ∈ user's preferred_wings else 0)
       + 30 · e^(−hours_since_published / 48)      -- recency, ~48h half-life
       + ln(1 + likes×3 + views)                    -- engagement, log-dampened
```
Verified with a real seeded user (interests `{bcs,study-tips}`, preferred
wings `{community,news}`) against 5 seeded items — the ranking came out
exactly as designed: a community/bcs post matching both an interest tag
*and* the preferred wing scored 80 and ranked #1; a news item matching only
the wing scored 50; an AI article matching only one tag scored 45; two
unrelated items scored 30 (recency only) and tied on that, correctly broken
by `published_at`.

**Caching**: `lib/cache.js` is a documented in-memory TTL cache (30s for
`/contents`, 20s for `/feed`) — the right first step on a single
Render/cPanel instance, zero extra infrastructure. It's written so the
call sites (`cache.get`/`cache.set`) don't need to change if you later swap
in Redis (`ioredis`) once you run more than one instance — see the comment
at the top of that file for exactly what to swap.

**Security**: every query in `routes/feed.js` uses parameterized queries
(`$1, $2...`) — never string-concatenated SQL — so it's not susceptible to
SQL injection regardless of what a client sends as `wing`, `category`, or
`page`. `POST/DELETE /contents/:id/like` require a valid login
(`requireAuth()`); `/feed` and viewing use `optionalAuth` so anonymous
visitors still get a (non-personalized) feed instead of an error.

**Frontend (not yet wired into index.html — this is architecture, not a
built page)**: the intended pattern for infinite scroll is an
`IntersectionObserver` watching a sentinel `<div>` at the bottom of the
feed list; when it intersects, fetch the next `?page=n+1` and append. See
my message for a complete, drop-in snippet.

### 10. Feed page is live — `index.html` (v2.5)
`/feed` now has a real frontend: Dashboard nav → **🌊 ফিড**. Login/Register
modal (student accounts, self-serve via `POST /auth/register`), a "🎯
আগ্রহ" preferences panel backed by two new endpoints —

```
GET  /auth/me                    → current user + interests/preferred_wings
PUT  /auth/me/preferences         → { interests: string[], preferred_wings: string[] }
```

— IntersectionObserver-driven infinite scroll (loads 10 at a time, matches
`PAGE_SIZE` in `routes/feed.js`), a second observer that fires
`POST /contents/:id/view` once a card is actually 50% scrolled into view
(not just fetched), and a working like button
(`POST`/`DELETE /contents/:id/like`). Works logged-out (generic
recency-ranked feed) and logged-in (personalized) — tested both.

### 11. Admin content publishing — Dashboard → Admin → 📰 ফিড কনটেন্ট (v2.6)
```
GET    /admin/contents            → list all content (published + unpublished), paginated
POST   /admin/contents            → create + publish new content
PATCH  /admin/contents/:id        → edit title/body, toggle is_published
DELETE /admin/contents/:id        → remove
```
A form (wing, kind, category, title, body, tags) plus a management table
with publish/unpublish and delete — this is how real rows get into the
`contents` table that `/feed` reads, instead of only `db/seed.js`. Tested
end-to-end: create → shows up in public `/contents` immediately → unpublish
→ disappears from `/contents` → delete → gone; non-admin correctly gets 403.

⚠️ **Important scope note**: this tab has its **own, separate login** —
it is not part of the Admin Dashboard's other tabs (ওভারভিউ / AI অ্যাপ্রুভাল /
পেআউট / রিপোর্ট / রেকর্ডেড ক্লাস), which are still static demo data with no
login at all in this version of `index.html`. That dashboard-wide login +
live-data wiring was built in an earlier session on a different, since-
superseded copy of this file and doesn't carry over automatically. If you
want the rest of the Admin Dashboard (and Teacher/Publisher/Seller
dashboards) wired the same way in *this* file, say so and I'll redo that
work here.

### What's still missing (real, but out of scope for this pass)
- **Course submission / enrollment / order-creation endpoints** — right now
  rows only get into `courses`/`orders`/`enrollments` via `npm run seed` or
  direct SQL. The public-facing "submit a course", "buy a book", "enroll"
  flows need their own routes before the numbers move on their own.
- **Student dashboard** — Admin, Teacher, Publisher, and Seller are all
  wired to live data now; Student is the one role left on static mock HTML.
- **Registration UI** — `POST /auth/register` exists and works, but nothing
  in `index.html` calls it yet (teachers/publishers/sellers currently only
  get in via `db/seed.js` or direct SQL).
- **Gold Coin discount caps & teacher-payout SMS** — from your correction
  guidelines doc: no code currently enforces the 50%/30% coin-discount caps
  (there's no checkout/redeem flow yet to enforce them in), and payout
  notifications have no SMS provider wired up. Both need a decision from you
  — see my message for the questions.
- **Kids Wing content is still frontend-only** — `/kids/*` above exists and
  is tested working, but `index.html`'s Kids Wing doesn't call it yet (it
  doesn't need to — its content is already real and interactive). Wire it up
  later only if you want content editable without redeploying the frontend.
- **The Feed only has 5 seeded content items** — real content needs to be
  inserted into the `contents` table (via `db/seed.js`, or a future
  admin-facing "publish to feed" route) before it feels like a real feed.

---

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
