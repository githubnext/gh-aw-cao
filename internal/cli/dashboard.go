package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/dashboard/queryengine"
	"github.com/githubnext/gh-aw-cao/server/operator"
)

func dashboardCommand() *cobra.Command {
	command := &cobra.Command{
		Use: "dashboard", Short: "Run native dashboard operator actions and queries",
		Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			return errors.New("use dashboard action or dashboard evaluate; local serving belongs to cao-dashboard serve-local")
		},
	}
	command.AddCommand(dashboardActionCommand(), dashboardEvaluateCommand())
	return command
}

func dashboardActionCommand() *cobra.Command {
	var workspace, executable, commandText, inputFile string
	var validate bool
	command := &cobra.Command{
		Use: "action", Short: "Execute one explicitly requested, allowlisted dashboard action",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if commandText == "" {
				return errors.New("--command is required")
			}
			if validate {
				tokens, err := operator.ParseCommand(commandText)
				if err != nil {
					return err
				}
				return json.NewEncoder(cmd.OutOrStdout()).Encode(tokens)
			}
			if workspace == "" {
				var err error
				workspace, err = os.Getwd()
				if err != nil {
					return err
				}
			}
			var input string
			if inputFile != "" {
				if inputFile != "-" {
					return errors.New("--input-file only accepts - for standard input")
				}
				content, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), (1<<20)+1))
				if err != nil {
					return err
				}
				if len(content) > 1<<20 {
					return errors.New("action input exceeds 1 MiB")
				}
				input = string(content)
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			writer := json.NewEncoder(cmd.OutOrStdout())
			var mu sync.Mutex
			result, err := operator.ExecuteCommand(ctx, workspace, executable, commandText, input, func(stream, data string) {
				mu.Lock()
				defer mu.Unlock()
				if err := writer.Encode(map[string]any{"type": "output", "stream": stream, "data": data}); err != nil {
					stop()
				}
			})
			if err != nil {
				return err
			}
			return writer.Encode(map[string]any{"type": "complete", "result": result})
		},
	}
	command.Flags().StringVar(&workspace, "workspace", "", "Operator workspace")
	command.Flags().StringVar(&executable, "gh-executable", "gh", "GitHub CLI executable")
	command.Flags().StringVar(&commandText, "command", "", "Explicit allowlisted command, parsed without a shell")
	command.Flags().StringVar(&inputFile, "input-file", "", "Read agent-task input from standard input (-)")
	command.Flags().BoolVar(&validate, "validate", false, "Validate and print argv without executing")
	return command
}

func dashboardEvaluateCommand() *cobra.Command {
	return &cobra.Command{
		Use: "evaluate", Short: "Evaluate supplied declarative queries with the native engine",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var request struct {
				Queries   []map[string]any `json:"queries"`
				Sources   map[string]any   `json:"sources"`
				Requested []string         `json:"requested"`
			}
			content, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), (8<<20)+1))
			if err != nil {
				return err
			}
			if len(content) > 8<<20 {
				return errors.New("dashboard evaluation request exceeds 8 MiB")
			}
			decoder := json.NewDecoder(bytes.NewReader(content))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&request); err != nil {
				return fmt.Errorf("invalid dashboard evaluation request: %w", err)
			}
			if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
				return errors.New("dashboard evaluation request must contain exactly one JSON object")
			}
			result, err := queryengine.ExecuteQueries(cmd.Context(), request.Queries, request.Sources, request.Requested)
			if err != nil {
				return err
			}
			content, err = json.Marshal(result)
			if err != nil {
				return err
			}
			if len(content) > 1_000_000 {
				return errors.New("dashboard query result exceeds 1 MB; add a limit or request fewer queries")
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), string(content))
			return err
		},
	}
}
