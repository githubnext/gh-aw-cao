package collect

import (
	"slices"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
)

func TestNormalizeEnumeratedRepositoriesCanonicalizesAndCounts(t *testing.T) {
	pushedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	covered := []githubapp.Repository{
		{FullName: "Octo/API", PushedAt: pushedAt},
		{FullName: "octo/tools", PushedAt: pushedAt.Add(time.Hour)},
	}
	names, repositories, skipped := normalizeEnumeratedRepositories(covered)
	if skipped != 0 {
		t.Fatalf("skipped = %d, want 0", skipped)
	}
	if want := []string{"octo/api", "octo/tools"}; !equalStrings(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	if len(repositories) != 2 {
		t.Fatalf("len(repositories) = %d, want 2", len(repositories))
	}
	if repositories[0].name != "octo/api" || !repositories[0].pushedAt.Equal(pushedAt) {
		t.Fatalf("repositories[0] = %+v, want name=octo/api pushedAt=%v", repositories[0], pushedAt)
	}
	if repositories[1].name != "octo/tools" || !repositories[1].pushedAt.Equal(pushedAt.Add(time.Hour)) {
		t.Fatalf("repositories[1] = %+v", repositories[1])
	}
}

func TestNormalizeEnumeratedRepositoriesDropsInvalidReferences(t *testing.T) {
	covered := []githubapp.Repository{
		{FullName: "octo/api"},
		{FullName: "not-a-repository"},
		{FullName: ""},
		{FullName: "octo/../escape"},
	}
	names, repositories, skipped := normalizeEnumeratedRepositories(covered)
	if skipped != 3 {
		t.Fatalf("skipped = %d, want 3", skipped)
	}
	if want := []string{"octo/api"}; !equalStrings(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	if len(repositories) != 1 || repositories[0].name != "octo/api" {
		t.Fatalf("repositories = %+v", repositories)
	}
}

func TestNormalizeEnumeratedRepositoriesHandlesNoRepositories(t *testing.T) {
	names, repositories, skipped := normalizeEnumeratedRepositories(nil)
	if len(names) != 0 || len(repositories) != 0 || skipped != 0 {
		t.Fatalf("names=%v repositories=%v skipped=%d, want all empty", names, repositories, skipped)
	}
}

func equalStrings(got, want []string) bool {
	return slices.Equal(got, want)
}

func TestSortByRecencyOrdersMostRecentFirst(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	repositories := []enrolledRepository{
		{name: "octo/old", pushedAt: base},
		{name: "octo/newest", pushedAt: base.Add(2 * time.Hour)},
		{name: "octo/mid", pushedAt: base.Add(time.Hour)},
	}
	sortByRecency(repositories)
	want := []string{"octo/newest", "octo/mid", "octo/old"}
	for index, repository := range repositories {
		if repository.name != want[index] {
			t.Fatalf("repositories[%d] = %q, want %q", index, repository.name, want[index])
		}
	}
}

func TestSortByRecencyHandlesEmptyAndSingleton(t *testing.T) {
	empty := []enrolledRepository(nil)
	sortByRecency(empty)
	if len(empty) != 0 {
		t.Fatalf("empty = %v, want empty", empty)
	}
	single := []enrolledRepository{{name: "octo/api"}}
	sortByRecency(single)
	if len(single) != 1 || single[0].name != "octo/api" {
		t.Fatalf("single = %+v", single)
	}
}
