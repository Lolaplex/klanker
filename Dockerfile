FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG GITHUB_TOKEN
RUN if [ -n "$GITHUB_TOKEN" ]; then \
        git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"; \
    fi

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir ".[suite]" && \
    (git config --global --remove-section url."https://${GITHUB_TOKEN}@github.com/" 2>/dev/null || true)

RUN useradd -m -d /data clanker && mkdir -p /data/.agents && chown -R clanker:clanker /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOME=/data \
    PYTHONUNBUFFERED=1 \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8000 \
    LOOP_PROVIDER=openai.default

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "clanker", "serve"]

