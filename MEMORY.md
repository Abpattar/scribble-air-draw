# MEMORY — Session Handoff

Continuity notes for working on **Scribble Air Draw** (repo `Abpattar/scribble-air-draw`,
previously `scribble-ai`; codebase directory `NeonAir-main`). Read this first
in any new session so nothing is missed.

---

## 1. What this project is

A React + TypeScript + Tailwind web app: point a webcam at yourself, hold up
your hand, and draw in the air — MediaPipe tracks your fingertip as the pen.
Includes stroke rendering, gestures, zoom/pan, a trace-template library,
friends/groups/battles, an admin panel, Clerk auth, MongoDB persistence, and
Razorpay billing.

**Product name is "Scribble Air Draw", NOT "Neon Air Draw".** Legacy codenames
(`NeonAir`, `neonair`, `neon-air-draw`) still exist in some spots; only the
MongoDB database name `neonair` may NOT change (that's where the data lives).

## 2. Current architecture (referenced by file)

- `src/App.tsx` — stage machine: landing → login (Clerk) → nickname → app.
  Owns camera start, hint bar, gallery, modals. Gate helper proxies feature
  checks to `useProfile`.
- `src/lib/engine.ts` — the drawing/hand-tracking engine (MediaPipe `Hands` +
  `Camera`, canvas, gesture state machine, stroke cache, replay/record/video).
  Camera has an idle auto-hibernate (`IDLE_CAMERA_OFF_MS`) and a tap-to-wake
  overlay.
- `src/hooks/useAuth.ts` — Clerk wrapper (`useAuth`, session, idToken helpers).
- `src/hooks/useProfile.ts` — profile persistence + **client entitlement**:
  `entitlementFeatures(isPro, serverFeatures)` forces all Pro features = true
  and gallery limit = -1 whenever `subscribed || subscribedUntil > now`. This
  is what makes a paying user never see locks.
- `src/components/` — `SubscriptionModal` (plan + Razorpay checkout),
  `TemplatesModal` (trace library), `RazorpayModal` (paywall global listener),
  gallery/tools/onboarding/stats/admin/chat/friends modals.
- `api/billing.js` — `?route=` dispatcher for `/api/create-order`,
  `/api/create-subscription`, `/api/verify-payment`, `/api/check-subscription`,
  `/api/cancel-subscription`, `/api/razorpay-webhook`.
- `api/profile.js`, `api/plans.js`, `api/friends.js`, `api/groups.js`,
  `api/competitions.js`, `api/admin.js`, `api/requests.js` — consolidated
  serverless functions. **These 8 files are the whole of `api/`.**
- `api-lib/` — shared server modules imported by the handlers
  (`battle.js` phase machine, `battleStore.js` Mongo reads/writes,
  `catalog.js` plan seeds, `ids.js`, `plans.js`). Deliberately *outside*
  `api/` so Vercel does not turn each one into a function.
- `server/devServer.js` + `server/vercelDevPlugin.js` — local API shim so
  `npm run dev` (Vite on 5173) also serves the real handlers on 8787 and
  proxies `/api` → it. **Handlers are imported ONCE at startup** — after
  editing any `api/*.js` you must restart the dev server.

## 3. Billing model (IMPORTANT — easy to get wrong)

**We use one-time Razorpay Orders, NOT recurring Subscriptions.** Reasons:
- The user pivoted to TEST keys only (no live keys yet; "real one later").
- The Razorpay test account returns **401 on the Subscriptions/plans API** —
  recurring billing is not enabled on the account. Orders API works fine.
- To go recurring later: enable Recurring Payments/Subscriptions in the
  Razorpay dashboard, then re-point the frontend/`createSubscription`.

Order flow (production and local both work):
1. `POST /api/create-order {planId}` → auth required; validates plan via
   `ensurePlans`; saves `pendingPlan` on the profile; returns
   `{ orderId, amount, currency, keyId, plan }`.
2. `SubscriptionModal.startCheckout` opens Razorpay checkout with `order_id`
   seeded from `keyId`, then `handleVerify` calls `POST /api/verify-payment`
   with the Clerk idToken.
3. `verifyPayment` (order branch) resolves plan/period from
   `profile.pendingPlan` (fallback: monthly), sets
   `subscribed, plan, planPeriod, subscribedUntil`, clears `pendingPlan`,
   pushes a payment record. Signature + Clerk identity are both verified.
4. `cancelSubscription` now **ends a subscription immediately**: best-effort
   Razorpay `subscriptions.cancel` (swallowed if the account can't do it),
   then sets `subscribed: false, subscribedUntil: 0, cancelledAt`. Payment
   history is kept. UI confirm text reflects "ends now".

Test card: `4111 1111 1111 1111`, future expiry, any CVV, OTP `1221`.

Webhook handling: `chargedEvents = ['payment.captured','subscription.charged',
'payment.authorized']`, `endedEvents = ['subscription.cancelled','subscription.completed',
'subscription.expired','subscription.paused','subscription.halted']`.

## 4. Environment / keys (keep consistent in 3 places: local `.env` + Vercel prod/preview/dev)

- `VITE_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — Clerk dashboard.
- `MONGODB_URI` — Mongo; DB name `neonair`, collection `profiles`, keyed by
  Clerk user id.
- `RAZORPAY_KEY_ID=rzp_test_TbQovvqgjvtDWT`
- `RAZORPAY_KEY_SECRET=ZWyGczQWgPkHR1YN4EwE3gOi`
- `RAZORPAY_WEBHOOK_SECRET=whsec_scribbleai_test_9f3kLm2Q8x`
- Old dead keys (`rzp_test_S9gk8Rymd2M1` / `kocYfhRUDPdjgD2zW2GM3gel`) were
  removed from Vercel after the 401 fiasco.

**Vercel env gotcha:** `PATCH /v9/.../env` returns 404. Use DELETE existing env
ids then `POST /v10/projects/{id}/env?upsert=true`.

## 5. Known accounts / data (Mongo `neonair.profiles`)

- Paid (the payment worked): `user_3JG4UeVR2X8ZdAatIuCQYMgYVYk` (nickname
  "Diablo"), `subscribed: true`, `plan: monthly`, `subscribedUntil: 2026-10-13`
  (this was reset when he cancelled during testing — verify current state).
- Free test accounts: user `user_3IXmc6awk4o3CIgYn0bcWsP7BrE` and
  `user_3IY4LSKE5a5G9KJ4Q3ijBSGU46g` (both nickname "Aditya").
- Plans live in `plans` collection: `free` (limited), `monthly` ₹99, `yearly`
  ₹999, with correct PRO feature flags.

## 6. What was fixed recently (session log, newest last)

- **`c206152` failed to deploy — Hobby 12-function limit.** Not a code bug: the
  build and all 185 battle checks were green. Vercel counts every `.js` under
  `api/`, and the commit left 8 handlers + 5 files in `api/lib/` = **13**.
  `api/lib/` → `api-lib/` (imports become `../api-lib/…`, including the
  helpers' own `../src/lib/mongodb.js`). `api/` is now exactly the 8 handlers.
  Proof: 8/8 handlers import cleanly, `npm run build` green, all 14 `/api/*`
  routes answer through the real handlers on the dev shim.
- **Submit button did nothing + create-battle 500s:**
  - `CompetitionsModal` Submit was wired to `onSubmit={load}` — a refresh, not
    an upload. Now `DrawingStage.doSubmit()` POSTs `{ action: 'submit',
    strokes }` to `/api/competitions/:id`, stops auto-sync after submit, and
    re-fetches. Verified live (create→submit→detail shows `submittedAt`).
  - Intermittent `FUNCTION_INVOCATION_FAILED` (500) was Vercel Hobby's ~10s
    cap being blown by cold starts on the 3–4-sequential-wave handlers:
    `/api/groups` and `/api/friends` are now **2-wave parallel** like
    `/api/competitions` (profile/suspension read runs in the same wave as the
    first data query; one `$in` profiles query resolves all members+friends).
    Mongo timeouts dropped 8000→5000ms so ops fail fast (503) instead of
    crashing at the cap; `createBattle` in the modal auto-retries once on
    5xx/cold-start ("temporarily unavailable"), never on 4xx.
  - Live after-fix profile (Diablo token): groups ~4.6-6.6s, friends
    ~2.6-4.5s, competitions ~2.6-4.6s cold; all 200, no crashes.
- **Battles 500 / slow (real cause):** Vercel logs showed `MongoNetworkError …
  tlsv1 alert internal error` + Atlas `SystemOverloadedError` on `/api/friends`,
  `/api/groups`, `/api/competitions`. Old `getCompetitions` also ran ~4
  sequential Mongo round-trips × up to 30 battles → broke Vercel Hobby's ~10s
  function cap → flaky 500s. Fixes:
  - `api/competitions.js` rewritten: 2 **wave-parallel** scheme — wave 1 runs
    the profile/suspension lookup + battle read together, wave 2 runs the
    group `$in` + user-membership finds together. Whole handler ≈2 round-trips.
    Never emits a raw 500: top-level try/catch → `503 { error: ... }`.
  - `src/lib/mongodb.js`: `retryReads/retryWrites` + `connectWithRetry()`
    (3 attempts, 500ms backoff) to ride over Atlas free-tier TLS handshake
    drops instead of 500ing.
  - `CompetitionsModal.tsx`: error banner only after ≥2 consecutive failures;
    keeps last-good list on screen; groups-load is silent (optional).
  - `src/hooks/useApi.ts`: a 401 now surfaces "Your sign-in has expired…"
    instead of the raw "Unauthorized: invalid session."
  - Live round-trips after fix: warm ~2.1-3.4s, cold ~5-7s (Atlas shared-tier
    query latency is the floor; verify Hotspot: real token from
    `clerk.sessions.getToken` → `curl /api/competitions`).
- **Camera wake freeze:** `resumeCamera()` used to call `start()` on the same
  MediaPipe `Camera` after `stop()` → stale loop sat on `video.currentTime`
  and never fired frames, so tracking stayed dead while the overlay was gone.
  Fix: rebuild a fresh `Camera` in `resumeCamera()`; added `frameLoopRunning`
  flag (false in `hibernate()`/`destroy()`, true after `start()`); `Camera`
  never auto-hibernates while `camPaused` (template tracing); wake prompt only
  hides when the loop actually restarts (`resumeCamera` returns false
  otherwise).
- **Pro features locked for a paying user:** server entitlement was correct but
  the client gate could report a subscriber as free. Fix: `useProfile.ts`
  trust-the-subscription entitlement (`entitlementFeatures`), applied in both
  `load()` and `refresh()`.
- **Free templates unusable:** `onPickTemplate` in `App.tsx` gated everything
  by Pro. Fix: only non-free templates gate; free templates pickable by
  anyone. `TemplatesModal` (locked = !templatesAllowed) already only locked
  non-free ones.
- **Plan modal "can't cancel" (UX):** `SubscriptionModal` overlay now closes on
  backdrop click (in addition to ✕).
- **Cancel did nothing / errored:** see §3 flow. Now ends the subscription
  immediately and returns a success message.
- **Empty-canvas feedback:** Replay/Record on a blank canvas shows a hint
  ("✍ Draw something first…").
- **Clerk v5 idToken:** modals use `useSession()` (not `useClerk().session`)
  so `/api/verify-payment` and other authed calls always have a token.

## 7. Commits / deployment state

- **Production is two commits behind and the live alias is stale.** The GitHub
  integration IS working (push → `vercel[bot]` deploys automatically), but:
  - `c206152` (battles/requests hub) — **deployment FAILED** on 2026-09-27
    (function count, §6). Fixed by moving `api/lib/` → `api-lib/`.
  - `54efde3` (floating-UI redesign) — deployment succeeded, but
    `scribble-ai.vercel.app` still serves a **pre-redesign** bundle
    (no `My Drawings` / `Brush size` strings in the live JS), i.e. the
    production alias is pinned to an older deployment. Re-pin after the next
    successful deploy, and verify with a string that only exists in the new
    bundle, not just the hash.
- Older: `6b2acbb` (real submit + 2-wave groups/friends + fail-fast Mongo),
  `6dac296` (untrack prompt.txt), `60b886f`, `d5603ea`, `5ee1d50`, `617e09e`,
  `c87c107`, `12cba2c`.
- Live: `https://scribble-ai.vercel.app` (alias pinned manually after every
  deploy; per-deploy URLs look like
  `scribble-xxxxxxxx-adityas-projects-cf1e02fd.vercel.app`). Project id in
  `.vercel/project.json` (`prj_y0H0V26pK6j1aJwF7igTOiIujo1n`, team
  `team_Kxe5J05W0LbH6jFkxmKW1vdE`).
- **The saved Vercel CLI token is dead** (API answers `403 invalidToken` for
  `v2/user`), so `vercel` cannot inspect, deploy or re-pin until you run
  `vercel login` again. GitHub auto-deploy does not need it.
- GitHub CLI (`gh`) is authed as `Abpattar`. To check a push's deploy result
  without the Vercel token:
  `gh api repos/Abpattar/scribble-air-draw/commits/<sha>/status --jq '.statuses[].state'`
  (and `.../commits/<sha>/status` description names the failed deployment id).

## 8. Handy commands

```bash
# local dev (Vite 5173 + local API 8787 via the vite plugin)
node node_modules/vite/bin/vite.js
# (the .bin shims lost their exec bit — always use node node_modules/...)

# typecheck + build
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build

# battle phase-machine proof (185 checks, no deps, fake clock)
node scripts/battle-lifecycle.mjs

# every handler must import cleanly — Vercel bundles each one on its own, so a
# broken path only shows up in the deploy, never in `vite build`
node --input-type=module -e "for (const f of (await import('node:fs')).readdirSync('api')) await import('./api/'+f)"

# function budget: Hobby allows 12; `api/` must hold only the 8 handlers
find api -name '*.js' | wc -l

# stop local servers (note: pkill patterns can match YOUR OWN shell cmdline —
# use exact pids, not pkill -f with a substring you also type)
kill $(cat /tmp/opencode/vite.pid)   # vite + it respawned api? no — kills only vite

# after an API deploy is READY, re-pin the alias:
vercel alias set <deployment-url> scribble-ai.vercel.app
```

## 9. Gotchas / pitfalls

- **Restart dev server after editing `api/*.js` or `api-lib/*.js`** (imports
  cached at startup).
- **`pkill -f '<pattern>'` can kill the shell running the command** if the
  pattern appears in that same command line — prefer `kill <pid>`.
- **Vercel alias is manual** — re-pin after every deploy or the old bundle
  stays live (stale client code makes features look broken). GitHub push also
  triggers a CI Production deploy, so after `vercel deploy --prod` check
  `vercel ls` and pin the **newest** URL (the CLI auto-aliases the throwaway
  `scribble-ai-one.vercel.app`; pin `scribble-ai.vercel.app` explicitly).
- **12-function Hobby limit** — Vercel turns **every `.js` file under `api/`,
  nested or not, into its own function**. So `api/` must contain the 8 handlers
  and nothing else; shared helpers live in `api-lib/`, which is outside `api/`
  and therefore not deployed as a function. Counting only the top-level files
  is what broke production on 2026-09-27 (see §6). Don't add a top-level
  `api/*.js` without folding it into a dispatcher, and don't move a helper back
  into `api/`.
- **Never rename the Mongo database** `neonair`; never commit `*.env` (it's
  gitignored; secrets live only in `.env` + Vercel).
- **`gh` renames the repo** but local `git remote` needs `git remote set-url`
  afterwards; GitHub redirects the old URL so Vercel's repo link keeps working.
- Built bundles change per deploy (`dist/assets/index-*.js`) — verify the live
  bundle hash matches the newest build when diagnosing "works locally, not on
  prod".

## 10. Deferred / next steps

- Enable **Recurring Payments + Subscriptions** in the Razorpay dashboard and
  switch `create-subscription`/recurring flow (or keep orders — user chose
  orders for now).
- Swap in **live Razorpay keys** when ready for real payments (update `.env` +
  Vercel prod/preview/dev).
- Resolve the documented-but-parked paths: recent page asset `/pages/` glue,
  activity/leaderboard wiring, mediapipe model warm-up spinner.
- Test template tracing uses an external background image; confirm
  camera-pause (camPaused) + resume behaviour is polished.
- (User may test cancel flow now on local and confirm the success alert +
  jump back to plan grid.)