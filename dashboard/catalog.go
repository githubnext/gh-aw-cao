// Package dashboard embeds the declarative contracts used by the native CLI.
package dashboard

import "embed"

// Catalog contains the same source documents consumed by the browser.
//
//go:embed site/dashboard.json site/dashboard-fragments/*.json site/src/data/queries/database.json site/src/agent/mcp-contract.json
var Catalog embed.FS
