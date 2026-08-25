# Rīga rental finder

Scrapes public rental listings **across the whole of Rīga** from **ss.lv**, **city24.lv**,
**pp.lv**, **varianti.lv** (which also powers cityreal.lv), **latio.lv** and
**arcoreal.lv**, filters them to your criteria, works out whether utilities are included,
collapses the same flat posted in several places into one card, and writes a local
**HTML report** plus a **CSV** — with every flat placeable on a map. Each source can be
narrowed back to chosen districts in `config.json`.

Searches **1, 2, 3 and 4-room flats on any floor**, across every Rīga district. All of it
is tunable in `config.json`.

No accounts, no logins, nothing that can get banned. Public pages only.
(That is also why there is no Facebook: Marketplace and the rental groups sit behind a
login wall and forbid scraping. The report's footer carries one-tap search links to both
instead.)

## Run it

Needs Node.js (you have v24).

- **Double-click `run.ps1`** — runs the finder, then opens the report, or
- from a terminal in this folder:

```bash
node find-rentals.js
```

A full run takes about three minutes.

**It also runs itself twice a day** — Task Scheduler entries `RigaRentals Morning` (08:00)
and `RigaRentals Afternoon` (15:00) run `find-rentals-quiet.ps1`; the latest log is in
`state\last-run.log`. A report left open in a browser tab notices a fresh build on its own
(it reloads when the tab is hidden and has nothing unsaved). Change the times with
`schtasks /Change /TN "RigaRentals Morning" /ST 09:00`, or remove a task with
`schtasks /Delete /TN "RigaRentals Morning" /F`.

## Running it online

See **DEPLOY.md** — GitHub Actions scrapes twice a day and GitHub Pages serves the report,
free, with your PC switched off.

## On your phone

- **Double-click `serve.ps1`** (or `node serve.js`). It prints an address like
  `http://192.168.x.x:8877` — open that on the phone, same Wi-Fi.
- The report is fully touch-ready: the filter set folds behind a **Filters** button, photos
  swipe left/right (swipe down closes), and every button is finger-sized.
- Verdicts made on the phone (or anywhere the page is served over http) save **straight to
  `state/user-state.json`** through the server — no Export step needed. The Sync button
  reads "Synced to disk" when this is active.
- LAN only, no auth — don't port-forward it.

## The map

- Every flat is a **price pill** (e.g. `590€`), coloured by your verdict — likes teal,
  maybes amber, discards faded, untouched white. A dashed border means street-level
  position only (geocoded without a house number).
- **Click a pill → a full mini-listing opens over the map**: photo (click it for the whole
  gallery), facts, tags, description, and working **Like / Maybe / Discard** buttons — you
  can triage without leaving the map. *show card* jumps to the listing in the grid.
- Click a card's **address** to see just that flat; the **Map** button plots everything the
  current filters admit.
- **✏ Draw area**: press it, drag a freehand line around any part of the city, release —
  the polygon closes itself and the whole report (cards, counts, pins) shows only flats
  inside it, until you clear it (the same button, or Reset). Flats without a known
  position are excluded while an area is active. The Filters button counts it, so a
  drawn area can never silently hide listings.
- Google Maps / OSM links sit in the map header for directions and Street View.
- city24 and varianti publish coordinates; every other address is geocoded once via
  Nominatim (max 60 new addresses per run, cached forever in `state/geocache.json`).
  Map data and geocoding © OpenStreetMap contributors.

| Flag | What it does |
|---|---|
| *(none)* | Full run: crawl, deep-read every ss.lv ad, rebuild everything |
| `--fast` | Skip the ss.lv deep read. Much quicker, but no exact dates and only partial galleries |
| `--report` | Rebuild `listings.html` from the last run's cache without touching the network. Handy after editing the styling |

## Your like / maybe / discard piles

This is the part worth protecting: listings can always be re-scraped, but sorting hundreds of
flats by hand cannot be redone.

Each flat has **Like / Maybe / Discard** buttons (or press <kbd>L</kbd> / <kbd>M</kbd> /
<kbd>D</kbd>). Verdicts are stored three ways so a single failure never loses them:

1. **In the browser**, immediately (localStorage).
2. **Baked into the report** — every run writes your current verdicts into `listings.html`
   itself, so they survive clearing browser data.
3. **On disk**, in `state/user-state.json`, with a dated snapshot of the previous version kept
   in `state/backups/history/` on every run (last 30).

**A browser opened from `file://` is not allowed to write to disk.** So when you have tagged
some flats, press **Export** — it drops a `user-state.json` in your Downloads folder, and the
next run picks it up automatically and merges it in. The report shows a reminder bar when you
have unsaved changes. (If you ever serve the folder over http, the **Sync to disk** button
writes `state/user-state.json` directly and the reminder goes away.)

Changing your mind works properly: the browser is always the authority on a flat you have
just judged, so downgrading a *like* to a *discard* sticks, and clicking a verdict again to
clear it is recorded as a real decision rather than being quietly refilled from the last
build. Merging only ever fills gaps — a verdict is never dropped because some other file
happens not to mention it.

### Verdicts and duplicates

When the same flat is found on several sites, the card remembers **every** listing id it
absorbed. Tagging that one card tags all of them, so a verdict is never stranded on the copy
that happens not to be shown — and it still applies next week if the sites re-post the flat
under different ids.

Each post keeps its own record, though. If you liked a flat in July and discarded its August
re-post, both are preserved: the card shows the strongest verdict, and the newer decision is
not overwritten by the older one.

Two posts are only merged when something actually ties them to the same place — shared
photos, near-identical wording, matching coordinates, or the same house number. Matching
price, floor, size and room count is *not* enough on its own, because a block of identical
flats matches on all four. A known difference in floor blocks a merge outright unless the
photos or the wording prove the ads show the same rooms.

## One card per address

A building often has several flats advertised at once — Kaukāza 11 had five, all sharing
one agency gallery. They are **not** duplicates, so the finder refuses to delete them.
Instead the report shows **one card per exact address**: the best of the group — most
photos, cheapest as the tie-break — with a **`+4 more here`** chip that opens the rest in
place (the others get a teal left edge). The counter says how many were folded.

Turn it off with the **one per address** switch in the filter bar to see every post
separately. Only addresses with a house number group; a bare street name never does.

This is display-only, and reversible. Real duplicates — the same flat posted on several
sites, or re-posted — are collapsed for good during the run instead (see above).

## Keyboard

| Key | Action |
|---|---|
| <kbd>j</kbd> / <kbd>k</kbd> | Next / previous flat |
| <kbd>L</kbd> <kbd>M</kbd> <kbd>D</kbd> | Like / Maybe / Discard |
| <kbd>O</kbd> | Open the original ad (marks it seen) |
| <kbd>Enter</kbd> | Open the photo gallery |
| <kbd>←</kbd> <kbd>→</kbd> | Previous / next photo |
| <kbd>/</kbd> | Jump to search |
| <kbd>Esc</kbd> | Close the gallery |

## Tuning — `config.json`

- `maxPrice`, `maxPriceWithUtilities` (a higher cap when utilities are included), `minPrice`
- `allowedRooms`, `preferredRooms`, `minArea`, `excludeFirstFloor`
- `excludeOld` / `requireRenovated` / `renovatedPriority`
- `requireUtilitiesIncluded` — `true` hides listings where utilities are extra
- `sslv.maxPages`, `city24.maxPages`, `city24.allowedDistricts`, `pplv.regions`
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
- **pp.lv** exposes only its ~20 newest Centrs rentals — its API has no deeper paging. Add
  more region ids to `pplv.regions` to widen it.
- **mm.lv** blocks scraping (HTTP 403). **ober-haus.lv** works but had 3 rental flats in
  the whole city when checked — not worth a collector.
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
