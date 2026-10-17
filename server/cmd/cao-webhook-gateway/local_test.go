package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func localEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"CAO_GATEWAY_RECEIVE_KEY_FILE", "CAO_GATEWAY_DISPATCH_KEY_FILE",
		"CAO_GATEWAY_WEBHOOK_SECRET", "CAO_GATEWAY_PREVIOUS_WEBHOOK_SECRET", "GH_TOKEN"} {
		t.Setenv(name, "")
	}
}

func TestSpecLocalHost(t *testing.T) {
	localEnvironment(t)
	t.Run("LG-H01", func(t *testing.T) {
		for _, args := range [][]string{
			{"--role=receive", "--sqlite=/tmp/forbidden.sqlite"},
			{"--role=dispatch", "--once=false"},
			{"--role=receive", "--events=issues,issue_comment,pull_request"},
			{"--role=local", "--policy=/etc/cao/cao.json"},
			{"--role=local", "--listen=127.0.0.1:8081"},
		} {
			if err := run(t.Context(), args); err == nil || !strings.Contains(err.Error(), "options") {
				t.Fatal("production/local options were combined", err)
			}
		}
		err := runLocal(t.Context(), localOptions{path: "relative.sqlite", interval: time.Minute}, &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "absolute") {
			t.Fatal("relative SQLite path accepted", err)
		}
	})
	t.Run("LG-H02", func(t *testing.T) {
		for _, name := range []string{"CAO_GATEWAY_RECEIVE_KEY_FILE", "CAO_GATEWAY_DISPATCH_KEY_FILE",
			"CAO_GATEWAY_WEBHOOK_SECRET", "CAO_GATEWAY_PREVIOUS_WEBHOOK_SECRET"} {
			t.Setenv(name, "production-credential-must-not-be-used")
			if err := validateRoleCredentials("local"); err == nil || strings.Contains(err.Error(), "must-not-be-used") {
				t.Fatal("local credential isolation failed", err)
			}
			t.Setenv(name, "")
		}
	})
	t.Run("LG-H03", func(t *testing.T) {
		server := localFixtureServer(t, nil)
		options := localOptions{apiURL: server.URL, repository: "octo/repo", events: []string{"issues"},
			path: filepath.Join(t.TempDir(), "gateway.sqlite"), interval: time.Minute, once: true}
		var output bytes.Buffer
		for range 2 {
			if err := runLocal(t.Context(), options, &output); err != nil {
				t.Fatal(err)
			}
		}
		if strings.Count(output.String(), "succeeded=1") != 2 || !strings.Contains(output.String(), "LOCAL SIMULATION") ||
			!strings.Contains(output.String(), "not remote workflow execution") {
			t.Fatal("local acceptance was not labeled or restart duplicated work", output.String())
		}
	})
	t.Run("LG-H04", func(t *testing.T) {
		observed := make(chan struct{}, 1)
		server := localFixtureServer(t, observed)
		options := localOptions{apiURL: server.URL, repository: "octo/repo", events: []string{"issues"},
			path: filepath.Join(t.TempDir(), "gateway.sqlite"), interval: time.Minute}
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		finished := make(chan error, 1)
		go func() { finished <- runLocal(ctx, options, &bytes.Buffer{}) }()
		select {
		case <-observed:
		case <-time.After(5 * time.Second):
			t.Fatal("local polling did not start")
		}
		cancel()
		select {
		case err := <-finished:
			if !errors.Is(err, context.Canceled) {
				t.Fatal("local host ignored cancellation", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("local host left polling or storage work running")
		}
		// Reopening the same database exercises the joined close/reopen path.
		options.once = true
		if err := runLocal(t.Context(), options, &bytes.Buffer{}); err != nil && !strings.Contains(err.Error(), "incomplete") {
			t.Fatal("local database unavailable after shutdown", err)
		}
	})
}

func localFixtureServer(t *testing.T, observed chan<- struct{}) *httptest.Server {
	t.Helper()
	requests := atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodGet {
			t.Error("local host attempted remote mutation")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var body string
		switch r.URL.Path {
		case "/repos/octo/repo":
			body = `{"id":42,"full_name":"octo/repo","owner":{"id":7,"type":"Organization"}}`
		case "/repos/octo/repo/events":
			body = `[{"id":"1","type":"IssuesEvent","repo":{"id":42},"payload":{"action":"opened"}}]`
			if observed != nil {
				select {
				case observed <- struct{}{}:
				default:
				}
			}
		default:
			t.Error("local host requested another repository")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if _, err := fmt.Fprint(w, body); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(func() {
		server.Close()
		if requests.Load() == 0 {
			t.Error("local host did not exercise GitHub reads")
		}
	})
	return server
}

func TestLocalStartupDoesNotCreateRelativeDatabase(t *testing.T) {
	localEnvironment(t)
	path := filepath.Join(t.TempDir(), "unused.sqlite")
	err := run(t.Context(), []string{"--role=local", "--sqlite=" + path, "--repository=octo/repo", "--poll-interval=0s"})
	if err == nil {
		t.Fatal("unbounded polling interval accepted")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid configuration created a database", err)
	}
}
