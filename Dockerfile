FROM gradle:8.10.2-jdk17 AS worker-build

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

ARG ORACLE_DOWNLOADER_REVISION=f824922b7021af69afe6d7980e0644860200ec16
ARG ORACLE_PROCESSOR_REVISION=9456f3486246e97d95680a20de469e0dde6eb917
ARG DDRAGON_SNAPSHOT_REVISION=df1e2bd757d9d1037bde75f0d25fa683224b7a9a
ARG DDRAGON_ARTIFACT_REVISION=04e64e94ae35a09a975de0914f69c6a8748f6b2e

WORKDIR /build

RUN git clone https://github.com/jmirving/lol-pro-data-download-cron.git oracle-downloader \
    && git -C oracle-downloader checkout --detach "$ORACLE_DOWNLOADER_REVISION" \
    && git clone https://github.com/jmirving/lol-pro-data-processor.git oracle-processor \
    && git -C oracle-processor checkout --detach "$ORACLE_PROCESSOR_REVISION" \
    && git clone https://github.com/jmirving/lol-ddragon-snapshot-cron.git ddragon-snapshot \
    && git -C ddragon-snapshot checkout --detach "$DDRAGON_SNAPSHOT_REVISION" \
    && git clone https://github.com/jmirving/lol-ddragon-context-artifact-builder.git ddragon-artifact-builder \
    && git -C ddragon-artifact-builder checkout --detach "$DDRAGON_ARTIFACT_REVISION"

RUN cd oracle-downloader && gradle --no-daemon bootJar \
    && cd /build/oracle-processor && gradle --no-daemon bootJar \
    && cd /build/ddragon-snapshot && gradle --no-daemon bootJar \
    && cd /build/ddragon-artifact-builder && gradle --no-daemon installDist

RUN mkdir -p /opt/workers/oracle-downloader \
      /opt/workers/oracle-processor \
      /opt/workers/ddragon-snapshot \
      /opt/workers/ddragon-artifact-builder \
    && cp oracle-downloader/build/libs/lol-pro-data-download-cron-1.0-SNAPSHOT.jar \
      /opt/workers/oracle-downloader/worker.jar \
    && cp oracle-processor/build/libs/lol-pro-data-processor-1.0-SNAPSHOT.jar \
      /opt/workers/oracle-processor/worker.jar \
    && cp ddragon-snapshot/build/libs/ai-pb-data-download-cron-1.0-SNAPSHOT.jar \
      /opt/workers/ddragon-snapshot/worker.jar \
    && cp -a ddragon-artifact-builder/build/install/lol-ddragon-context-artifact-builder/. \
      /opt/workers/ddragon-artifact-builder/

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /work \
    && chown node:node /work

ARG ORACLE_DOWNLOADER_REVISION=f824922b7021af69afe6d7980e0644860200ec16
ARG ORACLE_PROCESSOR_REVISION=9456f3486246e97d95680a20de469e0dde6eb917
ARG DDRAGON_SNAPSHOT_REVISION=df1e2bd757d9d1037bde75f0d25fa683224b7a9a
ARG DDRAGON_ARTIFACT_REVISION=04e64e94ae35a09a975de0914f69c6a8748f6b2e

LABEL org.opencontainers.image.source="https://github.com/jmirving/lol-data-refresh-cron" \
      lol.worker.oracle-downloader.revision="$ORACLE_DOWNLOADER_REVISION" \
      lol.worker.oracle-processor.revision="$ORACLE_PROCESSOR_REVISION" \
      lol.worker.ddragon-snapshot.revision="$DDRAGON_SNAPSHOT_REVISION" \
      lol.worker.ddragon-artifact-builder.revision="$DDRAGON_ARTIFACT_REVISION"

COPY --from=worker-build /opt/workers /opt/workers

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV ORCHESTRATOR_WORKSPACE_ROOT=/work
USER node

CMD ["node", "src/cli.js", "--profile", "production"]
