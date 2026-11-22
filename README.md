# Rīga rental finder

Scrapes public rental listings **across the whole of Rīga** from **ss.lv**, **pp.lv**,
**varianti.lv** (which also powers cityreal.lv), **reklama.lv**, **latio.lv**,
**arcoreal.lv** and — from a home connection — **city24.lv**. It works out whether
utilities are included, collapses the same flat posted on several sites into one card,
and publishes a phone-friendly **HTML report** (plus a CSV) where every flat is either
**👍 liked**, **👎 rejected** or still **new**.

No accounts, no logins, nothing that can get banned. Public pages only.
(That is also why there is no Facebook: Marketplace and the rental groups sit behind a
login wall and forbid scraping. The report's footer carries one-tap search links to both.)

## Run it

Needs Node.js (you have v24).

- **Double-click `run.ps1`** — runs the finder, then opens the report, or
- from a terminal in this folder:

```bash
node find-rentals.js
```

A full run takes about ten minutes (most of it reading each ss.lv and reklama.lv ad).

**It also runs itself twice a day** — Task Scheduler entries `RigaRentals Morning` (08:00)
and `RigaRentals Afternoon` (15:00) run `find-rentals-quiet.ps1`; the latest log is in
`state\last-run.log`. A report left open in a browser tab notices a fresh build on its own
(served over http, it reloads itself when you come back to it and a newer build exists). Change the times with
`schtasks /Change /TN "RigaRentals Morning" /ST 09:00`, or remove a task with
`schtasks /Delete /TN "RigaRentals Morning" /F`.

## Running it online

See **DEPLOY.md** — GitHub Actions scrapes twice a day and GitHub Pages serves the report,
free, with your PC switched off.

## On your phone

- **Double-click `serve.ps1`** (or `node serve.js`). It prints an address like
  `http://192.168.x.x:8877` — open that on the phone, same Wi-Fi.
- The report is built for the phone first: big 👍 / 👎 buttons, swipeable photos, all
  filters in one bottom sheet, and areas you draw on the map with a finger.
- Votes made on the phone save **straight to `state/user-state.json`** through the
  server; the footer says so when it is active.
- LAN only, no auth — don't port-forward it.

## Using the report

- **Four tabs: Unviewed · Viewed · 👍 Liked · 👎 Disliked.** A flat becomes *viewed*
  when you open it — its photos, the original ad, or its pin on the map — and stays put
  in the list you are looking at until you switch tabs. **👍 Like** / **👎 Nope** move
  it to those piles; a judged flat never shows up in Unviewed or Viewed again — not even
  when it is re-posted, or posted on another site (see below). Tap the active button
  again to un-judge it; every vote can be undone from the toast that pops up, and
  *mark viewed / mark unviewed* on a card flips that by hand.
- **Filters** opens one sheet with everything there is: max rent (quick presets or any
  number), rooms, minimum size, **an area drawn on the map**, districts, "last 3 days",
  utilities included, renovated, furnished, has photos, a free-text search and the sort
  order. Filters are remembered, and each active one shows as a chip under the tabs —
  tap it to remove it. Nothing is ever hidden silently.
- **Draw an area**: *Filters → Draw on map*, or **✏ Draw area** on the map. Drag one
  finger (or the mouse) around the part of the city you want and let go; the shape
  closes itself and from then on the list, the counts and the pins show only flats
  inside it. Draw more areas to add them up; *Clear areas* (or the chip's ×) removes
  them. Flats without a known position are left out while an area is active.
- **Photos are a stack of prints**, not a sliding strip: swipe left and the top photo
  falls away to show the next, swipe right and the previous one comes back up onto the
  stack (with a mouse: the ‹ › arrows on hover). Tap the stack for full screen, where the
  same gestures work; tap the photo for the next one, tap the dark area around it, swipe
  down, press Esc or use the phone's back gesture to close.
- **What is round the corner:** every card (and map pin) shows the nearest big
  supermarket by name (e.g. "Rimi Hyper", "Maxima XX", "Lidl"), tram stop and bus stop
  with straight-line distance. Only the large, cheaper formats count: Lidl, Rimi Hyper /
  Super / plain Rimi supermarkets, Maxima XX / XXX — never Rimi Mini, Rimi Express or
  Maxima X. On the map, zoom in to street level and the supermarkets (green, with the
  chain's letter L / R / M), tram stops (blue, T) and bus stops (grey, B) appear on a
  quiet base map with nothing else on it; the three switches above the map hide any
  kind. Opening one flat on the map draws dashed lines to its nearest three.
  The stores and stops come from OpenStreetMap (Overpass API), re-fetched weekly into
  `state/pois.json`.
- **Back gesture** closes whatever is open (photos, filters, map) instead of leaving the
  page. The header tucks away while you scroll down and returns on the slightest scroll
  up; each tab remembers where you were; far down, a button takes you back to the top.
- **Look:** the "Kvartāls" brand (Art Nouveau Rīga — teal, gilt, plaster on ivory) by
  default; `"theme": "logs"` in `config.json` switches to the Nordic "Logs" brand.
- **📍 address** shows that flat on the map; **🗺️ Map** shows every flat in the
  current tab and filters (blue = new, green = liked, grey = rejected) and you can vote
  straight from a pin.
- Each card links to **every site** the flat was found on.

### Where your votes are kept

**Signed in (recommended):** with Firebase set up (below), a **Sign in** button appears
at the top. Sign in with Google and your votes and views live in your account — one
small Firestore document — and sync live between phone and laptop. The browser only
keeps a cache. Anything the browser already knew is uploaded on first sign-in.

**Not signed in:** votes live in that browser's storage, which survives new builds but is
per device: **Back up votes** in the footer downloads them, **Restore a backup** merges
them into another device (it never wipes anything).

### Sign in and sync — one-time Firebase setup (free, ~10 minutes)

1. Go to <https://console.firebase.google.com>, **Add project** (any name, Analytics off).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable → Save.**
3. Authentication → **Settings → Authorized domains → Add domain:** `tarmonstart.github.io`.
4. **Build → Firestore Database → Create database** (production mode, an EU location).
   Then the **Rules** tab, replace everything with this and **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

   Each person can only ever read and write their own document.
5. **Project settings (⚙) → Your apps → Web (</>) → Register app** (no hosting). Copy
   `apiKey`, `authDomain`, `projectId` and `appId` from the config it shows into the
   `firebase` block of `config.json`. These are public identifiers, not secrets — the
   rules in step 4 are what protect the data.
6. Commit; the next build (or *Actions → Run workflow*) shows the **Sign in** button.

Served from your own PC with `serve.js`, every vote also goes straight to
`state/user-state.json`, and each run keeps a dated snapshot in `state/backups/history/`.
Votes from the earlier Like / Maybe / Discard report carry over (a *maybe* counts as 👍).

### Votes and duplicates

When the same flat is found on several sites, the card remembers **every** listing id it
absorbed, and a vote is written to all of them — so it still applies next week if the
sites re-post the flat under new ids.

Two posts are only merged when something actually ties them to the same place — shared
photos, near-identical wording, matching coordinates, or the same house number. Matching
price, floor, size and room count is *not* enough on its own, because a block of identical
flats matches on all four.

## Tuning — `config.json`

- `maxPrice`, `maxPriceWithUtilities` (a higher cap when utilities are included), `minPrice`
- `allowedRooms`, `preferredRooms`, `minArea`, `excludeFirstFloor`
- `excludeOld` / `requireRenovated` / `renovatedPriority`
- `requireUtilitiesIncluded` — `true` hides listings where utilities are extra
- `sslv.maxPages`, `city24.maxPages`, `city24.allowedDistricts`, `pplv.regions`,
  `varianti.pageSize`, `reklama.maxPages` — and `enabled: false` turns any source off
- `dedupe.threshold` — how much evidence is needed before two posts are treated as the same
  flat. Raise it if real flats are being merged; lower it if duplicates get through.
- `requestDelayMs`, `concurrency` — politeness. These are free public sites; don't raise them much.

## How it's put together

```
find-rentals.js          orchestrator: collect → filter → deep-read → geocode → dedupe → write
serve.js                 tiny LAN server: phone access + verdicts saved straight to disk
lib/http.js              fetching: retries, timeouts, gzip, POST, bounded concurrency
lib/detect.js            utilities / condition / furnishing from Latvian, Russian, English copy
lib/sources/sslv.js      ss.lv listing tables + per-ad deep read + galleries
lib/sources/city24.js    city24 search API
lib/sources/pplv.js      pp.lv apipub API
lib/sources/varianti.js  varianti.lv JSON API (same data as cityreal.lv)
lib/sources/latio.js     latio.lv server-rendered pages
lib/sources/arcoreal.js  arcoreal.lv server-rendered pages
lib/sources/reklama.js   reklama.lv table pages + per-ad deep read
lib/geocode.js           Nominatim geocoding behind state/geocache.json (1 req/s, cached)
lib/images.js            which photo rendition to request, and compact gallery storage
lib/vendor/              Leaflet 1.9.4, inlined into the report at build time
lib/dedupe.js            collapsing the same flat across sites and re-posts
lib/state.js             your verdicts: loading, merging, snapshotting
lib/report.js            builds listings.html and listings.csv
ui/report.css            the report's styling  — edit, then `node find-rentals.js --report`
ui/report.js             the report's behaviour — same
state/                   seen.json, user-state.json, geocache.json, last-run.json, backups/
```

If a site changes its markup, the collector for it is the only file that should need work.

### Photos

Each source publishes several sizes of every photo. The report requests a small one for the
card grid and a larger one only when you open the gallery:

| | grid | gallery |
|---|---|---|
| ss.lv | `.t.jpg` (174×130, ~4 KB) | `.800.jpg` (long side ≤910) |
| city24 | `/object/14/` (~18 KB) | `/object/22/` (~200 KB) |
| pp.lv | `43` (252×189, ~10 KB) | `0x1080` |
| varianti.lv | `small_` filename prefix (~17 KB) | `original_` prefix |
| latio.lv | `th/c_w410_h300…` (~25 KB) | same path without `th/…` (can be MBs) |
| arcoreal.lv | card thumbnail only (no deep read) | same image |
| reklama.lv | `m` size letter (~23 KB) | `z` (~270 KB) |

Two things worth knowing if you ever touch this:

- **ss.lv derives a photo's folder from the image id alone**
  (`ceil(id/1e7)/ceil(id/5e4)/ceil(id/200)`), and ids are allocated globally — so one ad's
  photos routinely sit in several different folders. The gallery is read from the ad's own
  inline `msg_img` array for exactly this reason.
- **pp.lv only serves its resized versions when the request says
  `Accept: image/avif`.** Browsers do this automatically for `<img>`; anything using `fetch()`
  has to set it, or it silently gets the full-size original.

## Notes

- Public listing pages and public APIs only, rate-limited, for personal apartment hunting.
- **pp.lv** pages its lots API with `currentPage` (20 per page); region 85 is the whole of
  Rīga (~230 rentals). Earlier versions read page 1 of seven districts and saw ~50.
- **city24.lv** now sits behind a Cloudflare bot challenge for datacenter IPs (GitHub
  Actions included), so the cloud run gets nothing from it; it still works from a home
  connection, and the report footer links to its search. The challenge is not bypassed.
- **varianti.lv** answers 100-item pages slowly (1.4 MB, ~17 s), which timed out on
  GitHub runners and silently cost the whole source; it is read 40 at a time now.
- **zip.lv** refuses direct API access by design ("Direct API access is not allowed"), and
  **realting.com**'s robots.txt forbids paging — neither is collected.
- **mm.lv** blocks scraping (HTTP 403). **ober-haus.lv** renders its rentals with
  JavaScript and has only a handful — not worth a collector.
- **Airbnb** was probed (2026-08-25): technically fetchable, but its robots.txt disallows
  the search page, the ToS forbids scraping, and DataDome + rotating API keys make it
  break-prone — so it stays a footer quick-link (monthly stays, Riga centre, next month),
  like Facebook.
- **Cloud hosting**: `.github/workflows/scrape.yml` + `.gitignore` are ready for a
  GitHub-Actions-scrapes-twice-daily + Pages setup, but nothing is pushed anywhere —
  the project is local-only until decided otherwise.
- **cityreal.lv** is a frontend over the varianti.lv API, so the varianti collector covers
  both — a second collector would only create duplicates.
- **varianti.lv quirks**: filter values are string keys (`"rent"`, `"flat"` — numeric ids
  500), `page` is 0-based, and the `title` fields carry mojibake — read `address_name` and
  `description_lv` instead.
- **latio.lv and arcoreal.lv publish no posting dates**, so their cards show "—" for age and
  sort to the bottom of "newest".
- Adding a site means writing one more `lib/sources/*.js` that returns the same listing
  shape (plus, if it hosts photos somewhere new, a rule in `lib/images.js`).
- `api.json` and `body6.html` are leftover captures from the original build and aren't used.
