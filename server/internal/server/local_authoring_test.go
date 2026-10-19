package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/localops"
)

func nativeAuthoringServer(t *testing.T, author func(context.Context, string, map[string]any) (any, error)) (*LocalServer, *httptest.Server) {
	t.Helper()
	local, server := localTestServer(t)
	local.config.EnhanceIntent = true
	operations, err := localops.New(localops.Options{
		Workspace: local.config.Workspace, Canvas: true, Author: author,
		GHExecutable: "unavailable-fixture-gh",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		server.Close()
		if err := operations.Close(); err != nil {
			t.Error(err)
		}
	})
	local.SetOperations(operations)
	return local, server
}

func TestLocalNativeAuthoringValidationAndConcurrency(t *testing.T) {
	started, finish := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	local, server := nativeAuthoringServer(t, func(ctx context.Context, operation string, payload map[string]any) (any, error) {
		calls.Add(1)
		if operation != "query.generate" || payload["intent"] != "Find failures" {
			t.Errorf("unexpected authoring request: %s", operation)
		}
		close(started)
		select {
		case <-finish:
			return map[string]any{"document": "{}"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	for _, body := range []string{
		`{}`, `null`, `[]`, `{"intent":"Find failures","model":"untrusted"}`,
		`{"intent":"Find failures","subject":"` + strings.Repeat("x", 513) + `"}`,
	} {
		status, result := queueRequest(t, local, server, "POST", "/__query_designer", body, "")
		if status != http.StatusBadRequest {
			t.Fatalf("invalid authoring input: %d %s", status, result)
		}
	}
	status, _ := queueRequest(t, local, server, "POST", "/__query_designer", `{"intent":"`+strings.Repeat("x", 200000)+`"}`, "")
	if status != http.StatusRequestEntityTooLarge || calls.Load() != 0 {
		t.Fatal("oversized or invalid requests reached authoring")
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		status, result := queueRequest(t, local, server, "POST", "/__query_designer",
			`{"intent":"Find failures","subject":"Workflow failures","acceptance":"Show native conclusions"}`, "")
		if status != 200 || !bytes.Contains(result, []byte(`"document":"{}"`)) {
			t.Errorf("native generation: %d %s", status, result)
		}
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("authoring did not start")
	}
	status, _ = queueRequest(t, local, server, "POST", "/__query_designer",
		`{"intent":"Find failures","subject":"Workflow failures","acceptance":"Show native conclusions"}`, "")
	if status != http.StatusConflict {
		t.Fatalf("concurrent authoring status: %d", status)
	}
	close(finish)
	<-done
	if calls.Load() != 1 {
		t.Fatal("concurrent request bypassed single-session admission")
	}
}

func TestLocalNativeAuthoringDisconnectCancelsAndSanitizesFailure(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	local, server := nativeAuthoringServer(t, func(ctx context.Context, _ string, _ map[string]any) (any, error) {
		if calls.Add(1) > 1 {
			return nil, errors.New("private model prompt content")
		}
		close(started)
		<-ctx.Done()
		close(canceled)
		return nil, ctx.Err()
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, "POST", server.URL+local.config.Prefix+"/__query_designer",
		strings.NewReader(`{"intent":"Find failures","subject":"Runs","acceptance":"Show native conclusions"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", server.URL)
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, requestErr := server.Client().Do(request)
		if requestErr == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("authoring did not start")
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("disconnected client retained authoring authority")
	}
	<-done
	status, result := queueRequest(t, local, server, "POST", "/__query_designer",
		`{"intent":"Find failures","subject":"Runs","acceptance":"Show native conclusions"}`, "")
	if status < 500 || bytes.Contains(result, []byte("private model prompt")) {
		t.Fatalf("authoring failure exposed private details: status %d", status)
	}
}
