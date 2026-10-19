package cao

import "embed"

// OperatorAssets keeps native query authoring independent of an installed checkout.
//
//go:embed docs/dashboard-language-specification.md .github/skills/generate-dashboard-ir/SKILL.md .github/skills/author-dashboard-intent/SKILL.md .github/skills/dashboard-authoring/SKILL.md .github/skills/generate-dashboard-ir/references/declarative-charts.md
var OperatorAssets embed.FS
