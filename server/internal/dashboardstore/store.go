// Package dashboardstore defines the canonical read boundary shared by hosted
// PostgreSQL and explicitly selected local SQLite snapshots.
package dashboardstore

import (
	"context"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/postgresx"
)

type State = postgresx.State
type Page = postgresx.SQLPage
type ExecutionOptions = postgresx.SQLExecutionOptions
type Reader = postgresx.NativeReader

type Store interface {
	Open() bool
	Close() error
	State(context.Context) (State, error)
	WithReadTransaction(context.Context, func(context.Context, Reader) error) error
	Diagnostics(context.Context) (model.Diagnostics, error)
}
