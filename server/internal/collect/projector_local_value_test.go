package collect

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/ingest"
	"github.com/githubnext/gh-cao/server/internal/operational"
)

type localValueAttemptState struct {
	operational.StateStore
	values map[string][]byte
}

func (s *localValueAttemptState) OperationalState(_ context.Context, key string) ([]byte, error) {
	return s.values[key], nil
}

func (s *localValueAttemptState) SetOperationalState(_ context.Context, key string, value []byte) error {
	s.values[key] = value
	return nil
}

func TestLocalValueFailureDoesNotRetryOrRequestCoreProjection(t *testing.T) {
	state := &localValueAttemptState{values: map[string][]byte{projectionCompletedKey: []byte("generation-1")}}
	projector := Projector{
		Leases: &workflowValueLease{acquire: true}, State: state,
		CatalogRoot: "unused", PolicyPath: "unused", Lake: Lake{Directory: t.TempDir()},
	}
	if err := projector.CollectLocalValues(t.Context()); err == nil {
		t.Fatal("missing snapshot must explicitly fail optional work")
	}
	if string(state.values[localValueAttemptKey]) != "generation-1" || len(state.values) != 2 {
		t.Fatalf("optional failure changed core state: %v", state.values)
	}
	if err := projector.CollectLocalValues(t.Context()); err != nil {
		t.Fatalf("the same completed input was retried: %v", err)
	}
}

func TestLocalValueSnapshotIsPrivateVerifiedAndBounded(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	for _, directory := range []string{lake.RunsDirectory(), lake.ShardDirectory()} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	content := []byte("{}\n")
	digest := sha256.Sum256(content)
	name := "gh-aw-logs-runs/fixture.jsonl"
	source := filepath.Join(lake.Directory, filepath.FromSlash(name))
	manifest, _ := json.Marshal(ingest.Manifest{name: hex.EncodeToString(digest[:])})
	for file, value := range map[string][]byte{
		source: content, lake.ManifestPath(): manifest,
		filepath.Join(lake.ShardDirectory(), "workflow-value-local.json"): []byte("[]"),
		lake.operationalValuesPath():                                      []byte("retained\n"),
	} {
		if err := os.WriteFile(file, value, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	destination := t.TempDir()
	if err := copyLocalValueSnapshot(t.Context(), lake, destination); err != nil {
		t.Fatal(err)
	}
	policy := filepath.Join(t.TempDir(), "cao.json")
	if err := os.WriteFile(policy, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	liveRevision, err := readLocalValueRevision(t.Context(), lake.Directory, policy, lake.operationalValuesPath())
	if err != nil {
		t.Fatal(err)
	}
	copiedRevision, err := readLocalValueRevision(t.Context(), destination, policy, filepath.Join(destination, "operational-values.jsonl"))
	if err != nil || copiedRevision != liveRevision {
		t.Fatalf("snapshot changed its publication precondition: %v", err)
	}
	if _, _, _, err := ingest.ValidateManifest(destination); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyLocalValueSnapshot(t.Context(), lake, t.TempDir()); err == nil ||
		!strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("changed inputs were accepted as immutable: %v", err)
	}
	if err := os.Truncate(source, 17<<20); err != nil {
		t.Fatal(err)
	}
	if err := copyLocalValueSnapshot(t.Context(), lake, t.TempDir()); err == nil ||
		!strings.Contains(err.Error(), "oversized") {
		t.Fatalf("oversized input was read or accepted: %v", err)
	}
	if retained, err := os.ReadFile(lake.operationalValuesPath()); err != nil || string(retained) != "retained\n" {
		t.Fatal("a failed disposable snapshot changed accepted evidence")
	}
}

func localValuePublicationFixture(t *testing.T) (Projector, string, localValueRevision) {
	t.Helper()
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	policy, output := filepath.Join(t.TempDir(), "cao.json"), filepath.Join(t.TempDir(), "computed.jsonl")
	for filename, content := range map[string]string{
		lake.ManifestPath():          "{}",
		policy:                       `{"version":1}`,
		lake.operationalValuesPath(): retainedValueLine("octo/api", "worker.retained"),
		output:                       retainedValueLine("octo/api", "worker.retained") + retainedValueLine("octo/api", "worker.new"),
	} {
		if err := os.WriteFile(filename, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	revision, err := readLocalValueRevision(t.Context(), lake.Directory, policy, lake.operationalValuesPath())
	if err != nil {
		t.Fatal(err)
	}
	return Projector{
		Lake: lake, PolicyPath: policy,
		State: &localValueAttemptState{values: map[string][]byte{projectionCompletedKey: []byte("generation-1")}},
	}, output, revision
}

func TestLocalValuePublicationRejectsSupersededInputs(t *testing.T) {
	for _, changed := range []string{"generation", "policy", "manifest", "accepted-evidence", "cancelled"} {
		t.Run(changed, func(t *testing.T) {
			projector, output, revision := localValuePublicationFixture(t)
			ctx := t.Context()
			switch changed {
			case "generation":
				if err := projector.State.SetOperationalState(ctx, projectionCompletedKey, []byte("generation-2")); err != nil {
					t.Fatal(err)
				}
			case "policy", "manifest", "accepted-evidence":
				filename := map[string]string{
					"policy": projector.PolicyPath, "manifest": projector.Lake.ManifestPath(),
					"accepted-evidence": projector.Lake.operationalValuesPath(),
				}[changed]
				if err := os.WriteFile(filename, []byte(retainedValueLine("octo/api", "worker.newer")), 0o600); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			before, err := os.ReadFile(projector.Lake.operationalValuesPath())
			if err != nil {
				t.Fatal(err)
			}
			if err := projector.publishLocalValues(ctx, output, []byte("generation-1"), revision); err == nil {
				t.Fatalf("%s allowed stale publication", changed)
			}
			after, err := os.ReadFile(projector.Lake.operationalValuesPath())
			if err != nil || string(after) != string(before) {
				t.Fatalf("%s changed accepted evidence: %v", changed, err)
			}
		})
	}
}

func TestLocalValuePublicationRechecksEnrollmentAndDoesNotRequestProjection(t *testing.T) {
	store, ctx := integrationStore(t)
	for _, enrolled := range []bool{true, false} {
		projector, output, revision := localValuePublicationFixture(t)
		projector.Enrollment = Enrollment{Metadata: store, Leases: store}
		if enrolled {
			if err := projector.Enrollment.AddRepositories(ctx, 7, []string{"octo/api"}); err != nil {
				t.Fatal(err)
			}
		} else if _, err := projector.Enrollment.RemoveRepositories(ctx, 7, []string{"octo/api"}); err != nil {
			t.Fatal(err)
		}
		if err := projector.publishLocalValues(ctx, output, []byte("generation-1"), revision); err != nil {
			t.Fatal(err)
		}
		content, err := os.ReadFile(projector.Lake.operationalValuesPath())
		if err != nil || strings.Contains(string(content), "worker.new") != enrolled {
			t.Fatalf("publication bypassed current enrollment: %q, %v", content, err)
		}
		if pending, err := projector.PendingProjection(ctx); pending || err != nil {
			t.Fatalf("optional publication created a projection loop: %t, %v", pending, err)
		}
	}
}
