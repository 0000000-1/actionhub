/**
 * Action Hub — Cloudflare Worker backend
 * -----------------------------------------------------------------
 * Storage: Cloudflare Workers KV (binding name: ACTION_HUB_KV)
 * Static asset: index.html served via Workers Assets (binding: ASSETS)
 *
 * Routes:
 *   GET  /                          -> app shell (landing / create-new state)
 *   GET  /b/:slug                   -> app shell (public view of a business page)
 *   GET  /b/:slug/edit/:token       -> app shell (owner edit view)
 *   GET  /api/pages/:slug           -> JSON state for a slug (public, read-only)
 *   POST /api/pages                 -> create a new page. Body: { slug, state }
 *                                      Returns { slug, editToken } — shown ONCE, caller must save it.
 *   POST /api/pages/:slug/:token    -> update an existing page if token matches. Body: { state }
 *
 * KV value shape stored per slug:
 *   {
 *     state: { title, sub, emoji, imageBlob, links: [...] },
 *     editTokenHash: "<sha256 hex of the edit token>",
 *     createdAt: <ISO string>,
 *     updatedAt: <ISO string>
 *   }
 *
 * Security notes:
 *   - Raw edit tokens are never stored — only their SHA-256 hash — so a KV
 *     leak doesn't hand out working edit tokens.
 *   - The public GET route never returns editTokenHash.
 *   - Per-IP rate limiting on writes via KV counters. This is best-effort
 *     (KV get+put isn't atomic) — swap for Durable Objects or Cloudflare's
 *     native Rate Limiting binding if you need airtight protection.
 *   - All state going into KV is re-validated server-side (never trust the client).
 * -----------------------------------------------------------------
 */

const MAX_LINKS = 8;
const MAX_TITLE_LEN = 60;
const MAX_SUB_LEN = 120;
const MAX_LINK_TITLE_LEN = 60;
const MAX_IMAGE_BYTES = 76800; // ~75KB, matches the frontend's own cap
const MAX_STATE_JSON_BYTES = 120000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_SLUG_LEN = 3;
const MAX_SLUG_LEN = 48;

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_WRITES = 10; // per IP per window

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname.startsWith('/api/pages')) {
        return await handleApi(request, env, pathname);
      }
      // Every other path (/, /b/:slug, /b/:slug/edit/:token) serves the
      // same app shell; client-side routing decides what to render.
      return await serveAppShell(env);
    } catch (err) {
      return json({ error: 'Internal error', detail: String(err) }, 500);
    }
  },
};

async function handleApi(request, env, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ["api","pages", ...]

  if (request.method === 'GET' && parts.length === 3) {
    return await getPage(env, parts[2]);
  }
  if (request.method === 'POST' && parts.length === 2) {
    return await createPage(request, env);
  }
  if (request.method === 'POST' && parts.length === 4) {
    return await updatePage(request, env, parts[2], parts[3]);
  }
  return json({ error: 'Not found' }, 404);
}

async function getPage(env, slug) {
  if (!isValidSlug(slug)) return json({ error: 'Invalid slug' }, 400);
  const raw = await env.ACTION_HUB_KV.get(kvKey(slug));
  if (!raw) return json({ error: 'Not found' }, 404);
  const record = JSON.parse(raw);
  return json({ slug, state: record.state, updatedAt: record.updatedAt });
}

async function createPage(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(env, `create:${ip}`)) {
    return json({ error: 'Too many requests, try again in a minute.' }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const slug = normalizeSlug(body.slug || '');
  if (!isValidSlug(slug)) {
    return json({ error: 'Slug must be 3-48 chars, lowercase letters/numbers/hyphens only.' }, 400);
  }

  const existing = await env.ACTION_HUB_KV.get(kvKey(slug));
  if (existing) return json({ error: 'That page name is already taken. Try another.' }, 409);

  const stateResult = validateAndCleanState(body.state);
  if (!stateResult.ok) return json({ error: stateResult.error }, 400);

  const editToken = generateToken();
  const editTokenHash = await sha256Hex(editToken);
  const now = new Date().toISOString();

  const record = { state: stateResult.state, editTokenHash, createdAt: now, updatedAt: now };
  await env.ACTION_HUB_KV.put(kvKey(slug), JSON.stringify(record));

  return json({ slug, editToken }, 201);
}

async function updatePage(request, env, slug, token) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(env, `update:${ip}`)) {
    return json({ error: 'Too many requests, try again in a minute.' }, 429);
  }

  if (!isValidSlug(slug)) return json({ error: 'Invalid slug' }, 400);
  if (!token || token.length < 16) return json({ error: 'Invalid token' }, 403);

  const raw = await env.ACTION_HUB_KV.get(kvKey(slug));
  if (!raw) return json({ error: 'Not found' }, 404);

  const record = JSON.parse(raw);
  const tokenHash = await sha256Hex(token);
  if (tokenHash !== record.editTokenHash) return json({ error: 'Edit token does not match this page.' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const stateResult = validateAndCleanState(body.state);
  if (!stateResult.ok) return json({ error: stateResult.error }, 400);

  record.state = stateResult.state;
  record.updatedAt = new Date().toISOString();
  await env.ACTION_HUB_KV.put(kvKey(slug), JSON.stringify(record));

  return json({ slug, updatedAt: record.updatedAt });
}

function validateAndCleanState(state) {
  if (!state || typeof state !== 'object') return { ok: false, error: 'Missing state.' };

  const jsonStr = JSON.stringify(state);
  if (jsonStr.length > MAX_STATE_JSON_BYTES) return { ok: false, error: 'Page data is too large.' };

  const title = clamp(state.title, MAX_TITLE_LEN, 'Action Hub');
  const sub = clamp(state.sub, MAX_SUB_LEN, '');
  const emoji = clamp(state.emoji, 4, '💼');

  let imageBlob = '';
  if (typeof state.imageBlob === 'string' && state.imageBlob.startsWith('data:image')) {
    const approxBytes = state.imageBlob.length * 0.75;
    if (approxBytes <= MAX_IMAGE_BYTES) imageBlob = state.imageBlob;
    else return { ok: false, error: 'Image is too large (max ~75KB).' };
  }

  const linksIn = Array.isArray(state.links) ? state.links.slice(0, MAX_LINKS) : [];
  const links = [];
  for (const link of linksIn) {
    const linkTitle = clamp(link && link.title, MAX_LINK_TITLE_LEN, '');
    const linkUrl = link && typeof link.url === 'string' ? link.url : '';
    if (linkTitle && isSafeUrl(linkUrl)) links.push({ title: linkTitle, url: linkUrl });
  }

  return { ok: true, state: { title, sub, emoji, imageBlob, links } };
}

function clamp(val, maxLen, fallback) {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  return trimmed ? trimmed.slice(0, maxLen) : fallback;
}

function isSafeUrl(rawUrl) {
  try { const u = new URL(rawUrl); return u.protocol === 'https:' || u.protocol === 'http:'; }
  catch { return false; }
}

function isValidSlug(slug) {
  return typeof slug === 'string' && slug.length >= MIN_SLUG_LEN && slug.length <= MAX_SLUG_LEN && SLUG_RE.test(slug);
}

function normalizeSlug(raw) {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function kvKey(slug) { return `page:${slug}`; }

function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function isRateLimited(env, key) {
  const rlKey = `rl:${key}`;
  const current = await env.ACTION_HUB_KV.get(rlKey);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= RATE_LIMIT_MAX_WRITES) return true;
  await env.ACTION_HUB_KV.put(rlKey, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return false;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

async function serveAppShell(env) {
  if (env.ASSETS) {
    return env.ASSETS.fetch(new Request('https://placeholder/index.html'));
  }
  return new Response(
    'App shell not configured. Deploy index.html as a static asset (see README.md).',
    { status: 501 }
  );
}