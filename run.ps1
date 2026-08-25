# Double-click helper: runs the finder and opens the report.
# If double-clicking is blocked, right-click -> Run with PowerShell,
# or run:  powershell -ExecutionPolicy Bypass -File run.ps1
Set-Location -Path $PSScriptRoot
Write-Host "Running Riga rental finder..." -ForegroundColor Cyan
node find-rentals.js
if ($LASTEXITCODE -eq 0) {
    Start-Process (Join-Path $PSScriptRoot "listings.html")
} else {
    Write-Host "Finder failed - see messages above." -ForegroundColor Red
    Read-Host "Press Enter to close"
}
