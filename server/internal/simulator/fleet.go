package simulator

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-cao/server/internal/clock"
)

type FleetRepository struct {
	ID       int64
	Name     string
	Archived bool
	Deleted  bool
}

type FleetStats struct {
	Discovered int `json:"workflowDiscoveries"`
	Dispatches int `json:"dispatches"`
	Reviews    int `json:"reviews"`
}

// FleetAPI serves only synthetic repository metadata and campaign declarations.
// Dispatches do not run Actions. Reviews are separate deterministic completions.
type FleetAPI struct {
	Clock    clock.Provider
	Workflow []byte
	// A single control repository owns the campaign; target repositories have
	// empty workflow inventories and do not execute workflows.
	WorkflowRepositoryID int64
	mu                   sync.Mutex
	repos                []FleetRepository
	stats                FleetStats
}

func (f *FleetAPI) Create() FleetRepository {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := int64(len(f.repos) + 1001)
	repo := FleetRepository{ID: id, Name: fmt.Sprintf("simulator/repo-%05d", id)}
	f.repos = append(f.repos, repo)
	return repo
}

func (f *FleetAPI) Repositories() []FleetRepository {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.repos)
}

func (f *FleetAPI) Retire(id int64, deleted bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	repo := &f.repos[id-1001]
	repo.Archived, repo.Deleted = !deleted, deleted
}

func (f *FleetAPI) Stats() FleetStats {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stats
}

func (f *FleetAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	endpoint := strings.TrimPrefix(r.URL.Path, "/api/v3")
	if strings.HasPrefix(endpoint, "/app/installations/") && strings.HasSuffix(endpoint, "/access_tokens") {
		id := strings.TrimSuffix(strings.TrimPrefix(endpoint, "/app/installations/"), "/access_tokens")
		// These are public fixture strings, not credentials.
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "simulator-installation-" + id,
			"expires_at":  clock.Now(f.Clock).Add(365 * 24 * time.Hour),
			"permissions": map[string]string{"contents": "write", "metadata": "read", "pull_requests": "write"}})
		return
	}
	var repo FleetRepository
	for _, candidate := range f.repos {
		if endpoint == "/repositories/"+strconv.FormatInt(candidate.ID, 10) ||
			strings.HasPrefix(endpoint, "/repos/"+candidate.Name+"/") {
			repo = candidate
			break
		}
	}
	if repo.ID == 0 || repo.Deleted {
		writeNotFound(w)
		return
	}
	prefix := "/repos/" + repo.Name
	switch {
	case r.Method == http.MethodGet && strings.HasPrefix(endpoint, "/repositories/"):
		_ = json.NewEncoder(w).Encode(map[string]any{"id": repo.ID, "full_name": repo.Name,
			"default_branch": "main", "private": true, "visibility": "private", "archived": repo.Archived,
			"owner": map[string]any{"id": GatewayOwnerID, "type": "Organization", "login": "simulator"}})
	case repo.Archived:
		w.WriteHeader(http.StatusForbidden)
	case r.Method == http.MethodGet && endpoint == prefix+"/git/ref/heads/main":
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"type": "commit", "sha": strings.Repeat("a", 40)}})
	case r.Method == http.MethodGet && endpoint == prefix+"/contents/.github/workflows":
		f.stats.Discovered++
		files := []map[string]any{}
		if repo.ID == f.WorkflowRepositoryID {
			files = append(files, map[string]any{"path": ".github/workflows/test.lock.yml", "type": "file", "size": len(f.Workflow)})
		}
		_ = json.NewEncoder(w).Encode(files)
	case r.Method == http.MethodGet && endpoint == prefix+"/contents/.github/workflows/test.lock.yml":
		if repo.ID != f.WorkflowRepositoryID {
			writeNotFound(w)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.github.raw+json")
		_, _ = w.Write(f.Workflow)
	case r.Method == http.MethodPost && endpoint == prefix+"/dispatches":
		f.stats.Dispatches++
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && strings.HasPrefix(endpoint, prefix+"/pulls/") && strings.HasSuffix(endpoint, "/reviews"):
		f.stats.Reviews++
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"state":"COMMENTED","body":"Synthetic vulnerability review; no inference performed."}`))
	default:
		writeNotFound(w)
	}
}
