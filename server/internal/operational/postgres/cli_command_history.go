package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

func (q *cliCommandQueue) detail(t *transaction, id int64) (operational.CLICommand, error) {
	if id < 1 {
		return operational.CLICommand{}, operational.ErrCLICommandInput
	}
	var command operational.CLICommand
	var invocation []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT id,invocation,status,created_at,started_at,completed_at,deadline,coalesce(completion_week::text,''),coalesce(idempotency_key,''),retry_of,exit_code,error,output_bytes,output_chunks,output_truncated,execution_claimed FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id).
		Scan(&command.ID, &invocation, &command.Status, &command.CreatedAt, &command.StartedAt, &command.CompletedAt, &command.Deadline,
			&command.CompletionWeek, &command.IdempotencyKey, &command.RetryOf, &command.ExitCode, &command.Error,
			&command.OutputBytes, &command.OutputChunks, &command.OutputTruncated, &command.ExecutionClaimed)
	if errors.Is(err, sql.ErrNoRows) {
		return operational.CLICommand{}, operational.ErrCLICommandNotFound
	}
	if err != nil {
		return operational.CLICommand{}, err
	}
	if err := json.Unmarshal(invocation, &command.CLICommandInvocation); err != nil {
		return operational.CLICommand{}, err
	}
	return command, nil
}

func (q *cliCommandQueue) Detail(ctx context.Context, id int64) (operational.CLICommand, error) {
	var command operational.CLICommand
	err := q.transact(ctx, false, func(t *transaction, _ cliQueueState) error {
		var err error
		command, err = q.detail(t, id)
		return err
	})
	if err != nil {
		return operational.CLICommand{}, err
	}
	return command, nil
}

func (q *cliCommandQueue) List(ctx context.Context, filter operational.CLICommandFilter) (operational.CLICommandPage, error) {
	if err := filter.Validate(); err != nil {
		return operational.CLICommandPage{}, err
	}
	page := operational.CLICommandPage{Commands: []operational.CLICommand{}}
	statuses := make([]string, 0, len(filter.Statuses))
	for _, status := range filter.Statuses {
		statuses = append(statuses, string(status))
	}
	err := q.transact(ctx, false, func(t *transaction, state cliQueueState) error {
		page.Revision, page.RecoveryBlocked = state.revision, state.blocked
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND (cardinality($3::text[])=0 OR status=ANY($3::text[]))`, t.namespace, q.name, statuses).Scan(&page.Total); err != nil {
			return err
		}
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND execution_claimed`, t.namespace, q.name).Scan(&page.Running); err != nil {
			return err
		}
		rows, err := t.tx.QueryContext(ctx, `SELECT id FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND (cardinality($3::text[])=0 OR status=ANY($3::text[])) ORDER BY id DESC LIMIT $4 OFFSET $5`, t.namespace, q.name, statuses, filter.Limit, filter.Offset)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		ids := []int64{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		if closeErr := rows.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		for _, id := range ids {
			command, err := q.detail(t, id)
			if err != nil {
				return err
			}
			// History summaries never expose stdin or output transcripts.
			command.Input = nil
			page.Commands = append(page.Commands, command)
		}
		return nil
	})
	if err != nil {
		return operational.CLICommandPage{}, err
	}
	return page, nil
}

func (q *cliCommandQueue) ListBefore(ctx context.Context, filter operational.CLICommandCursorFilter) (operational.CLICommandCursorPage, error) {
	if err := filter.Validate(); err != nil {
		return operational.CLICommandCursorPage{}, err
	}
	page := operational.CLICommandCursorPage{Commands: []operational.CLICommand{}}
	statuses := make([]string, 0, len(filter.Statuses))
	for _, status := range filter.Statuses {
		statuses = append(statuses, string(status))
	}
	err := q.transact(ctx, false, func(t *transaction, state cliQueueState) error {
		page.Revision, page.RecoveryBlocked = state.revision, state.blocked
		where := `namespace=$1 AND queue=$2`
		args := []any{t.namespace, q.name}
		if filter.BeforeID > 0 {
			args = append(args, filter.BeforeID)
			where += ` AND id<$` + strconv.Itoa(len(args))
		}
		if len(statuses) > 0 {
			args = append(args, statuses)
			where += ` AND status=ANY($` + strconv.Itoa(len(args)) + `::text[])`
		}
		args = append(args, filter.Limit+1)
		// #nosec G202 -- where contains only fixed SQL and numbered placeholders.
		rows, err := t.tx.QueryContext(ctx, `SELECT id FROM cao_operational_cli_commands WHERE `+where+` ORDER BY id DESC LIMIT $`+strconv.Itoa(len(args)), args...)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		ids := make([]int64, 0, filter.Limit+1)
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		if closeErr := rows.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		page.HasMore = len(ids) > filter.Limit
		if page.HasMore {
			ids = ids[:filter.Limit]
		}
		for _, id := range ids {
			command, err := q.detail(t, id)
			if err != nil {
				return err
			}
			command.Input = nil
			page.Commands = append(page.Commands, command)
		}
		return nil
	})
	if err != nil {
		return operational.CLICommandCursorPage{}, err
	}
	return page, nil
}

func (q *cliCommandQueue) Output(ctx context.Context, id, after int64, limit int) ([]operational.CLICommandOutput, error) {
	if id < 1 || after < 0 || limit < 1 || limit > 500 {
		return nil, operational.ErrCLICommandInput
	}
	output := []operational.CLICommandOutput{}
	err := q.transact(ctx, false, func(t *transaction, _ cliQueueState) error {
		if _, err := q.detail(t, id); err != nil {
			return err
		}
		rows, err := t.tx.QueryContext(ctx, `SELECT sequence,stream,data FROM cao_operational_cli_output WHERE namespace=$1 AND queue=$2 AND command_id=$3 AND sequence>$4 ORDER BY sequence LIMIT $5`, t.namespace, q.name, id, after, limit)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var chunk operational.CLICommandOutput
			if err := rows.Scan(&chunk.Sequence, &chunk.Stream, &chunk.Data); err != nil {
				return err
			}
			output = append(output, chunk)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return output, nil
}

func (q *cliCommandQueue) Retain(ctx context.Context) (int64, error) {
	var removed int64
	err := q.transact(ctx, true, func(t *transaction, _ cliQueueState) error {
		var err error
		removed, err = t.retainCLI(q.name, cliMonday(t.now.AddDate(0, 0, -q.options.RetentionDays)), 512)
		return err
	})
	if err != nil {
		return 0, err
	}
	return removed, nil
}

func (t *transaction) retainCLI(queue string, cutoff time.Time, limit int) (int64, error) {
	var removed, size, entries int64
	err := t.tx.QueryRowContext(t.ctx, `WITH expired AS (
		SELECT id FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND completion_week<$3 AND NOT execution_claimed AND status NOT IN ('queued','running') ORDER BY completion_week,id LIMIT $4
	), removed AS (
		DELETE FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND id IN (SELECT id FROM expired) RETURNING storage_bytes,output_chunks
	) SELECT count(*),coalesce(sum(storage_bytes),0),coalesce(sum(1+output_chunks),0) FROM removed`, t.namespace, queue, cutoff, limit).Scan(&removed, &size, &entries)
	if err != nil {
		return 0, err
	}
	if removed != 0 {
		if err := t.reserveCLI(-size, -entries); err != nil {
			return 0, err
		}
	}
	return removed, nil
}

func (t *transaction) maintainCLICommands() error {
	rows, err := t.tx.QueryContext(t.ctx, `SELECT q.name,q.config FROM cao_operational_cli_queues q WHERE q.namespace=$1 AND EXISTS(
		SELECT 1 FROM cao_operational_cli_commands c WHERE c.namespace=q.namespace AND c.queue=q.name AND NOT c.execution_claimed AND c.status NOT IN ('queued','running')
		AND c.completion_week < date_trunc('week', ($2::timestamptz AT TIME ZONE 'UTC') - make_interval(days => (convert_from(q.config,'UTF8')::jsonb->>'RetentionDays')::integer))::date
	) ORDER BY q.name LIMIT 512`, t.namespace, t.now)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	type expiredQueue struct {
		name    string
		options operational.CLICommandQueueOptions
	}
	queues := []expiredQueue{}
	for rows.Next() {
		var q expiredQueue
		var config []byte
		if err := rows.Scan(&q.name, &config); err != nil {
			_ = rows.Close()
			return err
		}
		if err := json.Unmarshal(config, &q.options); err != nil {
			_ = rows.Close()
			return err
		}
		queues = append(queues, q)
	}
	err = rows.Err()
	if closeErr := rows.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	remaining := 512
	for _, q := range queues {
		removed, err := t.retainCLI(q.name, cliMonday(t.now.AddDate(0, 0, -q.options.RetentionDays)), remaining)
		if err != nil {
			return err
		}
		if removed > 0 {
			if _, err := t.tx.ExecContext(t.ctx, `UPDATE cao_operational_cli_queues SET revision=revision+1 WHERE namespace=$1 AND name=$2`, t.namespace, q.name); err != nil {
				return err
			}
		}
		remaining -= int(removed)
		if remaining == 0 {
			break
		}
	}
	return nil
}
