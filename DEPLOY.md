# Running this online, without your PC

Everything below is free and needs no server: **GitHub Actions** runs the scrape twice a
day in the cloud, and **GitHub Pages** serves the report at a URL you can open from any
device. Your PC can be switched off.

---

## 1. Copy these files into your repository

The whole folder, minus what `.gitignore` already excludes. That is 28 files:

```
.github/workflows/scrape.yml    the twice-a-day job + the deploy
.gitignore                      keeps personal + generated files out
config.json                     what to search for
find-rentals.js                 the orchestrator
lib/                            sources, dedupe, geocoding, report builder, Leaflet
ui/report.css, ui/report.js     the report's look and behaviour
state/seen.json                 which ads have been seen (powers "new")
state/geocache.json             addresses already geocoded (do not lose this)
README.md, DEPLOY.md            docs
run.ps1, serve.ps1, serve.js,   local-only helpers; harmless to include
find-rentals-quiet.ps1
```

**Do not commit `state/user-state.json`** — those are your like/maybe/discard piles.
`.gitignore` already blocks it. (See §5 if you want them synced anyway.)

Keep `state/seen.json` and `state/geocache.json`. They are the memory between runs: without
the first, every flat looks "new" forever; without the second, the map re-geocodes from
scratch and takes days to fill in again.

```bash
cd your-repo
# copy the files in, then:
git add -A
git commit -m "Riga rental finder"
git push
```

## 2. Two settings in the repo — both are easy to miss

**Settings → Pages → Build and deployment → Source: `GitHub Actions`**
(not "Deploy from a branch" — that is the old way and will not work with this workflow.)

**Settings → Actions → General → Workflow permissions: `Read and write permissions`**
The job commits `seen.json` and `geocache.json` back after each crawl; without this it
fails at the push step.

## 3. First run

**Actions → "Scrape and publish" → Run workflow.** Watch it once. It takes about 5–10
minutes: crawl, deep-read the ss.lv ads, geocode up to 60 new addresses, build, deploy.

When it turns green, your report is at:

```
https://<your-github-username>.github.io/<repo-name>/
```

Put that URL in `config.json` as `siteUrl` and commit — it only feeds the canonical / social
tags, and it is fine to leave empty.

After that it runs by itself at **05:00 and 12:00 UTC** (08:00 / 15:00 Rīga in summer,
07:00 / 14:00 in winter). Change the two `cron:` lines in the workflow to move it.

## 4. Turn off the local schedule, or you will scrape twice

Your PC still has two Task Scheduler jobs from the local setup. Once the cloud version
works, remove them:

```powershell
schtasks /Delete /TN "RigaRentals Morning" /F
schtasks /Delete /TN "RigaRentals Afternoon" /F
```

## 5. Your like / maybe / discard piles on the hosted version

On GitHub Pages the page is static — there is no server to write to — so verdicts are kept
in **that browser's localStorage**. That is durable (it survives closing the browser and
new deploys), but it is **per device**: what you tag on the phone will not appear on the PC.

To move them: **⋯ → Export picks** on one device, **⋯ → Import picks** on the other. Import
merges, it never wipes.

If you want them to sync properly, the repo must be **private** and you must commit
`state/user-state.json` deliberately (delete those two lines from `.gitignore`). Then every
build bakes your current verdicts into the page. Note: GitHub Pages on a private repo needs
a paid plan; on the free plan a private repo can still run the Actions job, but the site
would have to be published elsewhere.

## 6. If a source stops returning anything

The sites are crawled from GitHub's datacenter IPs, which some sites treat more harshly
than a home connection. The run is built to survive that: **each source is wrapped
separately**, so one being blocked costs only its listings, and the summary ends with

```
WARNING: latio.lv returned nothing this run — their listings are missing from this report.
```

If the crawl returns nothing at all, the run **aborts without publishing**, so a bad day can
never replace a good report with an empty one.

Should a site block the cloud permanently, the fallback is to scrape at home and let the
cloud only publish: run `node find-rentals.js` on your PC, then commit the built
`listings.html` (remove it from `.gitignore`) and simplify the workflow to just the
"Assemble the site" + deploy steps.

## 7. Cost

Free. Public repo = unlimited Actions minutes and free Pages. A private repo gets 2,000
free minutes a month; two runs a day at ~10 minutes each is about 600.

## 8. Anything sensitive in the repo?

No credentials, no tokens, no logins — the scrapers only read public pages. The listings and
photos belong to ss.lv, city24, pp.lv, varianti, latio and arcoreal; a **public** repo makes
your copy of that data public too, which is worth a thought before you choose public over
private. The report itself carries `noindex, nofollow`, so search engines skip it.
