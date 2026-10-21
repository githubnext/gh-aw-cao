package admission

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestConclusionFailureStatus(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"denied", ErrDenied, http.StatusForbidden},
		{"wrapped denied", fmt.Errorf("authorize: %w", ErrDenied), http.StatusForbidden},
		{"unavailable", ErrUnavailable, http.StatusServiceUnavailable},
		{"other", errors.New("storage failure"), http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := conclusionFailureStatus(tc.err); got != tc.want {
				t.Fatalf("status = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestPublishConclusionRequiresAcceptanceTime(t *testing.T) {
	var s Service
	err := s.publishConclusion(context.Background(), Identity{}, ConclusionRequest{}, ConclusionReceipt{})
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}
