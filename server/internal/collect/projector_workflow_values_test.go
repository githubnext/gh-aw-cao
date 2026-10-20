package collect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
	"github.com/githubnext/gh-cao/server/internal/postgresx"
)

type workflowValueLease struct {
	operational.LeaseStore
	acquire bool
	locks   int
	release context.CancelFunc
}

func (l *workflowValueLease) TryLock(_ context.Context, name, _ string, _ time.Duration) (bool, error) {
	if name != projectionLockName {
		return false, errors.New("recurring values must share the projection lease")
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

func TestQuietProjectionTickDrivesReviewedWorkflowValuesWithoutNewActivity(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	directory, err := os.MkdirTemp(".", ".quiet-workflow-values-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	policy, _ := filepath.Abs(filepath.Join(directory, "cao.json"))
	if err := os.WriteFile(policy, []byte(`{"version":1,"gh-aw-version":"v0.92.5","control-plane":{"campaigns":{"activity":{"workflow-values":[]}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lease := &workflowValueLease{acquire: true, release: cancel}
	worker := Worker{Projector: Projector{
		State: quietProjectionState{}, Leases: lease, Data: &postgresx.Store{},
		CatalogRoot: root, PolicyPath: policy, Tokens: fakeTokens{}, MinInterval: time.Millisecond,
	}}
	worker.projectionLoop(ctx)
	if lease.locks == 0 {
		t.Fatalf("quiet repository did not use the existing projection driver for Value cadence: locks=%d", lease.locks)
	}
}

func TestWorkflowValueCollectionSharesProjectionLease(t *testing.T) {
	lease := &workflowValueLease{}
	projector := Projector{Leases: lease, Data: &postgresx.Store{}, CatalogRoot: "unused", PolicyPath: "unused", Tokens: fakeTokens{}}
	if _, err := projector.CollectWorkflowValues(context.Background()); !errors.Is(err, ErrProjectionBusy) || lease.locks != 1 {
		t.Fatalf("recurring producer bypassed snapshot lease: locks=%d err=%v", lease.locks, err)
	}
}
