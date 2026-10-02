package simulator

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSyntheticHistoryPaginatesAndRestrictsSevenDays(t *testing.T) {
	asOf := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	scenario := Scenario{
		Name: "enterprise-history", Repositories: 50_000,
		History: &History{Days: 14, RunsPerDay: 1, AsOf: asOf.Format(time.RFC3339)},
	}
	api, err := NewAPIHandler(scenario, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, page := range []int{1, 500} {
		response := httptest.NewRecorder()
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet,
			"http://127.0.0.1/api/v3/installation/repositories?page="+strconv.Itoa(page)+"&per_page=100", nil)
		api.ServeHTTP(response, request)
		var body struct {
			Total        int `json:"total_count"`
			Repositories []struct {
				FullName string `json:"full_name"`
			} `json:"repositories"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || len(body.Repositories) != 100 || body.Total != 50_000 {
			t.Fatalf("enterprise repository page %d = %+v", page, body)
		}
		if page == 1 && !strings.Contains(response.Header().Get("Link"), "page=2") {
			t.Fatal("repository enumeration lost the next-page link")
		}
		if page == 500 && (body.Repositories[99].FullName != "simulator/repo-50000" || response.Header().Get("Link") != "") {
			t.Fatal("final enterprise repository page is incorrect")
		}
	}
	created := asOf.Add(-7*24*time.Hour+time.Second).Format(time.RFC3339) + ".." + asOf.Format(time.RFC3339)
	total := 0
	for page := 1; page <= 4; page++ {
		response := httptest.NewRecorder()
		path := "http://127.0.0.1/api/v3/repos/simulator/repo-50000/actions/runs?per_page=2&page=" +
			strconv.Itoa(page) + "&created=" + url.QueryEscape(created)
		api.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		var body struct {
			Total int             `json:"total_count"`
			Runs  []HistoricalRun `json:"workflow_runs"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || body.Total != 7 {
			t.Fatal("synthetic API did not apply the seven-day created filter")
		}
		for _, run := range body.Runs {
			if run.CreatedAt.Before(asOf.Add(-7*24*time.Hour)) || run.ID != scenario.History.Run(49_999, total).ID {
				t.Fatal("paginated history returned a run outside the horizon or in the wrong order")
			}
			total++
		}
	}
	if total != 7 {
		t.Fatalf("windowed historical runs = %d, want 7", total)
	}
}

func TestSyntheticLakeIsDeterministicAndManifested(t *testing.T) {
	scenario := Scenario{
		Name: "lake", Repositories: 2,
		History: &History{Days: 14, RunsPerDay: 2, AsOf: "2026-10-01T12:00:00Z"},
	}
	var previous []byte
	for attempt := 0; attempt < 2; attempt++ {
		directory := t.TempDir()
		result, err := scenario.WriteLake(t.Context(), directory, 7)
		if err != nil {
			t.Fatal(err)
		}
		if result.Runs != 28 || result.Repositories != 2 {
			t.Fatalf("synthetic lake counts = %+v", result)
		}
		content, err := os.ReadFile(filepath.Join(directory, "gh-aw-logs-runs/synthetic.jsonl")) // #nosec G304 -- generated file in the test's temporary lake.
		if err != nil {
			t.Fatal(err)
		}
		if attempt != 0 && string(content) != string(previous) {
			t.Fatal("synthetic canonical evidence is not deterministic")
		}
		previous = content
		manifest, err := os.ReadFile(filepath.Join(directory, "payload-hashes.json")) // #nosec G304 -- generated manifest in the test's temporary lake.
		if err != nil {
			t.Fatal(err)
		}
		var hashes map[string]string
		if err := json.Unmarshal(manifest, &hashes); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(content)
		if hashes["gh-aw-logs-runs/synthetic.jsonl"] != hex.EncodeToString(hash[:]) {
			t.Fatal("synthetic evidence manifest has an invalid hash")
		}
	}
}
