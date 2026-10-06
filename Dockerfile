FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG GITHUB_TOKEN

RUN if [ -n "$GITHUB_TOKEN" ]; then \
        git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"; \
    fi

# agents-browser is the Python CDP client only. Chromium is not installed;
# set AGENTS_BROWSER_BIN when a browser binary is required.
COPY pyproject.toml README.md ./
COPY src ./src
# SUITE_REF is the default git ref for every suite package. CACHE_BUST
# invalidates this layer when the branch tip moved but the ref name did not.
# On your build platform, rebuild with --no-cache or bump CACHE_BUST, then confirm
# `pip freeze | grep agents-` shows the git commits you expect.
ARG SUITE_REF=dev
ARG CACHE_BUST=0
ARG HARNESS_REF=${SUITE_REF}
ARG RELAY_REF=${SUITE_REF}
ARG MEMORY_REF=${SUITE_REF}
ARG TRACES_REF=${SUITE_REF}
ARG DOCS_REF=${SUITE_REF}
ARG TERMINAL_REF=${SUITE_REF}
ARG CALENDAR_REF=${SUITE_REF}
ARG BROWSER_REF=${SUITE_REF}
RUN echo "klanker-suite cache=${CACHE_BUST} ref=${SUITE_REF}" && \
    pip install --no-cache-dir \
        "agents-harness[mcp] @ git+https://github.com/Lolaplex/agents-harness.git@${HARNESS_REF}" \
        "agents-relay @ git+https://github.com/Lolaplex/agents-relay.git@${RELAY_REF}" \
        "agents-memory @ git+https://github.com/Lolaplex/agents-memory.git@${MEMORY_REF}" \
        "agents-traces @ git+https://github.com/Lolaplex/agents-traces.git@${TRACES_REF}" \
        "agents-docs @ git+https://github.com/Lolaplex/agents-docs.git@${DOCS_REF}" \
        "agents-terminal @ git+https://github.com/Lolaplex/agents-terminal.git@${TERMINAL_REF}" \
        "agents-calendar @ git+https://github.com/Lolaplex/agents-calendar.git@${CALENDAR_REF}" \
        "agents-browser @ git+https://github.com/Lolaplex/agents-browser.git@${BROWSER_REF}" && \
    pip install --no-cache-dir . && \
    (git config --global --remove-section url."https://${GITHUB_TOKEN}@github.com/" 2>/dev/null || true)

RUN useradd -m -d /data klanker && mkdir -p /data/.agents && chown -R klanker:klanker /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/data \
    PYTHONUNBUFFERED=1 \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8000 \
    LOOP_PROVIDER=openai.default

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "klanker", "serve"]

