package doctor

import (
	"reflect"
	"strings"
	"testing"
)

func TestClassifyRedisMemory(t *testing.T) {
	cases := []struct {
		name        string
		used        int64
		maximum     int64
		policy      string
		wantStatus  Status
		wantReason  memoryClassificationReason
		summaryHas  string
		remedyEmpty bool
	}{
		{
			name: "evicting policy warns regardless of utilization",
			used: 100, maximum: 1000, policy: "allkeys-lru",
			wantStatus: StatusWarn, wantReason: memoryReasonEvictingPolicy,
			summaryHas: "eviction policy",
		},
		{
			name: "critical utilization fails at the 95 percent boundary",
			used: 950, maximum: 1000, policy: "noeviction",
			wantStatus: StatusFail, wantReason: memoryReasonCriticalUtilization,
			summaryHas: "95.0% used",
		},
		{
			name: "high utilization warns at the 80 percent boundary",
			used: 800, maximum: 1000, policy: "noeviction",
			wantStatus: StatusWarn, wantReason: memoryReasonHighUtilization,
			summaryHas: "80.0% used",
		},
		{
			name: "moderate utilization under a limit passes",
			used: 400, maximum: 1000, policy: "noeviction",
			wantStatus: StatusPass, wantReason: memoryReasonHealthy,
			summaryHas: "used for operational state", remedyEmpty: true,
		},
		{
			name: "no configured limit warns even at low usage",
			used: 100, maximum: 0, policy: "",
			wantStatus: StatusWarn, wantReason: memoryReasonNoLimit,
			summaryHas: "no maxmemory configured",
		},
		{
			name: "empty policy with a limit is treated as noeviction",
			used: 100, maximum: 1000, policy: "",
			wantStatus: StatusPass, wantReason: memoryReasonHealthy,
			summaryHas: "used for operational state", remedyEmpty: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := classifyRedisMemory(testCase.used, testCase.maximum, testCase.policy)
			if got.status != testCase.wantStatus {
				t.Fatalf("status = %s, want %s", got.status, testCase.wantStatus)
			}
			if got.reason != testCase.wantReason {
				t.Fatalf("reason = %s, want %s", got.reason, testCase.wantReason)
			}
			if !strings.Contains(got.summary, testCase.summaryHas) {
				t.Fatalf("summary = %q, want it to contain %q", got.summary, testCase.summaryHas)
			}
			if testCase.remedyEmpty && got.remedy != "" {
				t.Fatalf("remedy = %q, want empty for a passing check", got.remedy)
			}
			if !testCase.remedyEmpty && got.remedy == "" {
				t.Fatalf("remedy is empty, want a remedy for status %s", got.status)
			}
		})
	}
}

func TestClassifyRedisNamespace(t *testing.T) {
	cases := []struct {
		name        string
		namespace   string
		keyCount    int
		complete    bool
		wantStatus  Status
		wantReason  namespaceClassificationReason
		wantLabel   string
		summaryHas  string
		remedyEmpty bool
	}{
		{
			name: "empty namespace warns", namespace: "cao-dev", keyCount: 0, complete: true,
			wantStatus: StatusWarn, wantReason: namespaceReasonEmpty,
			wantLabel: "0", summaryHas: "holds no keys",
		},
		{
			name: "populated namespace with a complete scan passes", namespace: "cao-dev", keyCount: 42, complete: true,
			wantStatus: StatusPass, wantReason: namespaceReasonPopulated,
			wantLabel: "42", summaryHas: "holds 42 keys", remedyEmpty: true,
		},
		{
			name: "populated namespace with a bounded sample reports it as sampled", namespace: "cao-dev", keyCount: 20000, complete: false,
			wantStatus: StatusPass, wantReason: namespaceReasonPopulated,
			wantLabel: "at least 20000 (sampled)", summaryHas: "at least 20000 (sampled) keys", remedyEmpty: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := classifyRedisNamespace(testCase.namespace, testCase.keyCount, testCase.complete)
			if got.status != testCase.wantStatus {
				t.Fatalf("status = %s, want %s", got.status, testCase.wantStatus)
			}
			if got.reason != testCase.wantReason {
				t.Fatalf("reason = %s, want %s", got.reason, testCase.wantReason)
			}
			if got.countLabel != testCase.wantLabel {
				t.Fatalf("countLabel = %q, want %q", got.countLabel, testCase.wantLabel)
			}
			if !strings.Contains(got.summary, testCase.summaryHas) {
				t.Fatalf("summary = %q, want it to contain %q", got.summary, testCase.summaryHas)
			}
			if testCase.remedyEmpty && got.remedy != "" {
				t.Fatalf("remedy = %q, want empty for a passing check", got.remedy)
			}
			if !testCase.remedyEmpty && got.remedy == "" {
				t.Fatalf("remedy is empty, want a remedy for status %s", got.status)
			}
		})
	}
}

func TestClassifyRedisPersistence(t *testing.T) {
	cases := []struct {
		name         string
		lastSave     string
		aofEnabled   bool
		aofLastWrite string
		wantStatus   Status
		wantReason   persistenceClassificationReason
		summaryHas   string
		remedyEmpty  bool
	}{
		{
			name:     "failed background save warns even with AOF disabled",
			lastSave: "err", aofEnabled: false,
			wantStatus: StatusWarn, wantReason: persistenceReasonBackgroundSaveFailed,
			summaryHas: "background save did not succeed",
		},
		{
			name:     "failed background save is checked before a failed AOF write",
			lastSave: "err", aofEnabled: true, aofLastWrite: "err",
			wantStatus: StatusWarn, wantReason: persistenceReasonBackgroundSaveFailed,
			summaryHas: "background save did not succeed",
		},
		{
			name:     "healthy background save with a failed AOF write warns",
			lastSave: "ok", aofEnabled: true, aofLastWrite: "err",
			wantStatus: StatusWarn, wantReason: persistenceReasonAOFWriteFailed,
			summaryHas: "append-only-file write did not succeed",
		},
		{
			name:     "healthy background save with AOF disabled passes",
			lastSave: "ok", aofEnabled: false,
			wantStatus: StatusPass, wantReason: persistenceReasonHealthy,
			summaryHas: "reporting healthy writes", remedyEmpty: true,
		},
		{
			name:     "healthy background save with a healthy AOF write passes",
			lastSave: "ok", aofEnabled: true, aofLastWrite: "ok",
			wantStatus: StatusPass, wantReason: persistenceReasonHealthy,
			summaryHas: "reporting healthy writes", remedyEmpty: true,
		},
		{
			name:     "blank background save status with AOF disabled passes",
			lastSave: "", aofEnabled: false,
			wantStatus: StatusPass, wantReason: persistenceReasonHealthy,
			summaryHas: "reporting healthy writes", remedyEmpty: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := classifyRedisPersistence(testCase.lastSave, testCase.aofEnabled, testCase.aofLastWrite)
			if got.status != testCase.wantStatus {
				t.Fatalf("status = %s, want %s", got.status, testCase.wantStatus)
			}
			if got.reason != testCase.wantReason {
				t.Fatalf("reason = %s, want %s", got.reason, testCase.wantReason)
			}
			if !strings.Contains(got.summary, testCase.summaryHas) {
				t.Fatalf("summary = %q, want it to contain %q", got.summary, testCase.summaryHas)
			}
			if testCase.remedyEmpty && got.remedy != "" {
				t.Fatalf("remedy = %q, want empty for a passing check", got.remedy)
			}
			if !testCase.remedyEmpty && got.remedy == "" {
				t.Fatalf("remedy is empty, want a remedy for status %s", got.status)
			}
		})
	}
}

func TestClassifyRedisStats(t *testing.T) {
	cases := []struct {
		name        string
		evicted     int64
		rejected    int64
		wantStatus  Status
		wantReason  statsClassificationReason
		summaryHas  string
		remedyEmpty bool
	}{
		{
			name:    "evicted keys fail regardless of rejected connections",
			evicted: 5, rejected: 3,
			wantStatus: StatusFail, wantReason: statsReasonEvictedKeys,
			summaryHas: "evicted 5 keys",
		},
		{
			name:    "rejected connections warn when there are no evicted keys",
			evicted: 0, rejected: 2,
			wantStatus: StatusWarn, wantReason: statsReasonRejectedConnections,
			summaryHas: "rejected 2 connections",
		},
		{
			name:    "no evictions or rejections passes",
			evicted: 0, rejected: 0,
			wantStatus: StatusPass, wantReason: statsReasonHealthy,
			summaryHas: "no evicted keys or rejected connections", remedyEmpty: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := classifyRedisStats(testCase.evicted, testCase.rejected)
			if got.status != testCase.wantStatus {
				t.Fatalf("status = %s, want %s", got.status, testCase.wantStatus)
			}
			if got.reason != testCase.wantReason {
				t.Fatalf("reason = %s, want %s", got.reason, testCase.wantReason)
			}
			if !strings.Contains(got.summary, testCase.summaryHas) {
				t.Fatalf("summary = %q, want it to contain %q", got.summary, testCase.summaryHas)
			}
			if testCase.remedyEmpty && got.remedy != "" {
				t.Fatalf("remedy = %q, want empty for a passing check", got.remedy)
			}
			if !testCase.remedyEmpty && got.remedy == "" {
				t.Fatalf("remedy is empty, want a remedy for status %s", got.status)
			}
		})
	}
}

func TestForeignNamespacesOf(t *testing.T) {
	cases := []struct {
		name      string
		namespace string
		keys      []string
		want      []string
	}{
		{
			name:      "excludes keys scoped to the namespace",
			namespace: "cao-dev",
			keys:      []string{"cao-dev:g:1", "cao-dev:index:runs"},
			want:      []string{},
		},
		{
			name:      "collects and sorts distinct foreign prefixes",
			namespace: "cao-dev",
			keys:      []string{"other-app:key1", "cao-dev:g:1", "zeta:key2", "other-app:key3"},
			want:      []string{"other-app", "zeta"},
		},
		{
			name:      "ignores keys without a colon separator",
			namespace: "cao-dev",
			keys:      []string{"nocolon", "cao-dev:g:1"},
			want:      []string{},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := foreignNamespacesOf(testCase.namespace, testCase.keys)
			if len(got) == 0 && len(testCase.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("foreignNamespacesOf() = %v, want %v", got, testCase.want)
			}
		})
	}
}
