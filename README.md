# Saturdays Fantasy — v1

A free, static college-fantasy league site. No build step, no server to run, no monthly bill.

- **index.html** — the app. One file. Open it, edit it, that's the whole front end.
- **config.js** — the two Supabase values you paste in.
- **schema.sql** — the database. Paste into Supabase once.

Total cost: **$0**. Supabase free tier + GitHub Pages.

---

## Setup, once

### 1. Make the database (~5 min)

1. Go to https://supabase.com and sign up (free, no card).
2. **New project.** Name it anything. Pick a region near you. Save the database password
   somewhere — you won't need it for this, but you'll want it later.
3. Wait for it to finish provisioning.
4. Left sidebar → **SQL Editor** → **New query**.
5. Open `schema.sql`, copy all of it, paste it in, press **Run**.
   You should see "Success. No rows returned." It's safe to run again later.

### 2. Point the app at your database (~2 min)

1. Left sidebar → **Project Settings** → **Data API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `config.js` and paste them in, replacing the two placeholders.

Both values are public by design — committing them to a public repo is fine. The rules in
`schema.sql` are what protect your data. The **service_role** key is the dangerous one; never
put that in this file.

### 3. Let people sign in (~2 min)

1. Left sidebar → **Authentication** → **Sign In / Providers**. **Email** should be on.
   Turn **Confirm email** on and leave passwords off — this app uses one-time links.
2. **Authentication** → **URL Configuration** → add your site URL to **Redirect URLs**.
   Add both while you're testing:
   - `http://localhost:8000`
   - your live site's address

   Sign-in links only work for URLs listed here. For this site those are
   `https://saturdaysfantasy.com/` and `http://localhost:8000`.

### 4. Try it on your own machine first

```bash
cd ~/"College Football/saturdays-fantasy"
python3 -m http.server 8000
```

Open http://localhost:8000. Sign in with your email, click the link in the message, and you
should land back on the page signed in. Create a league. You'll get a join code.

> Open `file:///...index.html` directly and sign-in will not work — Supabase needs a real
> `http://` address. The one-line server above is why.

### 5. Put it online (~5 min)

1. Create a GitHub account if you don't have one.
2. New repository, **Public**. This one is `Sneb1/Saturdays-Fantasy`.
3. Upload `index.html`, `config.js` and `schema.sql` (the web uploader is fine — drag them in).
4. Repo → **Settings** → **Pages** → Source: **Deploy from a branch**, branch `main`, folder
   `/ (root)`. Save.
5. Wait a minute. Your site is at `https://YOURNAME.github.io/REPO/`.
6. Add that exact URL to Supabase's **Redirect URLs** (step 3).

**This site lives at https://saturdaysfantasy.com** - a custom domain on top of Pages. That
needs a `CNAME` file in the repo (GitHub writes it when you set the custom domain in Pages
settings) plus DNS: four `A` records on `@` pointing at GitHub's Pages servers
(185.199.108-111.153) and a `CNAME` for `www` to `sneb1.github.io`. On Cloudflare every one of
those must be **DNS only**, not proxied - the orange cloud stops GitHub issuing the HTTPS
certificate.

Send the link and the join code to a friend. When they join, your page updates on its own —
that's the live connection working.

---

## What works now

- Real accounts, by email link
- Creating a league, and a join code to share
- Joining someone else's league
- Everyone in the league sees the same team list, updating live

## What's next

- Move the draft room into this page, with picks stored in the database
- A pick clock that runs server-side, so it can't drift or be edited
- The season: lineups, scoring, standings
- Real Big 12 players instead of invented ones

## Notes

- **Free Supabase projects pause after a week of no activity.** Open the dashboard to wake one
  up. During a season you'll be using it weekly anyway; if it ever gets annoying, the $25/mo
  Pro plan removes it.
- GitHub Pages has no commercial-use restriction, which is why it's the pick here over Vercel's
  free tier.
