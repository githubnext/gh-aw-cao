FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dashboard-build

ARG REVISION
WORKDIR /workspace
COPY dashboard/site/package.json dashboard/site/package-lock.json ./dashboard/site/
RUN sed -i \
      's#https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/#https://registry.npmjs.org/#' \
      dashboard/site/package-lock.json \
    && npm --prefix dashboard/site ci --registry=https://registry.npmjs.org/
COPY . .
RUN if echo "${REVISION}" | grep -Eq '^[0-9a-f]{40}$'; then \
      npm --prefix dashboard/site run build -- dist ../../.github/workflows/cao.railway.json "${REVISION}"; \
    else \
      npm --prefix dashboard/site run build -- dist ../../.github/workflows/cao.railway.json; \
    fi

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS snapshot-build

ARG DASHBOARD_DATA_URL=https://githubnext.github.io/gh-aw-cao/cao/payload-hashes.json
ARG DASHBOARD_MANIFEST_SHA256
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN sed -i \
      's#https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/#https://registry.npmjs.org/#g; s#https://packagefeedproxy.microsoft.io/npm/#https://registry.npmjs.org/#g' \
      package-lock.json \
    && npm ci --registry=https://registry.npmjs.org/
COPY . .
RUN test -n "${DASHBOARD_MANIFEST_SHA256}" \
    && node activity/cao.mjs download \
      --url "${DASHBOARD_DATA_URL}" \
      --manifest-sha256 "${DASHBOARD_MANIFEST_SHA256}" \
      --output /out/source

FROM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS server-build

ARG VERSION=dev
WORKDIR /workspace/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o /out/cao-dashboard \
    ./cmd/cao-dashboard

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS caddy-runtime

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="Central Agentic Ops dashboard for Railway" \
      org.opencontainers.image.description="Hosted CAO dashboard with a loopback trust boundary for Railway ingress" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/githubnext/gh-aw-cao"

RUN addgroup -S -g 65532 cao \
    && adduser -S -D -H -u 65532 -G cao cao \
    && mkdir -p /app/site /app/source /app/queries /app/agent /app/config \
    && chown -R cao:cao /app

COPY --from=caddy-runtime /usr/bin/caddy /usr/bin/caddy
COPY --from=caddy-runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=server-build --chown=cao:cao /out/cao-dashboard /app/cao-dashboard
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dist/ /app/site/
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dashboard.json /app/dashboard.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/data/queries/database.json /app/queries/database.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/agent/catalog.generated.json /app/agent/catalog.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/agent/queries.generated.json /app/agent/queries.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/agent/mcp-contract.json /app/agent/mcp-contract.json
COPY --from=dashboard-build --chown=cao:cao /workspace/.github/workflows/cao.json /app/config/cao.json
COPY --from=dashboard-build --chown=cao:cao /workspace/.github/workflows/cao.railway.json /app/config/cao.railway.json
COPY --from=snapshot-build --chown=cao:cao /out/source/ /app/source/
COPY --chown=cao:cao server/internal/railway/Caddyfile /app/Caddyfile
COPY --chown=cao:cao server/internal/railway/entrypoint.sh /app/entrypoint.sh

WORKDIR /app
USER 65532:65532
EXPOSE 8080
ENV CAO_POLICY_PATH=/app/config/cao.railway.json \
    CAO_SOURCE_DIRECTORY=/app/source \
    XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -T 4 -O /dev/null http://127.0.0.1:${PORT:-8080}/api/readiness

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
