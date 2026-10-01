package redisx

// IssueUpdate is an explicitly scoped status observation from a verified issues
// delivery. It is never used to create an issue or to change its identity.
type IssueUpdate struct {
	Repository, ID, Delivery string
	InstallationID           int64
	State, StateReason       string
	ClosedAt, ObservedAt     string
}
