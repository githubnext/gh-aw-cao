package webhookgateway

// ValidateBatchMembers binds each member to one complete, compatible claim group.
func ValidateBatchMembers(jobs []Job) error {
	if len(jobs) == 0 || len(jobs) > MaxDispatchBatchItems || jobs[0].ClaimID == "" {
		return ErrInvalid
	}
	seen := make(map[string]bool)
	for _, job := range jobs {
		if seen[job.ID] || job.ClaimID != jobs[0].ClaimID || job.State != jobs[0].State ||
			!BatchCompatible(jobs[0], job) {
			return ErrConflict
		}
		seen[job.ID] = true
	}
	return nil
}
