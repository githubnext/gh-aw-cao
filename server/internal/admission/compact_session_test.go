package admission

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCompactSessionVocabularyAndScalars(t *testing.T) {
	for kind, fields := range compactFields {
		t.Run(kind, func(t *testing.T) {
			data := map[string]any{}
			for _, field := range fields {
				data[field] = "metadata"
			}
			if kind == "session.result" || kind == "usage.report" || kind == "firewall.token_usage" {
				usage := map[string]any{}
				for _, field := range compactUsageFields {
					usage[field] = 1
				}
				data["usage"] = usage
			}
			if kind == "grader.result" {
				data["run"] = map[string]any{"id": "one", "attempt": 1, "graderCount": 2, "passed": 1, "failed": 0, "errors": 1}
			}
			event := map[string]any{"type": kind, "data": data, "timestamp": 1234,
				"provenance": map[string]any{"component": "agent", "phase": "conclusion", "path": "usage/file", "index": 0},
			}
			line, _ := json.Marshal(event)
			if !validCompactEvent(line) {
				t.Fatal("published metadata vocabulary rejected")
			}
			data["arguments"] = "PRIVATE"
			line, _ = json.Marshal(event)
			if validCompactEvent(line) {
				t.Fatal("unbounded field survived compact validation")
			}
		})
	}
	for _, value := range []string{
		`{"type":"assistant.message","data":{}}`,
		`{"type":"tool.call","data":{}}`,
		`{"type":"session.result","data":{"errors":[]}}`,
		`{"type":"workflow.info","data":{"awContext":{}}}`,
		`{"type":"session.format","data":{"version":null}}`,
		`{"type":"session.format","data":{"version":[]}}`,
		`{"type":"session.format","data":{"version":{}}}`,
		`{"type":"session.format","data":{"version":1e400}}`,
		`{"type":"session.format","data":null}`,
		`{"type":"session.format","data":[]}`,
		`{"type":"session.format","data":{},"native":{}}`,
		`{"type":"session.format","data":{},"timestamp":null}`,
		`{"type":"session.format","data":{},"provenance":{"private":"x"}}`,
		`{"type":"session.format","data":{},"provenance":null}`,
		`{"type":"session.result","data":{"usage":{"private":1}}}`,
		`{"type":"session.result","data":{"usage":{"totalTokens":[]}}}`,
		`{"type":"session.result","data":{"usage":{"totalTokens":null}}}`,
		`{"type":"grader.result","data":{"run":{"errors":[]}}}`,
		`{"type":"grader.result","data":{"run":{"private":1}}}`,
		`{"type":"session.format","data":{"usage":{}}}`,
		`{"type":"session.format","data":{"version":1,"version":2}}`,
		`{"type":"session.format","data":{"version":"\ud800"}}`,
		`{"type":"session.format","data":{"version":"` + strings.Repeat("a", 257) + `"}}`,
		`{"type":"session.format","data":{"version":"` + strings.Repeat("😀", 65) + `"}}`,
		`null`, `[]`, `{}`, `false`,
	} {
		if validCompactEvent([]byte(value)) {
			t.Fatal("out-of-profile compact data accepted")
		}
	}
	for _, value := range []string{
		`true`, `false`, `0`, `-1`, `1.25`, `1e10`, `1.7976931348623157e308`,
		`"\ud83d\ude00"`, `""`, `"` + strings.Repeat("😀", 64) + `"`,
	} {
		if !validCompactEvent(fmt.Appendf(nil, `{"type":"session.format","data":{"version":%s}}`, value)) {
			t.Fatal("eligible compact scalar rejected")
		}
	}
	f := newFixture(t)
	input := conclusionInput(f)
	const prefix = `{"type":"session.format","data":{}}`
	input.Session = prefix + strings.Repeat(" ", MaxSessionBytes-len(prefix)-1) + "\n"
	if len(input.Session) != MaxSessionBytes {
		t.Fatalf("incorrect byte boundary fixture: %d", len(input.Session))
	}
	body, _ := json.Marshal(input)
	if _, err := decodeConclusion(body); err != nil {
		t.Fatal("16 KiB compact byte boundary rejected")
	}
}
