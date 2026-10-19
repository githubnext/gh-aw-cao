package localops

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	copilot "github.com/github/copilot-sdk/go"
)

func TestNativeEnhancementCondensesOverBudgetInputWithoutTools(t *testing.T) {
	s := service(t, func(o *Options) { o.Canvas = true })
	oversized := strings.Repeat("z", 512)
	request := map[string]any{"intent": "Condense this intent", "subject": oversized, "acceptance": "Use native conclusions"}
	var stopped atomic.Int64
	var config *copilot.SessionConfig
	session := &fakeAuthorSession{send: func(_ context.Context, message copilot.MessageOptions) (*copilot.SessionEvent, error) {
		if !strings.Contains(message.Prompt, oversized) {
			t.Error("SDK did not receive the full over-budget context to condense")
		}
		return authorReply(`{"intent":"Find failures","subject":"Workflow runs","objective":"Prioritize investigation","acceptance":"Use native conclusions"}`), nil
	}}
	s.options.NewAuthoringClient = func(AuthoringClientOptions) AuthoringClient {
		return &fakeAuthorClient{session: session, stopped: &stopped, config: &config}
	}
	result := call(t, s, "query.enhance", request)
	if result["subject"] != "Workflow runs" || config.AvailableTools == nil || len(config.AvailableTools) != 0 || len(config.Tools) != 0 || len(config.MCPServers) != 0 || stopped.Load() != 1 {
		t.Fatal("native enhancement did not preserve condensation and no-tools contracts")
	}
	session.send = func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) {
		return authorReply(`{"intent":"Find failures","subject":"` + oversized + `","objective":"Prioritize","acceptance":"Evidence"}`), nil
	}
	statusError(t, s.Call(t.Context(), "query.enhance", request, nil), 503)
	if stopped.Load() != 2 {
		t.Fatal("invalid enhancement output leaked an SDK session")
	}
}
