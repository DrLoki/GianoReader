# Google Cloud Translation API — Setup Guide

This guide walks you through configuring Google Cloud to use the **Cloud Translation API v2** with Giano Reader's **Basic** translation mode.

## Overview

The Basic translation mode uses Google's official Cloud Translation API v2, which provides:

- **NMT (Neural Machine Translation)** — High-quality translations using Google's production neural models. The same technology powering Google Translate, but accessed through the official, reliable API.
- **No CORS issues** — Unlike the free unofficial endpoint, the official API is stable and not subject to unexpected blocks.
- **Higher rate limits** — Suitable for translating entire books without throttling.

Cost: approximately **$20 per million characters** (~$0.01–0.02 per average novel).

---

## Prerequisites

- A Google account
- A credit card or billing account (required to enable APIs, but free tier credits are available)

---

## Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project selector dropdown at the top of the page.
3. Click **New Project**.
4. Enter a project name (e.g. `giano-reader-translate`).
5. Click **Create**.
6. Wait for the project to be created, then select it from the project dropdown.

---

## Step 2: Enable the Cloud Translation API

1. In the Cloud Console, go to **APIs & Services > Library** (or search "Cloud Translation API" in the top search bar).
2. Find **Cloud Translation API** and click on it.
3. Click **Enable**.
4. Wait for the API to be activated (this takes a few seconds).

---

## Step 3: Create an API Key

1. Go to **APIs & Services > Credentials**.
2. Click **+ Create Credentials > API Key**.
3. A new API key will be generated. Copy it immediately.
4. (Recommended) Click **Edit API Key** to restrict it:
   - Under **API restrictions**, select **Restrict key**.
   - Choose **Cloud Translation API** from the list.
   - Click **Save**.

> **Security tip:** Restricting the key to only the Cloud Translation API prevents misuse if the key is accidentally exposed.

---

## Step 4: (Optional) Enable Billing

If you haven't already set up billing:

1. Go to **Billing** in the Cloud Console sidebar.
2. Link a billing account to your project.

> **Free tier:** Google Cloud offers $300 in free credits for new accounts (valid for 90 days). The Cloud Translation API also has a free tier of 500,000 characters per month.

---

## Step 5: Configure Giano Reader

### Desktop App

1. Open **Settings** (gear icon in the sidebar).
2. Go to the **Basic** tab.
3. Enter your **Google Cloud API Key** (from Step 3).
4. Close Settings.
5. The translation mode dropdown in the sidebar will now show **BASIC** as an option. Select it.

### PWA Web Client

1. Open **Settings** in the mobile web interface.
2. Fill in the **Google Cloud API Key** field.
3. Change the **Translation mode** dropdown to **BASIC**.

---

## Pricing

| Tier | Cost | Notes |
|------|------|-------|
| Free tier | 500,000 chars/month | No charge |
| Standard | $20 per 1M characters | NMT model (default) |

### Estimating Costs

A typical English novel contains approximately 500,000-700,000 characters. At standard rates:
- One average novel = $0.01-0.014 (less than 2 cents)
- 100 novels = $1.00-1.40

For most personal use, costs are negligible and well within the free tier for casual reading.

---

## Supported Languages

Cloud Translation API v2 supports 100+ languages. In Giano Reader, you can translate to/from any of the configured target languages. The source language is auto-detected.

Full list: [Supported Languages](https://cloud.google.com/translate/docs/languages)

---

## Troubleshooting

### Error: "Google Cloud Translation error (403)"

- Verify your API key is correct and not revoked.
- Ensure the Cloud Translation API is enabled for your project.
- Check that the API key restriction (if set) includes Cloud Translation API.
- Confirm billing is active on the project.

### Error: "Google Cloud Translation quota exceeded" (429)

- You've hit the rate limit. Wait a few minutes and try again.
- Check your quota in **APIs & Services > Cloud Translation API > Quotas**.
- You can request a quota increase from the Cloud Console.

### Translation doesn't start

- Make sure you selected **BASIC** from the translation mode dropdown in the sidebar.
- Verify your API key starts with `AIza`.
- Check the browser console (F12) for detailed error messages.

---

## Security Considerations

- **Never share your API key publicly** (e.g., in git repositories or screenshots).
- Use API key restrictions to limit usage to the Translation API only.
- Monitor usage in the Cloud Console to detect unexpected activity.

---

## Further Reading

- [Cloud Translation API v2 Documentation](https://cloud.google.com/translate/docs/basic/translating-text)
- [Supported Languages](https://cloud.google.com/translate/docs/languages)
- [Pricing](https://cloud.google.com/translate/pricing)
- [API Key Best Practices](https://cloud.google.com/docs/authentication/api-keys)
