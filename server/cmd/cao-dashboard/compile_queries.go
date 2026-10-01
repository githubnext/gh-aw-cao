package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

func newCompileQueriesCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "compile-queries",
		Short: "report potential native Redis translation of dashboard queries without connecting to Redis",
		Args:  cobra.NoArgs,
	}
	fragments := cmd.Flags().String("fragments", "../dashboard/site/dashboard-fragments", "dashboard query fragments directory")
	database := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	format := cmd.Flags().String("format", "markdown", "report format: markdown or json")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		definitions, err := loadCompilationQueries(*fragments, *database)
		if err != nil {
			return err
		}
		results, err := redisx.CompileQueries(definitions)
		if err != nil {
			return fmt.Errorf("compile dashboard queries: %w", err)
		}
		return renderCompilation(cmd.OutOrStdout(), results, *format)
	}
	return cmd
}

func loadCompilationQueries(directory, database string) ([]query.Definition, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read dashboard fragments: %w", err)
	}
	var definitions []query.Definition
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		part, err := server.ParseDashboardQueries(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		definitions = append(definitions, part...)
	}
	databaseDefinitions, err := server.ParseDashboardQueries(database)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", database, err)
	}
	definitions = append(definitions, databaseDefinitions...)
	if len(definitions) == 0 {
		return nil, fmt.Errorf("no dashboard queries found")
	}
	return definitions, nil
}

func renderCompilation(out io.Writer, results []redisx.QueryCompilation, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		return encoder.Encode(results)
	}
	if format != "markdown" {
		return fmt.Errorf("unsupported report format %q", format)
	}
	counts := map[string]int{}
	for _, result := range results {
		counts[result.Level]++
	}
	if _, err := fmt.Fprintf(out, "### Redis native translation (offline)\n\n"+
		"%d queries: %d full candidates, %d partial candidates, %d Go fallback, %d unsupported by Go.\n\n"+
		"Candidates are **not** verified native executions: the active Redis generation must have JSON sources and compatible RediSearch indexes. "+
		"Partial candidates can still execute remaining operations in Go; no Redis connection or runtime row budget was checked.\n\n"+
		"| Query | Source | Level | Redis primitive | Limitation |\n| --- | --- | --- | --- | --- |\n",
		len(results), counts["full candidate"], counts["partial candidate"], counts["fallback"], counts["unsupported"]); err != nil {
		return err
	}
	for _, result := range results {
		cell := func(value string) string {
			return strings.NewReplacer("|", "\\|", "\n", " ", "\r", " ").Replace(value)
		}
		if _, err := fmt.Fprintf(out, "| %s | %s | %s | %s | %s |\n",
			cell(result.Name), cell(result.From), cell(result.Level), cell(result.Native), cell(result.Reason)); err != nil {
			return err
		}
	}
	return nil
}
