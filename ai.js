const express = require('express');
const router = express.Router();

// ══════════════════════════════════════════════════════
// Proxies every "AI feature" on the site (AI Tutor, AI News Brief,
// AI Study Plan, AI Fact Check, AI Exam Evaluator, etc.) through one
// endpoint, so the Anthropic API key never has to live in browser JS.
//
// Before this existed, index.html called https://api.anthropic.com
// directly from ~9 different places with no key at all — every one of
// those calls was silently failing (401 / CORS) and falling back to a
// canned Bengali error message. This makes them actually work.
// ══════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-5-20250929'; // fixed server-side; client can't pick the model or run up cost with a fancier one
const MAX_TOKENS_CAP = 1200;

// Simple in-memory per-IP rate limit: protects API cost/margin.
// Fine for a single Render instance; move to Redis if you scale to multiple instances.
const RATE_LIMIT = { windowMs: 60 * 60 * 1000, max: 30 }; // 30 requests/hour/IP
const hits = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT.max;
}
// Periodic cleanup so this Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const fresh = arr.filter(t => now - t < RATE_LIMIT.windowMs);
    if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

router.post('/ask', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'ANTHROPIC_API_KEY not set on the server' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'rate_limited', message: 'অনেকবার চেষ্টা করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages_required' });
  }
  // Only forward role+content — never trust/forward anything else the client sent
  const cleanMessages = messages
    .filter(m => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) })) // guard against huge payloads
    .slice(0, 10);
  if (!cleanMessages.length) return res.status(400).json({ error: 'messages_required' });

  const maxTokens = Math.min(Number(req.body.max_tokens) || 800, MAX_TOKENS_CAP);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: cleanMessages })
    });
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      console.error('[ai/ask] upstream error', upstream.status, errBody.slice(0, 300));
      return res.status(502).json({ error: 'upstream_error' });
    }
    const data = await upstream.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    res.json({ text, content: data.content }); // `content` kept for callers still reading the raw Anthropic shape
  } catch (err) {
    console.error('[ai/ask] error:', err);
    res.status(502).json({ error: 'upstream_error' });
  }
});

module.exports = router;
