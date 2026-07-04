# Action Hub

A free, no-login "link in bio" page for small businesses. One address, up to
8 links, a logo-derived color palette, and an automatic open/closed sign.

## What's in this folder

```
action-hub/
├── public/
│   └── index.html      ← landing page + app (single file, no build step)
├── worker.js            ← Cloudflare Worker: API + static asset serving
├── wrangler.toml        ← Worker config (KV binding, assets binding)
└── README.md
```

## Deploy (Cloudflare Workers)

1. Install Wrangler if you don't have it:
   ```
   npm install -g wrangler
   ```

2. Log in:
   ```
   wrangler login
   ```

3. Create the KV namespace that stores pages:
   ```
   wrangler kv namespace create ACTION_HUB_KV
   ```
   Copy the `id` it prints into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

4. Deploy:
   ```
   wrangler deploy
   ```

   Wrangler will print your live URL, e.g. `https://action-hub.<you>.workers.dev`.

5. (Optional) Attach a custom domain in the Cloudflare dashboard under
   Workers & Pages → your worker → Settings → Triggers → Custom Domains.

## How it works

- **`/`** — landing page (hero, features, how-it-works) with a "Create your
  page" flow.
- **`/b/:slug`** — a published page, publicly viewable.
- **`/b/:slug/edit/:token`** — the owner's private link; visiting it unlocks
  the "Edit This Page" button. This link is generated once at creation and
  shown to the owner exactly once — there's no recovery flow if it's lost,
  by design (no accounts, no passwords, no email required).
- **`/api/pages/:slug`** (GET) — public read of a page's state.
- **`/api/pages`** (POST) — create a page; returns `{ slug, editToken }`.
- **`/api/pages/:slug/:token`** (POST) — update a page if the token matches.

All state is re-validated server-side (length limits, image size, slug
format, URL scheme) regardless of what the client sends. Edit tokens are
never stored in plaintext — only their SHA-256 hash — so a KV read doesn't
hand out working credentials.

## Known trade-offs (read before using for anything sensitive)

- **The edit token lives in the URL.** That's simplest for a no-login tool,
  but it means the token can end up in browser history or server access
  logs. Treat it like a password: don't paste it into chat tools, don't
  share it, don't post it publicly.
- **Rate limiting is best-effort**, not airtight (KV counters aren't fully
  atomic under concurrent requests). Fine for deterring casual abuse; if you
  expect real attack traffic, swap in Cloudflare's native Rate Limiting
  binding or a Durable Object.
- **No CAPTCHA on page creation** — someone could still script
  slug-squatting at a slow pace even with rate limiting in place.
- **Slugs are permanent** once claimed — there's currently no delete/release
  endpoint.

## Customizing

- Colors, type, and copy all live in `public/index.html` — it's a single
  static file, no build step.
- `MAX_LINKS`, size limits, and rate-limit thresholds are constants at the
  top of `worker.js`.