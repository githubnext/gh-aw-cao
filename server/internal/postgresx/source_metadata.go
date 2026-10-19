package postgresx

import (
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// ComposeMetadata exposes the existing source-quality rules to other readers
// without changing PostgreSQL query execution.
func ComposeMetadata(definitions []query.Definition, roots map[string]model.Metadata, name string) model.Metadata {
	return composeMetadata(definitions, roots, name, map[string]bool{})
}
