package postgresx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

type entityColumn struct{ field, name, kind, sql string }
type entityTable struct {
	name      string
	runtime   bool
	canonical bool
	columns   []entityColumn
}

func IsCanonicalCollection(name string) bool {
	table, exists := entityTables["$"+name]
	return exists && table.canonical
}

func entityFieldValue(row model.Row, path string) (any, bool) {
	parts := strings.Split(path, ".")
	value, present := row[parts[0]]
	if len(parts) == 1 {
		return value, present
	}
	if text, ok := value.(string); ok && (strings.HasSuffix(parts[0], "Link") || strings.HasSuffix(parts[0], "-link")) {
		switch parts[1] {
		case "href":
			return text, present
		case "relation":
			return strings.TrimSuffix(strings.TrimSuffix(parts[0], "Link"), "-link"), present
		default:
			return nil, false
		}
	}
	if value, ok := value.(map[string]any); ok {
		field, exists := value[parts[1]]
		return field, exists
	}
	if value, ok := value.(model.Row); ok {
		field, exists := value[parts[1]]
		return field, exists
	}
	return nil, false
}

func (column entityColumn) bind(value any) (any, error) {
	switch pointer := value.(type) {
	case *int:
		if pointer == nil {
			return nil, nil
		}
		value = *pointer
	case *int64:
		if pointer == nil {
			return nil, nil
		}
		value = *pointer
	case *float64:
		if pointer == nil {
			return nil, nil
		}
		value = *pointer
	}
	if value == nil {
		return nil, nil
	}
	switch column.kind {
	case "object":
		switch value.(type) {
		case model.Row, map[string]any, string:
			return true, nil
		}
	case "boolean":
		if boolean, ok := value.(bool); ok {
			return boolean, nil
		}
	case "numeric":
		var text string
		switch number := value.(type) {
		case json.Number:
			text = string(number)
		case float64, float32, int, int64, int32, uint64:
			text = fmt.Sprint(number)
		default:
			return nil, errors.New("expected a native number")
		}
		if column.sql == "BIGINT" {
			return strconv.ParseInt(text, 10, 64)
		}
		number := pgtype.Numeric{}
		if err := number.Scan(text); err != nil {
			return nil, errors.New("invalid finite numeric field")
		}
		if number.NaN || number.InfinityModifier != pgtype.Finite {
			return nil, errors.New("numeric field must be finite")
		}
		return number, nil
	case "timestamp":
		if instant, ok := value.(time.Time); ok {
			return instant, nil
		}
		if text, ok := value.(string); ok {
			instant, err := time.Parse(time.RFC3339Nano, text)
			if err != nil {
				return nil, errors.New("invalid canonical timestamp")
			}
			return instant, nil
		}
	default:
		if text, ok := value.(string); ok {
			return text, nil
		}
	}
	return nil, errors.New("invalid native field type")
}

const BatchRows = 512
const BatchBytes = 8 << 20

// Writer replaces one namespace under a transaction-scoped writer lock.
// Rows are bounded per batch and are never retained beyond CopyFrom.
type Writer struct {
	store                *Store
	connection           *pgx.Conn
	tx                   pgx.Tx
	ordinals             map[string]int64
	inventoryOrdinals    map[string]int64
	inventoryTables      map[string]bool
	batches              map[string][][]any
	rows, bytes          int
	revision             int64
	PreviousDataRevision string
	evaluatedAt          time.Time
}

func (s *Store) BeginIngestion(ctx context.Context) (*Writer, error) {
	connection, err := pgx.ConnectConfig(ctx, s.config.Copy())
	if err != nil {
		return nil, err
	}
	tx, err := connection.Begin(ctx)
	if err != nil {
		_ = connection.Close(ctx)
		return nil, err
	}
	writer := &Writer{store: s, connection: connection, tx: tx, ordinals: map[string]int64{}, inventoryOrdinals: map[string]int64{}, inventoryTables: map[string]bool{}, batches: map[string][][]any{}, evaluatedAt: time.Unix(0, 0).UTC()}
	fail := func(err error) (*Writer, error) { writer.Abort(ctx); return nil, err }
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0))`, s.namespace); err != nil {
		return fail(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cao_state (namespace, revision, data_revision, evaluated_at, schema_version)
		VALUES ($1,0,'','epoch',$2) ON CONFLICT (namespace) DO NOTHING`, s.namespace, model.SchemaVersion); err != nil {
		return fail(err)
	}
	if err := tx.QueryRow(ctx, `SELECT revision,data_revision FROM cao_state WHERE namespace=$1 FOR UPDATE`, s.namespace).Scan(&writer.revision, &writer.PreviousDataRevision); err != nil {
		return fail(err)
	}
	if _, err := tx.Exec(ctx, "SET CONSTRAINTS ALL DEFERRED"); err != nil {
		return fail(err)
	}
	for _, source := range tableNames() {
		if _, err := tx.Exec(ctx, "DELETE FROM "+query.SQLIdentifier(entityTables[source].name)+" WHERE namespace=$1", s.namespace); err != nil {
			return fail(err)
		}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM cao_quality WHERE namespace=$1", s.namespace); err != nil {
		return fail(err)
	}
	return writer, nil
}

func (w *Writer) Abort(ctx context.Context) {
	if w.tx != nil {
		_ = w.tx.Rollback(context.WithoutCancel(ctx))
		w.tx = nil
	}
	if w.connection != nil {
		_ = w.connection.Close(context.WithoutCancel(ctx))
		w.connection = nil
	}
}

func (w *Writer) Append(ctx context.Context, source string, row model.Row) error {
	return w.append(ctx, source, row, false)
}

func (w *Writer) AppendInventory(ctx context.Context, source string, row model.Row) error {
	if !w.inventoryTables[source] {
		table, exists := entityTables[source]
		if !exists || table.runtime {
			return fmt.Errorf("unregistered inventory collection %q", source)
		}
		if _, err := w.tx.Exec(ctx, "CREATE TEMP TABLE "+query.SQLIdentifier(table.name+"_inventory")+" (LIKE "+query.SQLIdentifier(table.name)+" INCLUDING ALL) ON COMMIT DROP"); err != nil {
			return err
		}
		w.inventoryTables[source] = true
	}
	return w.append(ctx, source, row, true)
}

func (w *Writer) append(ctx context.Context, source string, row model.Row, inventory bool) error {
	table, exists := entityTables[source]
	if !exists || table.runtime {
		return fmt.Errorf("canonical collection %q is not registered by TypeSpec", source)
	}
	id, valid := row["id"].(string)
	if !valid || id == "" {
		return errors.New("native row requires a nonempty string id")
	}
	present := make([]byte, len(table.columns))
	values := make([]any, len(table.columns)+3)
	rowBytes := 0
	ordinals := w.ordinals
	batchName := source
	if inventory {
		ordinals = w.inventoryOrdinals
		batchName = source + "#inventory"
	}
	values[0], values[1] = w.store.namespace, ordinals[source]
	for index, column := range table.columns {
		value, exists := entityFieldValue(row, column.field)
		present[index] = '0'
		if exists {
			present[index] = '1'
		}
		bound, err := column.bind(value)
		if err != nil {
			return fmt.Errorf("%s.%s: %w", source, column.field, err)
		}
		values[index+3] = bound
		switch value := bound.(type) {
		case string:
			rowBytes += len(value)
		case time.Time:
			rowBytes += 16
		default:
			rowBytes += 32
		}
	}
	if rowBytes > BatchBytes {
		return errors.New("native record exceeds the bounded ingestion row budget")
	}
	if w.bytes+rowBytes > BatchBytes {
		if err := w.Flush(ctx); err != nil {
			return err
		}
	}
	w.bytes += rowBytes
	// #nosec G115 -- the column count is bounded by the generated TypeSpec registry.
	values[2] = pgtype.Bits{Bytes: presenceBytes(present), Len: int32(len(present)), Valid: true}
	ordinals[source]++
	w.batches[batchName] = append(w.batches[batchName], values)
	w.rows++
	if w.rows >= BatchRows || w.bytes >= BatchBytes {
		return w.Flush(ctx)
	}
	return nil
}

func presenceBytes(present []byte) []byte {
	value := make([]byte, (len(present)+7)/8)
	for index, bit := range present {
		if bit == '1' {
			value[index/8] |= 1 << (7 - index%8)
		}
	}
	return value
}

func (w *Writer) Flush(ctx context.Context) error {
	for source, batch := range w.batches {
		if len(batch) == 0 {
			continue
		}
		sourceName := strings.TrimSuffix(source, "#inventory")
		table := entityTables[sourceName]
		tableName := table.name
		if sourceName != source {
			tableName += "_inventory"
		}
		columns := make([]string, 0, 3+len(table.columns))
		columns = append(columns, "namespace", "ordinal", "present_fields")
		for _, column := range table.columns {
			columns = append(columns, column.name)
		}
		if _, err := w.tx.CopyFrom(ctx, pgx.Identifier{tableName}, columns, pgx.CopyFromRows(batch)); err != nil {
			return fmt.Errorf("copy native %s batch: %w", source, err)
		}
		delete(w.batches, source)
	}
	w.rows, w.bytes = 0, 0
	return nil
}

func (w *Writer) Quality(ctx context.Context, source string, metadata model.Metadata) error {
	table, exists := entityTables[source]
	if !exists || table.runtime {
		return fmt.Errorf("unregistered native quality collection %q", source)
	}
	availability, completeness, freshness := "available", "complete", "current"
	if value, ok := metadata["availability"].(string); ok {
		availability = value
	}
	if value, ok := metadata["completeness"].(string); ok {
		completeness = value
	}
	if value, ok := metadata["freshness"].(string); ok {
		freshness = value
	}
	if freshness == "fresh" {
		freshness = "current"
	}
	instants := map[string]any{}
	for _, field := range []string{"as-of", "retrieved-at"} {
		value, _ := metadata[field].(string)
		if field == "as-of" && value == "" {
			value, _ = metadata["observed-at"].(string)
		}
		if value != "" {
			instant, err := time.Parse(time.RFC3339Nano, value)
			if err != nil {
				return errors.New("invalid input quality timestamp")
			}
			instants[field] = instant
		}
	}
	_, err := w.tx.Exec(ctx, `INSERT INTO cao_quality(namespace,collection,row_count,availability,completeness,freshness,as_of,retrieved_at)
		VALUES($1,$2,0,$3,$4,$5,$6,$7) ON CONFLICT(namespace,collection) DO UPDATE SET
		availability=excluded.availability,completeness=excluded.completeness,freshness=excluded.freshness,as_of=excluded.as_of,retrieved_at=excluded.retrieved_at`,
		w.store.namespace, source, availability, completeness, freshness, instants["as-of"], instants["retrieved-at"])
	return err
}

func (w *Writer) Publish(ctx context.Context, dataRevision string) (State, error) {
	if dataRevision == "" {
		return State{}, errors.New("data revision is required")
	}
	if err := w.Flush(ctx); err != nil {
		return State{}, err
	}
	for source := range w.inventoryTables {
		table := entityTables[source]
		columns := []string{"namespace", "ordinal", "present_fields"}
		projection := []string{"i.namespace", fmt.Sprintf("%d + row_number() OVER(ORDER BY i.ordinal) - 1", w.ordinals[source]), "i.present_fields"}
		var updates []string
		var bits []string
		var inventoryBits []string
		for index, column := range table.columns {
			name := query.SQLIdentifier(column.name)
			columns = append(columns, name)
			inputValue, inputPresence := "i."+name, "get_bit(i.present_fields,"+strconv.Itoa(index)+")=1"
			if column.field == "observedAt" {
				inputValue = "CASE WHEN " + inputPresence + " THEN i." + name + " ELSE coalesce(q.as_of,q.retrieved_at) END"
				inputPresence = "(" + inputPresence + " OR coalesce(q.as_of,q.retrieved_at) IS NOT NULL)"
			}
			projection = append(projection, inputValue)
			inventoryBits = append(inventoryBits, "CASE WHEN "+inputPresence+" THEN '1' ELSE '0' END")
			if column.field != "id" {
				updates = append(updates, name+"=CASE WHEN get_bit(t.present_fields,"+strconv.Itoa(index)+")=1 THEN t."+name+" ELSE excluded."+name+" END")
			}
			projection[2] = "(" + strings.Join(inventoryBits, " || ") + ")::bit varying"
			bits = append(bits, "CASE WHEN get_bit(t.present_fields,"+strconv.Itoa(index)+")=1 OR get_bit(excluded.present_fields,"+strconv.Itoa(index)+")=1 THEN '1' ELSE '0' END")
		}
		updates = append(updates, "present_fields=("+strings.Join(bits, " || ")+")::bit varying")
		statement := "INSERT INTO " + query.SQLIdentifier(table.name) + " AS t(" + strings.Join(columns, ",") + ") SELECT " +
			strings.Join(projection, ",") + " FROM " + query.SQLIdentifier(table.name+"_inventory") + " i LEFT JOIN cao_quality q ON q.namespace=i.namespace AND q.collection=$2 WHERE i.namespace=$1 " +
			"ON CONFLICT(namespace,id) DO UPDATE SET " + strings.Join(updates, ",")
		if _, err := w.tx.Exec(ctx, statement, w.store.namespace, source); err != nil {
			return State{}, fmt.Errorf("publish typed inventory %s: %w", source, err)
		}
	}
	// Deferred parent checks and native primary keys reject orphans and duplicates
	// before the publication state becomes visible to readers.
	if _, err := w.tx.Exec(ctx, "SET CONSTRAINTS ALL IMMEDIATE"); err != nil {
		return State{}, fmt.Errorf("validate canonical relationships: %w", err)
	}
	for _, check := range []string{
		`SELECT 1 FROM runs r JOIN workflows p ON p.namespace=r.namespace AND p.id=r.workflow_id
			WHERE r.namespace=$1 AND r.repository_id<>p.repository_id LIMIT 1`,
		`SELECT 1 FROM experiment_assignments o JOIN runs r ON r.namespace=o.namespace AND r.id=o.run_id
			JOIN experiments d ON d.namespace=o.namespace AND d.id=o.experiment_id WHERE o.namespace=$1 AND r.workflow_id<>d.workflow_id LIMIT 1`,
		`SELECT 1 FROM grader_observations o JOIN runs r ON r.namespace=o.namespace AND r.id=o.run_id
			JOIN graders d ON d.namespace=o.namespace AND d.id=o.grader_id WHERE o.namespace=$1 AND r.workflow_id<>d.workflow_id LIMIT 1`,
		`SELECT 1 FROM eval_observations o JOIN runs r ON r.namespace=o.namespace AND r.id=o.run_id
			JOIN evals d ON d.namespace=o.namespace AND d.id=o.eval_id WHERE o.namespace=$1 AND r.workflow_id<>d.workflow_id LIMIT 1`,
	} {
		var invalid int
		if err := w.tx.QueryRow(ctx, check, w.store.namespace).Scan(&invalid); err == nil {
			return State{}, errors.New("canonical record references parents from different workflows or repositories")
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return State{}, err
		}
	}
	var clockSources []string
	for _, source := range tableNames() {
		table := entityTables[source]
		var fields []string
		for _, column := range table.columns {
			if column.kind != "timestamp" {
				continue
			}
			switch column.field {
			case "observedAt", "timestamp", "createdAt", "startedAt", "completedAt", "updatedAt", "observed-at", "created-at", "started-at", "ended-at", "provenance.observedAt":
				fields = append(fields, query.SQLIdentifier(column.name))
			}
		}
		if len(fields) > 0 {
			clockSources = append(clockSources, "SELECT max(greatest("+strings.Join(fields, ",")+")) AS instant FROM "+query.SQLIdentifier(table.name)+" WHERE namespace=$1")
		}
	}
	clockSources = append(clockSources, "SELECT max(greatest(as_of,retrieved_at)) AS instant FROM cao_quality WHERE namespace=$1")
	if err := w.tx.QueryRow(ctx, "SELECT coalesce(max(instant),'epoch'::timestamptz) FROM ("+strings.Join(clockSources, " UNION ALL ")+") AS clocks", w.store.namespace).Scan(&w.evaluatedAt); err != nil {
		return State{}, err
	}
	state := State{Ready: true, DataRevision: dataRevision, EvaluatedAt: w.evaluatedAt.UTC(), Counts: map[string]int{}}
	for _, source := range tableNames() {
		var count int
		if err := w.tx.QueryRow(ctx, "SELECT count(*) FROM "+query.SQLIdentifier(entityTables[source].name)+" WHERE namespace=$1", w.store.namespace).Scan(&count); err != nil {
			return State{}, err
		}
		state.Counts[source] = count
		if _, err := w.tx.Exec(ctx, `INSERT INTO cao_quality(namespace,collection,row_count,availability,completeness,freshness)
			VALUES($1,$2,$3,$4,'complete','current') ON CONFLICT(namespace,collection) DO UPDATE SET
			row_count=excluded.row_count,availability=CASE WHEN cao_quality.availability='unavailable' THEN 'unavailable' ELSE excluded.availability END`,
			w.store.namespace, source, count, map[bool]string{true: "empty", false: "available"}[count == 0]); err != nil {
			return State{}, err
		}
	}
	if err := w.tx.QueryRow(ctx, `UPDATE cao_state SET revision=revision+1,data_revision=$1,evaluated_at=$2,schema_version=$3
		WHERE namespace=$4 RETURNING revision`, dataRevision, w.evaluatedAt, model.SchemaVersion, w.store.namespace).Scan(&state.Revision); err != nil {
		return State{}, err
	}
	if err := w.tx.Commit(ctx); err != nil {
		return State{}, err
	}
	w.tx = nil
	_ = w.connection.Close(ctx)
	w.connection = nil
	return state, nil
}
