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

### 12. Aligned to your architecture doc (v2.7)
Per your "স্বতন্ত্র উইংস / হোম পেজ সারাংশ / ফিড উইং" document:

- **`/feed` scoring formula replaced** to match your spec exactly:
  `(wing ∈ preferred_wings ? 5.0 : 0) + (category ∈ interests ? 3.0 : 0) +
  GREATEST(0, 5.0 − days_since_published)`. Dropped the previous
  tag-overlap/engagement terms. Verified against seeded data — a post
  matching both wing and category scored 13.00 (5+3+5), wing-only scored
  10.00, no match scored 5.00 (pure recency), all exactly as designed.
- **`GET /contents` now accepts `?limit=` (1–20, default 10)** — the
  homepage's per-wing previews need 3 items, not the feed's fixed 10.
- **Kept `interests`/`preferred_wings` as free-text `TEXT[]`, not your
  doc's rigid `module_category` ENUM** — new categories don't need a
  migration this way. Functionally identical match logic either way
  (`category_key = ANY(interests)`); say the word if you want the ENUM
  version instead for stricter validation.
- **Homepage now has live per-wing preview sections** (`index.html`, new
  "🔥 সাম্প্রতিক কার্যক্রম" section, right below the hero) — exactly your
  `home-wing-section` / `summary-grid` / `view-more-link` pattern: 5 wings
  (Academy, Kids, News, Community, AI), each fetching its 3 latest items via
  `GET /contents?wing=X&limit=3` and linking to that wing's own page. Home
  stays a static summary, not a scroll feed — `/feed` remains the only
  infinite-scroll page, exactly as your doc separates them.

### 13. cPanel-style homepage, quick sign-up, feed as default landing (v2.8)
- **Homepage preview grid expanded from 5 to all 17 wings**, and every
  wing card now has an **"আগ্রহী" checkbox** — checking it calls
  `PUT /auth/me/preferences` immediately, adding that wing to
  `preferred_wings` (which is exactly what `/feed`'s scoring reads). This is
  the "cPanel-style, everything in one page, tick what you're interested
  in" homepage you asked for.
- **`POST /auth/quick-register`** (new) — name + phone *or* email, no
  password step. Generates a random password server-side (bcrypt-hashed,
  never exposed) and logs the person straight in via the returned token.
  `users.email` is now nullable and `users.phone` was added (unique,
  `email IS NOT NULL OR phone IS NOT NULL` constraint) — tested phone-only,
  email-only, missing-both (400), and duplicate-contact (409) registration,
  plus logging in with a phone number in `/auth/login`.
- **First-visit flow**: a brand-new visitor (no `eeh_visited` flag in
  localStorage) sees a quick sign-up modal over the homepage automatically.
  "এখন না, পরে করবো" or clicking outside always dismisses it — never a hard
  block. On success, the person is auto-logged-in and taken straight to
  `/feed`.
- **Feed is now the default landing page for anyone already logged in** —
  every homepage load checks for a session and redirects to `/feed`
  immediately if one exists, skipping the wing-preview fetches entirely in
  that case.
- **`GET /recommendations?wings=&interests=`** (new, public) — returns
  matching approved courses + active products (books/mart items), interest-
  matched by category when possible. The Feed page fetches this once per
  session and interleaves a "🎯 আপনার জন্য প্রস্তাবিত" push card (course/
  book/instrument, styled distinctly, links to Academy/Publications/Mart)
  every 5 real feed cards. Tested both the filtered and generic-fallback
  cases against seeded data.
- **Arabic voice preference for religious content** — `speakBn()` now
  tries to select a male-sounding Arabic voice (matched against known male
  voice names) specifically for the Kids Wing's Hijaiyah-letters/Dua
  module. This is a best-effort browser-side preference, not a guarantee —
  the Web Speech API doesn't expose voice gender, and which voices exist at
  all depends entirely on the visitor's device/OS, not anything this app
  controls.

### 14. Mobile horizontal-overflow bug fixed + cross-wing post composer (v2.9)
- **Real mobile bug found and fixed** — tested `index.html` in a real
  headless Chrome at a 390px mobile viewport (not guesswork). Found two
  compounding issues: (1) the splash screen logo ("Effective EduHub") had
  no responsive sizing and rendered as one unwrapped ~485px-wide line,
  and (2) `<html>` was missing `overflow-x:hidden` (only `<body>` had it,
  which doesn't contain `position:fixed` descendants). Together these let
  the layout viewport expand to 528px on load, dragging the fixed header
  bar and bottom tab bar 138px wider than the actual screen. Fixed both;
  re-tested in the same headless browser — `document.documentElement.
  scrollWidth` now exactly matches `clientWidth` (390=390) with zero
  elements wider than the viewport.
- **Facebook-style composer extended to every wing** — the rich composer
  (photo/video/music/feeling/event/live/location/GIF/tag) now also lives
  on the **Feed page**, with a wing selector, so a post can go to Academy,
  Kids, Teachers, Publications, Mart, Blog, AI, Higher Study, Institutional,
  Certificates, Community, Media, Creator, Research, Careers, or News —
  not just Community. New endpoint: `POST /contents` (any logged-in user,
  20 posts/hour rate limit, wing validated against the `wings` table).
  Reuses the exact same `commParseAttachments`/`commRenderAttachments`
  marker-parsing functions as the Community composer — same XSS
  protections apply everywhere a post can appear, verified by re-running
  all 10 security tests after this change (still all passing).

### 15. Course enrollment + book/mart purchasing — `routes/marketplace.js` (v3.0)
The biggest concrete gap from the "still missing" list below, closed:
there was previously no way for a real visitor to browse a course/book/
product catalog or actually enroll/buy anything.

```
GET  /academy/courses           GET  /academy/courses/:id      (public)
GET  /publications/books        GET  /mart/products             (public)
POST /academy/courses/:id/enroll   (login required)
POST /products/:id/buy  { quantity }   (login required)
GET  /me/enrollments            GET  /me/orders                (login required)
```
Both write endpoints run inside a DB transaction with `SELECT ... FOR
UPDATE` row locking — an enrollment and its order either both succeed or
neither does, and concurrent stock-decrementing purchases can't oversell.

**A real bug found and fixed while testing this**: the buy endpoint
originally silently clamped an out-of-range `quantity` (e.g. `9999`) down
to `20` and placed the order anyway, returning `200 ok` — a buyer asking
for 9999 units would be charged for 20 with nothing telling them their
request was altered. Fixed to reject anything outside 1–50 with a clear
`400 invalid_quantity` instead of silently substituting a different
number. Re-tested: excessive quantity → 400, reasonable quantity → still
works, genuinely-insufficient stock → still correctly 409.

Tested end-to-end against real Postgres: browse all three catalogs,
enroll (and get correctly blocked on a duplicate enroll), buy a book,
list "my enrollments"/"my orders", buying without login → 401, enrolling
in a nonexistent course → 404.

### What's still missing (real, but out of scope for this pass)
- **Student dashboard** — Admin, Teacher, Publisher, and Seller are all
  wired to live data now; Student is the one role left on static mock HTML.
  (Now that enroll/buy exist, a "my courses / my orders" student dashboard
  tab using `GET /me/enrollments` + `GET /me/orders` is a natural next step.)
- **Registration UI** — `POST /auth/register` exists and works, but nothing
  in `index.html` calls it yet (teachers/publishers/sellers currently only
  get in via `db/seed.js` or direct SQL).
- **Gold Coin discount caps & teacher-payout SMS** — from your correction
  guidelines doc: no code currently enforces the 50%/30% coin-discount caps
  (there's now a real checkout path — `/products/:id/buy` — to enforce them
  in, if you want that built), and payout notifications have no SMS
  provider wired up. Both need a decision from you — see my message for
  the questions.
- **Kids Wing content is still frontend-only** — `/kids/*` above exists and
  is tested working, but `index.html`'s Kids Wing doesn't call it yet (it
  doesn't need to — its content is already real and interactive). Wire it up
  later only if you want content editable without redeploying the frontend.
- **The Feed only has a handful of seeded content items** — real content
  needs to be inserted into the `contents` table (via `db/seed.js`, the
  admin "📰 ফিড কনটেন্ট" tab, or real users posting) before it feels like a
  full feed.
- **`index.html` doesn't call any of `routes/marketplace.js` yet** — the
  API is real, tested, and ready; the Academy/Publications/Mart pages still
  show static course/product cards. Say the word and I'll wire "ভর্তি হন" /
  "কিনুন" buttons into the real pages next.

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
