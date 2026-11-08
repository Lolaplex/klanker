# Build, push to the live SigmaNAS registry, seed data (first run), recreate.
# Local registry only (127.0.0.1:9500 on the NAS). No GHCR.
#
#   powershell -File scripts/nas-deploy.ps1
#   $env:SKIP_BUILD = "1"; powershell -File scripts/nas-deploy.ps1
#   $env:SKIP_SEED  = "1"; powershell -File scripts/nas-deploy.ps1
param(
    [string]$NasHost = $(if ($env:NAS_HOST) { $env:NAS_HOST } else { "cypoe@sigmanas" }),
    [string]$Dest = $(if ($env:NAS_PROJECT) { $env:NAS_PROJECT } else { "/volume1/docker/klanker" })
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Compose = "$Dest/compose.yml"
$DockerCompose = "/usr/local/bin/docker-compose"
$Docker = "/usr/local/bin/docker"

& "$Root\scripts\publish-registry.ps1"
& "$Root\scripts\nas-sync.ps1" -NasHost $NasHost -Dest $Dest

if ($env:SKIP_SEED -ne "1") {
    Write-Host "seeding $Dest (agents files, filtered .env, message ingest)"
    Get-Content -Raw "$Root\scripts\nas-seed.py" | ssh -o BatchMode=yes $NasHost "python3 -"
    if ($LASTEXITCODE -ne 0) { throw "seed failed" }
}

Write-Host "recreating $NasHost $Compose (--pull always)"
ssh -o BatchMode=yes $NasHost "$DockerCompose -f $Compose --project-directory $Dest up -d --force-recreate --no-build --pull always"
if ($LASTEXITCODE -ne 0) { throw "compose up failed" }

Write-Host "NAS containers:"
ssh -o BatchMode=yes $NasHost "$Docker ps --filter name=klanker"

Write-Host "OK NAS running sigmanas.local:9500/klanker:latest on :8787"
