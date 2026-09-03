FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir ".[suite]"

RUN useradd -m -d /data clanker && mkdir -p /data/.agents && chown -R clanker:clanker /data

USER clanker
ENV HOME=/data \
    PYTHONUNBUFFERED=1 \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8000 \
    LOOP_PROVIDER=openai.default

EXPOSE 8000

CMD ["python", "-m", "clanker", "serve"]

