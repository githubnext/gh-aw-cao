VERSION ?= dev

.PHONY: build release fmt lint test check

build:
	go build -trimpath -ldflags "-X main.version=$(VERSION)" -o gh-cao ./cmd/gh-cao

release:
	bash scripts/build-release.sh "$(VERSION)"

fmt:
	gofmt -w cmd internal

lint:
	@test -z "$$(gofmt -l cmd internal)" || (gofmt -l cmd internal; exit 1)
	go vet ./cmd/... ./internal/...

test:
	go test -race ./cmd/... ./internal/...

check: lint test build
