// Package dashboard embeds the declarative contracts used by the native CLI.
package dashboard

import "embed"

// Catalog contains the same source documents consumed by the browser.
//
//go:embed site/dashboard.json site/dashboard-fragments/*.json site/src/data/queries/database.json site/src/agent/mcp-contract.json
var Catalog embed.FS

// Site contains browser assets, not an operator-side JavaScript runtime.
// Keeping these sources in the binary permits offline previews without a Node
// installation. Published artifacts take precedence when they contain a site.
//
//go:embed site/index.html site/src site/dashboard.json site/dashboard-fragments site/canvas-query-editor.json site/favicon.svg site/*.png site/manifest.webmanifest site/service-worker.js
var Site embed.FS
