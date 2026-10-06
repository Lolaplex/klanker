FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG GITHUB_TOKEN
ARG HARNESS_REF=dev
ARG RELAY_REF=dev
ARG MEMORY_REF=dev
ARG TRACES_REF=dev
ARG DOCS_REF=dev
ARG TERMINAL_REF=dev
ARG CALENDAR_REF=dev

RUN if [ -n "$GITHUB_TOKEN" ]; then \
        git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"; \
    fi

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir ".[suite]"

RUN useradd -m -d /data klanker && mkdir -p /data/.agents/memory /data/.agents/traces /data/.agents/docs && chown -R klanker:klanker /data

USER klanker
ENV HOME=/data \
    PYTHONUNBUFFERED=1 \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8000 \
    LOOP_PROVIDER=openai.default

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "klanker", "serve"]

