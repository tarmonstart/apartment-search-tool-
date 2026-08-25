# Getting these files into your own GitHub repo, by hand

Nothing here needs Claude, and nothing needs to be "connected" to anything. You are just
copying 29 files into a repository you own. Pick **one** of the two routes below.

The files to upload are everything in this folder:

```
C:\Users\Tuukka\Desktop\Home\riga-rentals-for-github
```

---

# Route A — the GitHub website (no software, easiest)

Good if you would rather not touch a terminal.

### 1. Open your repo on github.com

If you have not made it yet: **github.com → + (top right) → New repository**, give it a
name (e.g. `riga-rentals`), and **tick "Add a README file"** so the repo is not empty.

### 2. Add file → Upload files

On the repo's main page: the **Add file** button (next to the green Code button) →
**Upload files**.

### 3. Drag the files in

Open `riga-rentals-for-github` in File Explorer. Press **Ctrl+A** to select everything —
this must include the **`.github`** and **`lib`** and **`ui`** and **`state`** folders —
then drag the selection into the browser window.

> **This is the step that matters:** drag the *contents* of the folder, not the folder
> itself. If you drag the folder, everything ends up one level too deep and the workflow
> will not run.
>
> Folder structure IS preserved when you drag folders in — GitHub keeps `lib/sources/...`
> and `.github/workflows/...` intact. You do not need to recreate them by hand.

Wait for the file list to finish appearing (it uploads ~576 KB, a few seconds).

### 4. Commit

Type a message like `Riga rental finder` and press **Commit changes**.

### 5. Check it looks right

The repo's file list should show `find-rentals.js`, `config.json`, and the folders `lib`,
`ui`, `state`, `.github`. Click into `.github/workflows/` — `scrape.yml` must be there. If
that file is missing or in the wrong place, the twice-a-day job will never run.

Now go to **DEPLOY.md → step 2** in this folder for the two repo settings you must change.

---

# Route B — Git on your PC (a bit faster, one-time setup)

You already have Git installed (2.54).

### 1. Make the repo on github.com

**+ → New repository → name it → create.** This time **do NOT tick "Add a README"** —
leave it completely empty. Copy the `https://github.com/...` URL it shows you.

### 2. In PowerShell, run these one at a time

```powershell
cd "C:\Users\Tuukka\Desktop\Home\riga-rentals-for-github"
git init
git add -A
git commit -m "Riga rental finder"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

Replace `YOUR-USERNAME/YOUR-REPO` with your actual repo.

### 3. If it asks you to sign in

A browser window will pop up — sign in as **the account that owns the new repo**.

**If it pushes as the wrong account, or you get a 403:** your PC has another GitHub account
saved. Clear it and try the push again:

- Start menu → **Credential Manager** → **Windows Credentials**
- Find the entries starting with `git:https://github.com` → **Remove**
- Run `git push -u origin main` again and sign in as the right account.

### 4. If the push is rejected with "updates were rejected"

The repo was not empty (you ticked "Add a README"). Run:

```powershell
git pull --rebase origin main
git push -u origin main
```

---

## After either route

Follow **DEPLOY.md**, starting at step 2. The two settings that people always miss:

1. **Settings → Pages → Source: `GitHub Actions`**
2. **Settings → Actions → General → Workflow permissions: `Read and write permissions`**

Then **Actions → "Scrape and publish" → Run workflow** to test it once.

## Updating it later

If you change something on your PC and want the online copy updated:

- **Route A:** upload the changed file again the same way — GitHub replaces it.
- **Route B:** `git add -A`, `git commit -m "tweak"`, `git push`.

You do not need to re-upload everything, just what changed.
