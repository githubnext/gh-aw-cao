package postgres

import (
	"context"
	"encoding/json"
	"math/bits"
	"sort"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func (s *Store) RecordGitHubQuotaUsage(ctx context.Context, bucket string, at time.Time, limit, used, reserved int64) (bool, error) {
	if err := quotaNames(bucket); err != nil {
		return false, err
	}
	if at.IsZero() || limit < 0 || limit > maxQuotaValue || used < 0 || used > limit || reserved < 0 || reserved > maxQuotaValue {
		return false, invalid("invalid quota usage observation")
	}
	saved := false
	err := s.transact(ctx, func(t *transaction) error {
		slot := at.UTC().Truncate(operational.GitHubQuotaUsageInterval)
		expires := slot.Add(operational.GitHubQuotaUsageInterval + operational.GitHubQuotaUsageRetention)
		if !expires.After(t.now) || slot.After(t.now.Add(operational.GitHubQuotaUsageInterval)) {
			return nil
		}
		k := key{"quota-usage", bucket, slot.Format(time.RFC3339)}
		var prior operational.GitHubQuotaUsageSample
		exists, err := t.json(k, &prior)
		if err != nil {
			return err
		}
		if exists {
			if prior.Used < 0 || prior.Limit < 0 || used < 0 || limit < 0 {
				return invalid("negative quota usage accounting")
			}
			hiA, loA := bits.Mul64(uint64(prior.Used), uint64(limit))
			hiB, loB := bits.Mul64(uint64(used), uint64(prior.Limit))
			if hiA > hiB || (hiA == hiB && (loA > loB || (loA == loB && prior.Used > used))) {
				limit, used = prior.Limit, prior.Used
			}
			reserved = max(reserved, prior.Reserved)
		}
		sample := operational.GitHubQuotaUsageSample{Bucket: bucket, Slot: slot, Limit: limit, Used: used, Reserved: reserved}
		if err := t.putJSON(k, sample, expires); err != nil {
			return err
		}
		saved = true
		return nil
	})
	return saved && err == nil, err
}

func (s *Store) GitHubQuotaUsage(ctx context.Context) ([]operational.GitHubQuotaUsageSample, time.Time, error) {
	samples := []operational.GitHubQuotaUsageSample{}
	var now time.Time
	err := s.transact(ctx, func(t *transaction) error {
		now = t.now
		records, err := t.list("quota-usage", "")
		if err != nil {
			return err
		}
		first := now.Add(-operational.GitHubQuotaUsageRetention).Truncate(operational.GitHubQuotaUsageInterval).Add(operational.GitHubQuotaUsageInterval)
		latest := now.Truncate(operational.GitHubQuotaUsageInterval)
		for _, r := range records {
			var sample operational.GitHubQuotaUsageSample
			if err := json.Unmarshal(r.value, &sample); err != nil {
				return err
			}
			if !sample.Slot.Before(first) && !sample.Slot.After(latest) {
				samples = append(samples, sample)
			}
		}
		sort.Slice(samples, func(i, j int) bool {
			if samples[i].Slot.Equal(samples[j].Slot) {
				return samples[i].Bucket < samples[j].Bucket
			}
			return samples[i].Slot.Before(samples[j].Slot)
		})
		return nil
	})
	return samples, now, err
}
