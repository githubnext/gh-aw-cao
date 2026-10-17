package ghcli

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestVersion(t *testing.T) {
	got, err := version(context.Background(), func(ctx context.Context, args ...string) (bytes.Buffer, bytes.Buffer, error) {
		if !reflect.DeepEqual(args, []string{"--version"}) {
			t.Fatalf("args = %q, want only --version", args)
		}
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 5*time.Second {
			t.Fatal("version check must have a five-second deadline")
		}
		return *bytes.NewBufferString("gh version test\n"), bytes.Buffer{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != "gh version test" {
		t.Fatalf("version = %q", got)
	}
}

func TestVersionFailure(t *testing.T) {
	want := errors.New("executable not found")
	got, err := version(context.Background(), func(context.Context, ...string) (bytes.Buffer, bytes.Buffer, error) {
		return bytes.Buffer{}, *bytes.NewBufferString("sensitive subprocess output"), want
	})
	if got != "" || !errors.Is(err, want) {
		t.Fatalf("version = %q, error = %v, want wrapped failure", got, err)
	}
	if strings.Contains(err.Error(), "sensitive subprocess output") {
		t.Fatal("subprocess output must not be included in errors")
	}
}

func TestEmptyVersion(t *testing.T) {
	_, err := version(context.Background(), func(context.Context, ...string) (bytes.Buffer, bytes.Buffer, error) {
		return *bytes.NewBufferString(" \n"), bytes.Buffer{}, nil
	})
	if err == nil || !strings.Contains(err.Error(), "empty version") {
		t.Fatalf("error = %v, want empty version error", err)
	}
}

func TestVersionCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := version(ctx, func(ctx context.Context, _ ...string) (bytes.Buffer, bytes.Buffer, error) {
		return bytes.Buffer{}, bytes.Buffer{}, ctx.Err()
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
}
