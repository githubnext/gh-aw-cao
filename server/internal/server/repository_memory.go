package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/repositorymemory"
)

func (a *App) repositoryMemoryCampaign(response http.ResponseWriter, request *http.Request) {
	campaignID := request.PathValue("campaign")
	if !repositorymemory.ValidCampaign(campaignID) {
		writeError(response, http.StatusBadRequest, "repository-memory campaign is invalid")
		return
	}
	_, campaign, err := a.repositoryMemorySnapshot(request, campaignID)
	if errors.Is(err, errCanonicalEntityNotFound) {
		writeError(response, http.StatusNotFound, "repository-memory branch was not found")
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
	content, err := a.store.RepositoryMemoryFile(request.Context(), generation, campaignID, filePath)
	if err != nil {
		if errors.Is(err, redisx.ErrSourceUnavailable) {
			writeError(response, http.StatusNotFound, "repository-memory file was not found")
			return
		}
		writeError(response, http.StatusServiceUnavailable, "repository memory is unavailable")
		return
	}
	sum := sha256.Sum256(content)
	if int64(len(content)) != selected.Size ||
		(selected.SHA256 != "" && !strings.EqualFold(selected.SHA256, hex.EncodeToString(sum[:]))) {
		writeError(response, http.StatusServiceUnavailable, "repository-memory file failed integrity validation")
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"content": string(content)})
}

func (a *App) repositoryMemorySnapshot(request *http.Request, campaignID string) (string, repositorymemory.Campaign, error) {
	active, err := a.store.Active(request.Context())
	if err != nil || active.Generation == "" {
		return "", repositorymemory.Campaign{}, errors.New("repository memory is unavailable")
	}
	content, err := a.store.RepositoryMemoryManifest(request.Context(), active.Generation)
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
