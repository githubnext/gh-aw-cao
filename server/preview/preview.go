// Package preview exposes the shared Go HTTP server to the native gh-cao CLI.
package preview

import (
	"context"
	"encoding/json"
	"io"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/localops"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

type Config = server.LocalConfig
type Operations = server.LocalOperations
type Control = server.LocalBridge
type CustomView = localops.CustomView

type WorkspaceOptions struct {
	Workspace, SourceDirectory, GHExecutable, QueuePath, CaoURL, Repository string
	Admin, Canvas                                                           bool
	QueueConcurrency                                                        int
	AcknowledgeRecovery                                                     bool
	Dashboard                                                               func() map[string]any
	SaveDashboard                                                           func(context.Context, []byte) (any, error)
	Approve                                                                 func(context.Context, map[string]any) (bool, error)
	OnQueueChanged                                                          func()
}

func NewWorkspaceOperations(ctx context.Context, options WorkspaceOptions) (*localops.Service, error) {
	native := localops.Options{
		Workspace: options.Workspace, SourceDirectory: options.SourceDirectory,
		GHExecutable: options.GHExecutable, QueuePath: options.QueuePath, CaoURL: options.CaoURL,
		Repository: options.Repository, Admin: options.Admin, Canvas: options.Canvas,
		MaxConcurrency: options.QueueConcurrency, AcknowledgeRecovery: options.AcknowledgeRecovery,
		Dashboard: options.Dashboard, OnQueueChanged: options.OnQueueChanged,
	}
	if options.SaveDashboard != nil {
		native.SaveDashboard = func(document []byte) (any, error) {
			return options.SaveDashboard(ctx, document)
		}
	}
	if options.Approve != nil {
		native.Approve = func(ctx context.Context, invocation localops.Invocation) (bool, error) {
			content, err := json.Marshal(invocation)
			if err != nil {
				return false, err
			}
			var payload map[string]any
			if err := json.Unmarshal(content, &payload); err != nil {
				return false, err
			}
			return options.Approve(ctx, payload)
		}
	}
	return localops.New(native) //nolint:contextcheck // Durable execution owns cancellation and is closed after HTTP shutdown.
}

func ExecuteCommand(ctx context.Context, workspace, ghExecutable, command, input string, output func(string, string)) (map[string]any, error) {
	return localops.ExecuteCommand(ctx, workspace, ghExecutable, command, input, output)
}

func ParseCommand(command string) ([]string, error) { return localops.ParseCommand(command) }

func LoadCustomViews(workspace string) ([]CustomView, error) {
	return localops.LoadCustomViews(workspace)
}

func SaveCustomView(workspace string, content []byte) (map[string]any, error) {
	return localops.SaveCustomView(workspace, content)
}

func MaterializeCustomView(document map[string]any, id string) map[string]any {
	return localops.MaterializeCustomView(document, id)
}

func NormalizeInventoryRow(name string, input map[string]any) (string, map[string]any, error) {
	collection, row, err := ingest.NormalizeInventoryRow(name, model.Row(input))
	return collection, map[string]any(row), err
}

func NewControl(input io.Reader, output io.Writer) *Control {
	return server.NewLocalBridge(input, output, nil)
}

type Server struct {
	local *server.LocalServer
}

func New(ctx context.Context, config Config, operations Operations) (*Server, error) {
	local, err := server.NewLocalServer(ctx, config)
	if err != nil {
		return nil, err
	}
	local.SetOperations(operations)
	return &Server{local: local}, nil
}

func (s *Server) Serve(ctx context.Context, input io.Reader, output io.Writer) error {
	return s.local.Serve(ctx, input, output)
}

func (s *Server) SetControl(control *Control) { s.local.SetControl(control) }

func (s *Server) Changed() { s.local.Changed() }

func (s *Server) UpdateDashboard(document []byte) {
	content, err := json.Marshal(map[string]any{"event": "dashboard", "dashboard": json.RawMessage(document)})
	if err == nil {
		s.local.Event(content)
	}
}
