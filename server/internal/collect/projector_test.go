package collect

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// pagedScanner returns a scanRepositoriesPage that serves pages from a fixed
// slice of (repositories, nextCursor) pairs, in order, and fails the test if
// called more times than there are pages or with an unexpected cursor.
func pagedScanner(t *testing.T, pages [][]string, cursors []string) scanRepositoriesPage {
	t.Helper()
	if len(pages) != len(cursors) {
		t.Fatalf("pagedScanner: %d pages but %d cursors", len(pages), len(cursors))
	}
	calls := 0
	return func(_ context.Context, cursor string, count int) ([]string, string, error) {
		if calls >= len(pages) {
			t.Fatalf("scanPage called more times (%d) than configured pages (%d)", calls+1, len(pages))
		}
		wantCursor := ""
		if calls > 0 {
			wantCursor = cursors[calls-1]
		}
		if cursor != wantCursor {
			t.Fatalf("scanPage call %d cursor = %q, want %q", calls, cursor, wantCursor)
		}
		if count != enrolledRepositoriesPageSize {
			t.Fatalf("scanPage call %d count = %d, want %d", calls, count, enrolledRepositoriesPageSize)
		}
		page, next := pages[calls], cursors[calls]
		calls++
		return page, next, nil
	}
}

func TestCollectEnrolledRepositoriesSortsAcrossPages(t *testing.T) {
	scan := pagedScanner(t,
		[][]string{{"octo/zebra", "octo/api"}, {"octo/beta"}},
		[]string{"cursor-1", "0"},
	)
	got, err := collectEnrolledRepositories(context.Background(), 0, scan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"octo/api", "octo/beta", "octo/zebra"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("collectEnrolledRepositories() = %v, want %v", got, want)
	}
}

func TestCollectEnrolledRepositoriesStopsOnEmptyCursor(t *testing.T) {
	scan := pagedScanner(t, [][]string{{"octo/api"}}, []string{""})
	got, err := collectEnrolledRepositories(context.Background(), 0, scan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0] != "octo/api" {
		t.Fatalf("collectEnrolledRepositories() = %v, want [octo/api]", got)
	}
}

func TestCollectEnrolledRepositoriesUnboundedByDefault(t *testing.T) {
	scan := pagedScanner(t,
		[][]string{{"a", "b", "c"}, {"d", "e"}},
		[]string{"cursor-1", "0"},
	)
	got, err := collectEnrolledRepositories(context.Background(), 0, scan)
	if err != nil {
		t.Fatalf("unexpected error with no limit: %v", err)
	}
	if len(got) != 5 {
		t.Fatalf("len(got) = %d, want 5", len(got))
	}
}

func TestCollectEnrolledRepositoriesFailsWhenLimitExceeded(t *testing.T) {
	scan := pagedScanner(t,
		[][]string{{"a", "b", "c"}},
		[]string{"0"},
	)
	_, err := collectEnrolledRepositories(context.Background(), 2, scan)
	if err == nil {
		t.Fatal("expected an error once the running total exceeds the limit")
	}
	if !strings.Contains(err.Error(), "exceed the configured inventory limit of 2") {
		t.Fatalf("error = %q, want it to mention the configured limit", err.Error())
	}
}

func TestCollectEnrolledRepositoriesAllowsExactlyAtLimit(t *testing.T) {
	scan := pagedScanner(t, [][]string{{"a", "b"}}, []string{"0"})
	got, err := collectEnrolledRepositories(context.Background(), 2, scan)
	if err != nil {
		t.Fatalf("unexpected error when count equals the limit: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2", len(got))
	}
}

func TestCollectEnrolledRepositoriesPropagatesScanError(t *testing.T) {
	wantErr := errors.New("scan failed")
	scan := func(context.Context, string, int) ([]string, string, error) {
		return nil, "", wantErr
	}
	_, err := collectEnrolledRepositories(context.Background(), 0, scan)
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
}

func TestCollectEnrolledRepositoriesHandlesNoRepositories(t *testing.T) {
	scan := pagedScanner(t, [][]string{nil}, []string{""})
	got, err := collectEnrolledRepositories(context.Background(), 0, scan)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	func TestOperationalValueReconstructionMatchesActionsProfile(t *testing.T) {
		root := filepath.Join("catalog", "root")
		got := operationalValueArguments(
			root,
			filepath.Join("workspace", "activity.sqlite"),
			filepath.Join("lake", "gh-aw-logs-shards", "operational-values.jsonl"),
			"2026-09-28T16:28:53Z",
			"githubnext/gh-aw-cao",
			"30",
			true,
			2000,
		)
		want := []string{
			filepath.Join(root, "activity", "cao.mjs"),
			"operational-value",
			"--database", filepath.Join("workspace", "activity.sqlite"),
			"--root", root,
			"--output", filepath.Join("lake", "gh-aw-logs-shards", "operational-values.jsonl"),
			"--timestamp", "2026-09-28T16:28:53Z",
			"--repository", "githubnext/gh-aw-cao",
			"--retention-days", "30",
			"--history-campaign", "optimization",
			"--max-github-api-rate-limit", "-2000",
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("operational-value arguments differ from the Actions profile:\ngot  %q\nwant %q", got, want)
		}
	}

	func TestOperationalValueReconstructionOmitsUnavailableHistoryCampaign(t *testing.T) {
		arguments := operationalValueArguments(
			"catalog", "activity.sqlite", "operational-values.jsonl",
			"2026-09-28T16:28:53Z", "octo/api", "14", false, 500,
		)
		joined := strings.Join(arguments, "\n")
		if strings.Contains(joined, "--history-campaign") {
			t.Fatalf("unexpected history campaign in %q", arguments)
		}
		for _, expected := range []string{"--retention-days\n14", "--max-github-api-rate-limit\n-500"} {
			if !strings.Contains(joined, expected) {
				t.Fatalf("operational-value arguments are missing %q: %q", expected, arguments)
			}
		}
	}
	if len(got) != 0 {
		t.Fatalf("len(got) = %d, want 0", len(got))
	}
}
