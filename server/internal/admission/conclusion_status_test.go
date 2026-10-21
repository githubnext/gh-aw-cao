package admission

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestConclusionStatus(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		ctxErr error
		want   int
	}{
		{"success", nil, nil, http.StatusNoContent},
		{"denied", ErrDenied, nil, http.StatusForbidden},
		{"wrapped denial", fmt.Errorf("policy: %w", ErrDenied), nil, http.StatusForbidden},
		{"denied wins over expired context", ErrDenied, context.DeadlineExceeded, http.StatusForbidden},
		{"unavailable", ErrUnavailable, nil, http.StatusServiceUnavailable},
		{"other failure", errors.New("storage"), nil, http.StatusServiceUnavailable},
		{"expired context after success", nil, context.DeadlineExceeded, http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := conclusionStatus(test.err, test.ctxErr); got != test.want {
				t.Fatalf("conclusionStatus() = %d, want %d", got, test.want)
			}
		})
	}
}
