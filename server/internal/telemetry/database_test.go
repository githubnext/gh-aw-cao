package telemetry

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
)

func TestDatabaseErrorTypeIsBounded(t *testing.T) {
	for _, test := range []struct {
		err  error
		want string
	}{
		{nil, ""},
		{context.Canceled, "canceled"},
		{fmt.Errorf("private detail: %w", context.Canceled), "canceled"},
		{context.DeadlineExceeded, "timeout"},
		{&net.DNSError{Err: "private hostname", IsTimeout: true}, "timeout"},
		{errors.New("private error message"), "_OTHER"},
	} {
		if got := DatabaseErrorType(test.err); got != test.want {
			t.Errorf("DatabaseErrorType = %q, want %q", got, test.want)
		}
	}
}
