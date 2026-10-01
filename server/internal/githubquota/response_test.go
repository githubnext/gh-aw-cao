package githubquota

import (
	"net/http"
	"testing"
	"time"
)

func TestParkDecisionPrefersRetryAfterReasonByStatus(t *testing.T) {
	retryAfter := testNow.Add(30 * time.Second)

	parkUntil, reason := parkDecision(http.StatusServiceUnavailable, retryAfter, true, false, 0, testNow)
	if reason != ParkReasonRetryAfter || !parkUntil.Equal(retryAfter) {
		t.Fatalf("503 with Retry-After = %v, %q", parkUntil, reason)
	}

	parkUntil, reason = parkDecision(http.StatusForbidden, retryAfter, true, false, 0, testNow)
	if reason != ParkReasonSecondaryRateLimit || !parkUntil.Equal(retryAfter) {
		t.Fatalf("403 with Retry-After = %v, %q", parkUntil, reason)
	}

	parkUntil, reason = parkDecision(http.StatusTooManyRequests, retryAfter, true, false, 0, testNow)
	if reason != ParkReasonSecondaryRateLimit || !parkUntil.Equal(retryAfter) {
		t.Fatalf("429 with Retry-After = %v, %q", parkUntil, reason)
	}
}

func TestParkDecisionAmbiguous403WithoutRetryAfterDoesNotPark(t *testing.T) {
	parkUntil, reason := parkDecision(http.StatusForbidden, time.Time{}, false, false, 0, testNow)
	if reason != "" || !parkUntil.IsZero() {
		t.Fatalf("ambiguous 403 parked: %v, %q", parkUntil, reason)
	}
}

func TestParkDecision429WithoutRetryAfterParksAsSecondaryRateLimit(t *testing.T) {
	// No observation at all: treated as primary quota unknown, so it parks.
	parkUntil, reason := parkDecision(http.StatusTooManyRequests, time.Time{}, false, false, 0, testNow)
	if reason != ParkReasonSecondaryRateLimit || !parkUntil.Equal(testNow.Add(SecondaryRateLimitBackoff)) {
		t.Fatalf("429 without observation = %v, %q", parkUntil, reason)
	}

	// Observation present with primary quota remaining: still parks.
	parkUntil, reason = parkDecision(http.StatusTooManyRequests, time.Time{}, false, true, 5, testNow)
	if reason != ParkReasonSecondaryRateLimit || !parkUntil.Equal(testNow.Add(SecondaryRateLimitBackoff)) {
		t.Fatalf("429 with remaining quota = %v, %q", parkUntil, reason)
	}

	// Observation present with primary quota exhausted: this is the primary
	// rate limit, not a secondary one, so it must not park here.
	parkUntil, reason = parkDecision(http.StatusTooManyRequests, time.Time{}, false, true, 0, testNow)
	if reason != "" || !parkUntil.IsZero() {
		t.Fatalf("429 with exhausted primary quota parked: %v, %q", parkUntil, reason)
	}
}

func TestParkDecisionOtherErrorStatusesDoNotPark(t *testing.T) {
	parkUntil, reason := parkDecision(http.StatusInternalServerError, time.Time{}, false, false, 0, testNow)
	if reason != "" || !parkUntil.IsZero() {
		t.Fatalf("500 parked: %v, %q", parkUntil, reason)
	}
}
