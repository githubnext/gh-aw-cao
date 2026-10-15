package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

func testBridge(t *testing.T, remaining int) (*bridge, *snapshot) {
	t.Helper()
	now := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	store, err := memory.New(memory.Config{Clock: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service, err := githubquota.New(store, githubquota.Options{})
	if err != nil {
		t.Fatal(err)
	}
	current := &snapshot{identity: "gh-test", observations: map[string]githubquota.Observation{}}
	for _, resource := range []string{"core", "graphql"} {
		current.observations[resource] = githubquota.Observation{
			Limit: 5000, Remaining: remaining, ResetAt: now.Add(time.Hour),
		}
	}
	b := newBridge(service, func(context.Context, []string) (snapshot, error) { return *current, nil })
	b.now = func() time.Time { return now }
	return b, current
}

func TestAdmissionUsesSharedReservationsAndFreshObservations(t *testing.T) {
	b, current := testBridge(t, 5000)
	ctx := context.Background()
	first := b.handle(ctx, request{ID: 1, Operation: "admit"})
	if first.Capacity != 4 || first.ReservationID == "" {
		t.Fatalf("first admission: %+v", first)
	}
	for _, resource := range []string{"core", "graphql"} {
		state, err := b.service.State(ctx, bucket(current.identity, resource))
		if err != nil || state.Reserved != 50 {
			t.Fatalf("reservation not in shared service: %+v, %v", state, err)
		}
	}
	// A subprocess consumes a different amount than its estimate.
	m := current.observations["core"]
	m.Remaining = 175
	current.observations["core"] = m
	finished := b.handle(ctx, request{Operation: "complete", ReservationID: first.ReservationID})
	if finished.Capacity != 1 {
		t.Fatalf("low quota did not lower concurrency: %+v", finished)
	}
	state, err := b.service.State(ctx, bucket(current.identity, "core"))
	if err != nil || state.Reserved != 0 || state.Remaining != 175 {
		t.Fatalf("completion invented consumption: %+v, %v", state, err)
	}
	second := b.handle(ctx, request{Operation: "admit"})
	if second.ReservationID == "" || second.Capacity != 1 {
		t.Fatalf("low quota admission: %+v", second)
	}
	third := b.handle(ctx, request{Operation: "admit"})
	if third.Capacity != 0 || third.Reason != "exhausted" || third.ReservationID != "" {
		t.Fatalf("exhausted quota admitted work: %+v", third)
	}
}

func TestUnknownGraphQLAndFailedRefreshPause(t *testing.T) {
	b, current := testBridge(t, 5000)
	first := b.handle(context.Background(), request{Operation: "admit"})
	if first.ReservationID == "" {
		t.Fatal("expected reservation")
	}
	b.read = func(context.Context, []string) (snapshot, error) { return snapshot{}, errors.New("unavailable") }
	unknown := b.handle(context.Background(), request{Operation: "complete", ReservationID: first.ReservationID})
	if unknown.Capacity != 0 || unknown.Reason != "unknown" {
		t.Fatalf("failed refresh should pause: %+v", unknown)
	}
	state, err := b.service.State(context.Background(), bucket(current.identity, "core"))
	if err != nil || state.Reserved != 50 {
		t.Fatalf("failed refresh released reservation: %+v, %v", state, err)
	}
	b.read = func(context.Context, []string) (snapshot, error) { return *current, nil }
	delete(current.observations, "graphql")
	unknown = b.handle(context.Background(), request{Operation: "admit"})
	if unknown.Capacity != 0 || unknown.Reason != "unknown" {
		t.Fatalf("missing graphql should pause: %+v", unknown)
	}
}

func TestConcurrencyBoundAndChangedIdentity(t *testing.T) {
	b, current := testBridge(t, 5000)
	ctx := context.Background()
	first := b.handle(ctx, request{Operation: "admit", MaxConcurrency: 1})
	if first.ReservationID == "" {
		t.Fatal("expected initial reservation")
	}
	blocked := b.handle(ctx, request{Operation: "admit", MaxConcurrency: 1})
	if blocked.ReservationID != "" || blocked.Reason != "concurrency" {
		t.Fatalf("concurrency exceeded: %+v", blocked)
	}
	current.identity = "gh-other-user"
	completed := b.handle(ctx, request{Operation: "complete", ReservationID: first.ReservationID})
	if completed.Capacity != 4 {
		t.Fatalf("new credential context unavailable: %+v", completed)
	}
	previous, err := b.service.State(ctx, bucket("gh-test", "core"))
	if err != nil || previous.Reserved != 50 {
		t.Fatalf("other user's observation reconciled old identity: %+v, %v", previous, err)
	}
}

func TestExternalRunningCapacityDoesNotAcquireReservations(t *testing.T) {
	b, current := testBridge(t, 175)
	ctx := context.Background()
	result := b.handle(ctx, request{Operation: "admit", Running: 1})
	if result.ReservationID != "" || result.Capacity != 1 || result.Reason != "concurrency" {
		t.Fatalf("reserved while local workers occupy capacity: %+v", result)
	}
	state, err := b.service.State(ctx, bucket(current.identity, "core"))
	if err != nil || state.Reserved != 0 {
		t.Fatalf("external running count leaked reservation: %+v, %v", state, err)
	}
}

func TestCoreOnlyDispatchIgnoresExhaustedGraphQL(t *testing.T) {
	b, current := testBridge(t, 5000)
	ctx := context.Background()
	graphql := current.observations["graphql"]
	graphql.Remaining = 0
	current.observations["graphql"] = graphql
	mixed := b.handle(ctx, request{Operation: "admit"})
	if mixed.Capacity != 0 || mixed.Reason != "exhausted" {
		t.Fatalf("mixed-resource command ignored exhausted GraphQL: %+v", mixed)
	}
	dispatch := b.handle(ctx, request{Operation: "admit", Resources: []string{"core"}})
	if dispatch.Capacity != 4 || dispatch.ReservationID == "" {
		t.Fatalf("GraphQL exhaustion blocked core-only dispatch: %+v", dispatch)
	}
	if len(b.reservations[dispatch.ReservationID].buckets) != 1 {
		t.Fatal("core-only dispatch reserved unrelated resources")
	}
	_ = b.handle(ctx, request{Operation: "complete", ReservationID: dispatch.ReservationID})
	core := current.observations["core"]
	core.Remaining = 0
	current.observations["core"] = core
	blocked := b.handle(ctx, request{Operation: "admit", Resources: []string{"core"}})
	if blocked.Capacity != 0 || blocked.Reason != "exhausted" {
		t.Fatalf("core exhaustion admitted dispatch: %+v", blocked)
	}
}

func TestResourcesValidateAndOnlyRequiredObservationsAreUsed(t *testing.T) {
	b, current := testBridge(t, 5000)
	delete(current.observations, "graphql")
	ctx := context.Background()
	dispatch := b.handle(ctx, request{Operation: "admit", Resources: []string{"core"}})
	if dispatch.ReservationID == "" {
		t.Fatalf("missing unrelated resource blocked core: %+v", dispatch)
	}
	completed := b.handle(ctx, request{Operation: "complete", ReservationID: dispatch.ReservationID})
	if completed.Reason != "available" || len(b.reservations) != 0 {
		t.Fatalf("core-only completion required GraphQL: %+v", completed)
	}
	if mixed := b.handle(ctx, request{Operation: "admit"}); mixed.Reason != "unknown" {
		t.Fatalf("default mixed command accepted missing GraphQL: %+v", mixed)
	}
	for _, resources := range [][]string{{"core", "core"}, {"search"}, {"graphql", "invalid"}} {
		if got := b.handle(ctx, request{Operation: "admit", Resources: resources}); got.Reason != "unknown" {
			t.Fatalf("invalid resource set admitted: %v %+v", resources, got)
		}
	}
}

func TestUnclaimedReservationReleaseDoesNotRefreshOrInventConsumption(t *testing.T) {
	b, current := testBridge(t, 5000)
	ctx := context.Background()
	result := b.handle(ctx, request{Operation: "admit"})
	b.read = func(context.Context, []string) (snapshot, error) {
		t.Fatal("release refreshed GitHub for work never started")
		return snapshot{}, nil
	}
	_ = b.handle(ctx, request{Operation: "release", ReservationID: result.ReservationID})
	state, err := b.service.State(ctx, bucket(current.identity, "core"))
	if err != nil || state.Reserved != 0 || state.Remaining != 5000 || len(b.reservations) != 0 {
		t.Fatalf("unclaimed reservation release incorrect: %+v, %v", state, err)
	}
}

func TestSecondaryLimitParksBothResources(t *testing.T) {
	b, current := testBridge(t, 5000)
	ctx := context.Background()
	first := b.handle(ctx, request{Operation: "admit"})
	parked := b.handle(ctx, request{
		Operation: "complete", ReservationID: first.ReservationID, RateLimited: true, RetryAfterSeconds: 120,
	})
	if parked.Capacity != 0 || parked.Reason != "parked" || parked.RetryAt == "" {
		t.Fatalf("secondary limit not parked: %+v", parked)
	}
	for _, resource := range []string{"core", "graphql"} {
		state, err := b.service.State(ctx, bucket(current.identity, resource))
		if err != nil || state.Status != githubquota.StatusParked {
			t.Fatalf("shared meter not parked: %+v, %v", state, err)
		}
	}
	if got := b.handle(ctx, request{Operation: "admit"}); got.ReservationID != "" {
		t.Fatalf("parked bridge admitted: %+v", got)
	}
}

func TestRefreshOnEveryStartAndResetRecovery(t *testing.T) {
	b, current := testBridge(t, 100)
	calls := 0
	b.read = func(context.Context, []string) (snapshot, error) {
		calls++
		return *current, nil
	}
	ctx := context.Background()
	if got := b.handle(ctx, request{Operation: "admit"}); got.Reason != "exhausted" {
		t.Fatalf("expected exhaustion: %+v", got)
	}
	for resource, observation := range current.observations {
		observation.ResetAt = observation.ResetAt.Add(time.Hour)
		observation.Remaining = 5000
		current.observations[resource] = observation
	}
	if got := b.handle(ctx, request{Operation: "admit"}); got.Capacity != 4 || got.ReservationID == "" {
		t.Fatalf("new reset window not admitted: %+v", got)
	}
	if calls != 2 {
		t.Fatalf("starts did not refresh: %d", calls)
	}
}

func TestGhSnapshotUsesActualUserHostAndBothMeters(t *testing.T) {
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "test-gh" || strings.Join(args[:3], " ") != "api --hostname example.test" {
			t.Fatalf("wrong credential context: %s %v", name, args)
		}
		if args[3] == "user" {
			return []byte("123\n"), nil
		}
		return []byte(`{"resources":{"core":{"limit":5000,"remaining":4900,"reset":1792070000},"graphql":{"limit":5000,"remaining":4800,"reset":1792070000}}}`), nil
	}
	first, err := ghSnapshot(context.Background(), run, "test-gh", "example.test")
	if err != nil || len(first.observations) != 2 || !strings.HasPrefix(first.identity, "gh-") {
		t.Fatalf("snapshot: %+v, %v", first, err)
	}
	second, err := ghSnapshot(context.Background(), run, "test-gh", "example.test")
	if err != nil || first.identity != second.identity || strings.Contains(first.identity, "123") {
		t.Fatalf("identity is unstable or exposes user: %s %s", first.identity, second.identity)
	}
}

func TestGhSnapshotRejectsMissingAndInvalidMeters(t *testing.T) {
	for _, data := range []string{
		`{}`,
		`{"resources":{"core":{"limit":5000,"remaining":10,"reset":1}}}`,
		`{"resources":{"core":{"limit":5000,"remaining":10,"reset":1},"graphql":{"limit":5000,"reset":1}}}`,
		`{"resources":{"core":{"limit":5000,"remaining":10,"reset":1},"graphql":{"limit":0,"remaining":0,"reset":1}}}`,
	} {
		run := func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if args[3] == "user" {
				return []byte("123"), nil
			}
			return []byte(data), nil
		}
		if _, err := ghSnapshot(context.Background(), run, "gh", "github.com"); err == nil {
			t.Fatalf("accepted incomplete quota: %s", data)
		}
	}
}

func TestGhSnapshotOnlyValidatesRequiredResources(t *testing.T) {
	run := func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[3] == "user" {
			return []byte("123"), nil
		}
		return []byte(`{"resources":{"core":{"limit":5000,"remaining":4900,"reset":1792070000}}}`), nil
	}
	current, err := ghSnapshot(context.Background(), run, "gh", "github.com", "core")
	if err != nil || len(current.observations) != 1 {
		t.Fatalf("core-only snapshot required unrelated resource: %+v, %v", current, err)
	}
	if _, err := ghSnapshot(context.Background(), run, "gh", "github.com"); err == nil {
		t.Fatal("default mixed snapshot accepted missing GraphQL")
	}
}

func TestJSONLinesPersistentAndRedacted(t *testing.T) {
	b, _ := testBridge(t, 5000)
	var out bytes.Buffer
	input := strings.NewReader("{\"id\":1,\"operation\":\"admit\"}\n{\"id\":2,\"operation\":\"status\"}\n")
	if err := serve(input, &out, b); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || strings.Contains(out.String(), "gh-test") {
		t.Fatalf("invalid or unredacted protocol: %s", out.String())
	}
	for i, line := range lines {
		var result decision
		if err := json.Unmarshal([]byte(line), &result); err != nil || result.ID != i+1 || result.Capacity != 4 {
			t.Fatalf("invalid response: %s, %v", line, err)
		}
	}
}
