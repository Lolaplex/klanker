# Copy project files to a remote docker host as compose.yml.
# Windows OpenSSH needs scp -O (legacy protocol).
#   $env:NAS_HOST = "user@host"; $env:NAS_PROJECT = "/path/to/project"
param(
    [string]$NasHost = $env:NAS_HOST,
    [string]$Dest = $env:NAS_PROJECT,
    [string]$ComposeSrc = $(if ($env:COMPOSE_SRC) { $env:COMPOSE_SRC } else { "compose.example.yaml" })
)

$ErrorActionPreference = "Stop"
if (-not $NasHost) { throw "NAS_HOST env or -NasHost required" }
if (-not $Dest) { throw "NAS_PROJECT env or -Dest required" }

$Root = Split-Path -Parent $PSScriptRoot

ssh -o BatchMode=yes $NasHost "mkdir -p $Dest/data"
if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed" }

scp -O "$Root\$ComposeSrc" "${NasHost}:${Dest}/compose.yml"
if ($LASTEXITCODE -ne 0) { throw "scp compose failed" }

scp -O "$Root\scripts\nas-pull-latest.sh" "${NasHost}:${Dest}/pull-latest.sh"
if ($LASTEXITCODE -ne 0) { throw "scp pull-latest failed" }
ssh -o BatchMode=yes $NasHost "chmod 755 $Dest/pull-latest.sh && sed -i 's/\r$//' $Dest/pull-latest.sh"

Write-Host "OK $NasHost $Dest/compose.yml"
