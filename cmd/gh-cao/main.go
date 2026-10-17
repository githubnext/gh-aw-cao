package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/githubnext/gh-aw-cao/internal/cli"
)

var version = "dev"

func main() {
	os.Exit(run())
}

func run() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := cli.NewRootCommand(version).ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}
	return 0
}
