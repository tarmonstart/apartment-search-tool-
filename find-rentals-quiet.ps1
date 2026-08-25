# Silent run for Task Scheduler: refreshes listings.html/csv without opening anything.
# Scheduled twice a day (see README). Log of the latest run: state\last-run.log
Set-Location -Path $PSScriptRoot
$log = Join-Path $PSScriptRoot "state\last-run.log"
"=== run started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log -Encoding utf8
node find-rentals.js *>> $log
"=== run finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" | Out-File $log -Append -Encoding utf8
