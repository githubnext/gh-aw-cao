package redisx

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type memoryCommandClient struct {
	do func(context.Context, []string) (any, error)
}

func (client memoryCommandClient) Do(ctx context.Context, command ...string) (any, error) {
	return client.do(ctx, command)
}

func (memoryCommandClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, errors.New("unexpected memory pipeline")
}

func TestDisposableCacheCapabilitiesFailClosed(t *testing.T) {
	for _, test := range []struct {
		name    string
		info    any
		probe   any
		err     error
		enabled bool
		wantErr bool
	}{
		{name: "supported", info: testMemoryInfo, probe: testCacheCapabilityReply(), enabled: true},
		{name: "Enterprise INFO", info: testMemoryInfo, probe: []any{
			[]any{int64(0), "ERR This Redis command is not allowed from script"}, []any{int64(1), nil},
		}},
		{name: "Azure missing outside quota", info: "used_memory:1024\r\n", probe: []any{
			[]any{int64(0), "ERR command is not allowed in scripts"}, []any{int64(1), nil},
		}},
		{name: "missing scripted quota", info: testMemoryInfo, probe: []any{
			[]any{int64(1), "used_memory:1024\r\n"}, []any{int64(1), nil},
		}},
		{name: "missing outside and scripted quota", info: "used_memory:1024\r\n", probe: []any{
			[]any{int64(1), "used_memory:1024\r\n"}, []any{int64(1), nil},
		}},
		{name: "Enterprise MEMORY", info: testMemoryInfo, probe: []any{
			[]any{int64(1), testMemoryInfo}, []any{int64(0), "ERR command is not allowed in scripts"},
		}},
		{name: "unsupported MEMORY command", info: testMemoryInfo, probe: []any{
			[]any{int64(1), testMemoryInfo}, []any{int64(0), "ERR unknown command 'MEMORY'"},
		}},
		{name: "ACL is not unsupported", info: testMemoryInfo, probe: []any{
			[]any{int64(0), "NOPERM this user has no permissions"}, []any{int64(1), nil},
		}, wantErr: true},
		{name: "other probe error", info: testMemoryInfo, probe: []any{
			[]any{int64(1), testMemoryInfo}, []any{int64(0), "ERR private backend failure"},
		}, wantErr: true},
		{name: "unsupported does not hide second error", info: testMemoryInfo, probe: []any{
			[]any{int64(0), "ERR command is not allowed in scripts"}, []any{int64(0), "OOM command not allowed"},
		}, wantErr: true},
		{name: "missing outside usage", info: "maxmemory:0\r\n", probe: testCacheCapabilityReply(), wantErr: true},
		{name: "malformed outside quota", info: "used_memory:1024\r\nmaxmemory:invalid\r\n", probe: testCacheCapabilityReply(), wantErr: true},
		{name: "negative outside quota", info: "used_memory:1024\r\nmaxmemory:-1\r\n", probe: testCacheCapabilityReply(), wantErr: true},
		{name: "malformed outside statistics", info: int64(1024), probe: testCacheCapabilityReply(), wantErr: true},
		{name: "malformed Lua statistics", info: testMemoryInfo, probe: []any{
			[]any{int64(1), "invalid"}, []any{int64(1), nil},
		}, wantErr: true},
		{name: "invalid memory usage", info: testMemoryInfo, probe: []any{
			[]any{int64(1), testMemoryInfo}, []any{int64(1), int64(-1)},
		}, wantErr: true},
		{name: "malformed probe", info: testMemoryInfo, probe: nil, wantErr: true},
		{name: "transport error", err: errors.New("unavailable"), wantErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := memoryCommandClient{do: func(_ context.Context, command []string) (any, error) {
				if test.err != nil {
					return nil, test.err
				}
				if command[0] == "INFO" {
					return test.info, nil
				}
				if command[0] != "EVAL" || command[1] != cacheCapabilityScript {
					t.Fatalf("unexpected probe command: %v", command)
				}
				return test.probe, nil
			}}
			store := NewStore(client, "capabilities")
			if store.DisposableCachesEnabled() {
				t.Fatal("uninitialized capabilities are enabled")
			}
			err := store.InitializeDisposableCaches(t.Context())
			if (err != nil) != test.wantErr || store.DisposableCachesEnabled() != test.enabled {
				t.Fatalf("enabled=%t err=%v", store.DisposableCachesEnabled(), err)
			}
			if test.wantErr && store.cacheCapability.Load() != 0 {
				t.Fatal("failed initialization became a supported/unsupported capability")
			}
		})
	}
}

func TestDisposableCacheCapabilitiesInitializeOnceConcurrently(t *testing.T) {
	var infoCalls, probes atomic.Int64
	client := memoryCommandClient{do: func(_ context.Context, command []string) (any, error) {
		if command[0] == "INFO" {
			infoCalls.Add(1)
			return testMemoryInfo, nil
		}
		probes.Add(1)
		return testCacheCapabilityReply(), nil
	}}
	store := NewStore(client, "capabilities")
	var group sync.WaitGroup
	for range 32 {
		group.Go(func() {
			if err := store.InitializeDisposableCaches(t.Context()); err != nil {
				t.Errorf("initialize capabilities: %v", err)
			}
		})
	}
	group.Wait()
	if infoCalls.Load() != 1 || probes.Load() != 1 || !store.DisposableCachesEnabled() {
		t.Fatalf("INFO calls=%d probes=%d enabled=%t", infoCalls.Load(), probes.Load(), store.DisposableCachesEnabled())
	}
}

func TestManagedProviderFallbackDisablesAllCachesAndPreservesProtectedState(t *testing.T) {
	var store *Store
	used := int64(4000)
	malformed := false
	probes := 0
	scans := 0
	deleted := []string{}
	var candidates []string
	client := memoryCommandClient{do: func(_ context.Context, command []string) (any, error) {
		switch command[0] {
		case "INFO":
			if malformed {
				return "used_memory:broken\r\nmaxmemory:0\r\n", nil
			}
			return fmt.Sprintf("used_memory:%d\r\n", used), nil
		case "EVAL":
			if command[1] != cacheCapabilityScript {
				t.Fatal("disabled caches reached an admission/read/maintenance script")
			}
			probes++
			return []any{[]any{int64(0), "ERR command is not allowed in scripts"}, []any{int64(1), nil}}, nil
		case "SCAN":
			scans++
			if !reflect.DeepEqual(command, []string{"SCAN", "0", "MATCH", store.Key("*"), "COUNT", "1024"}) {
				t.Fatalf("unexpected scan: %v", command)
			}
			keys := make([]any, len(candidates))
			for index, key := range candidates {
				keys[index] = key
			}
			return []any{"0", keys}, nil
		case "DEL":
			count := int64(0)
			for _, key := range command[1:] {
				if !store.disposableKey(key) {
					t.Fatalf("protected key deleted: %s", key)
				}
				deleted = append(deleted, key)
				if strings.Contains(key, "{query-cache:v1}") {
					continue
				}
				count++
				used -= 1000
			}
			return count, nil
		case "SET":
			if command[1] != store.Key("state:protected") {
				t.Fatalf("cache write was not disabled: %v", command)
			}
			return "OK", nil
		default:
			t.Fatalf("unexpected fallback command: %v", command)
			return nil, nil
		}
	}}
	store = NewStore(client, "managed")
	if err := store.SetMaxMemoryBytes(1500); err != nil {
		t.Fatal(err)
	}
	digest := queryDigest("cache")
	candidates = make([]string, 0, 7+len(disposableCachePrefixes))
	candidates = append(candidates,
		store.Key("session:protected"), store.Key("queue:protected"),
		store.Key("quota:protected"), store.Key("revocations:protected"),
		"cao:other:marketplace:registry:"+digest,
		store.Key("marketplace:registry:")+digest+":lock",
		store.Key("repository-memory:campaign:not-a-digest"),
	)
	for _, prefix := range disposableCachePrefixes {
		candidates = append(candidates, store.Key(prefix)+digest)
	}
	for _, write := range []func() error{
		func() error {
			return store.CacheMarketplaceRegistry(t.Context(), "registry", "rev", []byte("value"), time.Minute)
		},
		func() error {
			return store.CacheRepositoryMemoryCampaign(t.Context(), "campaign", []byte("value"), time.Minute)
		},
		func() error {
			return store.CacheRepositoryMemoryFile(t.Context(), "campaign", "commit", "file", []byte("value"), time.Minute)
		},
	} {
		if err := write(); err != nil {
			t.Fatal(err)
		}
	}
	if stored, stats, err := store.CacheQueryResult(t.Context(), digest, []byte("value"), 1024, 4096); err != nil || stored || stats != (QueryCacheStats{}) {
		t.Fatalf("query admission was not disabled: stored=%t stats=%+v err=%v", stored, stats, err)
	}
	for _, read := range []func() ([]byte, error){
		func() ([]byte, error) { return store.CachedMarketplaceRegistry(t.Context(), "registry", "rev") },
		func() ([]byte, error) { return store.CachedRepositoryMemoryCampaign(t.Context(), "campaign") },
		func() ([]byte, error) {
			return store.CachedRepositoryMemoryFile(t.Context(), "campaign", "commit", "file")
		},
		func() ([]byte, error) {
			value, _, err := store.CachedQueryResult(t.Context(), digest, 1024, 4096)
			return value, err
		},
	} {
		if value, err := read(); err != nil || value != nil {
			t.Fatalf("cache serving was not disabled: value=%v err=%v", value, err)
		}
	}
	if err := store.SetOperationalState(t.Context(), "protected", []byte("value")); err != nil {
		t.Fatalf("protected operation unavailable: %v", err)
	}
	stats, err := store.MaintainCaches(t.Context(), 4096)
	if err != nil || stats.UsedBytes != 1000 || stats.BudgetBytes != 1500 || stats.Evicted != 3 || store.DisposableCachesEnabled() || probes != 1 || scans != 1 {
		t.Fatalf("fallback maintenance: stats=%+v probes=%d scans=%d enabled=%t err=%v",
			stats, probes, scans, store.DisposableCachesEnabled(), err)
	}
	malformed = true
	before := len(deleted)
	if _, err := store.MaintainCaches(t.Context(), 4096); err == nil || len(deleted) != before {
		t.Fatal("malformed outside INFO was accepted or caused deletion")
	}
}

func TestMaintenanceRefreshesEmptyAndNonmatchingScanBatchesAndFinalPressure(t *testing.T) {
	for _, finalDrop := range []bool{false, true} {
		t.Run(fmt.Sprintf("drop-at-final-%t", finalDrop), func(t *testing.T) {
			used := int64(2000)
			scans, infosAfterScan := 0, 0
			var store *Store
			client := memoryCommandClient{do: func(_ context.Context, command []string) (any, error) {
				switch command[0] {
				case "INFO":
					if scans > 0 {
						infosAfterScan++
						if finalDrop && infosAfterScan == 3 {
							used = 1000
						}
					}
					return fmt.Sprintf("used_memory:%d\r\nmaxmemory:0\r\n", used), nil
				case "EVAL":
					if command[1] == cacheCapabilityScript {
						return testCacheCapabilityReply(), nil
					}
					return []any{nil, int64(0), int64(0), int64(0), int64(0)}, nil
				case "SCAN":
					scans++
					if command[3] != store.Key("*") || command[5] != "1024" {
						t.Fatalf("scan scope/count: %v", command)
					}
					if scans == 1 {
						if command[1] != "0" {
							t.Fatal("scan did not start at zero")
						}
						return []any{"7", []any{}}, nil
					}
					if scans != 2 || command[1] != "7" {
						t.Fatalf("scan restarted or ignored cursor: %v", command)
					}
					if !finalDrop {
						used = 1000
					}
					return []any{"0", []any{store.Key("session:protected")}}, nil
				default:
					t.Fatalf("unexpected maintenance command: %v", command)
					return nil, nil
				}
			}}
			store = NewStore(client, "scan-refresh")
			if err := store.SetMaxMemoryBytes(1500); err != nil {
				t.Fatal(err)
			}
			stats, err := store.MaintainCaches(t.Context(), 4096)
			if err != nil || stats.UsedBytes != 1000 || scans != 2 || infosAfterScan != 3 {
				t.Fatalf("stale/extra maintenance: stats=%+v scans=%d final INFOs=%d err=%v", stats, scans, infosAfterScan, err)
			}
		})
	}
}

func TestMaintenanceDeletionResamplingFailureIsNotHidden(t *testing.T) {
	calls := 0
	client := memoryCommandClient{do: func(_ context.Context, command []string) (any, error) {
		if command[0] == "DEL" {
			return int64(1), nil
		}
		calls++
		if calls == 1 {
			return "used_memory:2000\r\nmaxmemory:0\r\n", nil
		}
		return nil, errors.New("unavailable")
	}}
	store := NewStore(client, "resampling")
	if err := store.SetMaxMemoryBytes(1500); err != nil {
		t.Fatal(err)
	}
	if _, err := store.memoryStats(t.Context(), store.Key("marketplace:registry:")+queryDigest("cache")); err == nil {
		t.Fatal("post-deletion sampling failure was swallowed")
	}
}
