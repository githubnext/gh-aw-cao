package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

var canonicalLog = logger.New("cao:server:canonical")

type canonicalService struct {
	store       *postgresx.Store
	definitions []query.Definition
}

var errCanonicalEntityNotFound = errors.New("canonical entity was not found")

func (service canonicalService) rows(ctx context.Context, source string) ([]model.Row, error) {
	active, err := service.store.State(ctx)
	if err != nil {
		return nil, err
	}
	if !active.Ready {
		return nil, errors.New("dashboard data is unavailable")
	}
	engine := query.New(&generationLoader{ctx: ctx, database: service.store})
	sources, _, err := engine.Execute(service.definitions, []string{source})
	if err != nil {
		return nil, err
	}
	return sources[source].Rows, nil
}

func (service canonicalService) filteredRows(ctx context.Context, source string, filters map[string]any) ([]model.Row, error) {
	active, err := service.store.State(ctx)
	if err != nil {
		return nil, err
	}
	if !active.Ready {
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
	engine := query.New(&generationLoader{ctx: ctx, database: service.store})
	definitions := append(append([]query.Definition{}, service.definitions...), definition)
	sources, _, err := engine.Execute(definitions, []string{definition.Name})
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

// canonicalOutcome classifies a canonical query's result for the HTTP layer,
// so a query failure is diagnosable without logging the query error text
// (which may embed a source name or filter value).
type canonicalOutcome string

const (
	canonicalOutcomeOK          canonicalOutcome = "ok"
	canonicalOutcomeNotFound    canonicalOutcome = "not-found"
	canonicalOutcomeUnavailable canonicalOutcome = "unavailable"
)

// classifyCanonicalError applies the standard priority for turning a
// canonicalService error into an HTTP response: a nil error succeeds, a
// missing entity is a 404, and any other error means canonical data itself
// could not be read, which is a 503. It is a pure function extracted from
// the two call sites that previously duplicated this classification inline,
// so the mapping from error to outcome, status, and message is testable
// without an httptest server.
func classifyCanonicalError(err error) (outcome canonicalOutcome, status int, message string) {
	switch {
	case err == nil:
		return canonicalOutcomeOK, http.StatusOK, ""
	case errors.Is(err, errCanonicalEntityNotFound):
		return canonicalOutcomeNotFound, http.StatusNotFound, "canonical entity was not found"
	default:
		return canonicalOutcomeUnavailable, http.StatusServiceUnavailable, "canonical data is unavailable"
	}
}

func (a *App) repositories(response http.ResponseWriter, request *http.Request) {
	rows, err := a.canonical.rows(request.Context(), "repositories")
	a.writeCanonicalRows(response, rows, err)
}

func (a *App) repository(response http.ResponseWriter, request *http.Request) {
	row, err := a.canonical.entity(request.Context(), "repositories", request.PathValue("id"))
	if outcome, status, message := classifyCanonicalError(err); outcome != canonicalOutcomeOK {
		canonicalLog.Printf("repository query failed outcome=%s", outcome)
		if outcome == canonicalOutcomeNotFound {
			// This endpoint predates the shared classifier and names the
			// missing entity in its message, unlike the generic message the
			// other canonical endpoints share; preserve that wording.
			message = "repository was not found"
		}
		writeError(response, status, message)
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
	if outcome, status, message := classifyCanonicalError(err); outcome != canonicalOutcomeOK {
		canonicalLog.Printf("canonical rows query failed outcome=%s", outcome)
		writeError(response, status, message)
		return
	}
	writeJSON(response, http.StatusOK, rows)
}
