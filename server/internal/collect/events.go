package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

var eventsLog = logger.New("cao:collect:events")

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
	trimmedEvent := strings.TrimSpace(event)
	var intent Intent
	var err error
	switch trimmedEvent {
	case "workflow_run":
		intent, err = parseWorkflowRunEvent(envelope)
	case "installation":
		intent = parseInstallationEvent(envelope)
	case "installation_repositories":
		intent = parseInstallationRepositoriesEvent(envelope)
	default:
		intent = Intent{Kind: IntentIgnore}
	}
	if err != nil {
		return Intent{}, err
	}
	// One classification per delivery is a meaningful state transition worth
	// observing, and this is never called from a polling or retry loop, so
	// logging every delivery cannot flood the log.
	eventsLog.Printf("classified webhook event=%s kind=%s", trimmedEvent, intent.Kind)
	return intent, nil
}

// parseWorkflowRunEvent maps a "workflow_run" delivery to a collection intent.
// It is a pure function so this classification's edge cases (an
// action other than "completed", a missing repository) are testable without
// constructing a full webhook payload.
func parseWorkflowRunEvent(envelope webhookEnvelope) (Intent, error) {
	if envelope.Action != "completed" {
		return Intent{Kind: IntentIgnore}, nil
	}
	if envelope.Repository.FullName == "" {
		return Intent{}, errors.New("workflow_run payload is missing a repository")
	}
	return Intent{
		Kind:           IntentCollect,
		Repository:     envelope.Repository.FullName,
		InstallationID: envelope.Installation.ID,
		Reason:         "workflow_run",
	}, nil
}

// parseInstallationEvent maps an "installation" delivery to an enrollment or
// removal intent. It is a pure function so this classification's action
// dispatch is testable independently of json decoding.
func parseInstallationEvent(envelope webhookEnvelope) Intent {
	installationID := envelope.Installation.ID
	switch envelope.Action {
	case "created", "new_permissions_accepted", "unsuspend":
		return Intent{
			Kind:           IntentEnroll,
			Repositories:   names(envelope.Repositories),
			InstallationID: installationID,
			Reason:         "installation." + envelope.Action,
		}
	case "deleted", "suspend":
		return Intent{
			Kind:           IntentRemoveInstallation,
			InstallationID: installationID,
			Reason:         "installation." + envelope.Action,
		}
	default:
		return Intent{Kind: IntentIgnore}
	}
}

// parseInstallationRepositoriesEvent maps an "installation_repositories"
// delivery to an enrollment or unenrollment intent. It is a pure function so
// this classification's action dispatch is testable independently of json
// decoding.
func parseInstallationRepositoriesEvent(envelope webhookEnvelope) Intent {
	installationID := envelope.Installation.ID
	switch envelope.Action {
	case "added":
		return Intent{
			Kind:           IntentEnroll,
			Repositories:   names(envelope.RepositoriesAdded),
			InstallationID: installationID,
			Reason:         "installation_repositories.added",
		}
	case "removed":
		return Intent{
			Kind:           IntentUnenroll,
			Repositories:   names(envelope.RepositoriesRemoved),
			InstallationID: installationID,
			Reason:         "installation_repositories.removed",
		}
	default:
		return Intent{Kind: IntentIgnore}
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

var ErrDeliveryInProgress = errors.New("webhook delivery admission is already in progress")

// Admitter applies an intent: it updates enrollment or enqueues collection.
// It performs no projection, takes no global lease, and never blocks one
// repository behind another.
type Admitter struct {
	Enrollment Enrollment
	Queue      Queue
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
	Kind      IntentKind `json:"kind"`
	Enqueued  bool       `json:"enqueued"`
	Duplicate bool       `json:"duplicate,omitempty"`
	// ErasureQueued counts repositories with durable erasure work because they
	// left ingestion scope.
	ErasureQueued int `json:"erasureQueued,omitempty"`
}

// Admit applies one verified delivery.
func (a Admitter) Admit(ctx context.Context, event string, payload []byte) (Admission, error) {
	intent, err := ParseEvent(event, payload)
	if err != nil {
		return Admission{}, err
	}
	return a.admitIntent(ctx, intent)
}

// AdmitDelivery commits delivery deduplication with durable admission. Queue
// append, repository debounce, and delivery identity are one Redis operation.
func (a Admitter) AdmitDelivery(
	ctx context.Context,
	event string,
	payload []byte,
	delivery string,
	deliveryTTL time.Duration,
) (Admission, error) {
	intent, err := ParseEvent(event, payload)
	if err != nil {
		return Admission{}, err
	}
	if intent.Kind != IntentCollect {
		reservation, err := a.Queue.Store.ReserveDelivery(ctx, delivery, 30*time.Second)
		if err != nil {
			return Admission{}, err
		}
		switch reservation {
		case redisx.DeliveryAlreadyCommitted:
			return Admission{Kind: intent.Kind, Duplicate: true}, nil
		case redisx.DeliveryReserved:
		case redisx.DeliveryInProgress:
			return Admission{}, ErrDeliveryInProgress
		}
		defer func() {
			release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
			defer cancel()
			_ = a.Queue.Store.ReleaseDeliveryReservation(release, delivery)
		}()
		admission, err := a.admitIntent(ctx, intent)
		if err != nil {
			return Admission{}, err
		}
		fresh, err := a.Queue.Store.RememberDelivery(ctx, delivery, deliveryTTL)
		if err != nil {
			return Admission{}, err
		}
		admission.Duplicate = !fresh
		return admission, nil
	}
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
	enqueued, duplicate, err := a.Queue.EnqueueDelivery(ctx, Task{
		Repository:     intent.Repository,
		InstallationID: installationID,
		Reason:         intent.Reason,
	}, delivery, deliveryTTL)
	if err != nil {
		return Admission{}, err
	}
	return Admission{Kind: IntentCollect, Enqueued: enqueued, Duplicate: duplicate}, nil
}

func (a Admitter) queueErasures(ctx context.Context, installationID int64, repositories []string) error {
	for _, repository := range repositories {
		if _, err := a.Queue.Enqueue(ctx, Task{
			Repository:     repository,
			InstallationID: installationID,
			Reason:         "scope-withdrawn",
			Erase:          true,
		}); err != nil {
			return err
		}
	}
	return nil
}

func (a Admitter) admitIntent(ctx context.Context, intent Intent) (Admission, error) {
	switch intent.Kind {
	case IntentIgnore:
		return Admission{Kind: IntentIgnore}, nil
	case IntentEnroll:
		if err := a.Enrollment.AddRepositories(ctx, intent.InstallationID, intent.Repositories); err != nil {
			return Admission{}, err
		}
		return Admission{Kind: IntentEnroll}, nil
	case IntentUnenroll:
		removed, err := a.Enrollment.RemoveRepositoriesBefore(
			ctx, intent.InstallationID, intent.Repositories,
			func(ctx context.Context, repositories []string) error {
				return a.queueErasures(ctx, intent.InstallationID, repositories)
			},
		)
		if err != nil {
			return Admission{}, err
		}
		erased, err := a.erase(ctx, removed)
		if err != nil {
			return Admission{}, err
		}
		return Admission{Kind: IntentUnenroll, ErasureQueued: erased}, nil
	case IntentRemoveInstallation:
		removed, err := a.Enrollment.RemoveInstallationBefore(
			ctx, intent.InstallationID,
			func(ctx context.Context, repositories []string) error {
				return a.queueErasures(ctx, intent.InstallationID, repositories)
			},
		)
		if err != nil {
			return Admission{}, err
		}
		erased, err := a.erase(ctx, removed)
		if err != nil {
			return Admission{}, err
		}
		return Admission{Kind: IntentRemoveInstallation, ErasureQueued: erased}, nil
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

// erase requests projection after durable erasure work has been queued.
func (a Admitter) erase(ctx context.Context, repositories []string) (int, error) {
	if len(repositories) == 0 {
		return 0, nil
	}
	if a.Projection != nil {
		if err := a.Projection.RequestProjection(ctx); err != nil {
			return 0, err
		}
	}
	return len(repositories), nil
}
