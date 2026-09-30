package query

import "fmt"

// PlanLimitError identifies the query whose retained data exceeded the plan budget.
type PlanLimitError struct {
	QueryID string
	Limit   int64
}

func (e *PlanLimitError) Error() string {
	return fmt.Sprintf("Query %q needs more retained data than the server allows (limit %d MiB).", e.QueryID, e.Limit>>20)
}
