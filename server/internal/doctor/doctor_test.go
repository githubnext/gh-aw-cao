package doctor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type fakeClient struct {
	do func(...string) (any, error)
}

func (f fakeClient) Do(_ context.Context, arguments ...string) (any, error) {
	return f.do(arguments...)
}

func (f fakeClient) DoMany(_ context.Context, commands [][]string) ([]any, error) {
	results := make([]any, 0, len(commands))
	for _, command := range commands {
		result, err := f.do(command...)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}

// credentialedRedisURL is a fabricated Redis URL whose password must never
// reach any doctor output. It is assembled from parts so static analysis does
// not read the test fixture as a real embedded credential.
var credentialedRedisURL = "rediss://operator:" + "super-secret" + "@redis.example:6380/0"

// expectedRedactedRedisURL is what redaction must produce for it.
var expectedRedactedRedisURL = "rediss://operator:" + "***" + "@redis.example:6380/0"

func testDoctor(client fakeClient) Doctor {
	return Doctor{
		Store:     redisx.NewStore(client, "cao:test"),
		RedisURL:  credentialedRedisURL,
		Namespace: "cao:test",
		Version:   "test",
		Now: func() time.Time {
			return time.Date(2026, time.September, 25, 16, 0, 0, 0, time.UTC)
		},
	}
}

func TestRedactRedisURLNeverReportsPassword(t *testing.T) {
	redacted := redactRedisURL(credentialedRedisURL)
	if strings.Contains(redacted, "super-secret") {
		t.Fatalf("redacted URL leaked its password: %s", redacted)
	}
	if redacted != expectedRedactedRedisURL {
		t.Fatalf("redacted URL = %q", redacted)
	}
}

func TestRedisMemoryFailsWhenEvictionCanDiscardCanonicalRows(t *testing.T) {
	doctor := testDoctor(fakeClient{do: func(arguments ...string) (any, error) {
		if len(arguments) == 2 && arguments[0] == "INFO" && arguments[1] == "memory" {
			return "# Memory\r\nused_memory:734003200\r\nmaxmemory:1073741824\r\nmaxmemory_policy:allkeys-lru\r\nmem_fragmentation_ratio:1.10\r\n", nil
		}
		return nil, fmt.Errorf("unexpected command %v", arguments)
	}})
	check := doctor.checkRedisMemory(context.Background())
	if check.Status != StatusFail {
		t.Fatalf("status = %s, want fail: %+v", check.Status, check)
	}
	if !strings.Contains(check.Summary, "discarded") {
		t.Fatalf("summary does not explain the data-loss risk: %s", check.Summary)
	}
}

func TestRedisStatsFailsAfterAnyEviction(t *testing.T) {
	doctor := testDoctor(fakeClient{do: func(arguments ...string) (any, error) {
		if len(arguments) == 2 && arguments[0] == "INFO" && arguments[1] == "stats" {
			return "evicted_keys:4\r\nrejected_connections:0\r\ntotal_error_replies:1\r\n", nil
		}
		return nil, fmt.Errorf("unexpected command %v", arguments)
	}})
	check := doctor.checkRedisStats(context.Background())
	if check.Status != StatusFail {
		t.Fatalf("status = %s, want fail: %+v", check.Status, check)
	}
	if !strings.Contains(check.Remedy, "reproject") {
		t.Fatalf("remedy does not require restoring canonical data: %s", check.Remedy)
	}
}

func TestRedisTransportRejectsPlaintextRemoteEndpoint(t *testing.T) {
	doctor := Doctor{RedisURL: "redis://redis.example:6379/0"}
	check := doctor.checkRedisTransport(context.Background())
	if check.Status != StatusFail {
		t.Fatalf("status = %s, want fail: %+v", check.Status, check)
	}
	if !strings.Contains(check.Remedy, "rediss://") {
		t.Fatalf("remedy does not explain the secure transport: %s", check.Remedy)
	}
}

func TestGenerationCheckFindsUntrackedStoredGeneration(t *testing.T) {
	doctor := testDoctor(fakeClient{do: func(arguments ...string) (any, error) {
		switch arguments[0] {
		case "HGETALL":
			return []any{
				"generation", "current", "revision", "4",
				"activatedAt", "2026-09-25T15:59:00Z", "counts", "{}",
			}, nil
		case "ZRANGE":
			return []any{"current"}, nil
		case "SCAN":
			return []any{"0", []any{
				"cao:test:g:current",
				"cao:test:g:orphan",
				"cao:test:g:orphan:source:runs:rows",
			}}, nil
		default:
			return nil, fmt.Errorf("unexpected command %v", arguments)
		}
	}})
	check := doctor.checkGenerations(context.Background())
	if check.Status != StatusFail {
		t.Fatalf("status = %s, want fail: %+v", check.Status, check)
	}
	if !strings.Contains(check.Summary, "not in the reclamation registry") {
		t.Fatalf("summary = %q", check.Summary)
	}
}

func TestProfileCheckRejectsBothAcquisitionProfiles(t *testing.T) {
	values := map[string]string{
		"CAO_COLLECT_APP_ID":   "42",
		"CAO_SOURCE_DIRECTORY": "/snapshot",
	}
	doctor := Doctor{Getenv: func(name string) string { return values[name] }}
	check := doctor.checkCollectionProfile(context.Background())
	if check.Status != StatusFail {
		t.Fatalf("status = %s, want fail: %+v", check.Status, check)
	}
}

func TestRenderingsCarryStableCheckIdentifiersAndNoSecret(t *testing.T) {
	report := Report{
		SchemaVersion: ReportSchemaVersion,
		Tool:          "cao-dashboard doctor",
		Version:       "test",
		GeneratedAt:   "2026-09-25T16:00:00Z",
		Profile:       "actions",
		Namespace:     "cao:test",
		Redis:         redactRedisURL(credentialedRedisURL),
		Checks: []Check{{
			ID: "redis.connectivity", Area: areaRedis, Title: "Redis reachable",
			Status: StatusPass, Summary: "Redis answered PING",
		}},
	}
	report.Summary = summarize(report.Checks, 5*time.Millisecond)

	var text bytes.Buffer
	if err := Render(&text, report, "text"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text.String(), "[ PASS ] redis.connectivity") {
		t.Fatalf("text report lacks stable identifier:\n%s", text.String())
	}
	if strings.Contains(text.String(), "super-secret") {
		t.Fatal("text report leaked a Redis password")
	}

	var structured bytes.Buffer
	if err := Render(&structured, report, "json"); err != nil {
		t.Fatal(err)
	}
	var decoded Report
	if err := json.Unmarshal(structured.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SchemaVersion != ReportSchemaVersion || decoded.Checks[0].ID != "redis.connectivity" {
		t.Fatalf("JSON report lost its structured contract: %+v", decoded)
	}
	if strings.Contains(structured.String(), "super-secret") {
		t.Fatal("JSON report leaked a Redis password")
	}
}

func TestStrictModeTreatsWarningsAsFailure(t *testing.T) {
	report := Report{Summary: Summary{Warn: 1, Status: StatusWarn}}
	if report.Failed(false) {
		t.Fatal("warning failed non-strict report")
	}
	if !report.Failed(true) {
		t.Fatal("warning did not fail strict report")
	}
}
