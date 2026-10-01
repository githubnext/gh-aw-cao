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
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

type queryValidation struct {
	Name  string `json:"name"`
	From  string `json:"from"`
	Valid bool   `json:"valid"`
}

func newCompileQueriesCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "compile-queries",
		Short: "validate dashboard queries with the Go query engine without connecting to a database",
		Args:  cobra.NoArgs,
	}
	fragments := cmd.Flags().String("fragments", "../dashboard/site/dashboard-fragments", "dashboard query fragments directory")
	dashboard := cmd.Flags().String("dashboard-queries", "../dashboard/site/dashboard.json", "root dashboard query document")
	database := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	format := cmd.Flags().String("format", "markdown", "report format: markdown or json")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		definitions, err := loadCompilationQueries(*dashboard, *fragments, *database)
		if err != nil {
			return err
		}
		if err := query.Validate(definitions); err != nil {
			return fmt.Errorf("validate dashboard queries: %w", err)
		}
		results := make([]queryValidation, 0, len(definitions))
		for _, definition := range definitions {
			results = append(results, queryValidation{Name: definition.Name, From: definition.From, Valid: true})
		}
		return renderCompilation(cmd.OutOrStdout(), results, *format)
	}
	return cmd
}

func loadCompilationQueries(dashboard, directory, database string) ([]query.Definition, error) {
	definitions, err := server.ParseDashboardQueries(dashboard)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", dashboard, err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read dashboard fragments: %w", err)
	}
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

func renderCompilation(out io.Writer, results []queryValidation, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		return encoder.Encode(results)
	}
	if format != "markdown" {
		return fmt.Errorf("unsupported report format %q", format)
	}
	if _, err := fmt.Fprintf(out, "### Go query validation (offline)\n\n"+
		"%d queries passed structural and dependency validation. No database connection or runtime row budget was checked.\n\n"+
		"| Query | Source | Valid |\n| --- | --- | --- |\n", len(results)); err != nil {
		return err
	}
	for _, result := range results {
		cell := func(value string) string {
			return strings.NewReplacer("|", "\\|", "\n", " ", "\r", " ").Replace(value)
		}
		if _, err := fmt.Fprintf(out, "| %s | %s | %t |\n",
			cell(result.Name), cell(result.From), result.Valid); err != nil {
			return err
		}
	}
	return nil
}
