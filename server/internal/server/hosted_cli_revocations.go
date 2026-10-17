package server

import (
	"errors"
	"os"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/hostedcli"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

const hostedCLIRevocationNamespace = "hosted-cli-tokens-v1"

func hostedCLIRevocationsFromEnv(queue operational.RevocationQueue) (*hostedcli.Revocations, error) {
	if queue == nil {
		return nil, errors.New("hosted CLI execution requires durable token revocations")
	}
	if _, ok := queue.(operational.RevocationTransitions); !ok {
		return nil, errors.New("hosted CLI execution requires atomic token lifecycle audit transitions")
	}
	current, previous := os.Getenv("CAO_SESSION_SECRET"), os.Getenv("CAO_SESSION_SECRET_PREVIOUS")
	if len(strings.TrimSpace(current)) < 32 || (previous != "" && len(strings.TrimSpace(previous)) < 32) {
		return nil, errors.New("hosted CLI execution requires CAO_SESSION_SECRET and any CAO_SESSION_SECRET_PREVIOUS to contain at least 32 characters")
	}
	// Reuse the authenticated session envelope and current/previous key
	// handling, but keep these records out of the OAuth revocation namespace.
	codec := newGitHubOAuth(GitHubOAuthConfig{SessionSecret: current, PreviousSessionSecret: previous}, nil, nil, nil)
	return hostedcli.NewRevocations(queue, hostedCLIRevocationNamespace, codec.seal, codec.open), nil
}
