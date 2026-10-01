package redisx

import (
	"context"
	"reflect"
	"testing"
	"time"
)

type ingestionHealthCommandClient struct {
	fields  []any
	command []string
}

func (client *ingestionHealthCommandClient) Do(_ context.Context, command ...string) (any, error) {
	client.command = append([]string{}, command...)
	if command[0] == "HGETALL" {
		return client.fields, nil
	}
	return "OK", nil
}

func (*ingestionHealthCommandClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func TestIngestionHealthCountersAreBoundedAndNamespaced(t *testing.T) {
	client := &ingestionHealthCommandClient{
		fields: []any{"webhookReceived", "5", "collectionFailed", "2",
			"lastFailureAt", "2026-09-29T00:00:00Z", "lastFailureCode", "collection",
			"unexpected", "ignored"},
	}
	store := NewStore(client, "health-test")

	if err := store.IncrementIngestionCounter(t.Context(), "webhookReceived"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(client.command, []string{
		"EVAL",
		`redis.call("HINCRBY", KEYS[1], ARGV[4], 1); redis.call("HINCRBY", KEYS[1], "healthRevision", 1); ` + loadStep,
		"2", store.Key(ingestionHealthKey), store.Key("load:webhook"), "1", "60", "480", "webhookReceived",
	}) {
		t.Fatalf("unexpected counter command: %#v", client.command)
	}
	if err := store.IncrementIngestionCounter(t.Context(), "attacker-controlled"); err == nil {
		t.Fatal("unknown counter name was accepted")
	}
	counters, events, err := store.IngestionHealth(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if counters["webhookReceived"] != 5 || counters["collectionFailed"] != 2 {
		t.Fatalf("unexpected counters: %#v", counters)
	}
	if !reflect.DeepEqual(events, map[string]string{
		"lastFailureAt":   "2026-09-29T00:00:00Z",
		"lastFailureCode": "collection",
	}) {
		t.Fatalf("unexpected health events: %#v", events)
	}
}

func TestRecordIngestionHealthEventUsesFixedCodesAndUTC(t *testing.T) {
	client := &ingestionHealthCommandClient{}
	store := NewStore(client, "health-test")
	when := time.Date(2026, 9, 29, 1, 0, 0, 0, time.FixedZone("offset", 2*60*60))

	if err := store.RecordIngestionHealthEvent(t.Context(), "failure", "collection", when); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(client.command, []string{
		"EVAL",
		`redis.call("HINCRBY", KEYS[1], "healthRevision", 1); redis.call("HSET", KEYS[1], ARGV[1], ARGV[2], ARGV[3], ARGV[4]); return 1`,
		"1", store.Key(ingestionHealthKey), "lastFailureAt", "2026-09-28T23:00:00Z",
		"lastFailureCode", "collection",
	}) {
		t.Fatalf("unexpected failure event command: %#v", client.command)
	}
	if err := store.RecordIngestionHealthEvent(t.Context(), "failure", "token=secret", when); err == nil {
		t.Fatal("arbitrary failure code was accepted")
	}
	if err := store.RecordIngestionHealthEvent(t.Context(), "success", "collection", when); err == nil {
		t.Fatal("success event accepted an error code")
	}
}

func TestIngestionHealthRejectsInvalidCounterValues(t *testing.T) {
	client := &ingestionHealthCommandClient{fields: []any{"taskQueued", "-1"}}
	store := NewStore(client, "health-test")
	if _, _, err := store.IngestionHealth(t.Context()); err == nil {
		t.Fatal("negative counter was accepted")
	}
}

func TestParseIngestionHealthFieldsClassifiesCountersEventsAndUnknownFields(t *testing.T) {
	counters, events, err := parseIngestionHealthFields([]string{
		"webhookReceived", "5", "collectionFailed", "2",
		"lastFailureAt", "2026-09-29T00:00:00Z", "lastFailureCode", "collection",
		"unexpected", "ignored",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(counters, map[string]int64{"webhookReceived": 5, "collectionFailed": 2}) {
		t.Fatalf("unexpected counters: %#v", counters)
	}
	if !reflect.DeepEqual(events, map[string]string{
		"lastFailureAt":   "2026-09-29T00:00:00Z",
		"lastFailureCode": "collection",
	}) {
		t.Fatalf("unexpected health events: %#v", events)
	}
}

func TestParseIngestionHealthFieldsRejectsNonNumericAndNegativeCounters(t *testing.T) {
	if _, _, err := parseIngestionHealthFields([]string{"taskQueued", "not-a-number"}); err == nil {
		t.Fatal("non-numeric counter was accepted")
	}
	if _, _, err := parseIngestionHealthFields([]string{"taskQueued", "-1"}); err == nil {
		t.Fatal("negative counter was accepted")
	}
}

func TestParseIngestionHealthFieldsHandlesEmptyAndOddLengthInput(t *testing.T) {
	counters, events, err := parseIngestionHealthFields(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(counters) != 0 || len(events) != 0 {
		t.Fatalf("expected empty results for nil input, got counters=%#v events=%#v", counters, events)
	}
	// A trailing unpaired field name is ignored rather than causing a panic.
	counters, events, err = parseIngestionHealthFields([]string{"webhookReceived", "1", "dangling"})
	if err != nil {
		t.Fatal(err)
	}
	if counters["webhookReceived"] != 1 || len(events) != 0 {
		t.Fatalf("unexpected result for odd-length input: counters=%#v events=%#v", counters, events)
	}
}
