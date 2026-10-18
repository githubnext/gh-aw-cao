package cliegress

import (
	"context"
	"io"
	"net"
	"time"
)

const (
	RelayAddress = "127.0.0.1:18080"
	SocketPath   = "/cao-egress/proxy.sock"
	RelayPath    = "/cao-egress/relay"
)

// Relay transports bytes only to the command's fixed Unix socket. Docker's
// network-none namespace, not the relay or proxy variables, blocks direct IP.
func Relay(ctx context.Context, listener net.Listener, socket string) error {
	bounded := &boundedListener{Listener: listener, slots: make(chan struct{}, MaxConnections)}
	stop := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stop()
	for {
		client, err := bounded.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go relayConnection(ctx, client, socket)
	}
}

func relayConnection(ctx context.Context, client net.Conn, socket string) {
	defer func() { _ = client.Close() }()
	upstream, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
	if err != nil {
		return
	}
	defer func() { _ = upstream.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = client.Close(); _ = upstream.Close() })
	defer stop()
	deadline := time.Now().Add(MaxLifetime)
	if bound, ok := ctx.Deadline(); ok && bound.Before(deadline) {
		deadline = bound
	}
	left, right := &idleConn{Conn: client, deadline: deadline}, &idleConn{Conn: upstream, deadline: deadline}
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(right, left)
		_ = client.Close()
		_ = upstream.Close()
		close(done)
	}()
	_, _ = io.Copy(left, right)
	_ = client.Close()
	_ = upstream.Close()
	<-done
}
