package admission

import (
	"strings"
	"testing"
)

func TestConclusionBoundsViolation(t *testing.T) {
	valid := ConclusionRequest{SessionCompaction: SessionCompaction{Version: 1}}
	for _, test := range []struct {
		name string
		edit func(*ConclusionRequest)
		want string
	}{
		{"valid", func(*ConclusionRequest) {}, ""},
		{"version", func(r *ConclusionRequest) { r.SessionCompaction.Version = 2 }, "compaction_bounds"},
		{"negative included", func(r *ConclusionRequest) { r.SessionCompaction.IncludedEvents = -1 }, "compaction_bounds"},
		{"too many events", func(r *ConclusionRequest) { r.SessionCompaction.IncludedEvents = MaxSessionEvents + 1 }, "compaction_bounds"},
		{"unsafe omitted", func(r *ConclusionRequest) { r.SessionCompaction.OmittedEvents = maxSafeInteger + 1 }, "compaction_bounds"},
		{"oversized session", func(r *ConclusionRequest) { r.Session = strings.Repeat("x", MaxSessionBytes+1) }, "compaction_bounds"},
		{"three artifacts", func(r *ConclusionRequest) { r.UsageArtifactIDs = []string{"1", "2", "3"} }, "compaction_bounds"},
		{"non decimal artifact", func(r *ConclusionRequest) { r.UsageArtifactIDs = []string{"abc"} }, "artifact_ids"},
		{"long artifact", func(r *ConclusionRequest) { r.UsageArtifactIDs = []string{strings.Repeat("1", 21)} }, "artifact_ids"},
		{"duplicate artifact", func(r *ConclusionRequest) { r.UsageArtifactIDs = []string{"7", "7"} }, "artifact_ids"},
		{"distinct artifacts", func(r *ConclusionRequest) { r.UsageArtifactIDs = []string{"7", "8"} }, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := valid
			test.edit(&input)
			if got := conclusionBoundsViolation(input); got != test.want {
				t.Fatalf("violation = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCompactSessionViolation(t *testing.T) {
	event := "{\"type\":\"session.format\",\"data\":{}}\n"
	for _, test := range []struct {
		name     string
		session  string
		included int
		want     string
	}{
		{"empty", "", 0, ""},
		{"empty with count", "", 1, "session_count"},
		{"unterminated", strings.TrimSuffix(event, "\n"), 1, "session_terminator"},
		{"count mismatch", event, 2, "session_count"},
		{"unknown event", "{\"type\":\"nope\",\"data\":{}}\n", 1, "session_event"},
		{"valid", event + event, 2, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := compactSessionViolation(test.session, test.included); got != test.want {
				t.Fatalf("violation = %q, want %q", got, test.want)
			}
		})
	}
}
