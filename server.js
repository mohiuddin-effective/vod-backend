const express = require('express');
const cors = require('cors');

const app = express();

// ── Middlewares ──────────────────────────────────────────────
app.use(cors()); // TODO: Production-এ Domain restrict করুন
app.use(express.json());

// ── Root Route / Health Check ─────────────────────────────────
app.get('/', (req, res) => {
  res.send('VOD Access Control API is running live!');
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ── In-memory Data (Tables) ──────────────────────────────────
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

const user_video_access = [];
const notification_log = [];

// ── Helper Functions ─────────────────────────────────────────
function findRule(videoId) {
  return video_access_rules.find(r => r.video_id === videoId);
}

function canAccess(user, videoId) {
  const rule = findRule(videoId);
  if (!rule) return { allow: false, reason: 'no_rule' };
  if (rule.is_locked) return { allow: false, reason: 'locked' };

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

function enqueueReEngagementJob(videoId, unlockStart, unlockEnd) {
  const dormantUserCount = 0;
  const job = {
    video_id: videoId,
    unlock_start: unlockStart,
    unlock_end: unlockEnd,
    queued_at: new Date().toISOString(),
    channels: ['push', 'sms', 'whatsapp', 'email'],
    segment_size: dormantUserCount,
  };
  notification_log.push(job);
  console.log('[re-engagement] queued job:', job);
  return job;
}

// ── Admin Panel API Routes ───────────────────────────────────
app.get('/admin/videos', (req, res) => {
  const merged = videos.map(v => ({ ...v, rule: findRule(v.id) }));
  res.json({ videos: merged });
});

app.post('/admin/videos/:id/lock', (req, res) => {
  const rule = findRule(req.params.id);
  if (!rule) return res.status(404).json({ error: 'video_not_found' });
  rule.is_locked = true;
  rule.updated_at = new Date().toISOString();
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

// ── Student Access Route ──────────────────────────────────────
app.get('/videos/:id/playback-url', (req, res) => {
  const user = {
    user_id: req.query.user_id || null,
    batch_id: req.query.batch_id || null,
  };

  const result = canAccess(user, req.params.id);
  if (!result.allow) {
    return res.status(403).json({ error: 'access_denied', reason: result.reason, unlock_end: result.unlock_end });
  }

  const signedUrl = `https://cdn.effectiveeducationhub.com/hls/${req.params.id}/master.m3u8?token=DEMO-${Date.now()}`;
  res.json({ ok: true, playback_url: signedUrl, expires_in_sec: 900, unlock_end: result.unlock_end || null });
});

// ── Cloudflare Stream Integrations ───────────────────────────

// Direct Upload URL Endpoint
app.post('/api/videos/upload-url', async (req, res) => {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return res.status(500).json({ error: 'Cloudflare credentials not configured in environment variables.' });
    }

    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/direct_upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        maxDurationSeconds: 3600,
        creator: 'admin'
      })
    });

    const data = await response.json();

    if (data.success) {
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

// Cloudflare Signed Playback URL Generator
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

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${videoId}/token`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          exp: Math.floor(Date.now() / 1000) + (4 * 3600)
        })
      }
    );

    const data = await response.json();

    if (data.success) {
      const signedToken = data.result.token;
      res.json({
        success: true,
        videoId: videoId,
        signedToken: signedToken,
        hlsUrl: `https://videodelivery.net/${signedToken}/manifest/video.m3u8`,
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

// ── Server Listen ─────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`VOD Access Control API running on http://localhost:${PORT}`);
});
