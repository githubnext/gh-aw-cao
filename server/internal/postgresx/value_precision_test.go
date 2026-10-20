package postgresx

import (
	"errors"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
)

func TestValuePublicationRejectsSubMicrosecondEvidence(t *testing.T) {
	for _, field := range []string{"observedAt", "windowStart", "windowEnd"} {
		t.Run(field, func(t *testing.T) {
			packet := evidencePacket(t)
			at, _ := evidenceTime(packet[field])
			packet[field] = at.Add(time.Nanosecond).Format(time.RFC3339Nano)
			if _, err := (&Store{}).PublishOperationalValue(t.Context(), packet); !errors.Is(err, ErrValueInvalid) {
				t.Fatalf("sub-microsecond %s reached the database: %v", field, err)
			}
		})
	}
	for _, clock := range [][2]string{
		{"implementation", "at"}, {"implementation", "accepted-at"}, {"snapshot", "at"},
		{"coverage", "at"}, {"coverage", "end-at"}, {"implementation-lineage", "at"},
	} {
		t.Run(clock[0]+":"+clock[1], func(t *testing.T) {
			packet := evidencePacket(t)
			fact := publicationFact(t, packet, clock[0])
			at, _ := evidenceTime(fact[clock[1]])
			fact[clock[1]] = at.Add(time.Nanosecond).Format(time.RFC3339Nano)
			if err := validateOperationalValueEvidence(packet); err == nil {
				t.Fatal("typed snapshot validation would silently round a fact clock")
			}
			if _, err := (&Store{}).PublishOperationalValue(t.Context(), packet); !errors.Is(err, ErrValueInvalid) {
				t.Fatalf("sub-microsecond fact clock reached the database: %v", err)
			}
		})
	}
	for _, capture := range []string{"2026-10-20T12:00:00.123456001Z", "2026-10-20T12:00:00.1234560001Z"} {
		if _, err := evidenceTime(capture); err == nil {
			t.Fatal("fractional precision beyond the parser's nanosecond range was silently discarded")
		}
	}
}

func microsecondPublication(t *testing.T) model.Row {
	t.Helper()
	packet := evidencePacket(t)
	packet["observedAt"] = "2026-10-20T12:00:00.410Z"
	implementation := publicationFact(t, packet, "implementation")
	implementation["at"] = "2026-10-10T12:00:00.123456Z"
	implementation["accepted-at"] = implementation["at"]
	return packet
}

func TestValuePublicationPrecisionCanonicalRetry(t *testing.T) {
	packet := microsecondPublication(t)
	_, digest, err := normalizeValuePublication(packet)
	if err != nil {
		t.Fatal(err)
	}
	packet["observedAt"] = "2026-10-20T12:00:00.41Z"
	implementation := publicationFact(t, packet, "implementation")
	implementation["at"] = "2026-10-10T12:00:00.123456000Z"
	implementation["accepted-at"] = implementation["at"]
	_, retry, err := normalizeValuePublication(packet)
	if err != nil || retry != digest {
		t.Fatal("equivalent millisecond or microsecond timestamp spelling changed canonical identity")
	}
}

func TestValuePublicationHostedPrecisionAndAtomicRejection(t *testing.T) {
	store, _ := nativeTestStore(t)
	packet := microsecondPublication(t)
	seedPublicationParents(t, store, packet)
	initial, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil {
		t.Fatal(err)
	}
	packet["observedAt"] = "2026-10-20T12:00:00.41Z"
	retry, err := store.PublishOperationalValue(t.Context(), packet)
	if err != nil || retry.Updated || retry.Revision != initial.Revision {
		t.Fatalf("equivalent capture spelling was not idempotent: %+v %v", retry, err)
	}
	bad := microsecondPublication(t)
	bad["observedAt"] = "2026-10-20T13:00:00.000000001Z"
	assertPublicationError(t, store, bad, ErrValueInvalid)
	bad = microsecondPublication(t)
	bad["observedAt"] = "2026-10-20T13:00:00Z"
	publicationFact(t, bad, "implementation")["at"] = "2026-10-10T12:00:00.123456001Z"
	assertPublicationError(t, store, bad, ErrValueInvalid)
	read, err := store.ReadOperationalValue(t.Context(), "octo/example", "verify-bugs")
	if err != nil {
		t.Fatal(err)
	}
	implementation := publicationFact(t, read, "implementation")
	if implementation["at"] != "2026-10-10T12:00:00.123456Z" || implementation["accepted-at"] != implementation["at"] {
		t.Fatal("publication changed immutable accepted event clocks at native microsecond precision")
	}
}
