package redisx

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

type usageCommandClient struct {
	now     time.Time
	command []string
	batch   [][]string
	replies map[string][]any
}

func (client *usageCommandClient) Do(_ context.Context, command ...string) (any, error) {
	client.command = append([]string{}, command...)
	if command[0] == "TIME" {
		return []any{
			strconv.FormatInt(client.now.Unix(), 10),
			strconv.FormatInt(int64(client.now.Nanosecond()/1000), 10),
		}, nil
	}
	return int64(1), nil
}

func (client *usageCommandClient) DoMany(_ context.Context, commands [][]string) ([]any, error) {
	client.batch = commands
	replies := make([]any, len(commands))
	for index, command := range commands {
		reply, ok := client.replies[command[1]]
		if !ok {
			reply = []any{}
		}
		replies[index] = reply
	}
	return replies, nil
}

func TestRecordGitHubQuotaUsageUsesOneSlotScript(t *testing.T) {
	client := &usageCommandClient{}
	store := NewStore(client, "quota-test")
	at := time.Date(2026, 9, 30, 14, 52, 10, 0, time.UTC)
	recorded, err := store.RecordGitHubQuotaUsage(t.Context(), "collector:123:core", at, 5000, 1200, 300)
	if err != nil || !recorded {
		t.Fatalf("RecordGitHubQuotaUsage() = %t, %v", recorded, err)
	}
	slot := time.Date(2026, 9, 30, 14, 45, 0, 0, time.UTC)
	want := []string{
		"cao:quota-test:github:quota:usage:" + strconv.FormatInt(slot.UnixMilli(), 10),
		strconv.FormatInt(slot.UnixMilli(), 10), "5000", "1200", "300",
		strconv.FormatInt(GitHubQuotaUsageInterval.Milliseconds(), 10),
		strconv.FormatInt(GitHubQuotaUsageRetention.Milliseconds(), 10),
		"collector:123:core",
	}
	if client.command[0] != "EVAL" || client.command[2] != "1" || strings.Join(client.command[3:], " ") != strings.Join(want, " ") {
		t.Fatalf("unexpected usage command %q", client.command)
	}
}

func TestRecordGitHubQuotaUsageRejectsInvalidArguments(t *testing.T) {
	store := NewStore(&usageCommandClient{}, "quota-test")
	at := time.Now()
	for _, test := range []struct {
		name          string
		bucket        string
		at            time.Time
		limit, used   int64
		reservedCount int64
	}{
		{name: "bucket", bucket: "bad key", at: at, limit: 1},
		{name: "time", bucket: "a:1:core", limit: 1},
		{name: "negative", bucket: "a:1:core", at: at, limit: 1, used: -1},
		{name: "overused", bucket: "a:1:core", at: at, limit: 1, used: 2},
		{name: "bounded", bucket: "a:1:core", at: at, limit: 1 << 41},
		{name: "reserved", bucket: "a:1:core", at: at, limit: 1, reservedCount: -1},
	} {
		if _, err := store.RecordGitHubQuotaUsage(t.Context(), test.bucket, test.at, test.limit, test.used, test.reservedCount); err == nil {
			t.Errorf("%s: expected an error", test.name)
		}
	}
}

func TestGitHubQuotaUsageReadsRetainedSlots(t *testing.T) {
	now := time.Date(2026, 9, 30, 14, 52, 10, 0, time.UTC)
	latest := time.Date(2026, 9, 30, 14, 45, 0, 0, time.UTC)
	key := func(slot time.Time) string {
		return "cao:quota-test:github:quota:usage:" + strconv.FormatInt(slot.UnixMilli(), 10)
	}
	client := &usageCommandClient{now: now, replies: map[string][]any{
		key(latest):                 {"collector:123:core", "5000|1200|300", "bad key", "1|0|0", "collector:456:core", "1|2|0"},
		key(latest.Add(-time.Hour)): {"collector:123:core", "5000|400|0"},
	}}
	store := NewStore(client, "quota-test")
	samples, clock, err := store.GitHubQuotaUsage(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !clock.Equal(now) {
		t.Fatalf("clock = %s, want %s", clock, now)
	}
	if len(client.batch) != 96 || client.batch[95][1] != key(latest) ||
		client.batch[0][1] != key(latest.Add(-GitHubQuotaUsageRetention).Add(GitHubQuotaUsageInterval)) {
		t.Fatalf("unexpected slot batch size=%d first=%q last=%q", len(client.batch), client.batch[0], client.batch[len(client.batch)-1])
	}
	if len(samples) != 2 {
		t.Fatalf("expected malformed samples to be skipped, got %+v", samples)
	}
	if samples[0].Slot != latest.Add(-time.Hour) || samples[0].Used != 400 ||
		samples[1] != (GitHubQuotaUsageSample{Bucket: "collector:123:core", Slot: latest, Limit: 5000, Used: 1200, Reserved: 300}) {
		t.Fatalf("unexpected samples %+v", samples)
	}
}

func TestParseRedisTime(t *testing.T) {
	for _, value := range []any{"x", []any{"1"}, []any{"0", "0"}, []any{"1", "1000000"}, []any{"a", "1"}} {
		if _, err := parseRedisTime(value); err == nil {
			t.Errorf("parseRedisTime(%v) accepted an invalid reply", value)
		}
	}
	parsed, err := parseRedisTime([]any{"1900000000", "250000"})
	if err != nil || !parsed.Equal(time.Unix(1_900_000_000, 250_000_000)) {
		t.Fatalf("parseRedisTime() = %s, %v", parsed, err)
	}
}

func TestGitHubQuotaUsageAgainstRedis(t *testing.T) {
	rawURL := os.Getenv("REDIS_URL")
	if rawURL == "" {
		t.Skip("REDIS_URL is not set")
	}
	client, err := New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(client, "quota-usage-"+strconv.FormatInt(time.Now().UnixNano(), 36))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	bucket := "collector:123:core"
	now := time.Now()

	for _, sample := range []struct{ limit, used, reserved int64 }{
		{5000, 1000, 50}, {5000, 2500, 10}, {5000, 2000, 0}, {15000, 3000, 0},
	} {
		if recorded, err := store.RecordGitHubQuotaUsage(ctx, bucket, now, sample.limit, sample.used, sample.reserved); err != nil || !recorded {
			t.Fatalf("record usage = %t, %v", recorded, err)
		}
	}
	if recorded, err := store.RecordGitHubQuotaUsage(ctx, bucket, now.Add(-25*time.Hour), 5000, 5000, 0); err != nil || recorded {
		t.Fatalf("expired slot was recorded = %t, %v", recorded, err)
	}
	if recorded, err := store.RecordGitHubQuotaUsage(ctx, bucket, now.Add(time.Hour), 5000, 5000, 0); err != nil || recorded {
		t.Fatalf("future slot was recorded = %t, %v", recorded, err)
	}
	samples, clock, err := store.GitHubQuotaUsage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if clock.IsZero() || len(samples) != 1 {
		t.Fatalf("unexpected usage %+v at %s", samples, clock)
	}
	want := GitHubQuotaUsageSample{
		Bucket: bucket, Slot: GitHubQuotaUsageSlot(now), Limit: 5000, Used: 2500, Reserved: 50,
	}
	if samples[0] != want {
		t.Fatalf("usage = %+v, want peak ratio %+v", samples[0], want)
	}
	ttl, err := client.Do(ctx, "PTTL", store.gitHubQuotaUsageKey(want.Slot))
	if err != nil {
		t.Fatal(err)
	}
	if remaining, _ := ttl.(int64); remaining <= int64(GitHubQuotaUsageRetention/time.Millisecond) ||
		remaining > int64((GitHubQuotaUsageRetention+GitHubQuotaUsageInterval)/time.Millisecond) {
		t.Fatalf("usage slot TTL = %v", ttl)
	}
}
