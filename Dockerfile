# --- stage 1: dashboard build (node is discarded, runtime is python-only) ---
FROM node:22-alpine AS web
RUN corepack enable
WORKDIR /web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm config set dangerouslyAllowAllBuilds true && pnpm install --frozen-lockfile
COPY web ./
RUN pnpm build

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG GITHUB_TOKEN

RUN if [ -n "$GITHUB_TOKEN" ]; then \
        git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"; \
    fi

# agents-browser is the Python CDP client only. Chromium is not installed;
# set AGENTS_BROWSER_BIN when a browser binary is required.
COPY pyproject.toml README.md ./
COPY src ./src
COPY scripts/dev-suite.py ./scripts/dev-suite.py
# Vendored dashboard: klanker serve picks src/klanker/_web up automatically
# (RELAY_WEB_TOKEN still gates the web surface; unset = API-only).
COPY --from=web /web/dist ./src/klanker/_web
# SUITE_REF is the default git ref for every suite package. Default is
# `main` (latest release); pass --build-arg SUITE_REF=dev for lock-step
# dev builds — self-deploy.sh already forwards KLANKER_REF here.
# Per-package override: *_REF (e.g. RELAY_REF=main). CACHE_BUST
# invalidates this layer when the branch tip moved but the ref name did not.
# On your build platform, rebuild with --no-cache or bump CACHE_BUST, then confirm
# `pip freeze | grep agents-` shows the git commits you expect.
ARG SUITE_REF=main
ARG CACHE_BUST=6
ARG WORKSPACE_REF=${SUITE_REF}
ARG HARNESS_REF=${SUITE_REF}
ARG RELAY_REF=${SUITE_REF}
ARG MEMORY_REF=${SUITE_REF}
ARG TRACES_REF=${SUITE_REF}
ARG TERMINAL_REF=${SUITE_REF}
ARG CALENDAR_REF=${SUITE_REF}
ARG BROWSER_REF=${SUITE_REF}
ARG SYNC_REF=${SUITE_REF}
ARG KEYS_REF=${SUITE_REF}
ARG VOICE_REF=${SUITE_REF}
ARG STORE_REF=${SUITE_REF}
# The suite dep list is generated from pyproject.toml — adding an agents-*
# dep there reaches the image automatically; the *_REF ARGs stay the
# per-package override surface. One resolver pass also orders the
# workspace contract before its dependents.
RUN echo "klanker-suite cache=${CACHE_BUST} ref=${SUITE_REF}" && \
    python scripts/dev-suite.py --emit > /tmp/suite-reqs.txt && \
    pip install --no-cache-dir -r /tmp/suite-reqs.txt && \
    pip install --no-cache-dir . && \
    (git config --global --remove-section url."https://${GITHUB_TOKEN}@github.com/" 2>/dev/null || true)

# Optional ACP agent for agents-relay acp-run: INSTALL_DEVIN=1 bakes
# devin-cli into the image (AGENTS_ACP_CMD="devin acp"; credentials live
# on /data or come via WINDSURF_API_KEY/AGENTS_ACP_API_KEY env). Off by
# default — release images stay generic. The installer's trailing
# `devin setup` is interactive and fails headless; the binary itself is
# installed before it, so we verify the binary, not the exit code.
ARG INSTALL_DEVIN=0
RUN if [ "$INSTALL_DEVIN" = "1" ]; then \
        export HOME=/opt/devin-home \
        && mkdir -p "$HOME" && chmod 755 "$HOME" \
        && (curl -fsSL https://cli.devin.ai/install.sh | bash || true) \
        && test -x /opt/devin-home/.local/bin/devin \
        && ln -sf /opt/devin-home/.local/bin/devin /usr/local/bin/devin \
        && /usr/local/bin/devin version; \
    fi

RUN useradd -m -d /data klanker && mkdir -p /data/.agents/workspaces /data/.agents/run /data/.agents/cache /data/.agents/keys /data/.agents/logs && chown -R klanker:klanker /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER klanker
ENV HOME=/data \
    PYTHONUNBUFFERED=1 \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8000 \
    LOOP_PROVIDER=openai.default

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "klanker", "serve"]

