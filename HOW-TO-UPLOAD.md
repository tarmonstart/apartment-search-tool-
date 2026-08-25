# Step by step: putting this online

Repo:   https://github.com/tarmonstart/apartment-search-tool-
Folder: C:\Users\Tuukka\Desktop\Home\riga-rentals-for-github   (31 files)

Route A (browser) leaves **nothing** on this PC — no credential is stored, the upload
happens in the Chrome session you are already signed into. Route B is one command but
does store a login for tarmonstart on this machine. Pick one.

===============================================================================
ROUTE A - BROWSER (recommended: no credentials stored on this PC)
===============================================================================

STEP 1  Open the repo
        https://github.com/tarmonstart/apartment-search-tool-
        Make sure the top-right avatar is tarmonstart, not the work account.

STEP 2  Click "Add file" (next to the green Code button) -> "Upload files"

STEP 3  Open the folder in File Explorer:
        C:\Users\Tuukka\Desktop\Home\riga-rentals-for-github

STEP 4  Press Ctrl+A  (selects all 15 items: files + the folders
        .github, lib, ui, state)

STEP 5  Drag that selection into the browser window and drop it.

        >> THE ONE THING TO GET RIGHT <<
        Drag the CONTENTS, not the folder itself. If you drag the folder,
        everything ends up one level too deep and the scheduled job never runs.
        Sub-folders (lib/sources/..., .github/workflows/...) are preserved
        automatically - you never recreate them by hand.
        If Explorer shows a .git folder, ignore it; GitHub skips it.

STEP 6  Wait for the file list to finish appearing (about 600 KB).

STEP 7  Scroll down, type a message like "Riga rental finder",
        click "Commit changes".

STEP 8  VERIFY THE ONE FILE THAT MATTERS
        In the repo, click .github -> workflows -> scrape.yml must be there.
        If it is missing, the twice-a-day job will never run. Re-upload just
        that folder if so.

Now skip to "AFTER UPLOADING".

===============================================================================
ROUTE B - ONE COMMAND (faster, but stores a tarmonstart login on this PC)
===============================================================================

The folder is already a prepared git repository: all 31 files are committed, the
author is tarmonstart (not your work identity), and the remote already points at
your repo. Only the upload is left.

STEP 1  In File Explorer go to:
        C:\Users\Tuukka\Desktop\Home\riga-rentals-for-github
        Click the address bar, type  powershell  and press Enter.

STEP 2  Run:
            git push -u origin main

STEP 3  A "Git Credential Manager" window appears.
        Choose "Sign in with your browser" and sign in as tarmonstart.

        If it uses the wrong account, or you get 403:
          Start menu -> Credential Manager -> Windows Credentials
          -> remove entries starting with  git:https://github.com
          -> run the push again.

        (The repo's starter README has already been merged in locally, so the
         push should go straight through with no "rejected" error.)

===============================================================================
AFTER UPLOADING - 3 settings, then it runs by itself
===============================================================================

STEP 9   Settings -> Actions -> General -> scroll to "Workflow permissions"
         -> select "Read and write permissions" -> Save.
         (The job writes seen.json and geocache.json back after each crawl.
          Without this it fails at the last step.)

STEP 10  Settings -> Pages -> "Build and deployment" -> Source: "GitHub Actions"
         NOT "Deploy from a branch" - that is the old way and will not work.

         The repo is PUBLIC, so Pages works on the free plan - nothing to pay.

STEP 11  Actions tab -> "Scrape and publish" -> "Run workflow" button.
         It takes 5-10 minutes. Watch it go green.

STEP 12  Your report:
             https://tarmonstart.github.io/apartment-search-tool-/

         After this it runs itself at 05:00 and 12:00 UTC
         (08:00 / 15:00 Riga in summer, 07:00 / 14:00 in winter).

STEP 13  Stop your PC from scraping as well - in PowerShell:
             schtasks /Delete /TN "RigaRentals Morning" /F
             schtasks /Delete /TN "RigaRentals Afternoon" /F

===============================================================================
UPDATING IT LATER
===============================================================================

Route A: upload the changed file again the same way - GitHub replaces it.
Route B: git add -A  ->  git commit -m "tweak"  ->  git push

You never re-upload everything, only what changed.
