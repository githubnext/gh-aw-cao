package postgresx

import (
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

// ComposeMetadata exposes the existing source-quality rules to other readers
// without changing PostgreSQL query execution.
func ComposeMetadata(definitions []query.Definition, roots map[string]model.Metadata, name string) model.Metadata {
	return composeMetadata(definitions, roots, name, map[string]bool{})
}

// IsRuntimeSource uses the generated server registry rather than a second
// adapter-specific allowlist.
func IsRuntimeSource(name string) bool {
	table, exists := entityTables[name]
	return exists && table.runtime
}
