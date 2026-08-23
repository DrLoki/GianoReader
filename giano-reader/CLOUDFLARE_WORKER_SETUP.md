# 🌐 Cloudflare Worker CORS Proxy Setup for Giano Reader (PWA Offline Mode)

This guide explains how to create and deploy, for free, a **Cloudflare Worker** dedicated to bypassing CORS restrictions for translation requests sent to Google Translate.

> **Important:** This Worker is used **only** by the PWA web client in **offline mode** (when disconnected from the Giano Reader desktop server). The desktop app (Tauri) calls Google Translate directly without needing a CORS proxy.

For security reasons, the proposed code is configured to forward requests **exclusively to Google Translate**, preventing third parties from abusing your worker as a generic proxy for any website.

---

## 🛠️ 1. Worker Code (`worker.js`)

Create a new file, or copy this code into Cloudflare's editing screen:

```javascript
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle OPTIONS requests (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    // Only accept GET requests for security reasons
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Build the destination URL on Google Translate, forwarding the same parameters
    const targetUrl = new URL('https://translate.googleapis.com/translate_a/single');
    targetUrl.search = url.search;

    try {
      const response = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: {
          // Add a realistic User-Agent to prevent Google from blocking the request
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      const contentType = response.headers.get('Content-Type') || '';
      const body = await response.text();

      // Detect captcha/rate-limit: Google returns HTML instead of JSON when
      // it suspects automated traffic from this IP.
      const isCaptcha =
        contentType.includes('text/html') ||
        response.status === 429 ||
        body.includes('unusual traffic') ||
        body.includes('captcha');

      if (isCaptcha) {
        return new Response(JSON.stringify({
          error: 'CAPTCHA_REQUIRED',
          message: 'Google has detected unusual traffic and requires human verification.',
          verifyUrl: 'https://translate.google.com/',
        }), {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json; charset=utf-8',
          },
        });
      }

      return new Response(body, {
        status: response.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }
  },
};
```

---

## 🚀 2. How to Create and Deploy the Worker (Cloudflare Dashboard)

1. Log in to your **[Cloudflare Dashboard](https://dash.cloudflare.com/)** (sign up for free if you don't have an account).
2. In the left-hand menu, click on **Workers & Pages**.
3. Click the **Create Application** button (or **Create Worker**).
4. Give your worker a name (e.g. `giano-translate-proxy`).
5. Click **Deploy**.
6. Once created, click **Edit Code**.
7. Paste the code above, replacing all the existing text.
8. Click **Save and Deploy**.

Your proxy will be reachable at an address similar to this:
`https://giano-translate-proxy.<your-subdomain>.workers.dev`

---

## ⚙️ 3. How to Configure It in Giano Reader

The Cloudflare Worker subdomain is configured **in the PWA web client settings** (not in the desktop app):

1. Open the PWA web client on your mobile device.
2. Open **Settings** (bottom sheet).
3. Find the **Cloudflare Worker Subdomain** field.
4. Enter your Cloudflare subdomain (for example `happy-reader` if your worker's URL is `https://giano-translate-proxy.happy-reader.workers.dev`).
5. The value is saved locally. When the PWA is in offline mode (disconnected from the desktop server), FREE translation requests will be routed through your Cloudflare Worker to bypass CORS.
6. *Note:* If you leave the field empty and the PWA is offline, translation will not work (direct calls to `translate.googleapis.com` are blocked by CORS in the browser).

---

## ⚠️ 4. Captcha / Rate Limiting

Google may detect the Worker's IP as generating automated traffic and respond with a captcha challenge instead of a translation. When this happens:

- The Worker detects the captcha response (HTML body, status 429) and returns a structured JSON error: `{ "error": "CAPTCHA_REQUIRED" }`.
- The PWA client shows a notification asking the user to wait a few minutes before retrying.
- Since the Worker's IP is a shared Cloudflare data center IP, solving the captcha in the user's browser does **not** unblock the Worker. The rate limit typically expires after a few minutes of inactivity.

**Mitigation strategies:**

- Keep translation volume low (the free tier is for personal use).
- Use the PRO translation mode (OpenRouter) if you hit rate limits frequently.
- When connected to the desktop server (online mode), translations go through the Rust backend directly — no Worker needed, no CORS issue.
