VERSION ?= dev

.PHONY: build release fmt lint test test-doctor authtests check

build:
	go build -trimpath -ldflags "-X main.version=$(VERSION)" -o gh-cao ./cmd/gh-cao

release:
	bash scripts/build-release.sh "$(VERSION)"

fmt:
	gofmt -w cmd internal dashboard/catalog.go

lint:
	@test -z "$$(gofmt -l cmd internal dashboard/catalog.go)" || (gofmt -l cmd internal dashboard/catalog.go; exit 1)
	go vet ./cmd/... ./internal/... ./dashboard
	go -C internal/dashboardquery vet ./...

test:
	go test -race ./cmd/... ./internal/... ./dashboard
	go -C internal/dashboardquery test -race ./...

test-doctor:
	go test -race -run '^TestDoctorUnit' ./internal/cli

authtests:
	go test -race -count=1 -tags=authtests -run '^TestDoctorAuth$$' ./internal/cli

check: lint test build
