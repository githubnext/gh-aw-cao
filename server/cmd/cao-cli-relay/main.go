// cao-cli-relay runs only inside the network-none Docker workload. It holds
// neither the policy nor host credentials and cannot select another socket.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/cliegress"
)

func main() { os.Exit(run()) }

func run() int {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "hosted CLI relay requires a workload")
		return 125
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ready, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", cliegress.SocketPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hosted CLI egress socket is unavailable")
		return 125
	}
	_ = ready.Close()
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp4", cliegress.RelayAddress)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hosted CLI egress relay is unavailable")
		return 125
	}
	defer func() { _ = listener.Close() }()
	go func() {
		if err := cliegress.Relay(ctx, listener, cliegress.SocketPath); err != nil {
			fmt.Fprintln(os.Stderr, "hosted CLI egress relay stopped unexpectedly")
			cancel()
		}
	}()
	// #nosec G204 G702 -- fixed bootstrap and validated CLI arguments supplied by the Docker lifecycle, never host execution.
	command := exec.CommandContext(ctx, os.Args[1], os.Args[2:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(name) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY":
		default:
			command.Env = append(command.Env, entry)
		}
	}
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		command.Env = append(command.Env, name+"=http://"+cliegress.RelayAddress)
	}
	command.Env = append(command.Env, "NO_PROXY=", "no_proxy=")
	if err := command.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() >= 0 {
			return exit.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "hosted CLI relay workload failed")
		return 125
	}
	return 0
}
