# 🌐 Cloudflare Worker CORS Proxy Setup for Giano Reader

This guide explains how to create and deploy, for free, a **Cloudflare Worker** dedicated to bypassing CORS restrictions for translation requests sent to Google Translate.

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

      const body = await response.text();

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

There is no need to modify the application's source code:

1. Open **Settings** by clicking the gear icon in Giano Reader's sidebar.
2. Find the **Cloudflare Worker Subdomain** field.
3. Enter your Cloudflare subdomain (for example `happy-reader` if your worker's URL is `https://giano-translate-proxy.happy-reader.workers.dev`).
4. The value is automatically saved locally: FREE translation requests will be dynamically routed to `https://giano-translate-proxy.<your-subdomain>.workers.dev`.
5. *Note:* If you leave the field empty, the application will use the default endpoint `https://translate.googleapis.com/translate_a/single` directly.
