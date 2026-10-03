package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func backfillDebugTelemetry(t *testing.T, ctx context.Context) {
	t.Helper()
	if os.Getenv("CAO_BACKFILL_INTEGRATION") == "1" {
		backfillTelemetry(t, ctx, fmt.Sprintf("cao-backfill-fault-%d", time.Now().UnixNano()))
	}
}

func downloadBackfillTelemetry(t *testing.T, ctx context.Context, service string) {
	t.Helper()
	directory := os.Getenv("CAO_BACKFILL_REPORT_DIR")
	if directory == "" {
		directory = "../../../.tmp/go-backfill"
	}
	if err := os.MkdirAll(directory, 0o750); err != nil { // #nosec G703 -- operator-selected local diagnostic directory.
		t.Fatal("create OTEL diagnostic report directory")
	}
	for _, signal := range []string{"traces", "logs", "metrics"} {
		if signal == "logs" && os.Getenv("CAO_BACKFILL_OTEL_LOGS") != "1" {
			continue
		}
		var streams struct {
			List []struct {
				Name string `json:"name"`
			} `json:"list"`
		}
		backfillObserveRequest(t, ctx, "streams?type="+signal, nil, &streams)
		evidence := map[string][]map[string]any{}
		for _, stream := range streams.List {
			// Histogram parent streams are metadata-only in OpenObserve.
			// Download counters; root-span durations retain the timing evidence.
			if signal == "metrics" && !strings.HasSuffix(stream.Name, "_count") && !strings.HasSuffix(stream.Name, ".count") {
				continue
			}
			filter := fmt.Sprintf(" WHERE service_name = '%s'", service)
			if signal == "metrics" {
				filter = ""
			}
			rows := backfillObserveSearch(t, ctx, signal,
				fmt.Sprintf(`SELECT * FROM "%s"%s ORDER BY _timestamp DESC`, stream.Name, filter), time.Now().Add(-time.Hour))
			evidence[stream.Name] = rows
		}
		if signal == "logs" && len(evidence) == 0 {
			t.Error("OpenObserve did not retain diagnostic logs")
		}
		writeBackfillEvidence(t, directory, service, signal, map[string]any{
			"test": t.Name(), "service": service, "signal": signal, "maxRowsPerStream": 1000, "streams": evidence,
		})
	}
}

func writeBackfillEvidence(t *testing.T, directory, service, signal string, evidence any) {
	t.Helper()
	content, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G703 -- generated service identifiers and fixed signal names under the local report directory.
	if err := os.WriteFile(filepath.Join(directory, "otel-"+service+"-"+signal+".json"), content, 0o600); err != nil {
		t.Fatal("write OTEL diagnostic report")
	}
}
