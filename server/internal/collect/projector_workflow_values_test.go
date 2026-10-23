package collect

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

type workflowValueLease struct {
	operational.LeaseStore
	acquire bool
	locks   int
	release context.CancelFunc
}

func (l *workflowValueLease) TryLock(_ context.Context, name, _ string, _ time.Duration) (bool, error) {
	if name != localValueLockName {
		return false, errors.New("optional local values must not acquire the projection lease")
	}
	l.locks++
	return l.acquire, nil
}

func (l *workflowValueLease) Unlock(context.Context, string, string) error {
	if l.release != nil {
		l.release()
	}
	return nil
}

type quietProjectionState struct{ operational.StateStore }

func (quietProjectionState) OperationalState(context.Context, string) ([]byte, error) {
	return nil, nil
}

func TestLocalValuesHaveAnIndependentOwnedLoop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lease := &workflowValueLease{acquire: true, release: cancel}
	worker := Worker{Projector: Projector{
		State: quietProjectionState{}, Leases: lease,
		CatalogRoot: "unused", PolicyPath: "unused", MinInterval: time.Millisecond,
	}}
	worker.localValueLoop(ctx)
	if lease.locks == 0 {
		t.Fatalf("independent local computation did not check its own lease: locks=%d", lease.locks)
	}
}

func TestLocalValueLeaseBoundsConcurrencyWithoutBlockingProjection(t *testing.T) {
	lease := &workflowValueLease{}
	projector := Projector{Leases: lease, State: quietProjectionState{}, CatalogRoot: "unused", PolicyPath: "unused"}
	if err := projector.CollectLocalValues(context.Background()); !errors.Is(err, ErrLocalValueBusy) || lease.locks != 1 {
		t.Fatalf("local producer bypassed its concurrency bound: locks=%d err=%v", lease.locks, err)
	}
}

func TestQuietProjectionDoesNotWaitForOptionalValueWork(t *testing.T) {
	lease := &workflowValueLease{}
	worker := Worker{Projector: Projector{State: quietProjectionState{}, Leases: lease, MinInterval: time.Millisecond}}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel()
	worker.projectionLoop(ctx)
	if lease.locks != 0 {
		t.Fatal("core projection must not start or wait for optional Value work")
	}
}
