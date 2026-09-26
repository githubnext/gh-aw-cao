package redisx

import (
	"context"
	"strings"
	"testing"
	"time"
)

type rateLimitCommandClient struct {
	value   any
	command []string
}

func (client *rateLimitCommandClient) Do(_ context.Context, command ...string) (any, error) {
	client.command = append([]string{}, command...)
	return client.value, nil
}

func (*rateLimitCommandClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func TestTakeRateLimitTokenUsesAtomicRedisTokenBucket(t *testing.T) {
	client := &rateLimitCommandClient{value: []any{int64(1), int64(29), int64(0), int64(2000)}}
	store := NewStore(client, "rate-test")

	result, err := store.TakeRateLimitToken(t.Context(), "query:subject", 30, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Allowed || result.Remaining != 29 || result.RetryAfter != 0 || result.ResetAfter != 2*time.Second {
		t.Fatalf("unexpected rate limit result: %#v", result)
	}
	if len(client.command) != 6 || client.command[0] != "EVAL" || client.command[2] != "1" ||
		client.command[3] != "cao:rate-test:rate-limit:query:subject" ||
		client.command[4] != "30" || client.command[5] != "60000" {
		t.Fatalf("unexpected Redis command: %#v", client.command)
	}
	script := client.command[1]
	for _, operation := range []string{`redis.call("TIME")`, `redis.call("HMGET"`, `redis.call("HSET"`, `redis.call("PEXPIRE"`} {
		if !strings.Contains(script, operation) {
			t.Fatalf("rate limit script does not contain %s", operation)
		}
	}
}

func TestTakeRateLimitTokenRejectsInvalidBoundsAndResponses(t *testing.T) {
	client := &rateLimitCommandClient{value: int64(1)}
	store := NewStore(client, "rate-test")
	if _, err := store.TakeRateLimitToken(t.Context(), "general:subject", 0, time.Minute); err == nil {
		t.Fatal("zero capacity was accepted")
	}
	if _, err := store.TakeRateLimitToken(t.Context(), "general:subject", 1, 0); err == nil {
		t.Fatal("zero refill period was accepted")
	}
	if _, err := store.TakeRateLimitToken(t.Context(), "general:subject", 1, time.Minute); err == nil {
		t.Fatal("invalid Redis response was accepted")
	}
}
