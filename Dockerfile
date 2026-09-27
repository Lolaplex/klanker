FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG GITHUB_TOKEN
RUN if [ -n "$GITHUB_TOKEN" ]; then \
        git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"; \
    fi

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir \
        "agents-harness @ git+https://github.com/Lolaplex/agents-harness.git@dev" \
        "agents-relay @ git+https://github.com/Lolaplex/agents-relay.git@dev" \
        "agents-memory @ git+https://github.com/Lolaplex/agents-memory.git@dev" \
        "agents-traces @ git+https://github.com/Lolaplex/agents-traces.git@dev" \
        "agents-docs @ git+https://github.com/Lolaplex/agents-docs.git@dev" \
        "agents-terminal @ git+https://github.com/Lolaplex/agents-terminal.git@dev" \
        "agents-calendar @ git+https://github.com/Lolaplex/agents-calendar.git@dev" && \
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

