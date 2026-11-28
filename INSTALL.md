# Install — klanker

## Release (PyPI)

```bash
pip install klanker
pip install "klanker[repl]"      # interactive shell + TUI
pip install "klanker[all]"       # every optional extra (same as repl)
```

Browser, keys, calendar, voice, and the workspace sync line install
with the package. They are not extras.

## Dev lock-step (source)

One command. It installs every `agents-*` dependency from source, then
installs this repo editable. The lockstep floors (`agents-*>=0.2.0,<1`
and the matching floors of the packages that version on their own line)
are not on PyPI yet, so this has to be the first install on a clean venv.

```bash
git clone https://github.com/Lolaplex/klanker.git && cd klanker
python scripts/dev-suite.py
```

`dev-suite.py` reads `pyproject.toml` (the only dep list) and, for each
`agents-*` dep:

- **sibling checkout exists** (`../agents-*`) → `pip install -e` it, so
  uncommitted local work flows through
- **no sibling** → `git+https://github.com/Lolaplex/<name>.git@dev`
- **then this repo** → `pip install -e .`

```bash
python scripts/dev-suite.py --dry-run   # show the plan
python scripts/dev-suite.py --emit      # git-ref requirement lines (Dockerfile uses this)
SUITE_REF=main python scripts/dev-suite.py   # dev script, but pin released refs
<NAME>_REF=v0.4 python scripts/dev-suite.py  # per-package override (dashes → underscores)
```

## Docker image

```bash
docker build -t klanker .                          # suite @ main (release)
docker build -t klanker --build-arg SUITE_REF=dev .  # suite @ dev (lock-step)
docker build -t klanker --build-arg RELAY_REF=v0.3 . # per-package override
docker build -t klanker --build-arg INSTALL_DEVIN=1 .  # + devin-cli (ACP)
```

Default is `main`: an image is a release artifact. Dev images are always
explicit. Bump `--build-arg CACHE_BUST=$(date +%s)` when a branch tip
moved under the same ref name.

`INSTALL_DEVIN=1` bakes `devin-cli` into the image for `agents-relay
acp-run` — set `AGENTS_ACP_CMD="devin acp"` (plus `LOOP_CMD="python -m
agents_relay acp-run"` to route turns to it) and credentials via
`WINDSURF_API_KEY`/`AGENTS_ACP_API_KEY` env or one `devin auth login`
into the `/data` volume. Used by the VPS deploy where the platform
builds a single Dockerfile; the NAS keeps its untracked overlay.

## Self-deploy (container rebuilds itself)

Requires the compose mounts: `/var/run/docker.sock` (+ `group_add` of the
socket gid) and a git checkout at `/src`. Then, inside the container:

```bash
/src/scripts/self-deploy.sh
```

fetches `KLANKER_REF` (default `dev`), builds, and pushes to
`KLANKER_REGISTRY` (default `127.0.0.1:9500`). **The script ends at
`docker push`** — the host watcher (`pull-latest.sh` cron) pulls and
recreates when the digest moves. A container that recreates itself dies
mid-flight.

Deployment-specific additions live in an **untracked overlay Dockerfile**
(`KLANKER_DOCKERFILE=Dockerfile.nas` selects it), layered
`FROM` the registry image — never in the public `Dockerfile`. Example: the
sigmanas overlay installs `devin-cli` into the image at `/opt/devin-home`;
the binary is baked into the image layer (present in every container
built from it — it is *not* on the NAS host), while credentials persist
on the `/data` volume.
