package localops

import (
	"context"
	"strings"
	"testing"
)

func TestGeneratedCandidateCanBeRepairedUsingPriorDocumentAndFeedback(t *testing.T) {
	requests := 0
	s := service(t, func(o *Options) {
		o.Canvas = true
		o.Author = func(_ context.Context, operation string, payload map[string]any) (any, error) {
			requests++
			if operation != "query.generate" {
				t.Error(operation)
			}
			if requests == 1 {
				return map[string]any{"document": "{}"}, nil
			}
			if payload["document"] != "{}" || payload["feedback"] != "dashboard identity is required" {
				t.Error("repair feedback was not preserved", payload)
			}
			return map[string]any{"document": previewDocument}, nil
		}
	})
	intent := map[string]any{"intent": "List workflow runs", "subject": "Workflow runs", "acceptance": "Use canonical evidence"}
	first := call(t, s, "query.generate", intent)
	if first["document"] != "{}" {
		t.Fatal(first)
	}
	statusError(t, s.Call(t.Context(), "views.save", first, nil), 400)
	if actionByID(s.dashboard(), "complete") == nil {
		t.Fatal("candidate replaced the declared dashboard")
	}
	intent["document"] = first["document"]
	intent["feedback"] = "dashboard identity is required"
	second := call(t, s, "query.generate", intent)
	if second["document"] != previewDocument || requests != 2 {
		t.Fatal(second, requests)
	}
	call(t, s, "views.save", second)
	for _, value := range []any{42, nil, "", strings.Repeat("x", 131073)} {
		s.options.Author = func(context.Context, string, map[string]any) (any, error) {
			return map[string]any{"document": value}, nil
		}
		statusError(t, s.Call(t.Context(), "query.generate", intent, nil), 503)
	}
}
