FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dashboard-build

ARG REVISION
WORKDIR /workspace
COPY dashboard/site/package.json dashboard/site/package-lock.json ./dashboard/site/
RUN sed -i \
      's#https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/#https://registry.npmjs.org/#' \
      dashboard/site/package-lock.json \
    && npm --prefix dashboard/site ci
COPY . .
RUN if echo "${REVISION}" | grep -Eq '^[0-9a-f]{40}$'; then \
      npm --prefix dashboard/site run build -- dist ../../.github/workflows/cao.json "${REVISION}"; \
    else \
      npm --prefix dashboard/site run build -- dist ../../.github/workflows/cao.json; \
    fi

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

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="Central Agentic Ops dashboard server" \
      org.opencontainers.image.description="Hosted CAO dashboard and canonical query service" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/githubnext/gh-aw-cao"

RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 65532 cao \
    && adduser -S -D -H -u 65532 -G cao cao \
    && mkdir -p /app/site /app/source /app/queries \
    && chown -R cao:cao /app

COPY --from=server-build --chown=cao:cao /out/cao-dashboard /app/cao-dashboard
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dist/ /app/site/
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/dashboard.json /app/dashboard.json
COPY --from=dashboard-build --chown=cao:cao /workspace/dashboard/site/src/data/queries/database.json /app/queries/database.json

WORKDIR /app
USER 65532:65532
EXPOSE 8080
VOLUME ["/app/source"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD host="${CAO_ALLOWED_HOSTS%%,*}"; \
      test -n "${host}" && \
      wget -q -T 4 -O /dev/null \
        --header="X-Forwarded-Host: ${host}" \
        --header="X-Forwarded-Proto: https" \
        http://127.0.0.1:8080/api/readiness

ENTRYPOINT ["/app/cao-dashboard"]
CMD ["serve-hosted", "--listen", "0.0.0.0:8080", "--site", "/app/site", "--dashboard-queries", "/app/dashboard.json", "--database-queries", "/app/queries/database.json"]
