# Scribble Air Draw — PRD, System Architecture & Working Document

**Product name:** Scribble Air Draw *(legacy codenames: "NeonAir" / "Neon Air Draw" / `neon-air-draw`)*
**Repo:** `Abpattar/scribble-air-draw` — working directory `NeonAir-main`
**Stack:** React 18 + TypeScript + Vite + Tailwind · Clerk auth · MongoDB (Atlas) · Razorpay billing · Vercel serverless

This document is the single source of truth for *what* the product is, *how* it is built, and *how to work on it*. It is organised in four parts:

- **Part A — Product Requirements** (what we build, for whom, and the acceptance criteria)
- **Part B — System Architecture** (how it is built — client, engine, API, data, billing)
- **Part C — Developer & Operations Guide** (setup, commands, env, deploy, troubleshooting)
- **Part D — API Reference** (every endpoint, route, and payload)

---

# Part A — Product Requirements

## A1. Product overview

Scribble Air Draw turns a webcam into a drawing surface. The user points at the screen and their fingertip becomes a pen; an open hand draws, a peace sign moves/pans the canvas, and a fist stops. Drawings persist to the user's account, can be traced over templates, replayed, recorded, exported, and shared socially through friends → groups → group **battles** (mini competitions). A freemium model gates Pro features behind a paid plan processed by Razorpay. Admins manage users, content, and pricing from an in-app admin panel.

The app is browser-only, mobile-first, kid-friendly ("big buttons, fun colours"), and designed to require no stylus, mouse, or setup.

## A2. Goals & non-goals

### Goals
1. Deliver a delightful **hands-free drawing experience** with low-latency stroke feedback (the "neon" glow rendering).
2. Persist every stroke server-side (MongoDB) so drawings survive across sessions and devices.
3. Monetise via a simple **one-time-payment Pro plan** (₹99/month, ₹999/year) that is fully rights-managed (not hard-coded) by an admin.
4. Provide a **social loop**: friends → groups → timed drawing battles with voting and leaderboards.
5. Stay within free-tier constraints: Vercel Hobby (12 serverless functions), MongoDB Atlas, Razorpay test keys.
6. Be **safe for children**: optional nickname, no free-text feeds, admins can suspend/clear users, camera auto-hibernates (privacy + battery).

### Non-goals
- Native mobile apps (no React Native / capacitor).
- Recurring auto-billing for now (Razorpay Recurring API is disabled on the test account — see B8.5).
- Real-time multiplayer co-drawing (battles are asynchronous within a time window, not live).
- Server-rendered SEO pages (single SPA behind `/index.html` rewrite).
- Video storage (recorded replays are client-side `.webm` downloads).

## A3. Personas

| Persona | Description | Key needs |
|---|---|---|
| **Young artist** (primary) | Kids ~5-12 who draw in the air | Huge buttons, bright colours, instant feedback, no menus |
| **Parent / teacher** | Monitors usage, may pay | Safety, privacy (camera off when idle), low cost, no data leaks |
| **Casual free user** | Tries free tier | 3-slot gallery, free trace templates, ability to join battles |
| **Pro subscriber** | Pays for full features | Unlimited gallery, templates, replay, record, transparent export, background images, start battles |
| **Admin / Superadmin** | Operator of the app | Overview KPIs, user moderation (suspend/clear), plan & feature management, billing visibility |

## A4. Feature catalogue & entitlement gating

The app is gated by **features**, not by price checks. Every plan in MongoDB has a `features` map. The server computes a user's entitlement on every profile read; the client mirrors it locally so locks render instantly even offline.

| Feature key | Label | Free | Pro |
|---|---|---|---|
| `templates` | Trace template library | ❌ (2 free) | ✅ |
| `background_images` | Import your own background image | ❌ | ✅ |
| `export_transparent` | Transparent PNG export | ❌ | ✅ |
| `replay` | Replay your drawing | ❌ | ✅ |
| `record` | Record & save your drawing | ❌ | ✅ |
| `battles` | Start group battles | ✅ | ✅ |
| *gallery* | Saved drawings | 3 max | Unlimited |

**Rules:**
- A user is *Pro* when `subscribed === true` **or** `subscribedUntil > now`.
- Free-tier fallback `FREE_TIER_FEATURES` is duplicated client-side (`src/hooks/useProfile.ts`) and server-side (`api-lib/catalog.js`) so both agree even before the DB is reachable.
- **Client entitlement trust**: if a profile reports a paying subscription but the server plan lookup hiccups, the client force-unlocks everything for that user (`entitlementFeatures`). The server remains the source of truth for writes.
- The first two templates alphabetically are marked `free: true` and are pickable by anyone.

## A5. Functional requirements

### FR-1 · Onboarding & authentication (Clerk)
1. First-ever visit shows the **landing page**; after a logout, the next visit goes straight to **login**.
2. Sign-in is a Clerk-hosted flow (email/password or Google) styled to the app palette.
3. New users (no nickname) are routed to the **nickname screen**; nickname+email is persisted before entering the studio.
4. Auth state machine: `boot → landing | login → nickname → app` (and `app → admin`). Stages: `boot, landing, login, nickname, welcome, app, admin`. *(The `welcome` stage is rendered but never staged by the current code — a documented-but-parked path.)*

### FR-2 · Drawing studio (webcam → canvas)
1. On entering the app the MediaPipe hand model + camera start behind a load overlay with progress messages.
2. The fingertip (index landmark 8) is mirrored to screen space; drawing follows it with smoothing.
3. Stroke rendering is the "neon" layered glow (see B4).
4. Right = "draw" gesture, Peace = pan/move, Fist = stop (see FR-3).
5. A cursor dot shows fingertip position with the current tool colour.

### FR-3 · Gesture state machine
| Gesture | Detection | Behaviour |
|---|---|---|
| Draw | index up, middle down, ring+pinky down | freehand ink, or drag out shapes, or bucket-fill tap |
| Peace | index+middle up, ring+pinky down (4-frame confirm) | pan canvas, or grab+drag a nearby stroke, or start a bucket-fill... (serves as move/select) |
| Fist / none | all fingers down | immediately commit current stroke; no stroke is drawn |

- No-hand grace: `HAND_MISS_GRACE_FRAMES = 6` frames before a stroke is committed after the hand leaves.
- Idle timeout: after `IDLE_CAMERA_OFF_MS = 45s` without a hand and camera **not** paused → camera **hibernates** (releases webcam for privacy/battery). A "😴 tap to wake" chip appears; tapping rebuilds a fresh MediaPipe `Camera` (the old one can stall on a stale `video.currentTime`).

### FR-4 · Tools & controls
- **Freehand, Line, Circle, Rectangle, Bucket-fill** (`ToolType`).
- 12 colour swatches + a custom colour picker.
- Eraser (destructive `destination-out`), gradient stroke (hue-rotate 140°, per-segment colour interpolation), brush size slider (0.5–40).
- Undo (pop last stroke), Clear all.
- **Zoom/pan**: pinch via… zoom buttons ±25% (0.25×–6×), reset, panning by peace gesture; a zoom % flash badge.
- **Canvas modes**: live camera mirrored + PiP, white "whiteboard" mode with PiP, paused-camera with background image (template trace), or frozen frame when the camera is merely toggled off.
- **Export**: PNG download (`neon-<name>-<ts>.png`), optional transparent background (Pro).
- **Replay** (Pro): stroke-by-stroke animation; **Record** (Pro): `MediaRecorder` over `canvas.captureStream(30)` → `.webm` download.
- Empty-canvas feedback: hint "✍ Draw something first, then hit replay/record".

### FR-5 · Gallery & persistence
1. Drawings live as `{ name: Stroke[] }` on the profile document; saved debounced (800 ms) after any stroke change.
2. All drawing operations (new, switch, rename, duplicate, delete, favourite) update React state and then schedule a save.
3. Gallery limit: free users get `galleryLimit` (3) — trying to exceed opens the plan modal ("Free keeps 3 drawings…"). Pro = unlimited (−1).
4. **Version history**: every save pushes a snapshot `{ ts, strokes }`; max 10 per drawing; any snapshot can be restored (with confirm).
5. New sessions always open a blank drawing (auto-unique "Untitled"/"Untitled 2"…); saved drawings stay browsable in the gallery.
6. Save status chip: `Saving… → Saved ✓ / Save failed`.

### FR-6 · Trace templates (Pro, 2 free)
1. Template images live in `Subscription/<Category>/*.{jpg,jpeg}` and are auto-discovered at build time (`import.meta.glob`).
2. Categories today: **Cartoons, Fruits, Scenery, Vegetables**.
3. Picking a template pauses the camera and draws the outline as the background to trace over ("✕ Remove image" to return to live feed).
4. Locked (non-free) templates blur + show a lock; clicking routes to the Subscription modal.

### FR-7 · Friends (free)
1. Add by email or nickname; requests are directional pending → accepted.
2. If the target already sent you a request, adding accepts it instantly.
3. Friend request counter is polled every 25 s and shown as a badge on the gallery's Friends button.
4. Unfriend, cancel outgoing, decline incoming all supported.

### FR-8 · Groups (free)
1. Create groups of friends (max ~8 members, only accepted friends can be invited).
2. Group has: name, emoji avatar, admin (creator), `wins`/`played` leaderboard counters.
3. Admin-only: rename, invite friends, remove members, delete group.
4. Members can leave; if the admin leaves, ownership transfers; a group with 1 member auto-deletes (with its battles).

### FR-9 · Battles / Competitions
1. Two groups challenge each other with a prompt (custom or random from `BATTLE_PROMPTS`).
2. **Drawing window** = 5 minutes: each member draws on their own canvas; strokes auto-sync to the battle every ~5 s (`action: sync`); submitting locks the entry.
3. **Voting window** = 3 minutes: everyone votes A or B; one vote per user.
4. **Closed**: votes are tallied lazily on first read after the deadline (`settle`) — winner = plurality; ties are possible. Winner's group gets `wins+1`; both get `played+1`.
5. `active` (drawing/voting, max 12) and `recent` (closed, max 12) lists; battle detail polls every 8 s.
6. Starting battles is Pro-only (`battles` feature); joining/voting is open to free users.

### FR-10 · Plans & subscription (Razorpay)
1. Plan catalogue is DB-driven (`plans` collection), seeded with `free`, `monthly` (₹99), `yearly` (₹999). Public catalogue also served by `/api/plans`.
2. Checkout flow (see B8) — one-time order, signature-verified, marks profile subscribed with `plan`, `planPeriod`, `subscribedUntil`, and a payment record.
3. Subscriber view shows active plan, expiry date, and payment history; **Cancel** ends access immediately (one-time payments don't auto-renew), keeping history. UI confirm implies "ends now".
4. Admin errors must never break rendering: plan UI falls back to seeded defaults when `/api/plans` is unreachable.

### FR-11 · Admin panel
| Tab | Access | Contents |
|---|---|---|
| Overview | admin+ | Users, drawings, groups, battles, subscribers, revenue (₹), payments, played-battles cards; new users list; recent battles |
| Users | admin+ | List (200), view a user's drawings (rendered mini-canvases), suspend/reinstate, clear content, **role change (superadmin-only)** |
| Billing | admin+ | All payments flattened with cumulative total; **cancel subscription (superadmin-only)** |
| Content | admin+ | Groups & battles list; delete group (+ its battles) / delete battle |
| Plans | **superadmin** | Add/edit/remove plans, toggle per-plan features + gallery limit + active (these gate the app live) |

- Superadmin bootstrap: profile whose `email` matches `SUPERADMIN_EMAIL` is auto-promoted on every profile read. Fallback CLI: `node server/promote.js <email> <role>`.
- A plan with active subscribers cannot be deleted (409).

### FR-12 · Safety & moderation
- Suspended users are rejected server-side (`requireUser` null even with a valid JWT).
- Server-only fields (`subscribed`, `role`, `payments`, …) are stripped from any client write (`SERVER_ONLY`).
- Role checks: `requireRole(request, 'admin', 'superadmin')` etc. Suspension and role fields are never writable by the client.

## A6. Primary user flows

**First-time user**
```
Landing → Get Started → Clerk Sign-In → Nickname → Studio (load overlay → draw)
```

**Returning user**
```
Login (Clerk) → profile load → Studio (blank canvas; gallery shows saved drawings)
```

**Upgrade to Pro**
```
Gallery → "My Plan" (or a feature lock → plan modal) → choose ₹99/month or ₹999/year
→ /api/create-order → Razorpay Checkout (test card 4111 1111 1111 1111 / any expiry / any CVV / OTP 1221)
→ /api/verify-payment → "Payment successful — Pro unlocked!" → profile refresh
```

**Battles**
```
Gallery → Groups → (create group with friends) → Challenge (⚔️ on a group, or Battles → create)
→ both groups draw the prompt for 5 min (auto-sync) → submit → voting 3 min → winner & leaderboard updated
```

**Admin**
```
Gallery → Admin Panel → overview / users / billing / content / plans (superadmin) → back to studio
```

## A7. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Neon stroke caching (off-screen cache canvas) keeps pan/zoom and re-render under a frame; bucket-fill capped at 60% of pixels to avoid hangs |
| Latency | Interaction feedback is sub-frame; MediaPipe runs at 1280×720 max 1 hand, modelComplexity 1 |
| Privacy | Camera auto-releases after 45 s idle; camera grants requested at runtime; no images stored server-side (strokes only) |
| Auth security | Every API call verifies the Clerk JWT server-side; caller uid is never trusted; webhook validates Razorpay HMAC; payment verifies signature + Clerk identity |
| Data durability | Drawings persisted to MongoDB; debounced saves; history keeps 10 snapshots |
| Failure tolerance | Plans, entitlement, and gallery degrade gracefully when Mongo/Razorpay are down (seeded defaults, no 500s on reads) |
| Cost constraint | ≤ 12 Vercel serverless functions (Hobby); consolidated dispatchers enforce this |
| Compatibility | Modern evergreen browsers with webcam + WebGL2 (background shader no-ops gracefully); MediaRecorder webm (VP9 w/ fallback) |

---

# Part B — System Architecture

## B1. Context (high level)

```
                     ┌────────────────────────────  BROWSER  ────────────────────────────┐
                     │  React SPA (Vite, dist/)                                          │
                     │  ┌──────────────────────┐   ┌────────────────────────────────┐   │
                     │  │  UI / components     │   │  DrawEngine (class, plain TS)   │   │
                     │  │  App stage machine   │──▶│  - MediaPipe Hands + Camera     │   │
                     │  │  Panel/Gallery/Modals│   │  - gesture state machine        │   │
                     │  └──────────┬───────────┘   │  - neon renderer + stroke cache │   │
                     │             │ useApi/useAuth│  - zoom/pan/fill/replay/record   │   │
                     │             ▼              └────────────────────────┬─────────┘   │
                     │        /api (fetch, Bearer <Clerk JWT>)            │ webcam/MediaPipe│
                     └─────────────┬───────────────────────────────────────┼─────────────┘
                                  │ HTTPS                                  │ CDN scripts
                                  ▼                                        ▼
            ┌──────────────────────────────────────┐             npm/@mediapipe/hands + camera_utils
            │  VERCEL  (serverless, Hobby ≤12 fns)  │
            │  ─ dispatchers: profile, plans,       │
            │    billing(?route=), friends,         │
            │    groups, competitions, admin        │
            └───────┬───────────────┬──────────────┘
                    │               │   Razorpay webhook (HMAC signed)
                    ▼               ▼
              ┌───────────┐  ┌────────────┐
              │  MongoDB  │  │  Razorpay  │
              │ (neonair) │  │ (test)     │
              └───────────┘  └────────────┘
                       Auth: Clerk (frontend SDK + backend verifyToken)
```

## B2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Build tool | Vite 5 + `@vitejs/plugin-react` | `manualChunks` splits all `node_modules` into one `vendor` chunk |
| Runtime | React 18 + TypeScript (strict off) | Single SPA |
| Styling | Tailwind 3 + hand-rolled CSS vars (`src/index.css`) | `--accent`, `--kid-*` palette; light/dark via `body.dark` |
| Animations | framer-motion | modal enter/exit, landing scroll reveals |
| Icons | lucide-react | |
| State | Local hooks only (no redux) | `useProfile`, `useApi`, `useAuth`; App owns stage + modal state |
| Hand tracking | MediaPipe `hands` + `camera_utils` (CDN, jsdelivr→unpkg→jsdelivr fallbacks) | 1 hand, modelComplexity 1 |
| Auth (client) | `@clerk/clerk-react` v5 (`useUser`, `useSession`, `useClerk`) | Covers `main.tsx` whole app |
| Auth (server) | `@clerk/backend` `verifyToken` | JWT → Clerk user id |
| Database | `mongodb` driver v7 | Lazy connect, 5 s timeouts |
| Billing | `razorpay` package | Orders API (one-time); Recurring parked |
| Payments fallback | `stripe` package present (unused legacy dep) | |
| Hosting | Vercel (Hobby) | `vercel.json` rewrites + build command |

## B3. Client architecture

### B3.1 Entry & provider tree
- `index.html` → `src/main.tsx` renders `<ClerkProvider publishableKey=…><App/></ClerkProvider>`. Missing key throws early.
- `vite.config.ts` registers the `vercelDevApi()` plugin, which spawns the local API server (see B7).

### B3.2 App stage machine (`src/App.tsx`)
`App` owns the full-screen stage and the one-and-only `DrawEngine` instance (canvas refs + camera ref):

```
Stage: 'boot' → 'landing'/'login' → 'nickname' → 'app' → 'admin'
```

Behaviours keyed to stage:
- Camera starts when stage hits `'app'`; `hibernate()` when leaving.
- Friend-request badge polls only in `'app'`.
- All feature gates funnel through `gate(featureKey, reason)` → opens the plan modal.
- On any stroke commit, `onStrokesChanged` bumps `strokesTick` and calls `profile.scheduleSave(engine)`.

### B3.3 Hooks
| Hook | Responsibility |
|---|---|
| `useAuth` | Wraps Clerk into `{ user: AppUser \| null \| undefined, logout }`; stable memoised `user` so effects don't re-fire |
| `useProfile` | Profile persistence + client entitlement. Loads/refreshes profile, owns drawings/favorites/history maps, gallery limit, all drawing CRUD, debounced save, `saveStatus` |
| `useApi` | Authenticated fetch helper: injects `Authorization: Bearer <session JWT>`, JSON-in/out, throws `Error(data.error)` on non-2xx |

### B3.4 Components
| Component | Role |
|---|---|
| `LandingScreen` | Marketing hero / how-it-works / features / pricing; WebGL2 shader background |
| `LoginScreen` | Clerk `<SignIn routing="virtual">` styled white-card over shader |
| `StageOverlays` | `NicknameScreen`, `WelcomeScreen`, `LoadOverlay` (progress %) |
| `Panel` | Collapsible tools rail: colour, tool, size, eraser/undo/clear, zoom, media, export, replay/record, theme; scroll buttons |
| `GalleryPanel` | Drawing list w/ search, favorites, rename/dup/delete, new drawing, template picker, friends/groups/battles/plan/profile/stats/history/admin/logout |
| `TemplatesModal` | Trace library grid grouped by category; free templates shown, others blurred+locked → SubscriptionModal |
| `SubscriptionModal` | Plan grid → Razorpay checkout → verify → success; subscriber view w/ history + cancel |
| `RazorpayModal` | *(legacy, unused)* standalone checkalot-style checkout — not imported |
| `Modals` | `StatsModal`, `HistoryModal`, `ProfileModal` |
| `FriendsModal` | Add by email/nickname; friends / requests / outgoing tabs |
| `GroupsModal` | Create groups, manage, challenge entry point |
| `CompetitionsModal` | Live/create/results; battle detail w/ drawing/voting/closed stages, auto-sync, poll |
| `AdminPage` | Full admin console (overview/users/billing/content/plans) |
| `AnimatedShaderBackground` | WebGL2 fbm-noise coral/violet shader, pointer-reactive, graceful no-op |

## B4. Drawing engine internals (`src/lib/engine.ts`, ~1200 lines)

The engine is a **plain TS class** — React only creates it, calls its public methods, and listens to callbacks. No hooks/React state inside.

### B4.1 Canvases & coordinate model
- `bgCanvas` — webcam frame / background / PiP.
- `drawCanvas` — stroke layer (neon rendering).
- `strokeCache` (off-screen canvas) — cached composited strokes at a given zoom so pan/zoom renders instantly (`fastComposite` drawImage at offset; rebuilds only when scale changes).
- **World ↔ screen transform**: `viewScale`, `viewOffX/Y`. Strokes store *world* coordinates + per-stroke offsets `ox/oy` (world units) so a dragged stroke pans/zooms with everything else.

### B4.2 MediaPipe loop
- `start()`: (1) load `camera_utils.js` → (2) load `hands.js` → (3) `getUserMedia` (front cam 1280×720) → (4) wait for `loadedmetadata` → (5) build `Hands` (maxNumHands 1, minDetection 0.8, minTracking 0.75) → (6) start `Camera` loop (`hands.send({image: cam})`).
- Every script load has 2–3 CDN fallbacks + a friendly progress message on failure.
- `onResults(results)`: paints background, reads `multiHandLandmarks[0]`, mirrors index tip `(1-x, y)`, smooths (`SMOOTH=5` weighted history), classifies gesture, drives the state machine.
- **Hibernation**: 45 s with no hand (`!camPaused`) → `hibernate()` stops tracks + camera; `resumeCamera()` re-requests the stream and **recreates a fresh `Camera`** (documented fix for stale-frame stall). `frameLoopRunning` guards duplicates; wake chip persists until frame loop restarts.

### B4.3 Gesture classification
```
fingerUp(tip,pip) : lm[pip].y - lm[tip].y > handScale * 0.22
fingerDown(...)  : lm[tip].y - lm[pip].y > handScale * 0.132
getGesture:  fist(all down)→none; index+middle up & ring+pinky down→peace; else→draw
```
- Peace requires `PEACE_CONFIRM_FRAMES=4` (debounce vs draw). Fist cuts instantly.
- `commitActiveStroke` / `commitShape` fire on hand loss after grace, on switch to peace, or on fist.

### B4.4 Stroke data model (JSON-serialisable — saved to Mongo)
```ts
interface Stroke {
  type: 'freehand'|'line'|'circle'|'rect'|'fill';
  pts?: Pt[];          // freehand polyline (world coords)
  a?, b?: Pt;          // shape anchor + live corner
  col: Color; col2?: Color|null;  // gradient end colour
  size: number; erase: boolean;
  ox, oy: number;      // world-space offset after dragging
  imgSrc?: string;     // fill patches: small PNG data URL, rasterised in world space
  wx,wy,ww,wh?: number; // fill patch world rect
}
```

### B4.5 Rendering
- **Neon stroke** (`neonSeg`): 4-pass draw — wide faint glow (α0.06) → mid glow (α0.30 w/ shadowBlur) → core colour line → white specular core. Eraser uses `destination-out`.
- **Fill tool** (`doFill`): flood-fill on live pixels (alpha ≥ 40 = boundary; ≥ 60% of canvas → "shape isn't closed"), rasterises the reached region to a small PNG `dataURL` patch stored in world coords — so fills pan/zoom like everything else, and strokes stay plain JSON.
- `strokeRenderer.ts` mirrors the neon renderer onto plain canvases (identity transform, auto-fit bounds) for battle entries + admin previews.

### B4.6 Export / replay / record
- `exportPNG`: composites onto black (or transparent when `transparentExport`) → `neon-<name>-<ts>.png`.
- `replay`: animates strokes back in order via rAF.
- `record`: `canvas.captureStream(30)` + `MediaRecorder` (vp9 → fallback) + `replay` → `.webm` download on stop.

## B5. Serverless API architecture

**Constraint:** Vercel Hobby = **12 serverless functions max**. Solved by consolidating *every* legacy route into **8 top-level handlers** — which is all `api/` may contain; `vercel.json` rewrites translate old URLs into `?route=` dispatchers.

```
api/profile.js        profile read/write (drawings, favorites, history, nickname, bio, subscription)
api/plans.js          public plan catalogue (never 500s — seeds on failure)
api/billing.js        ?route=create-order|create-subscription|verify-payment|check-subscription|cancel-subscription|webhook
api/friends.js        friend graph + pending-request count
api/groups.js         group CRUD (+ :groupId actions)
api/competitions.js   battle list/create (+ :competitionId sync|submit|vote, lazy settle)
api/admin.js          ?route=overview|users|user|billing|plans|plan|group|competition
```

Shared helper modules live in **`api-lib/`**, *outside* `api/`, because Vercel turns every `.js` file under `api/` — nested or not — into its own Serverless Function and would blow the limit.

The **Vercel rewrite table** (`vercel.json`) maps each legacy path to a dispatcher, then falls back `(.*)` → `/index.html` (SPA). `dist/` is the output directory; build = `tsc -b && vite build`.

**Request/response conventions:** serverless handlers receive `request/response` (Express-style). `requireUser`/`requireUserId`/`requireRole` (in `src/lib/serverAuth.js`) verify the `Authorization: Bearer <JWT>` via Clerk.

## B6. Data model (MongoDB `neonair`)

### Collections

**`profiles`** — keyed `_id = Clerk userId`
```js
{
  _id: string,               // Clerk user id
  nickname?: string, email?: string, bio?: string, avatar?: string,
  drawings: { "<drawing name>": Stroke[] },
  favorites: { "<name>": boolean },
  history:  { "<name>": [{ ts, strokes: Stroke[] }] },  // ≤10 per drawing
  current?: string,
  role: 'user'|'admin'|'superadmin',           // server-controlled
  subscribed: boolean, plan?: string, planPeriod?: 'monthly'|'yearly',
  subscribedUntil?: number, subscriptionId?: string,
  pendingPlan?: string, cancelledAt?: number,
  payments: [{ paymentId, orderId?, subscriptionId?, amount, currency, plan, ts, status }],
  suspended: boolean, createdAt, updatedAt
}
```
*Row-level rules:* `SERVER_ONLY` fields can never be written by the client; a matching `SUPERADMIN_EMAIL` auto-promotes to `superadmin` on read.

**`friendships`** — pairwise, normalised `userA < userB`
```js
{ _id, userA, userB, status: 'pending'|'accepted', actionUserId, createdAt, respondedAt? }
```

**`groups`**
```js
{ _id: ObjectId, name, emoji, adminId, memberIds: [], wins: 0, played: 0, createdAt }
```

**`competitions`**
```js
{ _id: ObjectId, prompt, groupA, groupB, createdBy, createdAt,
  drawEndTime, voteEndTime,            // now+5m, now+8m
  entries: { "<groupId>": { strokes: Stroke[], updatedAt, submittedAt } },
  votes: { "<userId>": "<groupId>" }, winner: null|groupId, closedAt: null }
```

**`plans`** — seeded on demand (`ensurePlans`, `$setOnInsert`, never breaks a request)
```js
{ id: 'free'|'monthly'|'yearly'|..., label, amount(₹), price(paisa), period, interval,
  totalCount, features: {templates,background_images,export_transparent,replay,record,battles},
  galleryLimit: 3|-1, free, active, description, createdAt?, updatedAt? }
```

### Entitlement computation (server side)
`entitlementFor(profile)` → if `profile.plan` exists in `plans` **and** `subscribedUntil > now` → that plan's features; otherwise the `free` plan. Attached to every profile GET as `profile.features` + `profile.galleryLimit`. Client mirrors it (`entitlementFeatures`) and **overrides everything to Pro when a user is a paid subscriber**, so a transient catalogue hiccup never locks out a payer.

## B7. Local development parity (`server/`)

`npm run dev` → Vite (5173) with a plugin (`server/vercelDevPlugin.js`) that:
1. Finds a free port ≥8787, spawns `server/devServer.js`.
2. Proxies every `/api/*` request from Vite to that port.

`server/devServer.js` loads `.env.local`/`.env`, then **mounts the same `api/*.js` handlers** with an Express-like shim (`request.body/query/rawBody`, `response.status/json`), including parameterised paths (`/api/groups/:groupId` etc.). So profiles, drawings, billing, friends, groups, competitions behave exactly like production locally.

> ⚠️ Handlers are imported **once at startup**. Editing any `api/*.js` requires restarting the dev server (the Vite plugin kills the child on close).

## B8. Billing architecture (Razorpay)

### B8.1 Model decision — Orders, not Subscriptions
One-time Razorpay **Orders**. (The Razorpay test account returns **401 on the Subscriptions/plans API**, so recurring is disabled; Orders works.) Recurring is a documented later step (enable Recurring Payments in the Razorpay dashboard, flip `create-subscription`).

### B8.2 Checkout flow
```
User clicks Subscribe (plan)
  → POST /api/create-order {planId}
     · requireUser (Clerk JWT) · ensurePlans · plan must be active & paid
     · razorpay.orders.create(amount = plan.price paise, currency INR, notes)
     · profile.pendingPlan = plan.id
     · returns { orderId, amount, currency, keyId, plan }
  → frontend loads checkout.razorpay.com/v1/checkout.js (once)
  → new Razorpay({ key:keyId, order_id, amount, currency, prefill, handler })
     · handler(response) → POST /api/verify-payment { razorpay_*, idToken }
       1. HMAC signature check (sha256, timingSafeEqual)
       2. verifyToken(idToken) → REAL userId
       3. resolve plan from profile.pendingPlan (fallback monthly), PERIOD_MS
       4. set subscribed:true, plan, planPeriod, subscribedUntil=now+period, pendingPlan:null
       5. push payment record
     · verified → onSubscribed() → profile.refresh() → success step → close
```
Test card: `4111 1111 1111 1111`, future expiry, any CVV, OTP `1221`.

### B8.3 Cancel
`POST /api/cancel-subscription` → best-effort `razorpay.subscriptions.cancel(...)` (swallowed if impossible) → set `subscribed:false, subscribedUntil:0, cancelledAt`. History stays. UI wording: "cancelling ends your Pro access now".

### B8.4 Webhook reconciliation
POST `/api/razorpay-webhook` validates `x-razorpay-signature` against `RAZORPAY_WEBHOOK_SECRET` (invalid → 200-ignore). `chargedEvents = ['payment.captured','subscription.charged','payment.authorized']`, `endedEvents = ['subscription.cancelled|completed|expired|paused|halted']`. Finds profile by `subscriptionId`; adds payments (deduped by `paymentId`) / flips `subscribed`.

### B8.5 Keys
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` (server-only). The key id may also be fed from `VITE_RAZORPAY_KEY_ID` for backwards compat. Never prefix secrets with `VITE_`.

## B9. Authentication & authorization model

1. **Tier 0 — identify:** any `api/*` handler can call `requireUserId(request)` → returns Clerk `sub` or `null`.
2. **Tier 1 — authenticate:** `requireUser` → user id + profile; returns `null` if no profile or `suspended`.
3. **Tier 2 — authorize:** `requireRole(request, ...roles)`.
4. **Profile writes:** client can never set `SERVER_ONLY` fields (server strips them before upsert).
5. **Admin actions:** role changes = superadmin only; cannot demote self; suspended users blocked globally.
6. `profile.js` GET auto-promotes `SUPERADMIN_EMAIL`.

## B10. Ports / hosts / infra map

| Asset | Value |
|---|---|
| Vite dev | `http://localhost:5173` |
| Local API | `http://127.0.0.1:8787+` (auto-picked free port) |
| Prod alias | `https://scribble-ai.vercel.app` (manual re-alias after deploy) |
| Vercel project | `scribble-hcfo26h6q-adityas-projects-cf1e02fd.vercel.app` |
| GitHub | `Abpattar/scribble-air-draw` |
| DB | MongoDB Atlas, cluster `cluster0`, DB `neonair` |
| CDN | jsdelivr/unpkg for MediaPipe |
| Checkout | `https://checkout.razorpay.com/v1/checkout.js` |

---

# Part C — Developer & Operations Guide

## C1. Prerequisites
- Node 18+ (Vite 5, ESM).
- A webcam (browser grants at runtime).
- Accounts: Clerk dashboard, MongoDB Atlas, Razorpay (test), Vercel (CLI authed), GitHub (optionally `gh`).

## C2. Setup
```bash
npm install
cp .env.example .env        # then fill values (see C3)
npm run dev                 # Vite 5173 + local API; open http://localhost:5173
```
> Note from MEMORY.md: the `node_modules/.bin` shims have lost their exec bit — always run scripts through
> `node node_modules/<pkg>/bin.js` directly when needed (the classic `npm run dev` works via `vite` script in package.json unless the shim is broken on the host).

## C3. Environment variables

| Variable | Used by | Where | Notes |
|---|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | browser (ClerkProvider) | browser bundle | safe to expose |
| `CLERK_SECRET_KEY` | `serverAuth.js`, billing | server | verify JWTs |
| `MONGODB_URI` | `mongodb.js` | server | DB name `neonair` is hardcoded — never rename |
| `RAZORPAY_KEY_ID` | billing | server | may also come from `VITE_RAZORPAY_KEY_ID` |
| `RAZORPAY_KEY_SECRET` | billing | server | |
| `RAZORPAY_WEBHOOK_SECRET` | billing webhook | server | |
| `SUPERADMIN_EMAIL` | `profile.js`, `promote.js` | server | auto-promote matching email (in `.env`, not `.env.example`) |

Keep the **same values in three places**: local `.env` + Vercel (Production, Preview, Development). Browser only ever sees `VITE_CLERK_PUBLISHABLE_KEY`.

## C4. Commands

```bash
# dev (Vite 5173 + local API /api)
npm run dev

# typecheck + build
npm run build                 # tsc -b && vite build → dist/

# local preview of the build
npm run preview

# superadmin bootstrap fallback
node server/promote.js <email> <role|user|admin|superadmin>
```

## C5. Testing payments locally
1. Open the plan modal (Gallery → "My Plan").
2. Choose Monthly/Yearly → Razorpay checkout loads.
3. Use `4111 1111 1111 1111` / any future expiry / any CVV / OTP `1221`.
4. Expect: success step, Pro unlocked, payment history row appears, gallery becomes unlimited.
5. Cancel: My Plan → Cancel subscription → confirm → access ends immediately (history retained).

## C6. Deployment (Vercel)
1. `git push` to `main` → auto-deploy triggered (framework `vite`, build `npm run build`, output `dist`).
2. **Manually re-pin the alias after every deploy** (aliases are not automatic):
   ```bash
   vercel alias set <deployment-url> scribble-ai.vercel.app
   ```
3. Per-deploy URLs (fed from project settings) are also live.
4. Verify bundle hash `dist/assets/index-*.js` matches the deployed bundle when prod "looks stale".
5. Known Vercel env API gotcha (from MEMORY.md): `PATCH /v9/.../env` returns 404 — DELETE the env ids, then `POST /v10/projects/{id}/env?upsert=true`.

## C7. Known accounts / data (for testing)
- Paid test user: `user_3JG4UeVR2X8ZdAatIuCQYMgYVYk` ("Diablo") — paid monthly once; status may now be cancelled.
- Free test accounts: `user_3IXmc6awk4o3CIgYn0bcWsP7BrE`, `user_3IY4LSKE5a5G9KJ4Q3ijBSGU46g` (both "Aditya").
- Plans seeded: `free`, `monthly` ₹99, `yearly` ₹999.
- Superadmin email: see `SUPERADMIN_EMAIL` in local `.env`.

## C8. Troubleshooting & gotchas (session-proven)

| Symptom | Cause / fix |
|---|---|
| API returns SPA HTML on `/api` in dev | Dev API not running (plugin child died). Restart `npm run dev`. |
| Editing `api/*.js` has no effect locally | Handlers are imported once at startup — **restart the dev server**. |
| Feature locks even after paying | Entitlement is client-computed; re-login or trigger `profile.refresh()`; verified fix in `useProfile.ts`. |
| Camera "wake" hides chip but tracking stays dead | Old `Camera` stall on stale `video.currentTime`; `resumeCamera()` now rebuilds a fresh `Camera`. |
| Free templates all locked | Only the first 2 templates are `free:true`; others are Pro by design. |
| Cancel did nothing | One-time orders have nothing to cancel recurring; `cancelSubscription` now ends locally and reports success. |
| Webhook → 500 "secret missing" | `RAZORPAY_WEBHOOK_SECRET` not set. |
| Razorpay 401 on subscribe | Recurring API disabled on the test account → Orders flow is the intended path. |
| `pkill -f '<pattern>'` kills my own shell | Prefer `kill <pid>`; pattern matching can hit the shell running the command. |
| Vercel alias stale | Aliases are manual — re-pin after deploy. |
| New `api/*.js` count > 12 | Hobby limit — fold routes into the existing dispatchers (never add top-level files). |
| "Save failed — API unavailable" | You're on plain `vite dev` without the plugin/dev server. |

## C9. File map

```
NeonAir-main
├── index.html · vite.config.ts · tsconfig.json · tailwind.config.js · postcss.config.js
├── vercel.json                     # rewrites → ?route= dispatchers + SPA fallback
├── api/                            # 8 serverless handlers + shared lib
│   ├── profile.js  plans.js  billing.js  friends.js  groups.js  competitions.js  admin.js
│   └── lib/        catalog.js (plans/entitlement seeds) · plans.js (PERIOD_MS) · battle.js (constants)
├── src/
│   ├── main.tsx  App.tsx  index.css
│   ├── lib/      engine.ts (hand-tracking engine) · strokeRenderer.ts · templates.ts
│   │             battle.ts · plans.ts · mongodb.js · serverAuth.js
│   ├── hooks/    useAuth.ts · useApi.ts · useProfile.ts
│   └── components/  14 components (see B3.4)
├── server/       devServer.js (local API) · vercelDevPlugin.js (Vite proxy) · promote.js
├── Subscription/ template artwork: Cartoons/ Fruits/ Scenery/ Vegetables/
├── dist/         build output (gitignored)
└── README.md · MEMORY.md · PRD.md (this document)
```

---

# Part D — API Reference

All endpoints require `Authorization: Bearer <Clerk session JWT>` unless noted. Errors are `{ error: string }` with appropriate status.

### `GET/POST /api/profile` *(auth)*
- **GET** → `{ profile }` where profile includes `drawings, favorites, history, nickname, bio, role, subscribed, plan, planPeriod, subscribedUntil, payments, avatar, features, galleryLimit`. Returns `{ profile: null }` if none (client creates on first save).
- **POST/PUT** body → any subset of profile fields (`SERVER_ONLY` fields stripped/ignored server-side). Returns `{ ok: true }`. Upserts; `role` derived from email match vs `SUPERADMIN_EMAIL`.

### `GET /api/plans` *(public)*
- → `{ plans: Plan[], free: Plan|null, catalog: FeatureDef[] }`. Never 5xx; falls back to seeds.

### `POST /api/create-order` *(auth)*  → billing `?route=create-order`
Body `{ planId }` → `{ orderId, amount, currency, keyId, plan }`.

### `POST /api/create-subscription` *(auth)*  → `?route=create-subscription`
Body `{ planId }` → `{ keyId, subscriptionId, planId, plan, customer }`. (Recurring path — currently blocked by test-account 401; Orders is the active path.)

### `POST /api/verify-payment`  → `?route=verify-payment`
Body (Razorpay response + `idToken`) → `{ verified: true }` or 400/401. Verifies signature **and** Clerk identity; marks subscription.

### `GET /api/check-subscription` *(auth)*  → `?route=check-subscription`
→ `{ subscribed, plan, subscribedUntil, subscriptionId }` (reconciled with Razorpay when a sub exists). *(Not wired to a visible UI today — parked.)*

### `POST /api/cancel-subscription` *(auth)*  → `?route=cancel-subscription`
→ `{ ok, message }`; ends paid period immediately, keeps history.

### `POST /api/razorpay-webhook` *(Razorpay-signed, no auth)*  → `?route=webhook`
Reconciles charged/ended events. Invalid signature → HTTP 200 `{ ok }` ignored.

### `GET/POST /api/friends` *(auth)*  + `GET /api/friends/requests`
- GET → `{ friends[], outgoing[], incoming[] }` (views: userId/nickname/email/avatar).
- POST `{ action: 'add' }` with `{ email|nickname }`, or `{ action: 'accept'|'decline'|'cancel'|'remove', userId }`.
- `/requests` → `{ count }` pending incoming requests (badge).

### `GET/POST /api/groups` *(auth)* + `/api/groups/:groupId`
- GET → `{ groups: Group[], friends }`.
- POST `{ name, emoji, memberIds[] }` → `{ ok, groupId }` (invited members must be accepted friends).
- `:groupId` GET → detailed group; POST `{ action: 'rename'|'invite'|'remove'|'leave'|'delete' }` (admin-gated where relevant).

### `GET/POST /api/competitions` *(auth)* + `/api/competitions/:competitionId`
- GET → `{ active: Summary[], recent: Summary[] }`.
- POST `{ sourceGroupId, targetGroupId, prompt? }` → `{ ok, id, drawEndTime }`.
- `:competitionId` GET → detail (settles lazily when closed); POST `{ action:'sync'|'submit', strokes }` during drawing window, or `{ action:'vote', groupId }` during voting (one vote). Members of `myGroup` only.

### Admin (auth + role) — `api/admin.js` dispatcher
| Func | Route / query | Methods | Access | Notes |
|---|---|---|---|---|
| overview | `/api/admin` (route=overview) | GET | admin+ | KPIs, new users, groups/battles lists |
| users | `route=users` | GET | admin+ | ≤200 profiles |
| user | `route=user&userId=` | GET/PATCH/DELETE | admin+ | PATCH: suspend/role(super only); DELETE clears content |
| billing | `route=billing` | GET/POST | GET admin+, POST super | POST `{userId}` cancels subscription |
| plans | `route=plans` | GET/POST | GET admin+, POST super | POST creates plan (all Pro features) |
| plan | `route=plan&planId=` | GET/PATCH/DELETE | GET/PATCH admin+, PATCH/DELETE super | editable: label/period/interval/totalCount/features/galleryLimit/active/description; can't delete if active subscribers |
| group | `route=group&groupId=` | DELETE | admin+ | + cascade battles |
| competition | `route=competition&competitionId=` | DELETE | admin+ | |

---

*Generated from the `NeonAir-main` codebase (Sept 2026). Keep `MEMORY.md`, `README.md`, and this PRD in sync whenever the product or architecture changes.*