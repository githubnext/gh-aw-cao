package query

import "fmt"

const BoundaryRetainedBytes = "retained_bytes"

// PlanLimitError identifies the query and the type of plan boundary exceeded.
type PlanLimitError struct {
	QueryID  string
	Boundary string
}

func (e *PlanLimitError) Error() string {
	return fmt.Sprintf("Query %q needs more retained data than the server allows. Try a narrower time range or contact your dashboard administrator.", e.QueryID)
}
