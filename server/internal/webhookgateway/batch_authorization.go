package webhookgateway

import "context"

// AuthorizeCompatibleBatch shares one fresh read of identical GitHub authority,
// never an admission proof or evidence across different immutable identities.
func AuthorizeCompatibleBatch(ctx context.Context, authorizer Authorizer, jobs []Job) ([]AuthorizationSnapshot, error) {
	if authorizer == nil || ValidateBatchMembers(jobs) != nil {
		return nil, ErrInvalid
	}
	snapshot, err := authorizer.Authorize(ctx, jobs[0])
	if err != nil {
		return nil, err
	}
	evidence := make([]AuthorizationSnapshot, len(jobs))
	for i, job := range jobs {
		evidence[i] = snapshot
		evidence[i].JobID, evidence[i].Fence, evidence[i].Attempt = job.ID, job.Fence, job.Attempt+1
	}
	return evidence, nil
}
