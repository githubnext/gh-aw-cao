package simulator

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"path"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	GatewayRepositoryID   = 1001
	GatewayRepositoryName = "simulator/repo-00001"
	GatewayOwnerID        = 42
	gatewayWorkflowPrefix = ".github/workflows/"
	gatewayRepositoryPath = "/repos/" + GatewayRepositoryName
	gatewayReceivingToken = "simulator-gateway-receiving-token"
	gatewayDispatchToken  = "simulator-gateway-dispatch-token"
)

// GatewayDispatch records only synthetic dispatch payloads, never credentials.
type GatewayDispatch struct {
	EventType  string
	Payload    json.RawMessage
	APIVersion string
}

type GatewayStats struct {
	TokenMints, HeadReads, WorkflowLists, WorkflowReads int
}

// GatewayAPI is an opt-in, bounded GitHub fixture for one private synthetic
// repository and separate receiving (App/installation 1) and dispatch (2) roles.
// App JWT signatures are not verified; this is not a GitHub authentication emulator.
type GatewayAPI struct {
	mu         sync.Mutex
	head       string
	revisions  map[string]map[string][]byte
	dispatches []GatewayDispatch
	stats      GatewayStats
}

func NewGatewayAPI(workflows map[string][]byte) (*GatewayAPI, error) {
	api := &GatewayAPI{revisions: make(map[string]map[string][]byte)}
	if err := api.Publish(strings.Repeat("a", 40), workflows); err != nil {
		return nil, err
	}
	return api, nil
}

// Publish atomically advances main while preserving immutable commit reads.
// Eight revisions of at most 16 MiB each bound a simulation's retained fixtures.
func (a *GatewayAPI) Publish(commit string, workflows map[string][]byte) error {
	if len(commit) != 40 || commit != strings.ToLower(commit) || len(workflows) > 128 {
		return errors.New("invalid simulator workflow revision")
	}
	if _, err := hex.DecodeString(commit); err != nil {
		return errors.New("invalid simulator workflow commit")
	}
	frozen := make(map[string][]byte, len(workflows))
	total := 0
	for name, data := range workflows {
		if path.Clean(name) != name || path.Dir(name) != strings.TrimSuffix(gatewayWorkflowPrefix, "/") ||
			!strings.HasSuffix(name, ".lock.yml") || len(data) > 8<<20 {
			return errors.New("invalid simulator workflow artifact")
		}
		total += len(data)
		if total > 16<<20 {
			return errors.New("simulator workflow fixtures exceed capacity")
		}
		frozen[name] = bytes.Clone(data)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if previous, exists := a.revisions[commit]; exists {
		if !maps.EqualFunc(previous, frozen, bytes.Equal) {
			return errors.New("simulator workflow commits are immutable")
		}
	} else if len(a.revisions) >= 8 {
		return errors.New("simulator workflow revision capacity exceeded")
	}
	a.revisions[commit], a.head = frozen, commit
	return nil
}

func (a *GatewayAPI) Stats() GatewayStats {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.stats
}

func (a *GatewayAPI) Dispatches() []GatewayDispatch {
	a.mu.Lock()
	defer a.mu.Unlock()
	result := slices.Clone(a.dispatches)
	for i := range result {
		result[i].Payload = bytes.Clone(result[i].Payload)
	}
	return result
}

func (a *GatewayAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	setRateHeaders(w, successRate(APIWindow{}, nil))
	w.Header().Set("Content-Type", "application/json")
	endpoint := strings.TrimPrefix(r.URL.Path, "/api/v3")
	if strings.HasPrefix(endpoint, "/app/installations/") {
		a.installation(w, r, endpoint)
		return
	}
	scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if scheme != "token" && scheme != "Bearer" || token != gatewayReceivingToken && token != gatewayDispatchToken {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodGet && (endpoint == "/repositories/1001" || endpoint == gatewayRepositoryPath):
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": GatewayRepositoryID, "full_name": GatewayRepositoryName, "default_branch": "main",
			"private": true, "visibility": "private",
			"owner":       map[string]any{"id": GatewayOwnerID, "type": "Organization", "login": "simulator"},
			"permissions": map[string]bool{"push": token == gatewayDispatchToken},
		})
	case r.Method == http.MethodGet && endpoint == gatewayRepositoryPath+"/git/ref/heads/main":
		a.stats.HeadReads++
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"type": "commit", "sha": a.head}})
	case r.Method == http.MethodGet && strings.HasPrefix(endpoint, gatewayRepositoryPath+"/contents/"):
		a.contents(w, r, strings.TrimPrefix(endpoint, gatewayRepositoryPath+"/contents/"))
	case r.Method == http.MethodPost && endpoint == gatewayRepositoryPath+"/dispatches":
		if token != gatewayDispatchToken {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		a.dispatch(w, r)
	default:
		writeNotFound(w)
	}
}

func (a *GatewayAPI) installation(w http.ResponseWriter, r *http.Request, endpoint string) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	id := strings.TrimPrefix(endpoint, "/app/installations/")
	mint := strings.HasSuffix(id, "/access_tokens")
	id = strings.TrimSuffix(id, "/access_tokens")
	if id != "1" && id != "2" {
		writeNotFound(w)
		return
	}
	permissions := map[string]string{"metadata": "read", "contents": "read", "actions": "read", "vulnerability_alerts": "read"}
	token := gatewayReceivingToken
	appID := 1
	if id == "2" {
		permissions["contents"], permissions["actions"] = "write", "write"
		token, appID = gatewayDispatchToken, 2
	}
	switch {
	case mint && r.Method == http.MethodPost:
		var request struct {
			RepositoryIDs []int64 `json:"repository_ids"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 4097))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF ||
			len(request.RepositoryIDs) != 1 || request.RepositoryIDs[0] != GatewayRepositoryID {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
		a.stats.TokenMints++
		_ = json.NewEncoder(w).Encode(map[string]any{"token": token, "permissions": permissions,
			"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	case !mint && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode(map[string]any{"id": appID, "app_id": appID, "permissions": permissions,
			"account": map[string]any{"id": GatewayOwnerID, "login": "simulator", "type": "Organization"}})
	default:
		writeNotFound(w)
	}
}

func (a *GatewayAPI) contents(w http.ResponseWriter, r *http.Request, name string) {
	files, exists := a.revisions[r.URL.Query().Get("ref")]
	if !exists {
		writeNotFound(w)
		return
	}
	if name == strings.TrimSuffix(gatewayWorkflowPrefix, "/") {
		a.stats.WorkflowLists++
		names := slices.Sorted(maps.Keys(files))
		listing := make([]map[string]any, 0, len(names))
		for _, name := range names {
			listing = append(listing, map[string]any{"path": name, "type": "file", "size": len(files[name])})
		}
		_ = json.NewEncoder(w).Encode(listing)
		return
	}
	data, exists := files[name]
	if !exists {
		writeNotFound(w)
		return
	}
	if r.Header.Get("Accept") != "application/vnd.github.raw+json" {
		w.WriteHeader(http.StatusNotAcceptable)
		return
	}
	a.stats.WorkflowReads++
	w.Header().Set("Content-Type", "application/vnd.github.raw+json")
	_, _ = w.Write(data) // #nosec G705 -- fixture workflow served as application/vnd.github.raw+json, not HTML; preserve exact source bytes.
}

func (a *GatewayAPI) dispatch(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, 65536))
	if err != nil || len(data) >= 65536 {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	var request struct {
		EventType string                     `json:"event_type"`
		Payload   map[string]json.RawMessage `json:"client_payload"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF ||
		request.EventType == "" || len(request.EventType) > 100 || request.Payload == nil {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	if len(a.dispatches) >= 128 {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	a.dispatches = append(a.dispatches, GatewayDispatch{
		EventType: request.EventType, Payload: data, APIVersion: r.Header.Get("X-GitHub-Api-Version"),
	})
	w.WriteHeader(http.StatusNoContent)
}
