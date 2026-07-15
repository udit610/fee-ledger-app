# Fee Ledger — deployable version

Two parts:
- **backend/** — Node/Express API. Verifies Google sign-in, stores students/reminders in a JSON file, protects every route behind a session cookie.
- **frontend/** — React app (Vite). Real "Sign in with Google" button, talks to the backend over HTTPS.

---

## 1. Get a Google OAuth Client ID (~5 min)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project (or use an existing one).
2. **APIs & Services → OAuth consent screen** → External → fill in app name, your email → save. You don't need to publish it — "Testing" mode is fine as long as you add your own Google account (and any staff) under **Test users**.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.**
4. Under **Authorized JavaScript origins**, add both:
   - `http://localhost:5173` (for local testing)
   - your real frontend URL once deployed, e.g. `https://fee-ledger.vercel.app`
5. Copy the **Client ID** (looks like `123-abc.apps.googleusercontent.com`). You'll paste this into both `backend/.env` and `frontend/.env`.

---

## 2. Run it locally first

```bash
cd backend
cp .env.example .env
# edit .env: paste GOOGLE_CLIENT_ID, set ALLOWED_EMAILS to your Gmail address,
# generate JWT_SECRET with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm install
npm run dev
```

```bash
cd frontend
cp .env.example .env
# edit .env: paste the same GOOGLE_CLIENT_ID, leave VITE_API_URL as localhost:4000
npm install
npm run dev
```

Open the printed `localhost:5173` URL, sign in with the Gmail address you put in `ALLOWED_EMAILS`. Anyone not on that list gets rejected even with a valid Google login — that's your access control.

---

## 3. Deploy for real

**Backend → Render.com (free tier works fine):**
1. Push this whole folder to a GitHub repo.
2. Render → New → Web Service → connect the repo → root directory `backend`.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables (same ones as your local `.env`), but set `FRONTEND_URL` to your real frontend URL and `NODE_ENV=production`.
5. Render gives you a URL like `https://fee-ledger-api.onrender.com` — that's your `VITE_API_URL`.

Note: Render's free tier uses an ephemeral disk, so the `data.json` file can reset on redeploy. Fine for testing; for production add a Render persistent disk (small extra cost) or migrate `db.js` to a proper database later — the rest of the code doesn't need to change.

**Frontend → Vercel or Netlify (free):**
1. New project → same GitHub repo → root directory `frontend`.
2. Build command: `npm run build`. Output directory: `dist`.
3. Add environment variables: `VITE_GOOGLE_CLIENT_ID`, `VITE_API_URL` (your Render URL).
4. Deploy. Copy the resulting URL (e.g. `https://fee-ledger.vercel.app`).

**Then go back and:**
- Add that Vercel URL to Google Cloud Console's Authorized JavaScript origins (step 1.4 above).
- Update the backend's `FRONTEND_URL` env var to match it exactly, redeploy backend.

---

## 4. Adding staff logins later

Just add their Gmail address to `ALLOWED_EMAILS` in the backend's environment variables (comma-separated) and redeploy the backend. No code changes needed. If you want per-person permissions (e.g. one school only, view-only, etc.) later, that's a bigger change — happy to help when you get there.

---

## What's still manual

WhatsApp reminders open `wa.me` links pre-filled with the message — one tap per parent, no API needed, as you asked. If volume ever gets high enough that you want zero-tap sending, that requires Meta's WhatsApp Business Cloud API (needs business verification), which is a separate project from this one.
