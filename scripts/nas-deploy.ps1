# Build, push to a private docker registry, seed data (first run), recreate.
# All values come from env/args — no host-specific defaults in the repo.
#
#   $env:NAS_HOST = "user@host"; $env:NAS_PROJECT = "/path/to/project"
#   powershell -File scripts/nas-deploy.ps1
#   $env:SKIP_BUILD = "1"; powershell -File scripts/nas-deploy.ps1
#   $env:SKIP_SEED  = "1"; powershell -File scripts/nas-deploy.ps1
param(
    [string]$NasHost = $env:NAS_HOST,
    [string]$Dest = $env:NAS_PROJECT
)

$ErrorActionPreference = "Stop"
if (-not $NasHost) { throw "NAS_HOST env or -NasHost required" }
if (-not $Dest) { throw "NAS_PROJECT env or -Dest required" }

$Root = Split-Path -Parent $PSScriptRoot
$Compose = "$Dest/compose.yml"
$DockerCompose = if ($env:DOCKER_COMPOSE) { $env:DOCKER_COMPOSE } else { "docker-compose" }
$Docker = if ($env:DOCKER_BIN) { $env:DOCKER_BIN } else { "docker" }

& "$Root\scripts\publish-registry.ps1" -NasHost $NasHost -Dest $Dest
& "$Root\scripts\nas-sync.ps1" -NasHost $NasHost -Dest $Dest

if ($env:SKIP_SEED -ne "1") {
    Write-Host "seeding $Dest (agents files, filtered .env, message ingest)"
    Get-Content -Raw "$Root\scripts\nas-seed.py" | ssh -o BatchMode=yes $NasHost "python3 -"
    if ($LASTEXITCODE -ne 0) { throw "seed failed" }
}

Write-Host "recreating $NasHost $Compose (--pull always)"
ssh -o BatchMode=yes $NasHost "$DockerCompose -f $Compose --project-directory $Dest up -d --force-recreate --no-build --pull always"
if ($LASTEXITCODE -ne 0) { throw "compose up failed" }

Write-Host "OK $NasHost $Dest deployed"
