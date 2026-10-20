package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (q *Queue) AdmitBatch(ctx context.Context, admission wg.Admission) (wg.AdmissionResult, error) {
	if err := wg.ValidateAdmission(admission, q.options); err != nil {
		return wg.AdmissionResult{}, err
	}
	var result wg.AdmissionResult
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		if !current.Enabled || current != admission.Revision {
			return wg.ErrUnauthorized
		}
		var previous string
		err = tx.QueryRowContext(ctx, `SELECT digest FROM deliveries WHERE id=?`, admission.DeliveryID).Scan(&previous)
		if err == nil {
			if previous != admission.DeliveryDigest {
				return wg.ErrConflict
			}
			result.Duplicate = true
			ids, err := selectIDs(ctx, tx, `SELECT id FROM jobs WHERE delivery=? ORDER BY id`, admission.DeliveryID)
			if err != nil {
				return err
			}
			for _, id := range ids {
				job, err := load(ctx, tx, id)
				if err != nil {
					return err
				}
				result.Jobs = append(result.Jobs, job)
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		scopes := map[string]map[string]bool{"tenant": {}, "source": {}}
		size := int64(512 + len(admission.DeliveryID) + len(admission.DeliveryDigest))
		for _, job := range admission.Jobs {
			d := wg.JobDimensions(job)
			scopes["tenant"][d.Tenant], scopes["source"][d.Source] = true, true
		}
		for _, values := range scopes {
			for value := range values {
				size += int64(len(value) + 64)
			}
		}
		if err := q.capacity(ctx, tx, nil, size); err != nil {
			return err
		}
		for kind, values := range scopes {
			for value := range values {
				share := (size + int64(len(values)) - 1) / int64(len(values))
				if err := q.scopeCapacity(ctx, tx, kind, value, share); err != nil {
					return err
				}
			}
		}
		retain := now.Add(q.options.DedupWindow).UnixMilli()
		if _, err := tx.ExecContext(ctx, `INSERT INTO deliveries VALUES(?,?,?,?)`,
			admission.DeliveryID, admission.DeliveryDigest, retain, size); err != nil {
			return err
		}
		for kind, values := range scopes {
			for value := range values {
				if _, err := tx.ExecContext(ctx, `INSERT INTO receipt_scopes VALUES(?,?,?,?)`,
					admission.DeliveryID, kind, value, (size+int64(len(values))-1)/int64(len(values))); err != nil {
					return err
				}
			}
		}
		for _, job := range admission.Jobs {
			identity, err := json.Marshal([]string{admission.DeliveryID, job.Subscription.ID})
			if err != nil {
				return err
			}
			job.ID, job.QueueRevision = wg.MetadataDigest(identity), current
			job.CreatedAt = job.CreatedAt.UTC().Truncate(time.Millisecond)
			job.ExpiresAt = job.ExpiresAt.UTC().Truncate(time.Millisecond)
			job.NotBefore = maxTime(now, job.NotBefore.UTC().Truncate(time.Millisecond))
			job.Reason, job.LeaseUntil = "", time.Time{}
			if job.CreatedAt.After(now) || !job.ExpiresAt.After(job.NotBefore) ||
				!job.CreatedAt.Add(q.options.MaxAge).After(now) {
				return wg.ErrInvalid
			}
			document, err := json.Marshal(job)
			if err != nil {
				return err
			}
			d := wg.JobDimensions(job)
			size := int64(len(document) + 2048 + len(d.App) + len(d.Tenant) + len(d.Source) + len(d.Destination) + len(d.Workflow))
			if err := q.capacity(ctx, tx, &d, size); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				job.ID, admission.DeliveryID, document, d.Tenant, d.Source, d.Destination, job.State,
				job.CreatedAt.UnixMilli(), job.ExpiresAt.UnixMilli(), job.NotBefore.UnixMilli(),
				job.LeaseUntil.UnixMilli(), retain, size); err != nil {
				return err
			}
			result.Jobs = append(result.Jobs, job)
		}
		return nil
	})
	if err != nil {
		return wg.AdmissionResult{}, err
	}
	return result, nil
}

func (q *Queue) capacity(ctx context.Context, tx *sql.Tx, dimensions *wg.Dimensions, size int64) error {
	var count, used int64
	if err := tx.QueryRowContext(ctx, `SELECT
	 (SELECT count(*) FROM jobs)+(SELECT count(*) FROM deliveries),
	 (SELECT coalesce(sum(bytes),0) FROM jobs)+(SELECT coalesce(sum(bytes),0) FROM deliveries)`).Scan(&count, &used); err != nil {
		return err
	}
	if count >= q.options.MaxRows || size > q.options.MaxBytes-used {
		return wg.ErrCapacity
	}
	if dimensions != nil {
		for kind, value := range map[string]string{"tenant": dimensions.Tenant, "source": dimensions.Source, "destination": dimensions.Destination} {
			if err := q.scopeCapacity(ctx, tx, kind, value, size); err != nil {
				return err
			}
		}
	}
	return nil
}

func (q *Queue) scopeCapacity(ctx context.Context, tx *sql.Tx, kind, value string, size int64) error {
	var maxRows, maxBytes int64
	switch kind {
	case "tenant":
		maxRows, maxBytes = q.options.MaxTenantRows, q.options.MaxTenantBytes
	case "source":
		maxRows, maxBytes = q.options.MaxSourceRows, q.options.MaxSourceBytes
	case "destination":
		maxRows, maxBytes = q.options.MaxDestinationRows, q.options.MaxDestinationBytes
	default:
		return wg.ErrInvalid
	}
	var count, used, receipts, receiptBytes int64
	// kind is exclusively one of the closed column names above.
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(bytes),0) FROM jobs WHERE `+kind+`=?`, value).Scan(&count, &used); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(bytes),0) FROM receipt_scopes WHERE kind=? AND scope=?`, kind, value).Scan(&receipts, &receiptBytes); err != nil {
		return err
	}
	if count+receipts >= maxRows || size > maxBytes-used-receiptBytes {
		return wg.ErrCapacity
	}
	return nil
}

func maxTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}
