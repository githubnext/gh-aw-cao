package cli

import (
	"strings"
)

type evidenceProvenance struct {
	evidenceState
	ReceiptSHA256          string   `json:"receiptSHA256,omitempty"`
	Invocation             string   `json:"invocation,omitempty"`
	Subject                string   `json:"subject,omitempty"`
	SourceDigestConstraint string   `json:"sourceDigestConstraint,omitempty"`
	PredicateType          string   `json:"predicateType,omitempty"`
	Command                []string `json:"command,omitempty"`
	RawReceiptRetained     bool     `json:"rawReceiptRetained"`
}

type evidenceVerifiedAttestation struct {
	VerificationResult struct {
		Statement struct {
			PredicateType string `json:"predicateType"`
			Subject       []struct {
				Name   string `json:"name"`
				Digest struct {
					SHA256 string `json:"sha256"`
				} `json:"digest"`
			} `json:"subject"`
			Predicate struct {
				RunDetails struct {
					Metadata struct {
						InvocationID string `json:"invocationId"`
					} `json:"metadata"`
				} `json:"runDetails"`
			} `json:"predicate"`
		} `json:"statement"`
	} `json:"verificationResult"`
}

func (c evidenceClient) provenance(options evidenceReleaseOptions, invocation string) evidenceProvenance {
	const predicate = "https://slsa.dev/provenance/v1"
	result := evidenceProvenance{evidenceState: evidenceUnknown("unavailable-or-invalid")}
	args := []string{
		"attestation", "verify", "oci://" + options.Image, "--repo", c.repository,
		"--signer-workflow", c.repository + "/.github/workflows/cao-package-publish.yml",
		"--source-digest", options.Revision, "--predicate-type", predicate,
		"--limit", "10", "--format", "json", "--hostname", "github.com",
	}
	var receipts []evidenceVerifiedAttestation
	raw, err := c.command(args, &receipts)
	if err != nil || len(receipts) == 0 || len(receipts) > 10 {
		return result
	}
	subject, digest, _ := strings.Cut(options.Image, "@sha256:")
	for _, receipt := range receipts {
		statement := receipt.VerificationResult.Statement
		if statement.PredicateType != predicate || statement.Predicate.RunDetails.Metadata.InvocationID != invocation {
			continue
		}
		for _, value := range statement.Subject {
			if value.Name == subject && value.Digest.SHA256 == digest {
				return evidenceProvenance{
					evidenceState: evidenceState{Status: "verified-by-gh"}, ReceiptSHA256: evidenceSHA256(raw),
					Invocation: invocation, Subject: options.Image, SourceDigestConstraint: options.Revision,
					PredicateType: predicate, Command: args,
				}
			}
		}
	}
	return result
}
