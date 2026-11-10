# ZYNQ — made by Nexoria
Ephemeral photo-snap messaging. Android app (`mobile/`) + serverless backend on Cloudflare (`worker/`).

## Implemented (backend covered by 11 automated tests; app NOT yet run on a device)
**Backend:** accounts (PBKDF2, signed tokens), friends, view-once photo snaps (stored in D1, 1.4 MB max, no R2 needed) and atomic one-view guarantee, 24h stories + viewer list, chat, realtime via WebSocket Durable Objects, push-notification fallback (Expo push), block, report (+ admin report list), delete account (removes media), rate limiting, upload size + file-signature validation, scheduled cleanup, privacy-policy and delete-account web pages.
**App:** sign up/login, camera, snaps, stories, friends, chat with live updates, block/report, settings (privacy link, logout, delete account).

## Planned (not built)
Video snaps (need R2 or other object storage), video capture, filters/lenses, Snap Map, Spotlight, groups, calls, streaks, profiles/avatars, screenshot alerts, end-to-end encryption, automated moderation, admin dashboard UI, iOS app.

## Deploy backend (phone-friendly, all in the browser)
1. Cloudflare account (dash.cloudflare.com). Note your **Account ID** (Workers & Pages overview page). Open Workers & Pages once so your `*.workers.dev` subdomain is registered. For production use the Workers Paid plan (required for heavier use; check Cloudflare pricing).
2. Create an API token: My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers**; then edit the token to also allow **Account → D1 → Edit** and **Account → Workers R2 Storage → Edit**.
3. GitHub repo → Settings → Secrets and variables → Actions → **Secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `JWT_SECRET` (32+ random characters), `ADMIN_TOKEN` (32+ random characters).
4. Edit `worker/wrangler.toml`: set `CONTACT_EMAIL` to your real support email.
5. Actions → **Deploy backend (Cloudflare)** → Run workflow. The log prints your URL: `https://zynq-api.<subdomain>.workers.dev`. Open `<URL>/health` — expect `{"ok":true}` — and `<URL>/privacy`.
6. (Optional) Custom domain: Cloudflare dashboard → your Worker → Settings → Domains & Routes.

## Build the Android app
1. Repo → Settings → Secrets and variables → Actions → **Variables**: `API_URL` = your Worker URL.
2. Actions → **Android test APK** → Run workflow → download `zynq-test.apk` from Releases.

## Push notifications (optional, requires setup)
Create a Firebase project, add an Android app `com.nexoria.zynq`, put `google-services.json` in `mobile/` and reference it in app.json (`android.googleServicesFile`), create an EAS project (`eas init`) and upload FCM credentials. Without this the app works; you just won't get background notifications.

## Before Play Store release
Test on real phones; build a properly signed release (EAS or your own keystore); set Privacy Policy URL to `<URL>/privacy` and account-deletion URL to `<URL>/delete-account`; complete Data safety + content rating; have the privacy policy reviewed by a lawyer; watch `GET <URL>/admin/reports` (Bearer ADMIN_TOKEN) and act on reports promptly.
