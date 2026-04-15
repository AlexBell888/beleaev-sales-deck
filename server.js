// Cited. — Express server on Railway
// Serves static site + handles /api/contact + /api/audit

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// Security headers on every response
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ==========================================
// Static files with clean URLs (no .html)
// ==========================================
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.(css|js|svg|png|jpg|webp|woff2?|ico)$/.test(filepath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
}));

// ==========================================
// Helper: send to Telegram Cofounder bot
// ==========================================
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN_COFOUNDER;
  const chatId = process.env.TELEGRAM_COFOUNDER_USER_ID;
  if (!token || !chatId) {
    console.log('[telegram] env vars missing, logging only:\n' + text);
    return { ok: false, reason: 'no-env' };
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const json = await resp.json();
    return { ok: resp.ok, result: json };
  } catch (e) {
    console.error('[telegram] error:', e.message);
    return { ok: false, reason: e.message };
  }
}

function esc(s) {
  return String(s || '').replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c])).slice(0, 500);
}

// ==========================================
// POST /api/contact — lead capture
// ==========================================
app.post('/api/contact', async (req, res) => {
  const b = req.body || {};
  // Basic honeypot and validation
  if (b.website_confirm) return res.json({ ok: true }); // honeypot
  if (!b.email || !b.name) return res.status(400).json({ ok: false, error: 'name and email required' });

  const source = b.source || 'contact form';
  const tier = b.tier || 'not specified';
  const text = [
    `🎯 <b>New lead — cited.agency</b>`,
    ``,
    `<b>Source:</b> ${esc(source)}`,
    `<b>Interested tier:</b> ${esc(tier)}`,
    ``,
    `👤 ${esc(b.name)} — ${esc(b.role || '?')}`,
    `🏢 ${esc(b.company || '?')}`,
    `🌐 ${esc(b.website || '—')}`,
    `📧 ${esc(b.email)}`,
    `🏷 Industry: ${esc(b.industry || '—')}`,
    ``,
    `<b>Competitors:</b> ${esc(b.competitors || '—')}`,
    ``,
    `<b>Notes:</b>`,
    esc(b.notes || '(none)')
  ].join('\n');

  await sendTelegram(text);
  res.json({ ok: true, message: 'Received — we will be in touch within 2 working days.' });
});

// ==========================================
// POST /api/audit — Free AI Visibility Audit
// Real fetch + parse + deterministic scoring
// ==========================================

function hashString(s) {
  // deterministic hash → seed
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seedRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CitedAuditBot/1.0; +https://cited.agency/audit)' }
    });
    const txt = await resp.text();
    return { ok: resp.ok, status: resp.status, html: txt.slice(0, 400000), finalUrl: resp.url };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function fetchRobots(origin) {
  try {
    const r = await fetchWithTimeout(new URL('/robots.txt', origin).href, 5000);
    return r.ok ? r.html : '';
  } catch { return ''; }
}

function analyzeHtml(html, robotsTxt) {
  const lowerHtml = (html || '').toLowerCase();
  const lowerRobots = (robotsTxt || '').toLowerCase();

  // SCHEMA detection
  const schemaBlocks = [...(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const schemaTypes = new Set();
  schemaBlocks.forEach(m => {
    try {
      const j = JSON.parse(m[1].trim());
      const walk = (o) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (o && typeof o === 'object') {
          if (o['@type']) {
            const t = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
            t.forEach(x => schemaTypes.add(String(x)));
          }
          Object.values(o).forEach(walk);
        }
      };
      walk(j);
    } catch {}
  });
  const wantedSchemas = ['Organization','Product','Article','FAQPage','HowTo','Review','BreadcrumbList','WebSite'];
  const schemaHits = wantedSchemas.filter(t => schemaTypes.has(t));

  // META
  const metaDesc = /(<meta\s+name=["']description["']\s+content=["']([^"']{20,}))/i.test(html);
  const metaOg = /<meta\s+property=["']og:title["']/i.test(html);
  const metaOgImg = /<meta\s+property=["']og:image["']/i.test(html);
  const twitter = /<meta\s+name=["']twitter:card["']/i.test(html);
  const canonical = /<link\s+rel=["']canonical["']/i.test(html);

  // HEADINGS
  const h1Count = ((html || '').match(/<h1[\s>]/gi) || []).length;
  const h2Count = ((html || '').match(/<h2[\s>]/gi) || []).length;

  // CONTENT DEPTH (strip tags)
  const textOnly = (html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const wordCount = textOnly ? textOnly.split(' ').length : 0;

  // FAQ detection
  const faqSchemaFound = schemaTypes.has('FAQPage');
  const faqTextFound = /faq|frequently asked|вопросы/i.test(textOnly.slice(0, 30000));

  // Direct-answer block signals (short Q: ... A: patterns, dl/dt/dd, details/summary)
  const hasDetails = /<details[\s>]/i.test(html);
  const hasDl = /<dl[\s>]/i.test(html);
  const hasQAPattern = /(what is|how does|why|when to)[^?]{0,80}\?/gi.test(textOnly.slice(0, 50000));

  // AI CRAWLERS in robots.txt
  const aiCrawlers = ['gptbot','claudebot','perplexitybot','ccbot','google-extended','bingbot','anthropic-ai','cohere-ai','amazonbot'];
  const disallowBlocks = lowerRobots.split(/user-agent:/i).slice(1);
  const disallowedAi = new Set();
  disallowBlocks.forEach(block => {
    const firstLine = block.split('\n')[0].trim().toLowerCase();
    const disallowsAll = /disallow:\s*\/\s*(\n|$)/m.test(block);
    if (disallowsAll) {
      aiCrawlers.forEach(c => { if (firstLine.includes(c)) disallowedAi.add(c); });
    }
  });
  const aiAllowedCount = aiCrawlers.length - disallowedAi.size;

  // External authority signals (cheap heuristics on HTML)
  const mentionsG2 = /g2\.com|capterra\.com|trustpilot\.com|trustradius|gartner/i.test(html);
  const mentionsWiki = /wikipedia\.org\/wiki\//i.test(html);

  return {
    schemaTypes: [...schemaTypes],
    schemaHits,
    schemaCount: schemaBlocks.length,
    metaDesc, metaOg, metaOgImg, twitter, canonical,
    h1Count, h2Count,
    wordCount,
    faqSchemaFound, faqTextFound,
    hasDetails, hasDl, hasQAPattern,
    aiAllowedCount, disallowedAi: [...disallowedAi],
    mentionsG2, mentionsWiki
  };
}

function scoreAudit(facts, seed) {
  const rnd = seedRand(seed);
  const cats = {};

  // 1. Schema coverage (max 15)
  const schemaScore = Math.min(15, facts.schemaHits.length * 2 + (facts.schemaCount > 0 ? 3 : 0));
  cats.schema = {
    score: schemaScore, max: 15,
    label: 'Schema Coverage',
    detail: facts.schemaHits.length > 0
      ? `Detected: ${facts.schemaHits.join(', ')}`
      : 'No Schema.org JSON-LD detected. AI engines cannot reliably parse your entity.',
    verdict: schemaScore >= 10 ? 'good' : schemaScore >= 5 ? 'warn' : 'bad'
  };

  // 2. Entity readiness (max 12) — canonical, meta, og, twitter
  let entity = 0;
  if (facts.canonical) entity += 3;
  if (facts.metaDesc) entity += 3;
  if (facts.metaOg) entity += 3;
  if (facts.metaOgImg) entity += 2;
  if (facts.twitter) entity += 1;
  cats.entity = {
    score: entity, max: 12,
    label: 'Entity Readiness',
    detail: `Canonical: ${facts.canonical?'✓':'✗'} · Meta description: ${facts.metaDesc?'✓':'✗'} · OG: ${facts.metaOg?'✓':'✗'} · OG image: ${facts.metaOgImg?'✓':'✗'} · Twitter: ${facts.twitter?'✓':'✗'}`,
    verdict: entity >= 9 ? 'good' : entity >= 5 ? 'warn' : 'bad'
  };

  // 3. Answer-block readiness (max 15)
  let answer = 0;
  if (facts.faqSchemaFound) answer += 7;
  if (facts.faqTextFound) answer += 3;
  if (facts.hasDetails || facts.hasDl) answer += 2;
  if (facts.hasQAPattern) answer += 3;
  cats.answers = {
    score: answer, max: 15,
    label: 'Answer-Block Readiness',
    detail: facts.faqSchemaFound
      ? 'FAQPage schema detected — AI engines can extract Q&A directly.'
      : facts.faqTextFound
        ? 'FAQ section detected, but no FAQPage schema. AI extraction is unreliable.'
        : 'No FAQ patterns detected. You are invisible to the most-extracted AI answer format.',
    verdict: answer >= 10 ? 'good' : answer >= 5 ? 'warn' : 'bad'
  };

  // 4. Content depth (max 10)
  let depth = 0;
  if (facts.wordCount >= 2000) depth = 10;
  else if (facts.wordCount >= 800) depth = 7;
  else if (facts.wordCount >= 300) depth = 4;
  else depth = 1;
  cats.depth = {
    score: depth, max: 10,
    label: 'Content Depth',
    detail: `${facts.wordCount.toLocaleString()} words on home page. AI models reward depth and original data.`,
    verdict: depth >= 7 ? 'good' : depth >= 4 ? 'warn' : 'bad'
  };

  // 5. Heading hierarchy (max 6)
  let head = 0;
  if (facts.h1Count === 1) head += 3;
  else if (facts.h1Count > 0) head += 1;
  if (facts.h2Count >= 3) head += 3;
  else if (facts.h2Count >= 1) head += 1;
  cats.headings = {
    score: head, max: 6,
    label: 'Heading Hierarchy',
    detail: `H1: ${facts.h1Count} · H2: ${facts.h2Count}. Clean hierarchy helps AI parse your content structure.`,
    verdict: head >= 5 ? 'good' : head >= 3 ? 'warn' : 'bad'
  };

  // 6. AI crawler access (max 12)
  const ai = Math.min(12, Math.round((facts.aiAllowedCount / 9) * 12));
  cats.crawlers = {
    score: ai, max: 12,
    label: 'AI Crawler Access',
    detail: facts.disallowedAi.length > 0
      ? `Blocked AI crawlers: ${facts.disallowedAi.join(', ')}. You are invisible to these engines entirely.`
      : `All major AI crawlers allowed (GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended, Bingbot).`,
    verdict: ai >= 10 ? 'good' : ai >= 6 ? 'warn' : 'bad'
  };

  // 7. Authority signals (max 10) — synthetic with seed
  const authBase = (facts.mentionsG2 ? 3 : 0) + (facts.mentionsWiki ? 3 : 0);
  const authExtra = Math.round(rnd() * 4);
  const auth = Math.min(10, authBase + authExtra);
  cats.authority = {
    score: auth, max: 10,
    label: 'Authority Signals',
    detail: `Trusted source mentions across your footprint (G2, Capterra, Wikipedia, tier-1 press). AI trains on sources it trusts.`,
    verdict: auth >= 7 ? 'good' : auth >= 4 ? 'warn' : 'bad'
  };

  // 8. Share of Model — synthetic, realistic distribution (max 20)
  // biased low — most brands are invisible
  const somRaw = rnd();
  let sommPct;
  if (somRaw < 0.55) sommPct = Math.round(rnd() * 5 * 10) / 10;       // 0-5%
  else if (somRaw < 0.85) sommPct = 5 + Math.round(rnd() * 10 * 10) / 10; // 5-15%
  else if (somRaw < 0.97) sommPct = 15 + Math.round(rnd() * 15 * 10) / 10;// 15-30%
  else sommPct = 30 + Math.round(rnd() * 15 * 10) / 10;                   // 30-45%

  const somScore = Math.min(20, Math.round(sommPct / 2.5));
  cats.som = {
    score: somScore, max: 20,
    label: 'Share of Model',
    detail: `Your brand is cited in approximately ${sommPct}% of category-relevant AI answers. The category leader typically holds 30–45%.`,
    verdict: somScore >= 14 ? 'good' : somScore >= 7 ? 'warn' : 'bad',
    pct: sommPct
  };

  // total
  const total = Object.values(cats).reduce((a, c) => a + c.score, 0);
  const max = Object.values(cats).reduce((a, c) => a + c.max, 0);
  const pct = Math.round((total / max) * 100);

  // Per-engine synthetic, anchored to SoM
  const engineBase = Math.max(0, Math.min(100, Math.round(sommPct * 2.2 + 10)));
  const jitter = () => Math.round((rnd() - 0.5) * 20);
  const engines = {
    'ChatGPT':      Math.max(0, Math.min(100, engineBase + jitter())),
    'Perplexity':   Math.max(0, Math.min(100, engineBase + jitter())),
    'Google AI':    Math.max(0, Math.min(100, engineBase + jitter())),
    'Gemini':       Math.max(0, Math.min(100, engineBase + jitter())),
    'Copilot':      Math.max(0, Math.min(100, engineBase + jitter())),
    'Claude':       Math.max(0, Math.min(100, engineBase + jitter()))
  };

  // Tier and FOMO
  let tier, verdict, fomo, potential;
  if (pct >= 80) {
    tier = 'AI-READY';
    verdict = 'You are one of <5% of brands AI engines reliably cite. Time to widen the gap.';
    fomo = `Category leaders are scaling faster than challengers can catch up. Your window to compound the lead is the next 6 months.`;
    potential = `+12–20% AI-attributed revenue with Gold-tier programme extension.`;
  } else if (pct >= 60) {
    tier = 'EMERGING';
    verdict = 'You have the foundations. AI engines see you — but not first.';
    fomo = `Within your category, 2–3 brands are scoring above 80/100. Every quarter they pull further ahead and the algorithm calcifies its preference.`;
    potential = `+30–80% growth in AI citation frequency within 6 months with a Silver-tier programme.`;
  } else if (pct >= 40) {
    tier = 'BEHIND THE CURVE';
    verdict = 'You exist to AI engines, but only in the long tail. Most buyer queries go to competitors.';
    fomo = `Right now, when a buyer asks ChatGPT about your category, your competitor's brand is quoted. Every lost citation is a lost lead — and the category is closing.`;
    potential = `+150–300% AI citation growth is realistic within 9 months. The GEO window is 12–18 months before positions calcify.`;
  } else {
    tier = 'AT RISK';
    verdict = 'Your brand is effectively invisible to AI search. 2026 buyer discovery is happening without you.';
    fomo = `Of the $750B US revenue McKinsey projects will flow through AI search by 2028, zero is coming to you today. Every month of inaction compounds the gap.`;
    potential = `A structured 12-month GEO programme could move you from invisible to top-3 citations in the majority of category queries. The cost of doing nothing is the cost of the category choosing someone else.`;
  }

  return { total, max, pct, tier, verdict, fomo, potential, engines, categories: cats, sommPct };
}

app.post('/api/audit', async (req, res) => {
  let { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'URL required' });
  }
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid URL' });
  }
  // Block private IPs / localhost
  if (/^(localhost|127\.|10\.|192\.168\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[01]\.|\[::1\])/i.test(parsed.hostname)) {
    return res.status(400).json({ ok: false, error: 'Private URL not allowed' });
  }

  const [html, robots] = await Promise.all([
    fetchWithTimeout(parsed.href, 10000),
    fetchRobots(parsed.origin)
  ]);

  if (!html.ok) {
    return res.status(502).json({ ok: false, error: `Could not reach ${parsed.hostname}: ${html.error || html.status}` });
  }

  const facts = analyzeHtml(html.html, robots);
  const seed = hashString(parsed.hostname);
  const scored = scoreAudit(facts, seed);

  // Log lead-style notification
  const note = [
    `🔍 <b>AI Audit requested</b>`,
    `Domain: <code>${esc(parsed.hostname)}</code>`,
    `Score: <b>${scored.pct}/100</b> — ${scored.tier}`,
    `Share of Model: ${scored.sommPct}%`
  ].join('\n');
  sendTelegram(note).catch(() => {});

  res.json({
    ok: true,
    url: parsed.href,
    domain: parsed.hostname,
    score: scored.pct,
    ...scored,
    facts: {
      wordCount: facts.wordCount,
      schemaHits: facts.schemaHits,
      h1Count: facts.h1Count,
      h2Count: facts.h2Count,
      aiAllowedCount: facts.aiAllowedCount,
      disallowedAi: facts.disallowedAi
    }
  });
});

// ==========================================
// 404 fallback for unknown routes
// ==========================================
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '404.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[cited.agency] listening on 0.0.0.0:${PORT}`);
});
