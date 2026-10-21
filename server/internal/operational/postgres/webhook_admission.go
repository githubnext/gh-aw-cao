package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (q *webhookQueue) AdmitBatch(ctx context.Context, admission wg.Admission) (wg.AdmissionResult, error) {
	if err := wg.ValidateAdmission(admission, q.options); err != nil {
		return wg.AdmissionResult{}, err
	}
	var result wg.AdmissionResult
	err := q.transact(ctx, func(t *transaction) error {
		policy, err := q.policy(t)
		if err != nil {
			return err
		}
		if !policy.Enabled || policy != admission.Revision {
			return wg.ErrUnauthorized
		}
		var previous string
		err = t.tx.QueryRowContext(ctx, `SELECT digest FROM cao_operational_webhook_deliveries WHERE namespace=$1 AND queue=$2 AND delivery_id=$3`,
			t.namespace, q.name, admission.DeliveryID).Scan(&previous)
		if err == nil {
			if previous != admission.DeliveryDigest {
				return wg.ErrConflict
			}
			result.Duplicate = true
			result.Jobs, err = q.deliveryJobs(t, admission.DeliveryID)
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		retainUntil := t.now.Add(q.options.DedupWindow)
		tenants, sources := webhookAdmissionScopes(admission)
		receiptBytes := int64(512 + len(admission.DeliveryID) + len(admission.DeliveryDigest))
		for _, values := range [][]string{tenants, sources} {
			for _, value := range values {
				receiptBytes += int64(len(value) + 8)
			}
		}
		if err := q.capacity(t, "", "", "", receiptBytes); err != nil {
			return err
		}
		for _, tenant := range tenants {
			if err := q.capacity(t, tenant, "", "", webhookReceiptShare(receiptBytes, len(tenants))); err != nil {
				return err
			}
		}
		for _, source := range sources {
			if err := q.capacity(t, "", source, "", webhookReceiptShare(receiptBytes, len(sources))); err != nil {
				return err
			}
		}
		if err := t.reserveCLI(receiptBytes, 1); err != nil {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_webhook_deliveries(namespace,queue,delivery_id,digest,tenant,source,tenants,sources,created_at,retain_until,storage_bytes) VALUES($1,$2,$3,$4,'','',$5,$6,$7,$8,$9)`,
			t.namespace, q.name, admission.DeliveryID, admission.DeliveryDigest, tenants, sources, t.now, retainUntil, receiptBytes); err != nil {
			return err
		}
		for _, input := range admission.Jobs {
			job := input
			job.DeliveryID, job.QueueRevision = admission.DeliveryID, admission.Revision
			identity, err := json.Marshal([]string{admission.DeliveryID, job.Subscription.ID})
			if err != nil {
				return err
			}
			digest := sha256.Sum256(identity)
			job.ID = hex.EncodeToString(digest[:])
			job.State, job.Version, job.Fence, job.Attempt = wg.Ready, 1, 0, 0
			job.ClaimID, job.Reason, job.LeaseUntil = "", "", time.Time{}
			job.AcceptedStatus, job.WorkflowRunID = 0, 0
			if job.CreatedAt.IsZero() {
				job.CreatedAt = t.now
			}
			job.CreatedAt = job.CreatedAt.UTC().Truncate(time.Millisecond)
			job.ExpiresAt = job.ExpiresAt.UTC().Truncate(time.Millisecond)
			job.NotBefore = job.NotBefore.UTC().Truncate(time.Millisecond)
			if job.CreatedAt.After(t.now) || !t.now.Before(job.CreatedAt.Add(q.options.MaxAge)) {
				return wg.ErrInvalid
			}
			maxExpiry := job.CreatedAt.Add(q.options.MaxAge)
			subscriptionExpiry := job.CreatedAt.Add(time.Duration(job.Subscription.Delivery.TTLSeconds) * time.Second)
			if subscriptionExpiry.Before(maxExpiry) {
				maxExpiry = subscriptionExpiry
			}
			if job.ExpiresAt.IsZero() || maxExpiry.Before(job.ExpiresAt) {
				job.ExpiresAt = maxExpiry
			}
			if !t.now.Before(job.ExpiresAt) {
				return wg.ErrInvalid
			}
			if job.NotBefore.IsZero() || job.NotBefore.Before(t.now) {
				job.NotBefore = t.now
			}
			if !job.NotBefore.Before(job.ExpiresAt) {
				return wg.ErrInvalid
			}
			d := wg.JobDimensions(job)
			document, err := json.Marshal(job)
			if err != nil {
				return err
			}
			if int64(len(document)) > t.config.MaxRecordBytes {
				return wg.ErrCapacity
			}
			size := int64(2048 + len(document) + len(job.ID) + len(job.DeliveryID) + len(job.Subscription.ID) +
				len(d.Tenant) + len(d.Source) + len(d.Destination) + len(d.App) + len(d.Workflow))
			if err := q.capacity(t, d.Tenant, d.Source, d.Destination, size); err != nil {
				return err
			}
			if err := t.reserveCLI(size, 1); err != nil {
				return err
			}
			if _, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_webhook_jobs(namespace,queue,id,delivery_id,subscription_id,document,tenant,source,destination,app,workflow,state,created_at,expires_at,not_before,retain_until,storage_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ready',$12,$13,$14,$15,$16)`,
				t.namespace, q.name, job.ID, job.DeliveryID, job.Subscription.ID, document, d.Tenant, d.Source, d.Destination, d.App, d.Workflow,
				job.CreatedAt, job.ExpiresAt, job.NotBefore, retainUntil, size); err != nil {
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

func webhookAdmissionScopes(admission wg.Admission) (tenants, sources []string) {
	tenantSet, sourceSet := map[string]bool{}, map[string]bool{}
	for _, job := range admission.Jobs {
		d := wg.JobDimensions(job)
		tenantSet[d.Tenant], sourceSet[d.Source] = true, true
	}
	tenants, sources = make([]string, 0, len(tenantSet)), make([]string, 0, len(sourceSet))
	for tenant := range tenantSet {
		tenants = append(tenants, tenant)
	}
	for source := range sourceSet {
		sources = append(sources, source)
	}
	sort.Strings(tenants)
	sort.Strings(sources)
	return tenants, sources
}

func webhookReceiptShare(size int64, scopes int) int64 {
	return (size + int64(scopes) - 1) / int64(scopes)
}

func (q *webhookQueue) capacity(t *transaction, tenant, source, destination string, size int64) error {
	var count, used int64
	if err := t.tx.QueryRowContext(t.ctx, `SELECT
		(SELECT count(*) FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2)+(SELECT count(*) FROM cao_operational_webhook_deliveries WHERE namespace=$1 AND queue=$2),
		(SELECT coalesce(sum(storage_bytes),0) FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2)+(SELECT coalesce(sum(storage_bytes),0) FROM cao_operational_webhook_deliveries WHERE namespace=$1 AND queue=$2)`,
		t.namespace, q.name).Scan(&count, &used); err != nil {
		return err
	}
	if count >= q.options.MaxRows || size > q.options.MaxBytes-used {
		return wg.ErrCapacity
	}
	for _, scope := range []struct {
		column, value string
		rows, bytes   int64
	}{
		{"tenant", tenant, q.options.MaxTenantRows, q.options.MaxTenantBytes},
		{"source", source, q.options.MaxSourceRows, q.options.MaxSourceBytes},
		{"destination", destination, q.options.MaxDestinationRows, q.options.MaxDestinationBytes},
	} {
		if scope.value == "" {
			continue
		}
		// Column identifiers are from the closed list above, never caller input.
		query := `SELECT count(*),coalesce(sum(storage_bytes),0) FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2 AND ` + scope.column + `=$3`
		if err := t.tx.QueryRowContext(t.ctx, query, t.namespace, q.name, scope.value).Scan(&count, &used); err != nil {
			return err
		}
		if scope.column != "destination" {
			var receipts, receiptBytes int64
			array := scope.column + "s"
			// Older receipts have one scalar scope; new receipts account every
			// distinct scope with a rounded-up equal share of their total bytes.
			query = `SELECT count(*),coalesce(sum((storage_bytes+greatest(cardinality(` + array + `),1)-1)/greatest(cardinality(` + array + `),1)),0)
				FROM cao_operational_webhook_deliveries WHERE namespace=$1 AND queue=$2 AND $3=ANY(
					CASE WHEN cardinality(` + array + `)>0 THEN ` + array + ` ELSE ARRAY[` + scope.column + `] END)`
			if err := t.tx.QueryRowContext(t.ctx, query, t.namespace, q.name, scope.value).Scan(&receipts, &receiptBytes); err != nil {
				return err
			}
			count, used = count+receipts, used+receiptBytes
		}
		if count >= scope.rows || size > scope.bytes-used {
			return wg.ErrCapacity
		}
	}
	return nil
}

func (q *webhookQueue) deliveryJobs(t *transaction, delivery string) ([]wg.Job, error) {
	rows, err := t.tx.QueryContext(t.ctx, `SELECT id FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2 AND delivery_id=$3 ORDER BY id`, t.namespace, q.name, delivery)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	if closeErr := rows.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	jobs := make([]wg.Job, 0, len(ids))
	for _, id := range ids {
		job, err := q.detail(t, id)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}
