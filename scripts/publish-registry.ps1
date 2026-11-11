# Build a local image and push it into a private docker registry reachable
# only on the remote host (e.g. bound to 127.0.0.1 there).
# Flow: docker build (suite pinned via SUITE_REF git refs), save tar, scp -O,
# then ssh docker load + push. All host-specific values via env/args.
#
#   $env:NAS_HOST, $env:NAS_PROJECT, $env:REMOTE_REPO are required.
# GITHUB_TOKEN is passed as a build arg when set — needed while any suite
# repo is private. Never baked into a layer: the Dockerfile removes the
# git url rewrite after install.
param(
    [string]$NasHost = $env:NAS_HOST,
    [string]$Dest = $env:NAS_PROJECT,
    [string]$LocalImage = $(if ($env:LOCAL_IMAGE) { $env:LOCAL_IMAGE } else { "klanker:local" }),
    [string]$SuiteRef = $(if ($env:SUITE_REF) { $env:SUITE_REF } else { "dev" })
)

$ErrorActionPreference = "Stop"
if (-not $NasHost) { throw "NAS_HOST env or -NasHost required" }
if (-not $Dest) { throw "NAS_PROJECT env or -Dest required" }
$RemoteRepo = $env:REMOTE_REPO
if (-not $RemoteRepo) { throw "REMOTE_REPO env required (e.g. 127.0.0.1:<port>/<image>)" }
$Root = Split-Path -Parent $PSScriptRoot
$Tags = if ($env:TAGS) { $env:TAGS } else { "latest" }
$SkipBuild = $env:SKIP_BUILD

if ($SkipBuild -ne "1") {
    $buildArgs = @("--build-arg", "SUITE_REF=$SuiteRef", "--build-arg", "CACHE_BUST=$(Get-Date -Format yyyyMMddHHmmss)")
    if ($env:GITHUB_TOKEN) {
        $buildArgs += @("--build-arg", "GITHUB_TOKEN=$env:GITHUB_TOKEN")
    } else {
        Write-Host "note: GITHUB_TOKEN unset - build fails if any suite repo is private"
    }
    Write-Host "building $LocalImage (SUITE_REF=$SuiteRef)"
    docker build @buildArgs -t $LocalImage $Root
    if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
}

docker image inspect $LocalImage | Out-Null
if ($LASTEXITCODE -ne 0) { throw "error: $LocalImage missing" }

$tar = Join-Path $env:TEMP "klanker-local.tar"
Write-Host "saving $LocalImage to $tar"
docker save $LocalImage -o $tar
if ($LASTEXITCODE -ne 0) { throw "docker save failed" }

$remoteTar = "/tmp/klanker-local.tar"
Write-Host "copying tar to $NasHost"
scp -O $tar "${NasHost}:${remoteTar}"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

$pushCmds = @()
foreach ($tag in ($Tags -split "\s+")) {
    if ($tag) {
        $pushCmds += "docker tag $LocalImage ${RemoteRepo}:${tag} && docker push ${RemoteRepo}:${tag}"
    }
}
$push = $pushCmds -join " && "

Write-Host "loading and pushing on remote host"
ssh -o BatchMode=yes $NasHost "export PATH=/usr/local/bin:/usr/bin:/bin; docker load -i $remoteTar && $push && rm -f $remoteTar"
if ($LASTEXITCODE -ne 0) { throw "remote load/push failed" }

Remove-Item -Force $tar -ErrorAction SilentlyContinue
scp -O "$Root\scripts
as-pull-latest.sh" "${NasHost}:${Dest}/pull-latest.sh"
if ($LASTEXITCODE -ne 0) { throw "scp pull-latest failed" }
ssh -o BatchMode=yes $NasHost "chmod 755 $Dest/pull-latest.sh && sed -i 's/$//' $Dest/pull-latest.sh"
if ($LASTEXITCODE -ne 0) { throw "chmod pull-latest failed" }
Write-Host "recreating remote project if digest moved"
ssh -o BatchMode=yes $NasHost "$Dest/pull-latest.sh $Dest"
if ($LASTEXITCODE -ne 0) { throw "pull-latest failed" }

Write-Host "OK registry has $RemoteRepo tags: $Tags"
