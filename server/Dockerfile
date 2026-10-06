FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dashboard-build

SHELL ["/bin/ash", "-o", "pipefail", "-c"]

ARG REVISION
ARG VERSION=dev
ARG CAO_PROFILE=cao.json
ENV CAO_VERSION=${VERSION}
WORKDIR /workspace
COPY dashboard/site/package.json dashboard/site/package-lock.json ./dashboard/site/
RUN sed -i \
      's#https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/#https://registry.npmjs.org/#' \
      dashboard/site/package-lock.json \
    && npm --prefix dashboard/site ci --omit=dev --ignore-scripts
COPY . .
RUN REPORT_ROOT=/workspace \
    REPORT_INVENTORY=/tmp/control-plane-inventory.json \
    REPORT_INVENTORY_STATIC=true \
    node activity/inventory.mjs
RUN printf '%s' "${CAO_PROFILE}" | grep -Eq '^cao(\.[a-z0-9-]+)?\.json$' \
    && policy="../../.github/workflows/${CAO_PROFILE}" \
    && if echo "${REVISION}" | grep -Eq '^[0-9a-f]{40}$'; then \
      npm --prefix dashboard/site run build -- dist "${policy}" "${REVISION}"; \
    else \
      npm --prefix dashboard/site run build -- dist "${policy}"; \
    fi

FROM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS server-build

ARG VERSION=dev
ARG REVISION=unknown
WORKDIR /workspace/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION} -X main.revision=${REVISION}" \
    -o /out/cao-dashboard \
    ./cmd/cao-dashboard

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS dashboard-runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="Central Agentic Ops dashboard server" \
      org.opencontainers.image.description="Hosted CAO dashboard and canonical query service" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/githubnext/gh-aw-cao"

# Keep Alpine packages and CA roots current on rebuilds.
# hadolint ignore=DL3018
RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates \
    && addgroup -S -g 65532 cao \
    && adduser -S -D -H -u 65532 -G cao cao \
    && mkdir -p /app/site /app/source /app/queries /app/agent \
    && chown -R cao:cao /app

COPY --from=server-build --chown=cao:cao /out/cao-dashboard /app/cao-dashboard
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dist/ /app/site/
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dashboard.json /app/dashboard.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/data/queries/database.json /app/queries/database.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dist/src/agent/catalog.generated.json /app/agent/catalog.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dist/src/agent/queries.generated.json /app/agent/queries.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/agent/mcp-contract.json /app/agent/mcp-contract.json
COPY --from=dashboard-build --chown=cao:cao /workspace/.github/workflows/cao.json /app/.github/workflows/cao.json
COPY --from=dashboard-build --chown=cao:cao /workspace/.github/workflows/cao.coolify.json /app/.github/workflows/cao.coolify.json

WORKDIR /app
USER 65532:65532
EXPOSE 8080
VOLUME ["/app/source"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["sh", "-c", "host=\"${CAO_ALLOWED_HOSTS%%,*}\"; test -n \"${host}\" && wget -q -T 4 -O /dev/null --header=\"X-Forwarded-Host: ${host}\" --header=\"X-Forwarded-Proto: https\" http://127.0.0.1:8080/api/readiness"]

ENTRYPOINT ["/app/cao-dashboard"]
CMD ["serve-hosted", "--listen", "0.0.0.0:8080", "--site", "/app/site", "--dashboard-queries", "/app/agent/queries.json", "--database-queries", "/app/queries/database.json"]

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS collector-runtime

SHELL ["/bin/ash", "-o", "pipefail", "-c"]

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
ARG GH_AW_VERSION=v0.91.1
ARG TARGETARCH
LABEL org.opencontainers.image.title="Central Agentic Ops collector" \
      org.opencontainers.image.description="Hosted CAO collection worker and backfill runtime" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/githubnext/gh-aw-cao"

# Keep Alpine packages, CA roots, and the GitHub CLI current on rebuilds.
# hadolint ignore=DL3018
RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates github-cli \
    && addgroup -S -g 65532 cao \
    && adduser -S -D -H -u 65532 -G cao cao \
    && mkdir -p /app/catalog /app/evidence /app/.local/share/gh/extensions/gh-aw \
    && case "${TARGETARCH}" in \
      amd64) checksum="814a0efbee964ee2acb286bf9b3cbaa133d47699a2a57cbeb3ea4040a7f3b099" ;; \
      arm64) checksum="9767cbbfcd0f3c6cf68e5aff94a7efcfda911c7e865604434da391181c62e94d" ;; \
      *) echo "Unsupported collector architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q -O /usr/local/bin/gh-aw \
      "https://github.com/github/gh-aw/releases/download/${GH_AW_VERSION}/linux-${TARGETARCH}" \
    && echo "${checksum}  /usr/local/bin/gh-aw" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/gh-aw \
    && ln -s /usr/local/bin/gh-aw /app/.local/share/gh/extensions/gh-aw/gh-aw \
    && chown -R cao:cao /app

COPY --from=dashboard-runtime --chown=cao:cao /app/ /app/
COPY --from=dashboard-build --chown=cao:cao /workspace/activity/ /app/catalog/activity/
COPY --from=dashboard-build --chown=cao:cao /workspace/.github/workflows/shared/control.mjs /app/catalog/.github/workflows/shared/control.mjs
COPY --from=dashboard-build --chown=cao:cao /workspace/.github/workflows/shared/policy.mjs /app/catalog/.github/workflows/shared/policy.mjs
COPY --from=dashboard-build --chown=cao:cao /tmp/control-plane-inventory.json /app/catalog/control-plane-inventory.json
# gh aw logs discovers agentic workflow names from local compiled workflows
# before it queries runs, so the collection catalog must retain the lock files.
COPY --from=dashboard-build --chown=cao:cao /workspace/.github/workflows/*.lock.yml /app/catalog/.github/workflows/
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/report/ /app/catalog/dashboard/report/
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/package.json /app/catalog/dashboard/site/package.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/ /app/catalog/dashboard/site/src/
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/node_modules/yaml/ /app/catalog/node_modules/yaml/
COPY --from=dashboard-build --chown=cao:cao /workspace/dependabot/ /app/catalog/dependabot/
COPY --from=dashboard-build --chown=cao:cao /workspace/optimization/ /app/catalog/optimization/

ENV HOME=/app \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config
WORKDIR /app
USER 65532:65532
VOLUME ["/app/evidence"]
ENTRYPOINT ["/app/cao-dashboard"]
CMD ["collect", "--database-queries", "/app/queries/database.json"]

FROM dashboard-runtime AS final
