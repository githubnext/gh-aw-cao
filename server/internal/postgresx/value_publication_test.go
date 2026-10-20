package postgresx

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
)

func publicationFact(t *testing.T, row model.Row, kind string) map[string]any {
	t.Helper()
	for _, item := range row["facts"].([]any) {
		fact := item.(map[string]any)
		if fact["fact-kind"] == kind {
			return fact
		}
	}
	t.Fatalf("missing %s fact", kind)
	return nil
}

func laterPublication(t *testing.T) model.Row {
	t.Helper()
	row := evidencePacket(t)
	row["observedAt"] = "2026-10-20T13:00:00Z"
	return row
}

func seedPublicationParents(t *testing.T, store *Store, packet model.Row) {
	t.Helper()
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	for _, input := range []struct {
		source string
		row    model.Row
	}{
		{"$campaigns", model.Row{"id": "value-campaign", "slug": "example", "enabled": false}},
		{"$repositories", model.Row{"id": packet["repositoryId"], "owner": "octo", "name": "example", "rolloutMode": "review"}},
		{"$workflows", model.Row{"id": packet["workflowId"], "repositoryId": packet["repositoryId"],
			"campaignId": "value-campaign", "path": packet["sourcePath"], "state": "disabled", "rolloutMode": "review"}},
	} {
		if err := writer.Append(t.Context(), input.source, input.row); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := writer.Publish(t.Context(), "parents"); err != nil {
		t.Fatal(err)
	}
}

func assertPublicationError(t *testing.T, store *Store, packet model.Row, want error) {
	t.Helper()
	before, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.PublishOperationalValue(t.Context(), packet); !errors.Is(err, want) {
		t.Fatalf("wanted %v, got %v", want, err)
	}
	after, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if before.Revision != after.Revision || before.DataRevision != after.DataRevision ||
		before.Counts["$operationalValueEvidence"] != after.Counts["$operationalValueEvidence"] {
		t.Fatal("failed publication changed canonical state")
	}
}

func TestValuePublicationNormalizationAndValidation(t *testing.T) {
	packet := evidencePacket(t)
	delete(packet, "repositoryId")
	delete(packet, "workflowId")
	normalized, digest, err := normalizeValuePublication(packet)
	if err != nil || normalized["repositoryId"] != "repository:octo%2Fexample" || len(digest) != 64 {
		t.Fatalf("normalize structural identity: %v", err)
	}
	slices.Reverse(packet["facts"].([]any))
	_, reordered, err := normalizeValuePublication(packet)
	if err != nil || reordered != digest {
		t.Fatal("canonical retry digest depends on fact order")
	}
	numeric := evidencePacket(t)
	publicationFact(t, numeric, "implementation")["value"] = json.Number("9007199254740993")
	precise, _, err := normalizeValuePublication(numeric)
	if err != nil || publicationFact(t, precise, "implementation")["value"] != json.Number("9007199254740993") {
		t.Fatal("native decimal evidence was rounded through float64")
	}
	numeric = evidencePacket(t)
	publicationFact(t, numeric, "implementation")["value"] = json.Number("1.000")
	_, equivalent, err := normalizeValuePublication(numeric)
	if err != nil || equivalent != digest {
		t.Fatalf("canonical retry digest must compare numeric values, not JSON spelling: %s %s %v", equivalent, digest, err)
	}
	for _, mutate := range []func(model.Row){
		func(row model.Row) { row["observedAt"] = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano) },
		func(row model.Row) { row["facts"] = []any{} },
		func(row model.Row) { row["repositoryId"] = "unobserved" },
		func(row model.Row) { row["html"] = "<p>derived</p>" },
		func(row model.Row) { publicationFact(t, row, "snapshot")["value"] = "script()" },
	} {
		packet := evidencePacket(t)
		mutate(packet)
		// A zero store proves validation happens before connecting or writing.
		if _, err := (&Store{}).PublishOperationalValue(t.Context(), packet); !errors.Is(err, ErrValueInvalid) {
			t.Fatalf("expected bounded validation failure, got %v", err)
		}
	}
}

func TestValuePublicationFrozenHistory(t *testing.T) {
	previous := evidencePacket(t)
	for _, test := range []struct {
		name   string
		mutate func(model.Row)
	}{
		{"stale", func(row model.Row) { row["observedAt"] = "2026-10-20T11:00:00Z" }},
		{"equal capture", func(row model.Row) { row["observedAt"] = previous["observedAt"] }},
		{"shrunk history window", func(row model.Row) { row["windowStart"] = "2026-10-15T00:00:00Z" }},
		{"contract digest", func(row model.Row) { row["contractDigest"] = strings.Repeat("a", 64) }},
		{"frozen function", func(row model.Row) { publicationFact(t, row, "contract")["metric-formula"] = "Another function." }},
		{"accepted value", func(row model.Row) { publicationFact(t, row, "implementation")["value"] = 2.0 }},
		{"accepted revision", func(row model.Row) { publicationFact(t, row, "implementation")["ref"] = "different123" }},
		{"accepted time", func(row model.Row) {
			fact := publicationFact(t, row, "implementation")
			fact["at"], fact["accepted-at"] = "2026-10-11T12:00:00Z", "2026-10-11T12:00:00Z"
		}},
		{"snapshot value", func(row model.Row) { publicationFact(t, row, "snapshot")["value"] = 99.0 }},
		{"snapshot item", func(row model.Row) { publicationFact(t, row, "snapshot-item")["label"] = "Rewritten" }},
		{"removed history", func(row model.Row) {
			row["facts"] = slices.DeleteFunc(row["facts"].([]any), func(item any) bool {
				return item.(map[string]any)["fact-kind"] == "snapshot-item"
			})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			next := laterPublication(t)
			test.mutate(next)
			if !errors.Is(validateValueReplacement(previous, next), ErrValueConflict) {
				t.Fatal("history mutation did not conflict")
			}
		})
	}
	next := laterPublication(t)
	publicationFact(t, next, "output")["state"] = "open"
	publicationFact(t, next, "output")["origin"] = "receipt-verified"
	publicationFact(t, next, "implementation")["origin"] = "receipt-verified"
	publicationFact(t, next, "quality-check")["status"] = "verified"
	if err := validateValueReplacement(previous, next); err != nil {
		t.Fatalf("new capture must allow strengthened receipts and lifecycle: %v", err)
	}
}

func TestValuePublicationHostedAtomicityAndRetries(t *testing.T) {
	store, _ := nativeTestStore(t)
	packet := evidencePacket(t)
	assertPublicationError(t, store, packet, ErrValueParentMissing)
	seedPublicationParents(t, store, packet)
	initial, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil || !initial.Updated || initial.ID != packet["id"] || initial.ObservedAt != packet["observedAt"] {
		t.Fatalf("initial publication: %+v %v", initial, err)
	}
	slices.Reverse(packet["facts"].([]any))
	retry, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil || retry.Updated || retry.Revision != initial.Revision {
		t.Fatalf("exact retry changed revision: %+v %v", retry, err)
	}
	for _, mutate := range []func(model.Row){
		func(row model.Row) { row["observedAt"] = "2026-10-20T11:00:00Z" },
		func(row model.Row) { publicationFact(t, row, "quality-check")["status"] = "verified" },
		func(row model.Row) {
			row["observedAt"] = "2026-10-20T13:00:00Z"
			publicationFact(t, row, "snapshot")["value"] = 42.0
		},
	} {
		conflict := evidencePacket(t)
		mutate(conflict)
		assertPublicationError(t, store, conflict, ErrValueConflict)
	}
	next := laterPublication(t)
	publicationFact(t, next, "implementation")["origin"] = "receipt-verified"
	updated, err := store.PublishOperationalValue(t.Context(), next)
	if err != nil || !updated.Updated || updated.Revision != initial.Revision+1 {
		t.Fatalf("strengthened publication: %+v %v", updated, err)
	}
	// A database failure after typed rows were replaced must roll back rows,
	// ownership, and revision together rather than become a validation fallback.
	if _, err := store.db.ExecContext(t.Context(), `CREATE FUNCTION reject_value_publication() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'injected publication failure'; END; $$;
		CREATE TRIGGER reject_value_publication BEFORE INSERT OR UPDATE ON cao_value_publications
		FOR EACH ROW EXECUTE FUNCTION reject_value_publication()`); err != nil {
		t.Fatal(err)
	}
	failed := laterPublication(t)
	failed["observedAt"] = "2026-10-20T14:00:00Z"
	publicationFact(t, failed, "implementation")["origin"] = "receipt-verified"
	if _, err := store.PublishOperationalValue(t.Context(), failed); err == nil ||
		errors.Is(err, ErrValueInvalid) || errors.Is(err, ErrValueConflict) {
		t.Fatalf("infrastructure error was hidden: %v", err)
	}
	if _, err := store.db.ExecContext(t.Context(), `DROP TRIGGER reject_value_publication ON cao_value_publications`); err != nil {
		t.Fatal(err)
	}
	retry, err = store.PublishOperationalValue(t.Context(), next)
	if err != nil || retry.Updated || retry.Revision != updated.Revision {
		t.Fatal("failed transaction did not preserve the prior packet and metadata")
	}
	state, err := store.State(t.Context())
	if err != nil || state.DataRevision != "parents" {
		t.Fatalf("direct publication changed snapshot source identity: %+v %v", state, err)
	}
}

func TestValuePublicationSurvivesSnapshotReplacement(t *testing.T) {
	store, _ := nativeTestStore(t)
	packet := evidencePacket(t)
	seedPublicationParents(t, store, packet)
	published, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil {
		t.Fatal(err)
	}
	for _, snapshot := range []string{"omitted", "stale", "fresh-inventory", "same-data-revision"} {
		t.Run(snapshot, func(t *testing.T) {
			writer, err := store.BeginIngestion(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Abort(t.Context())
			if snapshot == "stale" {
				stale := evidencePacket(t)
				publicationFact(t, stale, "snapshot")["value"] = 999.0
				if err := writer.Append(t.Context(), "$operationalValueEvidence", stale); err != nil {
					t.Fatal(err)
				}
			}
			if snapshot == "fresh-inventory" {
				for source, row := range map[string]model.Row{
					"$repositories": {"id": packet["repositoryId"], "owner": "octo", "name": "example", "rolloutMode": "off"},
					"$workflows": {"id": packet["workflowId"], "repositoryId": packet["repositoryId"],
						"path": packet["sourcePath"], "state": "deleted", "rolloutMode": "off"},
				} {
					if err := writer.AppendInventory(t.Context(), source, row); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := writer.Publish(t.Context(), "replacement"); err != nil {
				t.Fatal(err)
			}
			retry, err := store.PublishOperationalValue(t.Context(), packet)
			if err != nil || retry.Updated || retry.Revision <= published.Revision {
				t.Fatalf("publication ownership lost: %+v %v", retry, err)
			}
			sources, _, err := store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"operational-value-evidence"})
			if err != nil {
				t.Fatal(err)
			}
			facts := sources["operational-value-evidence"]
			if len(facts.Rows) != len(packet["facts"].([]any)) || facts.Metadata["as-of"] != packet["windowEnd"] ||
				facts.Metadata["retrieved-at"] != packet["observedAt"] || facts.Metadata["freshness"] != "unknown" {
				t.Fatalf("native facts or explicit cutoff lost: %+v", facts.Metadata)
			}
			var state, rollout string
			if err := store.db.QueryRowContext(t.Context(), `SELECT state,rollout_mode FROM workflows WHERE namespace=$1 AND id=$2`,
				store.namespace, packet["workflowId"]).Scan(&state, &rollout); err != nil {
				t.Fatal(err)
			}
			want := "disabled"
			if snapshot == "fresh-inventory" || snapshot == "same-data-revision" {
				want = "deleted"
			}
			if state != want || (rollout != "review" && rollout != "off") {
				t.Fatalf("snapshot restoration fabricated workflow authority: %s %s", state, rollout)
			}
		})
	}
}

func TestValuePublicationNamespacesAndMetricVersions(t *testing.T) {
	store, config := nativeTestStore(t)
	other, err := openConfig(t.Context(), config, false, "other")
	if err != nil {
		t.Fatal(err)
	}

	defer func() { _ = other.Close() }()
	packet := evidencePacket(t)
	seedPublicationParents(t, store, packet)
	assertPublicationError(t, other, packet, ErrValueParentMissing)
	seedPublicationParents(t, other, packet)
	for _, target := range []*Store{store, other} {
		if _, err := target.PublishOperationalValue(t.Context(), packet); err != nil {
			t.Fatal(err)
		}
	}
	v2 := evidencePacket(t)
	publicationFact(t, v2, "contract")["metric-version"] = "v2"
	v2["id"] = strings.TrimSuffix(v2["id"].(string), "v1") + "v2"
	if _, err := store.PublishOperationalValue(t.Context(), v2); err != nil {
		t.Fatal(err)
	}
	for _, target := range []*Store{store, other} {
		state, err := target.State(t.Context())
		want := 1
		if target == store {
			want = 2
		}
		if err != nil || state.Counts["$operationalValueEvidence"] != want {
			t.Fatalf("namespace or ordinal collision: %+v %v", state, err)
		}
	}
	// Publication and ingestion share the transaction-scoped namespace lock.
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if _, err := store.PublishOperationalValue(ctx, packet); !errors.Is(err, context.DeadlineExceeded) {
		writer.Abort(t.Context())
		t.Fatalf("publication did not serialize with ingestion: %v", err)
	}
	writer.Abort(t.Context())
	if _, err := store.PublishOperationalValue(t.Context(), packet); err != nil {
		t.Fatal(err)
	}
}

func TestValuePublicationRespectsExistingSnapshotFacts(t *testing.T) {
	store, _ := nativeTestStore(t)
	packet := evidencePacket(t)
	seedPublicationParents(t, store, packet)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	for source, row := range map[string]model.Row{
		"$repositories": {"id": packet["repositoryId"], "owner": "octo", "name": "example"},
		"$workflows": {"id": packet["workflowId"], "repositoryId": packet["repositoryId"],
			"path": packet["sourcePath"], "state": "unknown"},
		"$operationalValueEvidence": packet,
	} {
		if err := writer.Append(t.Context(), source, row); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := writer.Publish(t.Context(), "snapshot-with-value"); err != nil {
		t.Fatal(err)
	}
	conflict := laterPublication(t)
	publicationFact(t, conflict, "implementation")["ref"] = "rewritten123"
	assertPublicationError(t, store, conflict, ErrValueConflict)
	conflict = laterPublication(t)
	publicationFact(t, conflict, "snapshot")["value"] = 42.0
	assertPublicationError(t, store, conflict, ErrValueConflict)
	var owners int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM cao_value_publications WHERE namespace=$1`,
		store.namespace).Scan(&owners); err != nil || owners != 0 {
		t.Fatal("rejected publication acquired ownership")
	}
	result, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil || !result.Updated {
		t.Fatalf("an exact existing native packet must be explicitly claimable: %+v %v", result, err)
	}
}

func recurringPublication(t *testing.T) model.Row {
	t.Helper()
	row := evidencePacket(t)
	row["observedAt"] = "2026-10-20T15:00:00Z"
	row["windowEnd"] = "2026-10-20T14:00:00Z"
	row["facts"] = append(row["facts"].([]any),
		map[string]any{"fact-kind": "implementation", "fact-id": "accepted:3",
			"at": "2026-10-20T14:00:00Z", "accepted-at": "2026-10-20T14:00:00Z",
			"value": 2.0, "ref": "next123", "origin": "corroborated"},
		map[string]any{"fact-kind": "snapshot", "fact-id": "snapshot:next",
			"at": "2026-10-20T14:00:00Z", "value": 0.0, "ref": "next123", "items-available": false},
	)
	return row
}

func TestValuePublicationRecurringCapturesRetainHistory(t *testing.T) {
	next := recurringPublication(t)
	if err := validateOperationalValueEvidence(next); err != nil {
		t.Fatal(err)
	}
	previous := evidencePacket(t)
	if err := validateValueReplacement(previous, next); err != nil {
		t.Fatalf("a later recurring capture cannot append facts: %v", err)
	}
	capture, _ := evidenceTime(previous["observedAt"])
	if err := validateValueSnapshotCapture(capture, next); !errors.Is(err, ErrValueConflict) {
		t.Fatal("newer owned snapshot capture would be silently ignored")
	}
	if err := validateValueSnapshotCapture(capture, previous); err != nil {
		t.Fatalf("an existing snapshot copy cannot be preserved: %v", err)
	}
	publicationFact(t, next, "implementation")["value"] = 9.0
	if err := validateValueReplacement(previous, next); !errors.Is(err, ErrValueConflict) {
		t.Fatal("recurring collection rewrote accepted historical evidence")
	}
}

func TestValuePublicationHostedRecurringCapture(t *testing.T) {
	store, _ := nativeTestStore(t)
	packet := evidencePacket(t)
	seedPublicationParents(t, store, packet)
	initial, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil {
		t.Fatal(err)
	}
	next := recurringPublication(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	err = writer.Append(t.Context(), "$operationalValueEvidence", next)
	writer.Abort(t.Context())
	if !errors.Is(err, ErrValueConflict) {
		t.Fatalf("newer owned snapshot capture did not fail closed: %v", err)
	}
	state, err := store.State(t.Context())
	if err != nil || state.Revision != initial.Revision {
		t.Fatal("rejected newer snapshot changed published state")
	}
	published, err := store.PublishOperationalValue(t.Context(), next)
	if err != nil || !published.Updated || published.Revision != initial.Revision+1 {
		t.Fatalf("recurring producer cannot publish a valid later capture: %+v %v", published, err)
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"operational-value-evidence"})
	if err != nil {
		t.Fatal(err)
	}
	evidence := sources["operational-value-evidence"]
	if len(evidence.Rows) != len(next["facts"].([]any)) || evidence.Metadata["retrieved-at"] != next["observedAt"] ||
		evidence.Metadata["as-of"] != next["windowEnd"] {
		t.Fatalf("recurring facts or capture cutoff lost: %v", evidence.Metadata)
	}
	retry, err := store.PublishOperationalValue(t.Context(), next)
	if err != nil || retry.Updated || retry.Revision != published.Revision {
		t.Fatalf("recurring retry is not idempotent: %+v %v", retry, err)
	}
}
