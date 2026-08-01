// ══════════════════════════════════════════════════════════════
// Effective Education Hub — Recorded Class Access Control API
// Implements the endpoints from the design doc's §2 Admin Panel API
// and §3 Re-engagement Engine trigger.
//
// STORAGE: in-memory (arrays), matching the Postgres schema in the
// design doc exactly (videos / video_access_rules / user_video_access).
// This makes it deployable in minutes with zero DB setup for a first
// pass. Swap the marked sections for real Postgres queries (e.g. via
// `pg` or an ORM) when you're ready — the function signatures and
// return shapes are written so that swap doesn't change the API.
//
// NOT INCLUDED (needs real provider credentials you'll add):
//  - Actual video transcoding / Cloudflare Stream / Mux integration
//  - Actual signed HLS URL generation (playback-url returns a
//    placeholder shaped like the real thing)
//  - Actual FCM/SMS/WhatsApp/Email dispatch (schedule-promo logs
//    what WOULD be sent — wire in real provider SDKs where marked)
// ══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // TODO: restrict to your real domain(s) in production:
                  // cors({ origin: ['https://effectiveeducationhub.com','https://effectiveeduhub.com'] })
app.use(express.json());

// ── In-memory "tables" (swap for Postgres later) ──────────────
const videos = [
  { id: 'v1', course_id: 'bcs-batch', title: 'BCS প্রিলি — অধ্যায় ১: বাংলা ব্যাকরণ', duration_sec: 2700, status: 'ready', created_at: new Date().toISOString() },
  { id: 'v2', course_id: 'bank-course', title: 'ব্যাংক রিটেন — গণিত শর্টকাট মডিউল', duration_sec: 1800, status: 'ready', created_at: new Date().toISOString() },
  { id: 'v3', course_id: 'ntrca-course', title: 'NTRCA প্রিলি — ফ্রি ডেমো ক্লাস', duration_sec: 1500, status: 'ready', created_at: new Date().toISOString() },
];

const video_access_rules = [
  { id: 'r1', video_id: 'v1', access_tier: 'batch_only', is_locked: false, batch_id: 'bcs-2025-batch', unlock_start: null, unlock_end: null, updated_at: new Date().toISOString() },
  { id: 'r2', video_id: 'v2', access_tier: 'paid_only',  is_locked: false, batch_id: null, unlock_start: null, unlock_end: null, updated_at: new Date().toISOString() },
  { id: 'r3', video_id: 'v3', access_tier: 'promo_unlock', is_locked: false, batch_id: null, unlock_start: null, unlock_end: null, updated_at: new Date().toISOString() },
];

const user_video_access = []; // { user_id, video_id, granted_via, expires_at }
const notification_log = [];  // dedup/suppression ledger

function findRule(videoId) {
  return video_access_rules.find(r => r.video_id === videoId);
}

// ── canAccess() — direct implementation of the design doc's pseudocode ──
function canAccess(user, videoId) {
  const rule = findRule(videoId);
  if (!rule) return { allow: false, reason: 'no_rule' };
  if (rule.is_locked) return { allow: false, reason: 'locked' }; // admin kill switch overrides everything

  if (rule.access_tier === 'public') return { allow: true };

  if (rule.access_tier === 'promo_unlock') {
    const now = Date.now();
    const start = rule.unlock_start ? new Date(rule.unlock_start).getTime() : null;
    const end = rule.unlock_end ? new Date(rule.unlock_end).getTime() : null;
    if (start && end && now >= start && now <= end) return { allow: true, unlock_end: rule.unlock_end };
    return { allow: false, reason: 'promo_window_closed' };
  }

  if (rule.access_tier === 'batch_only') {
    return user && user.batch_id === rule.batch_id
      ? { allow: true }
      : { allow: false, reason: 'wrong_batch' };
  }

  if (rule.access_tier === 'paid_only') {
    const grant = user_video_access.find(a =>
      a.user_id === (user && user.user_id) &&
      a.video_id === videoId &&
      (a.expires_at === null || new Date(a.expires_at).getTime() > Date.now())
    );
    return grant ? { allow: true } : { allow: false, reason: 'not_purchased' };
  }

  return { allow: false, reason: 'unknown_tier' };
}

// ── §3 Re-engagement job (stub — wire real providers where marked) ──
function enqueueReEngagementJob(videoId, unlockStart, unlockEnd) {
  // Segment builder: users inactive 14+ days who don't already have access.
  // In a real deployment this queries your `users` table; here it's illustrative.
  const dormantUserCount = 0; // TODO: replace with real query against your users table

  const job = {
    video_id: videoId,
    unlock_start: unlockStart,
    unlock_end: unlockEnd,
    queued_at: new Date().toISOString(),
    channels: ['push', 'sms', 'whatsapp', 'email'],
    segment_size: dormantUserCount,
  };
  notification_log.push(job);

  // TODO: fan out for real —
  //   Push:     admin.messaging().sendMulticast(...)        (Firebase Admin SDK)
  //   SMS:      sslWirelessClient.sendBulk(...)              (SSL Wireless / Banglalink API)
  //   WhatsApp: fetch to Meta's WhatsApp Business Cloud API
  //   Email:    ses.sendEmail(...) / SendGrid
  console.log('[re-engagement] queued job:', job);
  return job;
}

// ══════════════════════════════════════════════════════════════
// Admin Panel API (matches the design doc's endpoint table)
// ══════════════════════════════════════════════════════════════

app.post('/admin/videos/:id/lock', (req, res) => {
  const rule = findRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'video_not_found' });
  rule.is_locked = true;
  rule.updated_at = new Date().toISOString();
  // TODO: push a websocket event here to invalidate any active player session immediately
  res.json({ ok: true, video_id: req.params.id, is_locked: true });
});

app.post('/admin/videos/:id/unlock', (req, res) => {
  const rule = findRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'video_not_found' });
  rule.is_locked = false;
  rule.updated_at = new Date().toISOString();
  res.json({ ok: true, video_id: req.params.id, is_locked: false });
});

app.put('/admin/videos/:id/access-rule', (req, res) => {
  const rule = findRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'video_not_found' });
  const { access_tier, batch_id, unlock_start, unlock_end } = req.body || {};
  if (access_tier) rule.access_tier = access_tier;
  if (batch_id !== undefined) rule.batch_id = batch_id;
  if (unlock_start !== undefined) rule.unlock_start = unlock_start;
  if (unlock_end !== undefined) rule.unlock_end = unlock_end;
  rule.updated_at = new Date().toISOString();
  res.json({ ok: true, rule });
});

app.post('/admin/videos/:id/schedule-promo', (req, res) => {
  const rule = findRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'video_not_found' });
  const { hours } = req.body || {};
  const h = Number(hours) > 0 ? Number(hours) : 2;
  const start = new Date().toISOString();
  const end = new Date(Date.now() + h * 3600000).toISOString();

  rule.access_tier = 'promo_unlock';
  rule.is_locked = false;
  rule.unlock_start = start;
  rule.unlock_end = end;
  rule.updated_at = new Date().toISOString();

  const job = enqueueReEngagementJob(req.params.id, start, end);

  res.json({ ok: true, video_id: req.params.id, unlock_start: start, unlock_end: end, reengagement_job: job });
});

// ══════════════════════════════════════════════════════════════
// Student-facing endpoint
// ══════════════════════════════════════════════════════════════

app.get('/videos/:id/playback-url', (req, res) => {
  // In production: pull `user` from your auth middleware / session / JWT.
  // Demo: accept it via query params so this is testable without auth wired up yet.
  const user = {
    user_id: req.query.user_id || null,
    batch_id: req.query.batch_id || null,
  };

  const result = canAccess(user, req.params.id);
  if (!result.allow) {
    return res.status(403).json({ error: 'access_denied', reason: result.reason, unlock_end: result.unlock_end });
  }

  // TODO: replace with a real signed URL from Cloudflare Stream / Mux / MediaConvert output,
  // short-lived (5–15 min) and tied to user_id + video_id + expiry per the design doc.
  const signedUrl = `https://cdn.effectiveeducationhub.com/hls/${req.params.id}/master.m3u8?token=DEMO-${Date.now()}`;
  res.json({ ok: true, playback_url: signedUrl, expires_in_sec: 900, unlock_end: result.unlock_end || null });
});

// ── Read-only listing endpoint (handy for the admin UI to sync state) ──
app.get('/admin/videos', (req, res) => {
  const merged = videos.map(v => ({ ...v, rule: findRule(v.id) }));
  res.json({ videos: merged });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`VOD Access Control API running on http://localhost:${PORT}`);
});
// Cloudflare Stream Direct Upload URL Endpoint
app.post('/api/videos/upload-url', async (req, res) => {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Cloudflare credentials not configured in environment variables.' });
    }

    // Direct Upload URL চাওয়ার জন্য Cloudflare API-তে Request
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        maxDurationSeconds: 3600, // সর্বোচ্চ ১ ঘণ্টার ভিডিও (প্রয়োজনমতো বাড়াতে পারেন)
        creator: 'admin'
      })
    });

    const data = await response.json();

    if (data.success) {
      // Cloudflare থেকে পাওয়া Upload URL এবং Video ID ব্যাকএন্ড থেকে রেসপন্স করা
      res.json({
        uploadURL: data.result.uploadURL,
        videoId: data.result.uid
      });
    } else {
      res.status(400).json({ error: 'Cloudflare API Error', details: data.errors });
    }
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});
// Cloudflare Stream Signed Playback URL Generator
app.get('/api/videos/playback-url', async (req, res) => {
  try {
    const { videoId } = req.query;

    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Cloudflare credentials not configured in environment variables.' });
    }

    // ১. Cloudflare API-তে Signed Token-এর জন্য Request পাঠানো
    // exp: ৪ ঘণ্টা (4 * 3600 seconds) মেয়াদের Signed Token জেনারেট হবে
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${videoId}/token`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + (4 * 3600) // ৪ ঘণ্টার জন্য মেয়াদী
        })
      }
    );

    const data = await response.json();

    if (data.success) {
      const signedToken = data.result.token;

      // ২. সুরক্ষিত Playback URLs রেসপন্স করা
      res.json({
        success: true,
        videoId: videoId,
        signedToken: signedToken,
        // HLS Manifest URL (মোবাইল ও কাস্টম প্লেয়ারের জন্য)
        hlsUrl: `https://videodelivery.net/${signedToken}/manifest/video.m3u8`,
        // Direct Cloudflare Iframe Player (ওয়েব প্লেয়ার বা মোবাইল অ্যাপের WebView-র জন্য)
        iframeUrl: `https://iframe.videodelivery.net/${signedToken}`
      });
    } else {
      res.status(400).json({
        error: 'Failed to generate signed token from Cloudflare',
        details: data.errors
      });
    }
  } catch (error) {
    console.error('Error generating playback token:', error);
    res.status(500).json({ error: 'Internal server error while generating video playback URL' });
  }
});