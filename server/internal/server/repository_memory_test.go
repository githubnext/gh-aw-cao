package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/repositorymemory"
)

func TestRepositoryMemoryHandlers(t *testing.T) {
	content := []byte("# Context\n")
	sum := sha256.Sum256(content)
	manifest, err := json.Marshal(repositorymemory.Manifest{
		Version: 1,
		Campaigns: []repositorymemory.Campaign{{
			Campaign: "security-review",
			Branch:   "memory/security-review",
			Commit:   strings.Repeat("a", 40),
			Files: []repositorymemory.File{{
				Path:   "notes/context.md",
				OID:    strings.Repeat("b", 40),
				SHA256: hex.EncodeToString(sum[:]),
				Size:   int64(len(content)),
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	client := &repositoryMemoryClient{manifest: manifest, content: content}
	app := &App{store: redisx.NewStore(client, "test")}

	list := httptest.NewRecorder()
	listRequest := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/memory/security-review", nil)
	listRequest.SetPathValue("campaign", "security-review")
	app.repositoryMemoryCampaign(list, listRequest)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"notes/context.md"`) {
		t.Fatalf("list response = %d %s", list.Code, list.Body.String())
	}

	file := httptest.NewRecorder()
	fileRequest := httptest.NewRequestWithContext(
		t.Context(), http.MethodGet,
		"/api/v1/memory/security-review/content?path=notes%2Fcontext.md", nil,
	)
	fileRequest.SetPathValue("campaign", "security-review")
	app.repositoryMemoryContent(file, fileRequest)
	if file.Code != http.StatusOK || !strings.Contains(file.Body.String(), `"# Context\n"`) {
		t.Fatalf("content response = %d %s", file.Code, file.Body.String())
	}
}

func TestRepositoryMemoryHandlersRejectInvalidAndMissingRequests(t *testing.T) {
	manifest := []byte(`{"version":1,"campaigns":[]}`)
	app := &App{store: redisx.NewStore(&repositoryMemoryClient{manifest: manifest}, "test")}

	invalid := httptest.NewRecorder()
	invalidRequest := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/memory/INVALID", nil)
	invalidRequest.SetPathValue("campaign", "INVALID")
	app.repositoryMemoryCampaign(invalid, invalidRequest)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid campaign response = %d", invalid.Code)
	}

	missing := httptest.NewRecorder()
	missingRequest := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/memory/missing", nil)
	missingRequest.SetPathValue("campaign", "missing")
	app.repositoryMemoryCampaign(missing, missingRequest)
	if missing.Code != http.StatusOK || strings.TrimSpace(missing.Body.String()) != "null" {
		t.Fatalf("missing campaign response = %d", missing.Code)
	}
}

func TestRepositoryMemoryHandlerReportsConcurrentRefresh(t *testing.T) {
	store := redisx.NewStore(
		&repositoryMemoryClient{manifest: []byte(`{"version":1,"campaigns":[]}`)}, "test")
	app := &App{
		store:  store,
		memory: &repositorymemory.RemoteResolver{Cache: store},
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/memory/example", nil)
	request.SetPathValue("campaign", "example")

	app.repositoryMemoryCampaign(response, request)

	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("throttled response = %d Retry-After=%q", response.Code, response.Header().Get("Retry-After"))
	}
}

func TestRepositoryMemoryIntegrityFailureAcceptsMatchingContent(t *testing.T) {
	content := []byte("# Context\n")
	sum := sha256.Sum256(content)
	expected := repositorymemory.File{Size: int64(len(content)), SHA256: hex.EncodeToString(sum[:])}
	if reason, ok := repositoryMemoryIntegrityFailure(content, expected); !ok {
		t.Fatalf("expected matching content to pass integrity validation, got reason %q", reason)
	}
}

func TestRepositoryMemoryIntegrityFailureAcceptsContentWithoutRecordedChecksum(t *testing.T) {
	content := []byte("# Context\n")
	expected := repositorymemory.File{Size: int64(len(content))}
	if reason, ok := repositoryMemoryIntegrityFailure(content, expected); !ok {
		t.Fatalf("expected content without a recorded checksum to pass, got reason %q", reason)
	}
}

func TestRepositoryMemoryIntegrityFailureRejectsSizeMismatch(t *testing.T) {
	content := []byte("# Context\n")
	expected := repositorymemory.File{Size: int64(len(content)) + 1}
	reason, ok := repositoryMemoryIntegrityFailure(content, expected)
	if ok || reason != repositoryMemoryIntegrityReasonSizeMismatch {
		t.Fatalf("expected size-mismatch rejection, got ok=%t reason=%q", ok, reason)
	}
}

func TestRepositoryMemoryIntegrityFailureRejectsSHA256Mismatch(t *testing.T) {
	content := []byte("# Context\n")
	expected := repositorymemory.File{Size: int64(len(content)), SHA256: strings.Repeat("0", 64)}
	reason, ok := repositoryMemoryIntegrityFailure(content, expected)
	if ok || reason != repositoryMemoryIntegrityReasonSHA256Mismatch {
		t.Fatalf("expected sha256-mismatch rejection, got ok=%t reason=%q", ok, reason)
	}
}

func TestRepositoryMemoryIntegrityFailureIsCaseInsensitiveForSHA256(t *testing.T) {
	content := []byte("# Context\n")
	sum := sha256.Sum256(content)
	expected := repositorymemory.File{
		Size:   int64(len(content)),
		SHA256: strings.ToUpper(hex.EncodeToString(sum[:])),
	}
	if reason, ok := repositoryMemoryIntegrityFailure(content, expected); !ok {
		t.Fatalf("expected case-insensitive checksum comparison to pass, got reason %q", reason)
	}
}

func TestRepositoryMemoryContentRejectsIntegrityFailure(t *testing.T) {
	content := []byte("# Context\n")
	manifest, err := json.Marshal(repositorymemory.Manifest{
		Version: 1,
		Campaigns: []repositorymemory.Campaign{{
			Campaign: "security-review",
			Branch:   "memory/security-review",
			Commit:   strings.Repeat("a", 40),
			Files: []repositorymemory.File{{
				Path:   "notes/context.md",
				OID:    strings.Repeat("b", 40),
				SHA256: strings.Repeat("0", 64),
				Size:   int64(len(content)),
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	client := &repositoryMemoryClient{manifest: manifest, content: content}
	app := &App{store: redisx.NewStore(client, "test")}

	response := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodGet,
		"/api/v1/memory/security-review/content?path=notes%2Fcontext.md", nil,
	)
	request.SetPathValue("campaign", "security-review")
	app.repositoryMemoryContent(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("integrity-failure response = %d %s", response.Code, response.Body.String())
	}
}

type repositoryMemoryClient struct {
	manifest []byte
	content  []byte
}

func (c *repositoryMemoryClient) Do(_ context.Context, arguments ...string) (any, error) {
	switch arguments[0] {
	case "HGETALL":
		return []any{
			"revision", "1",
			"counts", "{}",
			"activatedAt", "2026-01-01T00:00:00Z",
			"evaluatedAt", "2026-01-01T00:00:00Z",
		}, nil
	case "HGET":
		if arguments[2] == "revision" {
			return "1", nil
		}
		if strings.HasSuffix(arguments[2], "manifest") {
			return string(c.manifest), nil
		}
		if len(c.content) == 0 {
			return nil, nil
		}
		return string(c.content), nil
	default:
		return nil, nil
	}
}

func (*repositoryMemoryClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}
