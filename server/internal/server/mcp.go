package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type mcpContract struct {
	ProtocolVersion string `json:"protocolVersion"`
	ServerInfo      struct {
		Name    string `json:"name"`
		Title   string `json:"title"`
		Version string `json:"version"`
	} `json:"serverInfo"`
	Instructions string `json:"instructions"`
	Limits       struct {
		MaxRequestBytes    int64 `json:"maxRequestBytes"`
		DefaultQueryRows   int   `json:"defaultQueryRows"`
		MaxQueryRows       int   `json:"maxQueryRows"`
		MaxParameters      int   `json:"maxParameters"`
		MaxParameterLength int   `json:"maxParameterLength"`
	} `json:"limits"`
	Tools []mcpContractTool `json:"tools"`
}

type mcpContractTool struct {
	Name         string         `json:"name"`
	Title        string         `json:"title"`
	Description  string         `json:"description"`
	InputSchema  map[string]any `json:"inputSchema"`
	OutputSchema map[string]any `json:"outputSchema"`
	Annotations  map[string]any `json:"annotations"`
}

type agentCatalog struct {
	Dashboard map[string]any `json:"dashboard"`
	Pages     []agentPage    `json:"pages"`
	Queries   []agentQuery   `json:"queries"`
}

type agentPage struct {
	ID string `json:"id"`
}

type agentQuery struct {
	ID         string           `json:"id"`
	Parameters []queryParameter `json:"parameters"`
	Execution  struct {
		Local        bool     `json:"local"`
		Requirements []string `json:"requirements"`
		Reason       string   `json:"reason"`
	} `json:"execution"`
}

type queryParameter struct {
	Name  string `json:"name"`
	Field string `json:"field"`
}

type mcpRuntime struct {
	app        *App
	contract   mcpContract
	catalog    agentCatalog
	catalogRaw map[string]any
}

func (a *App) newMCPHandler() (http.Handler, error) {
	contract, err := readJSONFile[mcpContract](a.config.MCPContractPath)
	if err != nil {
		return nil, fmt.Errorf("read contract: %w", err)
	}
	if contract.ProtocolVersion == "" || len(contract.Tools) == 0 {
		return nil, errors.New("contract must declare a protocol version and tools")
	}
	if contract.Limits.MaxRequestBytes <= 0 || contract.Limits.DefaultQueryRows <= 0 ||
		contract.Limits.MaxQueryRows < contract.Limits.DefaultQueryRows ||
		contract.Limits.MaxParameters <= 0 || contract.Limits.MaxParameterLength <= 0 {
		return nil, errors.New("contract declares invalid resource limits")
	}
	catalog, err := readJSONFile[agentCatalog](a.config.AgentCatalogPath)
	if err != nil {
		return nil, fmt.Errorf("read agent catalog: %w", err)
	}
	catalogRaw, err := readJSONFile[map[string]any](a.config.AgentCatalogPath)
	if err != nil {
		return nil, fmt.Errorf("read agent catalog payload: %w", err)
	}
	runtime := &mcpRuntime{app: a, contract: contract, catalog: catalog, catalogRaw: catalogRaw}
	server := mcp.NewServer(&mcp.Implementation{
		Name: contract.ServerInfo.Name, Title: contract.ServerInfo.Title, Version: contract.ServerInfo.Version,
	}, &mcp.ServerOptions{
		Instructions:              contract.Instructions,
		SupportedProtocolVersions: []string{contract.ProtocolVersion},
	})
	registered := map[string]bool{}
	for _, declared := range contract.Tools {
		tool := declared
		if tool.Name != "cao_catalog" && tool.Name != "cao_query" {
			return nil, fmt.Errorf("contract declares unsupported tool %q", tool.Name)
		}
		if registered[tool.Name] {
			return nil, fmt.Errorf("contract declares tool %q more than once", tool.Name)
		}
		registered[tool.Name] = true
		server.AddTool(&mcp.Tool{
			Name: tool.Name, Title: tool.Title, Description: tool.Description,
			InputSchema: tool.InputSchema, OutputSchema: tool.OutputSchema,
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
		}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return runtime.call(ctx, tool.Name, request.Params.Arguments), nil
		})
	}
	if !registered["cao_catalog"] || !registered["cao_query"] || len(registered) != 2 {
		return nil, errors.New("contract must declare exactly cao_catalog and cao_query")
	}
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true, MaxRequestBodyBytes: contract.Limits.MaxRequestBytes,
		PropagateRequestCancellation: true,
	})
	return &mcpContractHandler{next: handler, tools: contract.Tools}, nil
}

func readJSONFile[T any](path string) (T, error) {
	var value T
	if strings.TrimSpace(path) == "" {
		return value, errors.New("path is required")
	}
	// #nosec G304 -- these paths are explicit operator configuration.
	data, err := os.ReadFile(path)
	if err != nil {
		return value, err
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return value, err
	}
	return value, nil
}

func (runtime *mcpRuntime) call(ctx context.Context, name string, arguments json.RawMessage) *mcp.CallToolResult {
	var args map[string]any
	if len(arguments) == 0 {
		args = map[string]any{}
	} else if err := json.Unmarshal(arguments, &args); err != nil {
		return mcpErrorResult("Tool arguments must be an object")
	}
	var (
		payload any
		err     error
	)
	switch name {
	case "cao_catalog":
		payload, err = runtime.callCatalog(args)
	case "cao_query":
		payload, err = runtime.callQuery(ctx, args)
	default:
		err = fmt.Errorf("Unknown tool: %s", name)
	}
	if err != nil {
		return mcpErrorResult(err.Error())
	}
	data, _ := json.Marshal(payload)
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: string(data)}},
		StructuredContent: payload,
	}
}

func mcpErrorResult(message string) *mcp.CallToolResult {
	payload := map[string]any{"error": message}
	data, _ := json.Marshal(payload)
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
		IsError: true,
	}
}

func (runtime *mcpRuntime) callCatalog(args map[string]any) (any, error) {
	if err := onlyArguments(args, "kind", "id"); err != nil {
		return nil, err
	}
	kind, _ := args["kind"].(string)
	id, _ := args["id"].(string)
	id = strings.TrimSpace(id)
	switch kind {
	case "pages":
		pages, _ := runtime.catalogRaw["pages"].([]any)
		if id == "" {
			return map[string]any{"command": "pages", "pages": pages}, nil
		}
		for _, item := range pages {
			page, _ := item.(map[string]any)
			if page["id"] == id {
				return map[string]any{"command": "pages", "page": page}, nil
			}
		}
		return nil, fmt.Errorf("Unknown dashboard page: %s", id)
	case "queries":
		queries, _ := runtime.catalogRaw["queries"].([]any)
		if id == "" {
			return map[string]any{"command": "queries", "queries": queries}, nil
		}
		for _, item := range queries {
			entry, _ := item.(map[string]any)
			if entry["id"] == id {
				return map[string]any{"command": "query-info", "query": entry}, nil
			}
		}
		return nil, fmt.Errorf("Unknown dashboard query: %s", id)
	default:
		return nil, errors.New(`cao_catalog requires kind to be "pages" or "queries"`)
	}
}

func (runtime *mcpRuntime) callQuery(ctx context.Context, args map[string]any) (any, error) {
	if err := onlyArguments(args, "id", "parameters", "limit"); err != nil {
		return nil, err
	}
	id, _ := args["id"].(string)
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, errors.New("A dashboard query identifier is required")
	}
	catalogQuery, ok := runtime.findQuery(id)
	if !ok {
		return nil, fmt.Errorf("Unknown dashboard query: %s", id)
	}
	limit, err := runtime.queryLimit(args["limit"])
	if err != nil {
		return nil, err
	}
	filters, parameterValues, err := runtime.queryFilters(catalogQuery, args["parameters"])
	if err != nil {
		return nil, err
	}
	if !catalogQuery.Execution.Local {
		return map[string]any{
			"query": id, "rows": []model.Row{},
			"metadata": model.Metadata{
				"availability":     "unavailable",
				"completeness":     "unknown",
				"freshness":        "unknown",
				"query-diagnostic": catalogQuery.Execution.Reason,
				"requirements":     catalogQuery.Execution.Requirements,
			},
		}, nil
	}
	definition, ok := findDefinition(runtime.app.config.DashboardQueries, id)
	if !ok {
		return nil, fmt.Errorf("Unknown dashboard query: %s", id)
	}
	alias := "agent:" + id
	sourceName := alias + ":source"
	cloned := definition
	cloned.Name = sourceName
	boundedLimit := min(limit+1, query.MaxOutputRows)
	bounded := query.Definition{Name: alias, From: sourceName, Limit: &boundedLimit}
	if len(filters) > 0 {
		bounded.Filter = &query.Filter{Predicates: filters}
	}
	result, _, err := runtime.app.executeQuery(ctx, queryRequest{
		Aliases: []string{alias}, Queries: runtime.app.config.DashboardQueries,
		CompiledQueries: []query.Definition{cloned, bounded},
	})
	if err != nil {
		return nil, err
	}
	source := result.Sources[alias]
	rows := source.Rows
	truncated := len(rows) > limit
	if truncated {
		rows = rows[:limit]
	}
	metadata := model.Metadata{
		"availability":  metadataString(source.Metadata, "availability", "unknown"),
		"completeness":  metadataString(source.Metadata, "completeness", "unknown"),
		"freshness":     metadataString(source.Metadata, "freshness", "unknown"),
		"as-of":         metadataString(source.Metadata, "as-of", ""),
		"returned-rows": len(rows),
		"limit":         limit,
	}
	if metadata["availability"] == "available" && len(rows) == 0 {
		metadata["availability"] = "empty"
	}
	if truncated {
		metadata["completeness"] = "partial"
	}
	if len(parameterValues) > 0 {
		metadata["parameters"] = parameterValues
	}
	return map[string]any{"query": id, "rows": rows, "metadata": metadata}, nil
}

func onlyArguments(args map[string]any, names ...string) error {
	for name := range args {
		if !slices.Contains(names, name) {
			return fmt.Errorf("Unknown tool argument: %s", name)
		}
	}
	return nil
}

func (runtime *mcpRuntime) queryLimit(value any) (int, error) {
	if value == nil {
		return runtime.contract.Limits.DefaultQueryRows, nil
	}
	number, ok := value.(float64)
	if !ok || math.IsInf(number, 0) || math.IsNaN(number) || math.Trunc(number) != number || number < 1 {
		return 0, errors.New("cao_query limit must be a positive integer")
	}
	if number >= float64(runtime.contract.Limits.MaxQueryRows) {
		return runtime.contract.Limits.MaxQueryRows, nil
	}
	return int(number), nil
}

func (runtime *mcpRuntime) queryFilters(entry agentQuery, value any) ([]query.Predicate, map[string]string, error) {
	if value == nil {
		return nil, nil, nil
	}
	parameters, ok := value.(map[string]any)
	if !ok {
		return nil, nil, errors.New("cao_query parameters must be an object")
	}
	if len(parameters) > runtime.contract.Limits.MaxParameters {
		return nil, nil, fmt.Errorf("At most %d query parameters are accepted", runtime.contract.Limits.MaxParameters)
	}
	declared := make(map[string]string, len(entry.Parameters))
	for _, parameter := range entry.Parameters {
		declared[parameter.Name] = parameter.Field
	}
	filters := make([]query.Predicate, 0, len(parameters))
	resolved := make(map[string]string, len(parameters))
	for name, raw := range parameters {
		field, ok := declared[name]
		if !ok {
			known := make([]string, 0, len(declared))
			for candidate := range declared {
				known = append(known, candidate)
			}
			slices.Sort(known)
			label := strings.Join(known, ", ")
			if label == "" {
				label = "none"
			}
			return nil, nil, fmt.Errorf("Unknown parameter %q for query %s; declared parameters: %s", name, entry.ID, label)
		}
		var text string
		switch raw := raw.(type) {
		case string:
			text = raw
		case float64, bool:
			text = fmt.Sprint(raw)
		default:
			return nil, nil, fmt.Errorf("Parameter %q must be a string, number, or boolean", name)
		}
		if len(text) > runtime.contract.Limits.MaxParameterLength {
			return nil, nil, fmt.Errorf("Parameter %q exceeds %d characters", name, runtime.contract.Limits.MaxParameterLength)
		}
		filters = append(filters, query.Predicate{Field: field, Equals: text})
		resolved[name] = text
	}
	return filters, resolved, nil
}

func (runtime *mcpRuntime) findQuery(id string) (agentQuery, bool) {
	for _, entry := range runtime.catalog.Queries {
		if entry.ID == id {
			return entry, true
		}
	}
	return agentQuery{}, false
}

func findDefinition(definitions []query.Definition, id string) (query.Definition, bool) {
	for _, definition := range definitions {
		if definition.Name == id {
			return definition, true
		}
	}
	return query.Definition{}, false
}

func metadataString(metadata model.Metadata, name, fallback string) string {
	if value, ok := metadata[name].(string); ok {
		return value
	}
	return fallback
}

// mcpContractHandler replaces SDK-normalized annotations with the authoritative
// contract annotations while leaving all protocol handling to the SDK.
type mcpContractHandler struct {
	next  http.Handler
	tools []mcpContractTool
}

func (handler *mcpContractHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	recorder := newBufferedResponse(response)
	handler.next.ServeHTTP(recorder, request)
	body := recorder.body
	if request.Header.Get("Mcp-Method") == "tools/list" && recorder.status == http.StatusOK {
		var message map[string]any
		if json.Unmarshal(body, &message) == nil {
			result, _ := message["result"].(map[string]any)
			tools, _ := result["tools"].([]any)
			byName := make(map[string]mcpContractTool, len(handler.tools))
			for _, tool := range handler.tools {
				byName[tool.Name] = tool
			}
			for _, item := range tools {
				tool, _ := item.(map[string]any)
				if declared, ok := byName[fmt.Sprint(tool["name"])]; ok {
					tool["annotations"] = declared.Annotations
				}
			}
			body, _ = json.Marshal(message)
		}
	}
	recorder.flush(response, body)
}

type bufferedResponse struct {
	header http.Header
	status int
	body   []byte
}

func newBufferedResponse(response http.ResponseWriter) *bufferedResponse {
	return &bufferedResponse{header: response.Header(), status: http.StatusOK}
}

func (response *bufferedResponse) Header() http.Header    { return response.header }
func (response *bufferedResponse) WriteHeader(status int) { response.status = status }
func (response *bufferedResponse) Write(body []byte) (int, error) {
	response.body = append(response.body, body...)
	return len(body), nil
}
func (response *bufferedResponse) flush(target http.ResponseWriter, body []byte) {
	target.WriteHeader(response.status)
	_, _ = target.Write(body)
}
