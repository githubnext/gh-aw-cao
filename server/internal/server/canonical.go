package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type canonicalService struct {
	store *redisx.Store
}

var errCanonicalEntityNotFound = errors.New("canonical entity was not found")

func (service canonicalService) rows(ctx context.Context, source string) ([]model.Row, error) {
	active, err := service.store.Active(ctx)
	if err != nil {
		return nil, err
	}
	if active.Generation == "" {
		return nil, errors.New("dashboard data is unavailable")
	}
	engine := query.New(&generationLoader{ctx: ctx, store: service.store, generation: active.Generation})
	sources, _, err := engine.Execute(nil, []string{source})
	if err != nil {
		return nil, err
	}
	return sources[source].Rows, nil
}

func (service canonicalService) filteredRows(ctx context.Context, source string, filters map[string]any) ([]model.Row, error) {
	active, err := service.store.Active(ctx)
	if err != nil {
		return nil, err
	}
	if active.Generation == "" {
		return nil, errors.New("dashboard data is unavailable")
	}
	predicates := make([]query.Predicate, 0, len(filters))
	for field, value := range filters {
		predicates = append(predicates, query.Predicate{Field: field, Equals: value})
	}
	definition := query.Definition{
		Name: "canonical-api-result",
		From: source,
		Filter: &query.Filter{
			Predicates: predicates,
		},
	}
	engine := query.New(&generationLoader{ctx: ctx, store: service.store, generation: active.Generation})
	sources, _, err := engine.Execute([]query.Definition{definition}, []string{definition.Name})
	if err != nil {
		return nil, err
	}
	return sources[definition.Name].Rows, nil
}

func (service canonicalService) entity(ctx context.Context, source, id string) (model.Row, error) {
	rows, err := service.filteredRows(ctx, source, map[string]any{"id": id})
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		return rows[0], nil
	}
	return nil, errCanonicalEntityNotFound
}

func (service canonicalService) repositoryRuns(ctx context.Context, id string) ([]model.Row, error) {
	repository, err := service.entity(ctx, "repositories", id)
	if err != nil || repository == nil {
		return nil, err
	}
	return service.filteredRows(ctx, "runs", map[string]any{
		"organization": repository["organization"],
		"repository":   repository["repository"],
	})
}

func (service canonicalService) workflowRuns(ctx context.Context, id string) ([]model.Row, error) {
	workflow, err := service.entity(ctx, "workflows", id)
	if err != nil || workflow == nil {
		return nil, err
	}
	return service.filteredRows(ctx, "runs", map[string]any{
		"organization": workflow["organization"],
		"repository":   workflow["repository"],
		"workflow":     workflow["workflow"],
	})
}

func (service canonicalService) related(ctx context.Context, source, id, field string) ([]model.Row, error) {
	return service.filteredRows(ctx, source, map[string]any{field: id})
}

func (a *App) repositories(response http.ResponseWriter, request *http.Request) {
	rows, err := a.canonical.rows(request.Context(), "repositories")
	a.writeCanonicalRows(response, rows, err)
}

func (a *App) repository(response http.ResponseWriter, request *http.Request) {
	row, err := a.canonical.entity(request.Context(), "repositories", request.PathValue("id"))
	if errors.Is(err, errCanonicalEntityNotFound) {
		writeError(response, http.StatusNotFound, "repository was not found")
		return
	}
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "canonical data is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, row)
}

func (a *App) repositoryRuns(response http.ResponseWriter, request *http.Request) {
	rows, err := a.canonical.repositoryRuns(request.Context(), request.PathValue("id"))
	a.writeCanonicalRows(response, rows, err)
}

func (a *App) workflowRuns(response http.ResponseWriter, request *http.Request) {
	rows, err := a.canonical.workflowRuns(request.Context(), request.PathValue("id"))
	a.writeCanonicalRows(response, rows, err)
}

func (a *App) runJobs(response http.ResponseWriter, request *http.Request) {
	rows, err := a.canonical.related(request.Context(), "jobs", request.PathValue("id"), "runId")
	a.writeCanonicalRows(response, rows, err)
}

func (a *App) runSessions(response http.ResponseWriter, request *http.Request) {
	rows, err := a.canonical.related(request.Context(), "sessions", request.PathValue("id"), "runId")
	a.writeCanonicalRows(response, rows, err)
}

func (a *App) sessionEvents(response http.ResponseWriter, request *http.Request) {
	rows, err := a.canonical.related(request.Context(), "events", request.PathValue("id"), "sessionId")
	a.writeCanonicalRows(response, rows, err)
}

func (a *App) writeCanonicalRows(response http.ResponseWriter, rows []model.Row, err error) {
	if errors.Is(err, errCanonicalEntityNotFound) {
		writeError(response, http.StatusNotFound, "canonical entity was not found")
		return
	}
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "canonical data is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, rows)
}
