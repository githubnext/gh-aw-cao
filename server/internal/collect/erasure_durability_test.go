package collect

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/operational"
	"github.com/githubnext/gh-cao/server/internal/postgresx"
)

type projectionFaultState struct {
	operational.StateStore
	beforeSet func(context.Context, string, []byte) error
	afterSet  func(string)
	afterRead func(string)
}

func (s projectionFaultState) SetOperationalState(ctx context.Context, key string, value []byte) error {
	if s.beforeSet != nil {
		if err := s.beforeSet(ctx, key, value); err != nil {
			return err
		}
	}
	if err := s.StateStore.SetOperationalState(ctx, key, value); err != nil {
		return err
	}
	if s.afterSet != nil {
		s.afterSet(key)
	}
	return nil
}

func (s projectionFaultState) OperationalState(ctx context.Context, key string) ([]byte, error) {
	value, err := s.StateStore.OperationalState(ctx, key)
	if s.afterRead != nil {
		s.afterRead(key)
	}
	return value, err
}

func TestErasurePersistsProjectionBeforeAcknowledgement(t *testing.T) {
	for _, path := range []string{"explicit", "explicit-without-enrollment", "withdrawn-collection"} {
		for _, failure := range []string{"none", "marker-write", "cancel-before-marker", "cancel-after-marker"} {
			t.Run(path+"/"+failure, func(t *testing.T) {
				w := refreshWorker(t)
				ctx := t.Context()
				task := Task{Repository: "octo/withdrawn", Erase: path != "withdrawn-collection"}
				if path == "explicit-without-enrollment" {
					w.Enrollment = Enrollment{}
				}
				shard := retainedRepository(t, w.Runner.Lake, task.Repository)
				if _, err := w.Queue.Enqueue(ctx, task); err != nil {
					t.Fatal(err)
				}
				lease := refreshLease(t, w.Queue)
				processCtx, cancel := context.WithCancel(ctx)
				defer cancel()
				state := w.Projector.State
				w.Projector.State = projectionFaultState{
					StateStore: state,
					beforeSet: func(ctx context.Context, key string, _ []byte) error {
						if key != projectionDirtyKey {
							return nil
						}
						if _, err := os.Stat(shard); !errors.Is(err, os.ErrNotExist) {
							t.Fatalf("projection intent preceded deletion: %v", err)
						}
						if failure == "marker-write" {
							return errors.New("injected state write failure")
						}
						if failure == "cancel-before-marker" {
							cancel()
							return ctx.Err()
						}
						return nil
					},
					afterSet: func(key string) {
						if key == projectionDirtyKey && failure == "cancel-after-marker" {
							cancel()
						}
					},
				}
				w.process(processCtx, lease)
				// Inspect through a fresh projector, not the failed worker's state wrapper.
				restarted := Projector{State: state}
				pending, err := restarted.PendingProjection(ctx)
				if err != nil || pending != (failure == "none" || failure == "cancel-after-marker") {
					t.Fatalf("pending projection = %t, %v", pending, err)
				}
				wantPending := int64(0)
				if failure != "none" {
					wantPending = 1
				}
				depth, err := w.Queue.Pending(ctx)
				if err != nil || depth != wantPending {
					t.Fatalf("recoverable task depth = %d, %v", depth, err)
				}
				if failure != "none" {
					leases, err := w.Queue.Reclaim(ctx, "replacement", 0, 1)
					if err != nil || len(leases) != 1 {
						t.Fatalf("reclaim after interruption = %+v, %v", leases, err)
					}
					w.Projector.State = state
					if !w.process(ctx, leases[0]) {
						t.Fatal("reclaimed erasure did not complete")
					}
				}
				if depth, err := w.Queue.Pending(ctx); err != nil || depth != 0 {
					t.Fatalf("recovered task depth = %d, %v", depth, err)
				}
				if pending, err := restarted.PendingProjection(ctx); err != nil || !pending {
					t.Fatalf("acknowledged erasure lost projection: %t, %v", pending, err)
				}
			})
		}
	}
}

func TestProjectionInterruptionNeverConsumesIntent(t *testing.T) {
	for _, failure := range []string{"compaction-and-state-outage", "cancellation", "crash-equivalent"} {
		t.Run(failure, func(t *testing.T) {
			w := refreshWorker(t)
			p := w.Projector
			p.Data = &postgresx.Store{} // Interruption happens before any database operation.
			p.DatabaseQueriesPath = databaseQueries
			state := p.State
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			writes := 0
			p.State = projectionFaultState{
				StateStore: state,
				beforeSet: func(context.Context, string, []byte) error {
					writes++
					if writes > 1 {
						return errors.New("operational state is unavailable")
					}
					return nil
				},
				afterRead: func(key string) {
					if key != projectionDirtyKey {
						return
					}
					switch failure {
					case "cancellation":
						cancel()
					case "crash-equivalent":
						panic("process stopped after reading projection generation")
					}
				},
			}
			if failure == "crash-equivalent" {
				func() {
					defer func() {
						if recover() == nil {
							t.Fatal("crash boundary was not reached")
						}
					}()
					_, _ = p.Project(ctx)
				}()
			} else if _, err := p.Project(ctx); err == nil {
				t.Fatal("expected interrupted projection to fail")
			}
			if pending, err := (Projector{State: state}).PendingProjection(t.Context()); err != nil || !pending {
				t.Fatalf("restart lost interrupted projection: %t, %v", pending, err)
			}
		})
	}
}
