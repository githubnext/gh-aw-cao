VERSION ?= dev

.PHONY: build release fmt lint test test-doctor authtests check

build:
	go build -trimpath -ldflags "-X main.version=$(VERSION)" -o gh-cao ./cmd/gh-cao

release:
	bash scripts/build-release.sh "$(VERSION)"

fmt:
	gofmt -w operator_assets.go cmd internal dashboard/catalog.go dashboard/queryengine

lint:
	@test -z "$$(gofmt -l operator_assets.go cmd internal dashboard/catalog.go dashboard/queryengine)" || (gofmt -l operator_assets.go cmd internal dashboard/catalog.go dashboard/queryengine; exit 1)
	go vet . ./cmd/... ./internal/... ./dashboard ./dashboard/queryengine/...

test:
	go test -race . ./cmd/... ./internal/... ./dashboard ./dashboard/queryengine/...

test-doctor:
	go test -race -run '^TestDoctorUnit' ./internal/cli

authtests:
	go test -race -count=1 -tags=authtests -run '^TestDoctorAuth$$' ./internal/cli

check: lint test build
