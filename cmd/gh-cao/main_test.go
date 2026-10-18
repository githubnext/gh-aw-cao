package main

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/githubnext/gh-aw-cao/internal/cli"
)

func TestReportError(t *testing.T) {
	for _, tt := range []struct {
		name string
		err  error
		code int
		text string
	}{
		{"success", nil, 0, ""},
		{"input failure", errors.New("invalid argument"), 1, "error: invalid argument\n"},
		{"validation failure", &cli.ExitError{Code: 1}, 1, ""},
		{"incomplete validation", &cli.ExitError{Code: 2}, 2, ""},
		{"interrupted command", &cli.ExitError{Code: 130}, 130, ""},
		{"terminated command", &cli.ExitError{Code: 143}, 143, ""},
		{"canceled", context.Canceled, 130, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			if got := reportError(tt.err, &stderr); got != tt.code || stderr.String() != tt.text {
				t.Fatalf("status = %d, stderr = %q; want %d, %q", got, stderr.String(), tt.code, tt.text)
			}
		})
	}
}
