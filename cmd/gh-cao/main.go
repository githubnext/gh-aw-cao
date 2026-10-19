package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/githubnext/gh-cao/internal/cli"
)

var version = "dev"

func main() {
	os.Exit(run())
}

func run() int {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case received := <-signals:
			code := 130
			if received == syscall.SIGTERM {
				code = 143
			}
			cancel(&cli.ExitError{Code: code})
		case <-ctx.Done():
		}
	}()

	err := cli.NewRootCommand(version).ExecuteContext(ctx)
	if ctx.Err() != nil {
		return reportError(context.Cause(ctx), os.Stderr)
	}
	return reportError(err, os.Stderr)
}

func reportError(err error, stderr io.Writer) int {
	if err == nil {
		return 0
	}
	var exit *cli.ExitError
	if errors.As(err, &exit) {
		return exit.Code
	}
	if errors.Is(err, context.Canceled) {
		return 130
	}
	if _, writeErr := fmt.Fprintln(stderr, "error:", err); writeErr != nil {
		return 1
	}
	return 1
}
