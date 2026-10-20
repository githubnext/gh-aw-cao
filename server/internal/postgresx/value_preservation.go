package postgresx

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

var valuePreservedSources = []string{
	"$campaigns", "$repositories", "$workflows", "$operationalValueEvidence", "$operationalValueEvidence.facts",
}

func validateValueSnapshotCapture(previous time.Time, row model.Row) error {
	capture, err := evidenceTime(row["observedAt"])
	if err != nil {
		return ErrValueInvalid
	}
	if capture.After(previous) {
		return fmt.Errorf("%w: newer publication-owned captures must use PublishOperationalValue", ErrValueConflict)
	}
	return nil
}

// Keep publication-owned facts and their existing structural parents inside
// PostgreSQL, not in an unbounded application-side snapshot.
func (w *Writer) preserveValuePublications(ctx context.Context) error {
	conditions := map[string]string{
		"$operationalValueEvidence":       "EXISTS(SELECT 1 FROM cao_value_publications p WHERE p.namespace=t.namespace AND p.packet_id=t.id)",
		"$operationalValueEvidence.facts": "EXISTS(SELECT 1 FROM cao_value_publications p WHERE p.namespace=t.namespace AND p.packet_id=t.packet_id)",
		"$repositories":                   "EXISTS(SELECT 1 FROM operational_value_evidence e JOIN cao_value_publications p ON p.namespace=e.namespace AND p.packet_id=e.id WHERE e.namespace=t.namespace AND e.repository_id=t.id)",
		"$workflows":                      "EXISTS(SELECT 1 FROM operational_value_evidence e JOIN cao_value_publications p ON p.namespace=e.namespace AND p.packet_id=e.id WHERE e.namespace=t.namespace AND e.workflow_id=t.id)",
		"$campaigns":                      "EXISTS(SELECT 1 FROM workflows f JOIN operational_value_evidence e ON e.namespace=f.namespace AND e.workflow_id=f.id JOIN cao_value_publications p ON p.namespace=e.namespace AND p.packet_id=e.id WHERE f.namespace=t.namespace AND f.campaign_id=t.id)",
	}
	for _, source := range valuePreservedSources {
		table := entityTables[source]
		statement := "CREATE TEMP TABLE " + query.SQLIdentifier(table.name+"_value_preserved") +
			" ON COMMIT DROP AS SELECT t.* FROM " + query.SQLIdentifier(table.name) +
			" t WHERE t.namespace=$1 AND " + conditions[source]
		if _, err := w.tx.Exec(ctx, statement, w.store.namespace); err != nil {
			return err
		}
	}
	return nil
}

func (w *Writer) restoreValuePublications(ctx context.Context) error {
	// An incoming Activity copy has no authority to replace an explicit packet.
	for _, statement := range []string{
		`DELETE FROM operational_value_evidence_facts t USING cao_value_publications p WHERE t.namespace=$1 AND p.namespace=t.namespace AND p.packet_id=t.packet_id`,
		`DELETE FROM operational_value_evidence t USING cao_value_publications p WHERE t.namespace=$1 AND p.namespace=t.namespace AND p.packet_id=t.id`,
	} {
		if _, err := w.tx.Exec(ctx, statement, w.store.namespace); err != nil {
			return err
		}
	}
	for _, source := range valuePreservedSources {
		table := entityTables[source]
		columns := []string{"namespace", "ordinal", "present_fields"}
		projection := []string{"p.namespace", "n.next_ordinal + row_number() OVER(ORDER BY p.ordinal) - 1", "p.present_fields"}
		for _, column := range table.columns {
			columns = append(columns, query.SQLIdentifier(column.name))
			projection = append(projection, "p."+query.SQLIdentifier(column.name))
		}
		name := query.SQLIdentifier(table.name)
		statement := fmt.Sprintf(`INSERT INTO %s(%s) SELECT %s FROM %s p
			CROSS JOIN (SELECT coalesce(max(ordinal)+1,0) AS next_ordinal FROM %s WHERE namespace=$1) n
			WHERE NOT EXISTS(SELECT 1 FROM %s t WHERE t.namespace=p.namespace AND t.id=p.id)`,
			name, strings.Join(columns, ","), strings.Join(projection, ","),
			query.SQLIdentifier(table.name+"_value_preserved"), name, name)
		if _, err := w.tx.Exec(ctx, statement, w.store.namespace); err != nil {
			return fmt.Errorf("restore published value %s: %w", source, err)
		}
	}
	return w.valueQuality(ctx)
}
