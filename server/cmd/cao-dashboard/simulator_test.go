package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReadBoundedFileReturnsContentsWithinLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scenario.json")
	want := []byte(`{"name":"small"}`)
	if err := os.WriteFile(path, want, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readBoundedFile(path, int64(len(want)))
	if err != nil {
		t.Fatalf("readBoundedFile returned error: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("readBoundedFile = %q, want %q", got, want)
	}
}

func TestReadBoundedFileRejectsFileOverLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scenario.json")
	if err := os.WriteFile(path, []byte(`{"name":"too-big"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := readBoundedFile(path, 4)
	if !errors.Is(err, errScenarioTooLarge) {
		t.Fatalf("readBoundedFile error = %v, want errScenarioTooLarge", err)
	}
}

func TestReadBoundedFileReportsMissingFile(t *testing.T) {
	_, err := readBoundedFile(filepath.Join(t.TempDir(), "missing.json"), maxScenarioBytes)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("readBoundedFile error = %v, want os.ErrNotExist", err)
	}
}

func TestClassifyScenarioLoadFailure(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		decoding bool
		want     scenarioLoadStage
	}{
		{
			name: "decode failure reported regardless of underlying error",
			err:  errors.New("boom"), decoding: true,
			want: scenarioLoadStageDecode,
		},
		{
			name: "over-limit sentinel classified as over-limit",
			err:  errScenarioTooLarge,
			want: scenarioLoadStageOverLimit,
		},
		{
			name: "missing file classified as open",
			err:  os.ErrNotExist,
			want: scenarioLoadStageOpen,
		},
		{
			name: "permission denied classified as open",
			err:  os.ErrPermission,
			want: scenarioLoadStageOpen,
		},
		{
			name: "other read errors classified as read",
			err:  errors.New("disk exploded"),
			want: scenarioLoadStageRead,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyScenarioLoadFailure(tt.err, tt.decoding); got != tt.want {
				t.Fatalf("classifyScenarioLoadFailure() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLoadSimulatorScenarioSucceedsWithValidScenario(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scenario.json")
	content := `{"name":"cmd-test","repositories":2,"events_per_repository":1,"seed":1,"distribution":"uniform"}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	scenario, err := loadSimulatorScenario(path)
	if err != nil {
		t.Fatalf("loadSimulatorScenario returned error: %v", err)
	}
	if scenario.Name != "cmd-test" || scenario.Repositories != 2 {
		t.Fatalf("loadSimulatorScenario = %+v, want name=cmd-test repositories=2", scenario)
	}
}

func TestLoadSimulatorScenarioPropagatesMissingFile(t *testing.T) {
	_, err := loadSimulatorScenario(filepath.Join(t.TempDir(), "missing.json"))
	if err == nil || !strings.Contains(err.Error(), "load simulator scenario") {
		t.Fatalf("loadSimulatorScenario error = %v, want a wrapped load error", err)
	}
}

func TestLoadSimulatorScenarioPropagatesInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scenario.json")
	if err := os.WriteFile(path, []byte(`{"name":"broken"`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := loadSimulatorScenario(path)
	if err == nil {
		t.Fatal("loadSimulatorScenario returned nil error for invalid JSON")
	}
}

func TestValidateWebhookDeliveryFlagsAcceptsValidInput(t *testing.T) {
	failure, err := validateWebhookDeliveryFlags("scenario.json", 30*time.Second, 64)
	if err != nil {
		t.Fatalf("validateWebhookDeliveryFlags returned error: %v", err)
	}
	if failure != webhookDeliveryFlagFailureNone {
		t.Fatalf("validateWebhookDeliveryFlags() failure = %q, want %q", failure, webhookDeliveryFlagFailureNone)
	}
}

func TestValidateWebhookDeliveryFlagsRejectsEmptyScenario(t *testing.T) {
	failure, err := validateWebhookDeliveryFlags("", 30*time.Second, 64)
	if err == nil {
		t.Fatal("validateWebhookDeliveryFlags returned nil error for an empty scenario path")
	}
	if failure != webhookDeliveryFlagFailureScenario {
		t.Fatalf("validateWebhookDeliveryFlags() failure = %q, want %q", failure, webhookDeliveryFlagFailureScenario)
	}
}

func TestValidateWebhookDeliveryFlagsRejectsNonPositiveTimeout(t *testing.T) {
	tests := []time.Duration{0, -time.Second}
	for _, timeout := range tests {
		failure, err := validateWebhookDeliveryFlags("scenario.json", timeout, 64)
		if err == nil {
			t.Fatalf("validateWebhookDeliveryFlags(timeout=%s) returned nil error, want an error", timeout)
		}
		if failure != webhookDeliveryFlagFailureTimeout {
			t.Fatalf("validateWebhookDeliveryFlags(timeout=%s) failure = %q, want %q", timeout, failure, webhookDeliveryFlagFailureTimeout)
		}
	}
}

func TestValidateWebhookDeliveryFlagsRejectsOutOfRangeConcurrency(t *testing.T) {
	tests := []int{0, -1, 513}
	for _, concurrency := range tests {
		failure, err := validateWebhookDeliveryFlags("scenario.json", 30*time.Second, concurrency)
		if err == nil {
			t.Fatalf("validateWebhookDeliveryFlags(concurrency=%d) returned nil error, want an error", concurrency)
		}
		if failure != webhookDeliveryFlagFailureConcurrency {
			t.Fatalf("validateWebhookDeliveryFlags(concurrency=%d) failure = %q, want %q", concurrency, failure, webhookDeliveryFlagFailureConcurrency)
		}
	}
}

func TestValidateWebhookDeliveryFlagsAcceptsBoundaryConcurrency(t *testing.T) {
	tests := []int{1, 512}
	for _, concurrency := range tests {
		failure, err := validateWebhookDeliveryFlags("scenario.json", 30*time.Second, concurrency)
		if err != nil {
			t.Fatalf("validateWebhookDeliveryFlags(concurrency=%d) returned error: %v", concurrency, err)
		}
		if failure != webhookDeliveryFlagFailureNone {
			t.Fatalf("validateWebhookDeliveryFlags(concurrency=%d) failure = %q, want %q", concurrency, failure, webhookDeliveryFlagFailureNone)
		}
	}
}

// newTestListener opens a real loopback TCP listener on an OS-assigned port,
// so runSimulatorAPI is exercised against an actual net.Listener rather than
// a fake.
func newTestListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenConfig.Listen() error = %v", err)
	}
	return listener
}

func TestRunSimulatorAPIReturnsNilOnGracefulShutdown(t *testing.T) {
	listener := newTestListener(t)
	httpServer := &http.Server{Handler: http.NewServeMux(), ReadHeaderTimeout: time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := runSimulatorAPI(ctx, httpServer, listener, time.Second); err != nil {
		t.Fatalf("runSimulatorAPI() error = %v, want nil for a graceful shutdown", err)
	}
}

func TestRunSimulatorAPIReturnsNilWhenServerClosesCleanly(t *testing.T) {
	listener := newTestListener(t)
	httpServer := &http.Server{Handler: http.NewServeMux(), ReadHeaderTimeout: time.Second}

	// Closing the listener before serving makes Serve return
	// http.ErrServerClosed-compatible behavior is not guaranteed, so close
	// the server itself instead: Close makes Serve return
	// http.ErrServerClosed immediately, exercising the "clean" branch of the
	// select without waiting on ctx.
	if err := httpServer.Close(); err != nil {
		t.Fatalf("httpServer.Close() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := runSimulatorAPI(ctx, httpServer, listener, time.Second); err != nil {
		t.Fatalf("runSimulatorAPI() error = %v, want nil when the server closes cleanly", err)
	}
}

func TestRunSimulatorAPIPropagatesServerError(t *testing.T) {
	listener := newTestListener(t)
	// Closing the listener before Serve is called makes http.Server.Serve
	// return a real "use of closed network connection" error, exercising
	// the propagated-error branch of the select with an authentic failure
	// rather than an injected one.
	if err := listener.Close(); err != nil {
		t.Fatalf("listener.Close() error = %v", err)
	}
	httpServer := &http.Server{Handler: http.NewServeMux(), ReadHeaderTimeout: time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := runSimulatorAPI(ctx, httpServer, listener, time.Second)
	if err == nil {
		t.Fatal("runSimulatorAPI() returned nil error, want a propagated server error")
	}
	if errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("runSimulatorAPI() error = %v, want a non-ErrServerClosed failure", err)
	}
}
