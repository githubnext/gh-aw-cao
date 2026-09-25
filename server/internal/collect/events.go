package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// IntentKind classifies what an admitted webhook asks the collector to do.
type IntentKind string

const (
	// IntentCollect requests collection of one repository.
	IntentCollect IntentKind = "collect"
	// IntentEnroll adds repositories to the enrollment set.
	IntentEnroll IntentKind = "enroll"
	// IntentUnenroll removes repositories from the enrollment set.
	IntentUnenroll IntentKind = "unenroll"
	// IntentRemoveInstallation removes an installation and all its
	// repositories.
	IntentRemoveInstallation IntentKind = "remove-installation"
	// IntentIgnore is an event the collector does not act on.
	IntentIgnore IntentKind = "ignore"
)

// Intent is the admitted meaning of one webhook delivery.
type Intent struct {
	Kind           IntentKind
	Repository     string
	Repositories   []string
	InstallationID int64
	Reason         string
}

type webhookEnvelope struct {
	Action       string `json:"action"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	WorkflowRun struct {
		Status     string `json:"status"`
		Conclusion string `json:"conclusion"`
	} `json:"workflow_run"`
	Repositories []struct {
		FullName string `json:"full_name"`
	} `json:"repositories"`
	RepositoriesAdded []struct {
		FullName string `json:"full_name"`
	} `json:"repositories_added"`
	RepositoriesRemoved []struct {
		FullName string `json:"full_name"`
	} `json:"repositories_removed"`
}

// ParseEvent maps a verified webhook delivery to a collector intent.
//
// Parsing never infers enrollment: it reports what the payload says, and
// admission decides whether that repository is in scope.
func ParseEvent(event string, payload []byte) (Intent, error) {
	var envelope webhookEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return Intent{}, fmt.Errorf("parse webhook payload: %w", err)
	}
	installationID := envelope.Installation.ID
	switch strings.TrimSpace(event) {
	case "workflow_run":
		if envelope.Action != "completed" {
			return Intent{Kind: IntentIgnore}, nil
		}
		if envelope.Repository.FullName == "" {
			return Intent{}, errors.New("workflow_run payload is missing a repository")
		}
		return Intent{
			Kind:           IntentCollect,
			Repository:     envelope.Repository.FullName,
			InstallationID: installationID,
			Reason:         "workflow_run",
		}, nil
	case "installation":
		switch envelope.Action {
		case "created", "new_permissions_accepted", "unsuspend":
			return Intent{
				Kind:           IntentEnroll,
				Repositories:   names(envelope.Repositories),
				InstallationID: installationID,
				Reason:         "installation." + envelope.Action,
			}, nil
		case "deleted", "suspend":
			return Intent{
				Kind:           IntentRemoveInstallation,
				InstallationID: installationID,
				Reason:         "installation." + envelope.Action,
			}, nil
		default:
			return Intent{Kind: IntentIgnore}, nil
		}
	case "installation_repositories":
		switch envelope.Action {
		case "added":
			return Intent{
				Kind:           IntentEnroll,
				Repositories:   names(envelope.RepositoriesAdded),
				InstallationID: installationID,
				Reason:         "installation_repositories.added",
			}, nil
		case "removed":
			return Intent{
				Kind:           IntentUnenroll,
				Repositories:   names(envelope.RepositoriesRemoved),
				InstallationID: installationID,
				Reason:         "installation_repositories.removed",
			}, nil
		default:
			return Intent{Kind: IntentIgnore}, nil
		}
	default:
		return Intent{Kind: IntentIgnore}, nil
	}
}

func names(entries []struct {
	FullName string `json:"full_name"`
}) []string {
	values := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.FullName != "" {
			values = append(values, entry.FullName)
		}
	}
	return values
}

// ErrNotEnrolled reports a delivery for a repository outside ingestion scope.
var ErrNotEnrolled = errors.New("repository is not enrolled")

// Admitter applies an intent: it updates enrollment or enqueues collection.
// It performs no projection, takes no global lease, and never blocks one
// repository behind another.
type Admitter struct {
	Enrollment Enrollment
	Queue      Queue
	// Lake, when set, has un-enrolled repositories' retained evidence erased
	// from it. Leaving it unset keeps evidence after consent is withdrawn, so
	// deployments that retain evidence must do so deliberately.
	Lake *Lake
	// Projection requests a projection after erasure, so the canonical
	// database stops reporting repositories that left ingestion scope.
	Projection ProjectionRequester
}

// ProjectionRequester marks the lake as changed. Projector satisfies it.
type ProjectionRequester interface {
	RequestProjection(ctx context.Context) error
}

// Admission describes what a delivery did, for the webhook response.
type Admission struct {
	Kind     IntentKind `json:"kind"`
	Enqueued bool       `json:"enqueued"`
	// Erased counts repositories whose retained evidence was deleted because
	// they left ingestion scope.
	Erased int `json:"erased,omitempty"`
}

// Admit applies one verified delivery.
func (a Admitter) Admit(ctx context.Context, event string, payload []byte) (Admission, error) {
	intent, err := ParseEvent(event, payload)
	if err != nil {
		return Admission{}, err
	}
	switch intent.Kind {
	case IntentIgnore:
		return Admission{Kind: IntentIgnore}, nil
	case IntentEnroll:
		if err := a.Enrollment.AddRepositories(ctx, intent.InstallationID, intent.Repositories); err != nil {
			return Admission{}, err
		}
		return Admission{Kind: IntentEnroll}, nil
	case IntentUnenroll:
		removed, err := a.Enrollment.RemoveRepositories(ctx, intent.InstallationID, intent.Repositories)
		if err != nil {
			return Admission{}, err
		}
		erased, err := a.erase(ctx, removed)
		if err != nil {
			return Admission{}, err
		}
		return Admission{Kind: IntentUnenroll, Erased: erased}, nil
	case IntentRemoveInstallation:
		removed, err := a.Enrollment.RemoveInstallation(ctx, intent.InstallationID)
		if err != nil {
			return Admission{}, err
		}
		erased, err := a.erase(ctx, removed)
		if err != nil {
			return Admission{}, err
		}
		return Admission{Kind: IntentRemoveInstallation, Erased: erased}, nil
	case IntentCollect:
		enrolled, err := a.Enrollment.Enrolled(ctx, intent.Repository)
		if err != nil {
			return Admission{}, err
		}
		if !enrolled {
			return Admission{}, ErrNotEnrolled
		}
		installationID := intent.InstallationID
		if installationID == 0 {
			installationID, err = a.Enrollment.InstallationFor(ctx, intent.Repository)
			if err != nil {
				return Admission{}, err
			}
		}
		if installationID == 0 {
			return Admission{}, ErrNotEnrolled
		}
		enqueued, err := a.Queue.Enqueue(ctx, Task{
			Repository:     intent.Repository,
			InstallationID: installationID,
			Reason:         intent.Reason,
		})
		if err != nil {
			return Admission{}, err
		}
		return Admission{Kind: IntentCollect, Enqueued: enqueued}, nil
	default:
		return Admission{Kind: IntentIgnore}, nil
	}
}

// erase deletes retained evidence for repositories that left ingestion scope
// and requests a projection so the canonical database drops their rows.
//
// Erasure is best-effort per repository but never silent: the first failure is
// returned so the delivery is retried rather than reported as complete.
func (a Admitter) erase(ctx context.Context, repositories []string) (int, error) {
	if len(repositories) == 0 {
		return 0, nil
	}
	erased := 0
	for _, repository := range repositories {
		if a.Lake == nil {
			// An admission-only process holds no evidence lake, so erasure is
			// queued for a worker that does rather than skipped.
			if _, err := a.Queue.Enqueue(ctx, Task{
				Repository: repository,
				Reason:     "scope-withdrawn",
				Erase:      true,
			}); err != nil {
				return erased, err
			}
			erased++
			continue
		}
		if err := a.Lake.Forget(repository); err != nil {
			return erased, err
		}
		erased++
	}
	if a.Projection != nil {
		if err := a.Projection.RequestProjection(ctx); err != nil {
			return erased, err
		}
	}
	return erased, nil
}
