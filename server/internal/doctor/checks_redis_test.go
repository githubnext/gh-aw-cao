package doctor

import (
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
			name: "evicting policy fails regardless of utilization",
			used: 100, maximum: 1000, policy: "allkeys-lru",
			wantStatus: StatusFail, wantReason: memoryReasonEvictingPolicy,
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
			summaryHas: "used under a noeviction policy", remedyEmpty: true,
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
			summaryHas: "used under a noeviction policy", remedyEmpty: true,
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
