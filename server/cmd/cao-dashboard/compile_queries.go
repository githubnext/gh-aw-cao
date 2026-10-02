package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	debuglogger "github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

var compileQueriesLog = debuglogger.New("cao:dashboard:compile")

type queryValidation struct {
	Name   string `json:"name"`
	From   string `json:"from"`
	Valid  bool   `json:"valid"`
	Reason string `json:"reason,omitempty"`
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
		results := validateCompilationQueries(definitions)
		valid, invalid := summarizeCompilationValidity(results)
		compileQueriesLog.Printf("compile-queries validated definitions=%d valid=%d invalid=%d", len(results), valid, invalid)
		return renderCompilation(cmd.OutOrStdout(), results, *format)
	}
	return cmd
}

// validateCompilationQueries runs the Go query engine's offline validation
// against each definition independently, so one invalid query never masks
// the validity of the others.
func validateCompilationQueries(definitions []query.Definition) []queryValidation {
	results := make([]queryValidation, 0, len(definitions))
	for _, definition := range definitions {
		result := queryValidation{Name: definition.Name, From: definition.From, Valid: true}
		if err := query.Validate([]query.Definition{definition}); err != nil {
			result.Valid = false
			result.Reason = err.Error()
		}
		results = append(results, result)
	}
	return results
}

// summarizeCompilationValidity counts how many results passed and failed Go
// query validation, shared by the diagnostic log line and the markdown
// report header so both describe the same totals.
func summarizeCompilationValidity(results []queryValidation) (valid, invalid int) {
	for _, result := range results {
		if result.Valid {
			valid++
		} else {
			invalid++
		}
	}
	return valid, invalid
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
	fragmentFiles := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		fragmentFiles++
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
	compileQueriesLog.Printf("compile-queries loaded definitions=%d fragment-files=%d", len(definitions), fragmentFiles)
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
	valid, invalid := summarizeCompilationValidity(results)
	if _, err := fmt.Fprintf(out, "### Go query validation (offline)\n\n"+
		"%d queries: %d passed individual Go query validation, %d require unsupported or invalid features. "+
		"Cross-query dependencies, source availability, and runtime row budgets were not checked.\n\n"+
		"| Query | Source | Valid | Reason |\n| --- | --- | --- | --- |\n",
		len(results), valid, invalid); err != nil {
		return err
	}
	for _, result := range results {
		cell := func(value string) string {
			return strings.NewReplacer("|", "\\|", "\n", " ", "\r", " ").Replace(value)
		}
		if _, err := fmt.Fprintf(out, "| %s | %s | %t | %s |\n",
			cell(result.Name), cell(result.From), result.Valid, cell(result.Reason)); err != nil {
			return err
		}
	}
	return nil
}
