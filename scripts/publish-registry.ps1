# Build klanker:local and push into the live NAS registry.
# Registry binds 127.0.0.1:9500 on SigmaNAS - this PC cannot docker-push to :9500.
# Flow: docker build (suite pinned via SUITE_REF git refs), save tar, scp -O,
# then ssh docker load and docker push 127.0.0.1:9500.
# No GHCR. GITHUB_TOKEN is passed as a build arg when set — needed while any
# Lolaplex suite repo is private (agents-traces is). Never baked into a layer:
# the Dockerfile removes the git url rewrite after install.
param(
    [string]$NasHost = $(if ($env:NAS_HOST) { $env:NAS_HOST } else { "cypoe@sigmanas" }),
    [string]$LocalImage = $(if ($env:LOCAL_IMAGE) { $env:LOCAL_IMAGE } else { "klanker:local" }),
    [string]$SuiteRef = $(if ($env:SUITE_REF) { $env:SUITE_REF } else { "dev" })
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Tags = if ($env:TAGS) { $env:TAGS } else { "latest" }
$SkipBuild = $env:SKIP_BUILD
$RemoteRepo = "127.0.0.1:9500/klanker"

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

Write-Host "loading and pushing on NAS"
ssh -o BatchMode=yes $NasHost "export PATH=/usr/local/bin:/usr/bin:/bin; docker load -i $remoteTar && $push && rm -f $remoteTar && curl -fsS http://127.0.0.1:9500/v2/_catalog"
if ($LASTEXITCODE -ne 0) { throw "NAS load/push failed" }

Remove-Item -Force $tar -ErrorAction SilentlyContinue
scp -O "$Root\scripts\nas-pull-latest.sh" "${NasHost}:/volume1/docker/pull-latest.sh"
if ($LASTEXITCODE -ne 0) { throw "scp pull-latest failed" }
ssh -o BatchMode=yes $NasHost "chmod 755 /volume1/docker/pull-latest.sh && sed -i 's/\r$//' /volume1/docker/pull-latest.sh"
if ($LASTEXITCODE -ne 0) { throw "chmod pull-latest failed" }
Write-Host "recreating NAS project if digest moved"
ssh -o BatchMode=yes $NasHost "/volume1/docker/pull-latest.sh /volume1/docker/klanker"
if ($LASTEXITCODE -ne 0) { throw "pull-latest failed" }

Write-Host "OK registry has $RemoteRepo tags: $Tags"
Write-Host "CM compose image: sigmanas.local:9500/klanker:latest"
