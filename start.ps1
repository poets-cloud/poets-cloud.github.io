param(
  [int]$Port = 5123
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw 'Python is required but was not found in PATH.'
}

$server = Start-Process -PassThru -WindowStyle Hidden -FilePath python -ArgumentList @('-m', 'uvicorn', 'api:app', '--host', '127.0.0.1', '--port', "$Port")
Start-Sleep -Seconds 2
Start-Process "http://localhost:$Port/app"
Write-Host "Poets Cloud is running at http://localhost:$Port/app"
Write-Host "API docs are available at http://localhost:$Port/docs"
Write-Host "Stop process $($server.Id) when finished."
