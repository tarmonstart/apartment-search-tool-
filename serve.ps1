# Double-click helper: serves the report on your home Wi-Fi so a phone can use it.
# The window shows the address to type on the phone. Close the window to stop.
Set-Location -Path $PSScriptRoot
node serve.js
Read-Host "Server stopped - press Enter to close"
