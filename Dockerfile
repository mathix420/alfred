# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-slim AS bun

FROM python:3.12-slim-bookworm AS matrix-dependencies
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential libolm-dev \
    && rm -rf /var/lib/apt/lists/*
COPY apps/pocket/matrix/requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    TZ=UTC \
    ALFRED_POCKET_HOST=0.0.0.0 \
    ALFRED_POCKET_PORT=9191 \
    ALFRED_POCKET_DATA_FILE=/data/tasks.json \
    ALFRED_POCKET_VOICE_DIR=/data/voice \
    ALFRED_MATRIX_STORE_DIR=/data/matrix \
    ALFRED_MATRIX_PYTHON=/opt/venv/bin/python

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates libolm3 ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid app --create-home app \
    && install -d --mode=0700 --owner=app --group=app /data /data/matrix /data/voice

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=matrix-dependencies /opt/venv /opt/venv
WORKDIR /app
COPY apps/pocket/src ./apps/pocket/src
COPY apps/pocket/web ./apps/pocket/web
COPY apps/pocket/matrix ./apps/pocket/matrix
COPY apps/companion/src/stt/whisper.ts ./apps/companion/src/stt/whisper.ts
COPY apps/companion/src/tts/piper.ts ./apps/companion/src/tts/piper.ts
COPY apps/companion/src/ports.ts apps/companion/src/protocol.ts ./apps/companion/src/

USER app
VOLUME ["/data"]
EXPOSE 9191
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.ALFRED_POCKET_PORT}/healthz`); if (!r.ok) process.exit(1);'
CMD ["bun", "run", "apps/pocket/src/index.ts"]
