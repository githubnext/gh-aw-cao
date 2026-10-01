package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/repositorymemory"
)

var repositoryMemoryLog = logger.New("cao:server:repository-memory")

func (a *App) repositoryMemoryCampaign(response http.ResponseWriter, request *http.Request) {
	campaignID := request.PathValue("campaign")
	if !repositorymemory.ValidCampaign(campaignID) {
		writeError(response, http.StatusBadRequest, "repository-memory campaign is invalid")
		return
	}
	_, campaign, err := a.repositoryMemorySnapshot(request, campaignID)
	if err != nil && a.memory != nil &&
		(errors.Is(err, errCanonicalEntityNotFound) || errors.Is(err, redisx.ErrSourceUnavailable)) {
		resolved, resolveErr := a.memory.Campaign(request.Context(), campaignID)
		if resolveErr != nil {
			writeRepositoryMemoryError(response, resolveErr)
			return
		}
		if resolved == nil {
			writeJSON(response, http.StatusOK, nil)
			return
		}
		campaign = *resolved
		err = nil
	}
	if errors.Is(err, errCanonicalEntityNotFound) {
		writeJSON(response, http.StatusOK, nil)
		return
	}
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "repository memory is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, campaign)
}

func (a *App) repositoryMemoryContent(response http.ResponseWriter, request *http.Request) {
	campaignID := request.PathValue("campaign")
	filePath := request.URL.Query().Get("path")
	if !repositorymemory.ValidCampaign(campaignID) || !repositorymemory.ValidPath(filePath) {
		writeError(response, http.StatusBadRequest, "repository-memory file path is invalid")
		return
	}
	generation, campaign, err := a.repositoryMemorySnapshot(request, campaignID)
	if err != nil && a.memory != nil &&
		(errors.Is(err, errCanonicalEntityNotFound) || errors.Is(err, redisx.ErrSourceUnavailable)) {
		content, resolveErr := a.memory.Content(request.Context(), campaignID, filePath)
		if errors.Is(resolveErr, repositorymemory.ErrNotFound) ||
			(resolveErr == nil && content == nil) {
			writeError(response, http.StatusNotFound, "repository-memory file was not found")
			return
		}
		if resolveErr != nil {
			writeRepositoryMemoryError(response, resolveErr)
			return
		}
		writeJSON(response, http.StatusOK, map[string]string{"content": string(content)})
		return
	}
	if errors.Is(err, errCanonicalEntityNotFound) {
		writeError(response, http.StatusNotFound, "repository-memory branch was not found")
		return
	}
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "repository memory is unavailable")
		return
	}
	var selected *repositorymemory.File
	for index := range campaign.Files {
		if campaign.Files[index].Path == filePath {
			selected = &campaign.Files[index]
			break
		}
	}
	if selected == nil {
		writeError(response, http.StatusNotFound, "repository-memory file was not found")
		return
	}
	content, err := a.dashboardDatabase().RepositoryMemoryFile(request.Context(), generation, campaignID, filePath)
	if err != nil {
		if errors.Is(err, redisx.ErrSourceUnavailable) {
			writeError(response, http.StatusNotFound, "repository-memory file was not found")
			return
		}
		writeError(response, http.StatusServiceUnavailable, "repository memory is unavailable")
		return
	}
	if reason, ok := repositoryMemoryIntegrityFailure(content, *selected); !ok {
		repositoryMemoryLog.Printf("repository-memory file failed integrity validation reason=%s", reason)
		writeError(response, http.StatusServiceUnavailable, "repository-memory file failed integrity validation")
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"content": string(content)})
}

// repositoryMemoryIntegrityReason names why repositoryMemoryIntegrityFailure
// rejected a fetched file, stable across message wording changes so it is
// useful to log without exposing the file's path or content.
type repositoryMemoryIntegrityReason string

const (
	repositoryMemoryIntegrityReasonSizeMismatch   repositoryMemoryIntegrityReason = "size-mismatch"
	repositoryMemoryIntegrityReasonSHA256Mismatch repositoryMemoryIntegrityReason = "sha256-mismatch"
)

// repositoryMemoryIntegrityFailure validates fetched content against the
// manifest's recorded size and, when present, SHA-256 checksum. It is a pure
// function extracted from repositoryMemoryContent so the size-mismatch and
// checksum-mismatch rejection paths are independently testable without a
// Redis-backed store. ok is false when content fails validation; reason then
// names which check failed.
func repositoryMemoryIntegrityFailure(content []byte, expected repositorymemory.File) (reason repositoryMemoryIntegrityReason, ok bool) {
	if int64(len(content)) != expected.Size {
		return repositoryMemoryIntegrityReasonSizeMismatch, false
	}
	if expected.SHA256 != "" {
		sum := sha256.Sum256(content)
		if !strings.EqualFold(expected.SHA256, hex.EncodeToString(sum[:])) {
			return repositoryMemoryIntegrityReasonSHA256Mismatch, false
		}
	}
	return "", true
}

func (a *App) repositoryMemorySnapshot(request *http.Request, campaignID string) (string, repositorymemory.Campaign, error) {
	active, err := a.dashboardDatabase().Active(request.Context())
	if err != nil || active.Generation == "" {
		return "", repositorymemory.Campaign{}, redisx.ErrSourceUnavailable
	}
	content, err := a.dashboardDatabase().RepositoryMemoryManifest(request.Context(), active.Generation)
	if err != nil {
		return "", repositorymemory.Campaign{}, err
	}
	var manifest repositorymemory.Manifest
	if err := json.Unmarshal(content, &manifest); err != nil || manifest.Version != 1 {
		return "", repositorymemory.Campaign{}, errors.New("repository-memory manifest is invalid")
	}
	for _, campaign := range manifest.Campaigns {
		if campaign.Campaign == campaignID {
			return active.Generation, campaign, nil
		}
	}
	return active.Generation, repositorymemory.Campaign{}, errCanonicalEntityNotFound
}

func writeRepositoryMemoryError(response http.ResponseWriter, err error) {
	if retryAfter, throttled := repositorymemory.RetryAfterSeconds(err); throttled {
		response.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeError(response, http.StatusTooManyRequests, "repository memory is temporarily throttled")
		return
	}
	writeError(response, http.StatusServiceUnavailable, "repository memory is unavailable")
}
