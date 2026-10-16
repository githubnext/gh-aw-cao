package operational

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCLICommandValidation(t *testing.T) {
	for _, options := range []CLICommandQueueOptions{
		{MaxConcurrency: 33}, {MaxJobs: -1}, {MaxChunkBytes: 16385},
		{RetentionDays: 6}, {Timeout: time.Hour},
	} {
		if _, err := options.Resolve(); !errors.Is(err, ErrCLICommandInput) {
			t.Fatalf("invalid limits accepted: %+v %v", options, err)
		}
	}
	options, err := (CLICommandQueueOptions{}).Resolve()
	if err != nil || options.MaxConcurrency != 4 || options.Timeout != 15*time.Minute || options.RetentionDays != 30 {
		t.Fatalf("defaults: %+v %v", options, err)
	}
	for _, text := range []string{"ghp_example", "Bearer example", "password=example", "hello\x00world", "\xff"} {
		if err := ValidateCLICommandText(text); !errors.Is(err, ErrCLICommandInput) {
			t.Fatalf("unsafe input accepted")
		}
	}
	for _, invocation := range []CLICommandInvocation{
		{ActionID: "compile", Command: "gh aw compile", Values: map[string]string{"access-token": "value"}},
		{ActionID: "compile", Command: "gh aw compile", Input: new(strings.Repeat("x", 100001))},
		{ActionID: "compile", Command: "gh aw compile --token value"},
		{ActionID: "compile", Command: "gh aw compile", Values: map[string]string{"value": "\x00"}},
	} {
		if _, err := invocation.Encode(options.MaxInputBytes); !errors.Is(err, ErrCLICommandInput) {
			t.Fatalf("unsafe invocation accepted")
		}
	}
	if _, err := (CLICommandInvocation{ActionID: "compile", Command: "gh aw compile"}).Encode(1); !errors.Is(err, ErrCLICommandInput) {
		t.Fatalf("payload budget: %v", err)
	}
	for _, filter := range []CLICommandFilter{{Limit: 0}, {Limit: 501}, {Limit: 1, Offset: -1}, {Limit: 1, Statuses: []CLICommandStatus{"unknown"}}} {
		if err := filter.Validate(); !errors.Is(err, ErrCLICommandInput) {
			t.Fatalf("invalid filter accepted: %v", err)
		}
	}
	for _, key := range []string{"contains spaces", "ghp_example", strings.Repeat("k", 129)} {
		if err := ValidateCLICommandKey(key); !errors.Is(err, ErrCLICommandInput) {
			t.Fatalf("invalid idempotency accepted")
		}
	}
}

func TestCLICommandsRequireDurability(t *testing.T) {
	for _, required := range []bool{true, false} {
		f := serviceFeature{name: "cli commands", cap: Capability{Scope: ScopeProcess}, present: true, required: required}
		if got := classifyFeatureRejection(f, Requirements{SingleProcess: true, AllowVolatile: true}); got != featureRejectionStageInvalidGuarantees {
			t.Fatalf("volatile commands accepted: %s", got)
		}
	}
	if got := classifyFeatureRejection(serviceFeature{name: "cli commands", required: true}, Requirements{}); got != featureRejectionStageUnsupported {
		t.Fatalf("unsupported commands accepted: %s", got)
	}
}
