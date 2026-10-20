package postgresx

import (
	"errors"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/model"
)

func TestReadOperationalValueValidatesExactPair(t *testing.T) {
	for _, pair := range [][2]string{
		{"", "verify-bugs"}, {"octo", "verify-bugs"}, {"octo/example", "../verify-bugs"},
		{"octo/example", "verify-bugs.md"}, {"octo/example", ""},
	} {
		if _, err := (&Store{}).ReadOperationalValue(t.Context(), pair[0], pair[1]); !errors.Is(err, ErrValueInvalid) {
			t.Fatalf("invalid exact pair reached the database: %v", err)
		}
	}
}

func TestReadOperationalValueHosted(t *testing.T) {
	store, config := nativeTestStore(t)
	if _, err := store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs"); !errors.Is(err, ErrValueParentMissing) {
		t.Fatalf("unobserved pair did not fail closed: %v", err)
	}
	packet := evidencePacket(t)
	seedPublicationParents(t, store, packet)
	if _, err := store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs"); !errors.Is(err, ErrValueNotFound) {
		t.Fatalf("missing explicit publication was not distinguished: %v", err)
	}
	initial, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil {
		t.Fatal(err)
	}
	read, err := store.ReadOperationalValue(t.Context(), "Octo/Example", "verify-bugs")
	if err != nil || read["id"] != packet["id"] || read["observedAt"] != packet["observedAt"] ||
		len(read["facts"].([]any)) != len(packet["facts"].([]any)) {
		t.Fatalf("bounded exact read lost typed packet identity: %v", err)
	}
	retry, err := store.PublishOperationalValue(t.Context(), read)
	if err != nil || retry.Updated || retry.Revision != initial.Revision {
		t.Fatalf("read packet no longer matches canonical retry identity: %+v %v", retry, err)
	}
	other, err := openConfig(t.Context(), config, false, "read-other")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	if _, err := other.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs"); !errors.Is(err, ErrValueParentMissing) {
		t.Fatalf("exact read leaked another namespace's packet: %v", err)
	}
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	read, err = store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs")
	writer.Abort(t.Context())
	if err != nil || read["id"] != packet["id"] {
		t.Fatalf("read exposed uncommitted snapshot replacement: %v", err)
	}
	next := recurringPublication(t)
	if _, err := store.PublishOperationalValue(t.Context(), next); err != nil {
		t.Fatal(err)
	}
	read, err = store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs")
	if err != nil || read["observedAt"] != next["observedAt"] {
		t.Fatalf("exact read did not select the latest capture: %v", err)
	}
	v2 := recurringPublication(t)
	publicationFact(t, v2, "contract")["metric-version"] = "v2"
	v2["id"] = strings.TrimSuffix(v2["id"].(string), "v1") + "v2"
	if _, err := store.PublishOperationalValue(t.Context(), v2); err != nil {
		t.Fatal(err)
	}
	read, err = store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs")
	if err != nil || read["id"] != v2["id"] {
		t.Fatalf("equal-capture metric versions were not selected deterministically: %v", err)
	}
}

func TestReadOperationalValuePreservesSnapshotHistoryForRecurringCollection(t *testing.T) {
	store, _ := nativeTestStore(t)
	packet := evidencePacket(t)
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
	if _, err := writer.Publish(t.Context(), "activity-evidence"); err != nil {
		t.Fatal(err)
	}
	read, err := store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs")
	if err != nil || read["id"] != packet["id"] || len(read["facts"].([]any)) != len(packet["facts"].([]any)) {
		t.Fatalf("Actions-ingested history is unavailable to the exact-pair reader: %v", err)
	}
	var ownership int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM cao_value_publications WHERE namespace=$1`,
		store.namespace).Scan(&ownership); err != nil || ownership != 0 {
		t.Fatal("reading snapshot evidence inferred publication ownership")
	}
	next := recurringPublication(t)
	if _, err := store.PublishOperationalValue(t.Context(), next); err != nil {
		t.Fatalf("valid recurring capture could not retain Activity's history: %v", err)
	}
	read, err = store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs")
	if err != nil || read["observedAt"] != next["observedAt"] || len(read["facts"].([]any)) != len(next["facts"].([]any)) {
		t.Fatalf("snapshot-to-publication history was not preserved: %v", err)
	}
}
