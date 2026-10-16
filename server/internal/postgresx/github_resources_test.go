package postgresx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestGitHubResourcesPersistAcrossConnectionsAndNamespaces(t *testing.T) {
	store, config := nativeTestStore(t)
	reopened, err := NewConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	other, err := NewConfig(t.Context(), config, "other")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	for _, test := range []struct{ name, body string }{
		{"repository", `{"full_name":"owner/repo","description":"<test> & value","html_url":"https://github.com/owner/repo","default_branch":"main","stargazers_count":42,"forks_count":3,"open_issues_count":2,"archived":false,"visibility":"public"}`},
		{"release", `{"tag_name":"v1","name":null,"html_url":"https://github.com/owner/repo/releases/tag/v1","published_at":null,"draft":false,"prerelease":true}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			entry := GitHubResource{Body: []byte(test.body), ETag: `"normalized"`, UpstreamETag: `"upstream"`, Validated: time.Now().UTC().Truncate(time.Microsecond)}
			if err := store.WriteGitHubResource(t.Context(), test.name, entry); err != nil {
				t.Fatal(err)
			}
			got, found, err := reopened.ReadGitHubResource(t.Context(), test.name)
			if err != nil || !found || got.ETag != entry.ETag || got.UpstreamETag != entry.UpstreamETag || !got.Validated.Equal(entry.Validated) {
				t.Fatalf("persisted resource missing or changed: found=%t err=%v", found, err)
			}
			// Compare the same HTML-escaped normalized wire representation.
			expected, err := json.Marshal(json.RawMessage(entry.Body))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.Body, expected) {
				t.Fatalf("normalized resource changed: %s != %s", got.Body, expected)
			}
			if _, found, err := other.ReadGitHubResource(t.Context(), test.name); err != nil || found {
				t.Fatalf("namespace isolation failed: found=%t err=%v", found, err)
			}
			if err := reopened.DeleteGitHubResource(t.Context(), test.name); err != nil {
				t.Fatal(err)
			}
			if _, found, err := store.ReadGitHubResource(t.Context(), test.name); err != nil || found {
				t.Fatalf("deleted resource remains: found=%t err=%v", found, err)
			}
		})
	}
}

func TestGitHubResourceStorageBoundExpiryAndNamespaceDeletion(t *testing.T) {
	store, config := nativeTestStore(t)
	replica, err := NewConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = replica.Close() }()
	entry := GitHubResource{Body: []byte(`{"full_name":"owner/repo","html_url":"https://github.com/owner/repo"}`), ETag: `"v1"`, Validated: time.Now()}
	var group sync.WaitGroup
	for _, writer := range []*Store{store, replica} {
		group.Go(func() {
			for index := range GitHubResourceEntries/2 + 5 {
				if err := writer.WriteGitHubResource(t.Context(), fmt.Sprintf("%p:%d", writer, index), entry); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	group.Wait()
	var count int
	if err := store.db.QueryRowContext(t.Context(), "SELECT count(*) FROM cao_github_resources WHERE namespace=$1", store.namespace).Scan(&count); err != nil || count != GitHubResourceEntries {
		t.Fatalf("replica budget: count=%d err=%v", count, err)
	}
	entry.Validated = time.Now().Add(-GitHubResourceKeepFor - time.Minute)
	if err := store.WriteGitHubResource(t.Context(), "expired", entry); err != nil {
		t.Fatal(err)
	}
	if _, found, err := replica.ReadGitHubResource(t.Context(), "expired"); err != nil || found {
		t.Fatalf("expired resource visible: found=%t err=%v", found, err)
	}
	if err := store.DeleteNamespace(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(t.Context(), "SELECT count(*) FROM cao_github_resources WHERE namespace=$1", store.namespace).Scan(&count); err != nil || count != 0 {
		t.Fatalf("deleted namespace retained resources: count=%d err=%v", count, err)
	}
}
