package auditdelivery

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDestinationConformanceFixture(t *testing.T) {
	_, destination := newFixture(t)
	destinationConformance(t, destination)
}

// TestDestinationConformance is opt-in and writes a unique test prefix. It does
// not delete evidence or assert administrative immutability/retention settings.
func TestDestinationConformance(t *testing.T) {
	endpoint := os.Getenv("CAO_AUDIT_CONFORMANCE_URL")
	if endpoint == "" {
		t.Skip("set CAO_AUDIT_CONFORMANCE_URL and CAO_AUDIT_CONFORMANCE_TOKEN for an explicit adapter test")
	}
	destination, err := NewHTTPDestination(endpoint, os.Getenv("CAO_AUDIT_CONFORMANCE_TOKEN"))
	if err != nil {
		t.Fatal(err)
	}
	destinationConformance(t, destination)
}

func destinationConformance(t *testing.T, destination *HTTPDestination) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	_, options := seededSource(t, 2)
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	options.Stream = "conformance-" + hex.EncodeToString(id[:])
	checkpoint := Checkpoint{Version: 1, Stream: options.Stream, Delivered: options.Bootstrap.Head,
		VerifiedAt: time.Now().UTC()}
	checkpoint.Verification.LastSequence = checkpoint.Delivered.Sequence
	checkpoint.Verification.LastHash = checkpoint.Delivered.Hash
	_, _, exists, err := destination.Load(ctx, options.Stream)
	if err != nil || exists {
		t.Fatalf("fresh prefix read: exists=%v, err=%v", exists, err)
	}
	key := options.Stream + "/events/00000000000000000001.json"
	body := []byte(`{"conformance":"create-only-exact-readback"}`)
	if err := destination.Create(ctx, key, body); err != nil {
		t.Fatal(err)
	}
	if err := destination.Create(ctx, key, body); err != nil {
		t.Fatalf("exact replay: %v", err)
	}
	if err := destination.Create(ctx, key, []byte(`{"conformance":"conflicting-content"}`)); err == nil {
		t.Fatal("conflicting object accepted")
	}
	if err := destination.confirm(ctx, key, body, false); err != nil {
		t.Fatalf("create-only object was overwritten: %v", err)
	}
	if err := destination.Commit(ctx, options.Stream, checkpoint, ""); err != nil {
		t.Fatal(err)
	}
	loaded, version, exists, err := destination.Load(ctx, options.Stream)
	if err != nil || !exists || loaded.Delivered != checkpoint.Delivered {
		t.Fatalf("checkpoint load: %+v %v", loaded, err)
	}
	checkpoint.VerifiedAt = checkpoint.VerifiedAt.Add(time.Nanosecond)
	if err := destination.Commit(ctx, options.Stream, checkpoint, version); err != nil {
		t.Fatalf("checkpoint CAS: %v", err)
	}
	// A stale writer must not move the destination backwards, even if all its
	// event objects were already acknowledged.
	if err := destination.Commit(ctx, options.Stream, loaded, version); err == nil {
		t.Fatal("stale checkpoint CAS accepted")
	}
	if err := destination.Commit(ctx, options.Stream, loaded, ""); err == nil {
		t.Fatal("checkpoint reinitialization accepted")
	}
	current, _, _, err := destination.Load(ctx, options.Stream)
	if err != nil || !current.VerifiedAt.Equal(checkpoint.VerifiedAt) {
		t.Fatal("conflict overwrote newer checkpoint")
	}
	other := options.Stream + "-other"
	if _, _, exists, err := destination.Load(ctx, other); err != nil || exists {
		t.Fatal("checkpoint crossed namespace boundary")
	}
	t.Logf("Adapter protocol exercised in retained prefix %s; this is not retention or WORM evidence.", options.Stream)
}

func TestHTTPBoundaries(t *testing.T) {
	for _, fault := range []string{"accepted_async", "mismatched", "oversized", "missing", "redirect", "weak_etag"} {
		t.Run(fault, func(t *testing.T) {
			var redirected atomic.Int64
			target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				redirected.Add(1)
				w.WriteHeader(http.StatusOK)
			}))
			t.Cleanup(target.Close)
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if fault == "redirect" {
					http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
					return
				}
				if fault == "accepted_async" {
					w.WriteHeader(http.StatusAccepted)
					return
				}
				if fault == "weak_etag" {
					w.Header().Set("ETag", `W/"1"`)
					_, _ = w.Write([]byte(`{}`))
					return
				}
				if r.Method == http.MethodPut {
					w.WriteHeader(http.StatusCreated)
					return
				}
				switch fault {
				case "oversized":
					_, _ = w.Write(bytes.Repeat([]byte("x"), maxObjectBytes+1))
				case "missing":
					w.WriteHeader(http.StatusNotFound)
				default:
					_, _ = w.Write([]byte(`{"token":"must-not-appear-in-error"}`))
				}
			}))
			t.Cleanup(srv.Close)
			destination, err := NewHTTPDestination(srv.URL, "test-only-token")
			if err != nil {
				t.Fatal(err)
			}
			destination.client.Transport = srv.Client().Transport
			if fault == "weak_etag" {
				_, _, _, err = destination.Load(t.Context(), "stream")
			} else {
				err = destination.Create(t.Context(), "stream/events/1.json", []byte(`{}`))
			}
			if err == nil || strings.Contains(err.Error(), "must-not-appear") || strings.Contains(err.Error(), srv.URL) {
				t.Fatalf("unsafe result: %v", err)
			}
			if redirected.Load() != 0 {
				t.Fatal("followed credential-bearing redirect")
			}
		})
	}
}

func TestHTTPDeadlineAndConfiguration(t *testing.T) {
	for _, endpoint := range []string{"http://example.test", "https://user:password@example.test", "https://example.test?secret=x", "https://example.test#x", ""} {
		if _, err := NewHTTPDestination(endpoint, "secret"); err == nil {
			t.Fatalf("accepted unsafe endpoint %q", endpoint)
		}
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	destination, err := NewHTTPDestination(srv.URL, "test-only-token")
	if err != nil {
		t.Fatal(err)
	}
	destination.client.Transport = srv.Client().Transport
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	if _, _, _, err := destination.Load(ctx, "stream"); err == nil {
		t.Fatal("request deadline did not interrupt read")
	}
}

func TestAcknowledgementLossReplaysSafely(t *testing.T) {
	fixture, destination := newFixture(t)
	store, options := seededSource(t, 2)
	fixture.reject = func(r *http.Request) bool {
		return r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/events/")
	}
	if _, err := Run(t.Context(), store, destination, options); err == nil {
		t.Fatal("missing delivery readback accepted")
	}
	fixture.mu.Lock()
	fixture.reject = nil
	fixture.mu.Unlock()
	if _, err := Run(t.Context(), store, destination, options); err != nil {
		t.Fatal(err)
	}
	body, _, _, err := destination.request(t.Context(), http.MethodGet, options.Stream+"/events/00000000000000000001.json", nil, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var event Envelope
	if err := json.Unmarshal(body, &event); err != nil || event.Event.Sequence != 1 {
		t.Fatalf("retained event: %+v %v", event, err)
	}
}
