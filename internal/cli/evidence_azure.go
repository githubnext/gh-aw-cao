package cli

import (
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"
)

type evidenceAzureImage struct {
	Target                     string `json:"target"`
	Digest                     string `json:"digest"`
	ReferenceSHA256            string `json:"referenceSHA256"`
	ConfiguredReferenceMatches bool   `json:"configuredReferenceMatches"`
	Scan                       string `json:"scan"`
	SBOM                       string `json:"sbom"`
	Provenance                 string `json:"provenance"`
}

type evidenceDeployment struct {
	evidenceState
	Attribution             string                    `json:"attribution,omitempty"`
	ReceiptSHA256           string                    `json:"receiptSHA256,omitempty"`
	SourceRevision          string                    `json:"sourceRevision,omitempty"`
	SourceWorktree          string                    `json:"sourceWorktree,omitempty"`
	ContextSHA256           string                    `json:"contextSHA256,omitempty"`
	PlanSHA256              string                    `json:"planSHA256,omitempty"`
	Environment             string                    `json:"environment,omitempty"`
	ImageAssurance          string                    `json:"imageAssurance,omitempty"`
	StartedAt               string                    `json:"startedAt,omitempty"`
	CompletedAt             string                    `json:"completedAt,omitempty"`
	Images                  []evidenceAzureImage      `json:"images,omitempty"`
	Verification            []deployAzureVerification `json:"verification,omitempty"`
	VerificationComplete    bool                      `json:"verificationComplete"`
	RunningImageMeasurement string                    `json:"runningImageMeasurement,omitempty"`
	IndependentVerification string                    `json:"independentVerification,omitempty"`
}

func summarizeEvidenceAzure(content []byte, revision string) (evidenceDeployment, error) {
	var receipt deployAzureReceipt
	if json.Unmarshal(content, &receipt) != nil {
		return evidenceDeployment{}, errors.New("selected Azure receipt is not valid JSON")
	}
	started, startErr := time.Parse(time.RFC3339Nano, receipt.StartedAt)
	completed, completeErr := time.Parse(time.RFC3339Nano, receipt.CompletedAt)
	if receipt.Kind != "cao.deploy.azure.receipt" || receipt.SchemaVersion != 1 ||
		receipt.SourceRevision != revision || !evidenceRevisionPattern.MatchString(receipt.SourceRevision) ||
		receipt.Environment != "development" || receipt.ImageAssurance != "not-evaluated-development-only" ||
		!slices.Contains([]string{"clean", "dirty"}, receipt.SourceWorktree) ||
		!evidenceHashPattern.MatchString(receipt.ContextSHA256) || !evidenceHashPattern.MatchString(receipt.PlanSHA256) ||
		startErr != nil || completeErr != nil || !evidenceTimestamp(receipt.StartedAt) || !evidenceTimestamp(receipt.CompletedAt) ||
		completed.Before(started) || len(receipt.Images) < 2 || len(receipt.Images) > 3 {
		return evidenceDeployment{}, errors.New("invalid or mismatched Azure development receipt")
	}
	targets := map[string]bool{}
	images := make([]evidenceAzureImage, 0, len(receipt.Images))
	referencePattern := regexp.MustCompile(`^[a-z0-9]+\.azurecr\.io/[a-z0-9][a-z0-9_.-]*@sha256:[0-9a-f]{64}$`)
	for _, image := range receipt.Images {
		if !slices.Contains([]string{"azure-functions-runtime", "azure-ingest-runtime", "azure-empty-ingest-runtime", "azure-db-provision"}, image.Target) ||
			targets[image.Target] || !evidenceDigestPattern.MatchString(image.Digest) || !referencePattern.MatchString(image.Reference) ||
			!strings.HasSuffix(image.Reference, "@"+image.Digest) || image.ConfiguredReference != image.Reference ||
			image.Scan != "not-performed" || image.SBOM != "not-generated" || image.Provenance != "local-context-not-attested" {
			return evidenceDeployment{}, errors.New("invalid Azure image identity or assurance")
		}
		targets[image.Target] = true
		images = append(images, evidenceAzureImage{
			Target: image.Target, Digest: image.Digest, ReferenceSHA256: evidenceSHA256([]byte(image.Reference)),
			ConfiguredReferenceMatches: true, Scan: image.Scan, SBOM: image.SBOM, Provenance: image.Provenance,
		})
	}
	if !targets["azure-functions-runtime"] || targets["azure-ingest-runtime"] == targets["azure-empty-ingest-runtime"] {
		return evidenceDeployment{}, errors.New("missing or conflicting Azure image target")
	}
	expected := map[string]int{
		"health": 200, "readiness": 200, "signed-out-campaigns": 401,
		"root-login": 302, "github-oauth": 302, "scm-denied": 403,
	}
	if len(receipt.Verification) > len(expected) {
		return evidenceDeployment{}, errors.New("invalid Azure verification inventory")
	}
	seen := map[string]bool{}
	for _, check := range receipt.Verification {
		status, ok := expected[check.Check]
		if !ok || seen[check.Check] || check.Status < 100 || check.Status > 599 ||
			!evidenceTimestamp(check.CheckedAt) || check.Passed && check.Status != status {
			return evidenceDeployment{}, errors.New("invalid Azure verification check")
		}
		seen[check.Check] = true
	}
	return evidenceDeployment{
		evidenceState: evidenceState{Status: "reported"}, Attribution: "owner-supplied-local-receipt",
		ReceiptSHA256: evidenceSHA256(content), SourceRevision: revision, SourceWorktree: receipt.SourceWorktree,
		ContextSHA256: receipt.ContextSHA256, PlanSHA256: receipt.PlanSHA256,
		Environment: "development", ImageAssurance: receipt.ImageAssurance,
		StartedAt: receipt.StartedAt, CompletedAt: receipt.CompletedAt, Images: images,
		Verification: receipt.Verification, VerificationComplete: len(seen) == len(expected),
		RunningImageMeasurement: "unknown", IndependentVerification: "unknown",
	}, nil
}
