# Copy NAS project files to SigmaNAS as compose.yml (not compose.nas.yaml).
# Windows OpenSSH needs scp -O (DSM legacy protocol).
param(
    [string]$NasHost = $(if ($env:NAS_HOST) { $env:NAS_HOST } else { "cypoe@sigmanas" }),
    [string]$Dest = $(if ($env:NAS_PROJECT) { $env:NAS_PROJECT } else { "/volume1/docker/klanker" })
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

ssh -o BatchMode=yes $NasHost "mkdir -p $Dest/data"
if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed" }

scp -O "$Root\compose.nas.yaml" "${NasHost}:${Dest}/compose.yml"
if ($LASTEXITCODE -ne 0) { throw "scp compose failed" }

scp -O "$Root\scripts\nas-pull-latest.sh" "${NasHost}:/volume1/docker/pull-latest.sh"
if ($LASTEXITCODE -ne 0) { throw "scp pull-latest failed" }
ssh -o BatchMode=yes $NasHost "chmod 755 /volume1/docker/pull-latest.sh && sed -i 's/\r$//' /volume1/docker/pull-latest.sh"

Write-Host "OK $NasHost $Dest/compose.yml"
