package query

import (
	"encoding/json"
	"testing"
)

func TestParseDefinitionsRejectsUnsupportedObservationWindows(t *testing.T) {
	for _, window := range []string{
		`[{"operation":"rolling","field":"count","as":"recent","frame":7}]`,
		`[]`,
		`null`,
		`[{"operation":"rolling","field":"count","as":"recent","frame":2,"alignment":"centered","order-by":[{"field":"day"}]}]`,
		`[{"operation":"change","field":"count","as":"recent","order-by":[{"field":"day"}],"mode":"rate","unit":"hour"}]`,
		`[{"operation":"rolling","field":"count","as":"recent","frame":1001,"order-by":[{"field":"day"}]}]`,
		`[{"operation":"rolling","field":"count","as":"recent","frame":2,"order-by":[{"field":"day"}],"mode":"rate"}]`,
		`[{"operation":"change","field":"count","as":"recent","order-by":[{"field":"day"}],"frame":null}]`,
		`[{"operation":"rolling","field":"count","as":"recent","frame":2,"order-by":[{"field":"day"}],"sql":"unsafe"}]`,
	} {
		t.Run(window, func(t *testing.T) {
			_, err := ParseDefinitions([]byte(`[{"name":"trend","from":"runs","window":` + window + `}]`))
			if err == nil {
				t.Fatalf("expected invalid observation window error, got %v", err)
			}
		})
	}
}

func TestParseDefinitionsAcceptsTypedWindows(t *testing.T) {
	definitions, err := ParseDefinitions([]byte(`[{"name":"trend","from":"runs","window":[
		{"operation":"rolling","field":"count","as":"recent","frame":3,"alignment":"centered","order-by":[{"field":"day"}]},
		{"operation":"change","field":"recent","as":"speed","mode":"rate","time-field":"day","unit":"day","groupby":["owner"],"order-by":[{"field":"day","direction":"desc"}]}
	]}]`))
	if err != nil || len(definitions) != 1 || len(definitions[0].Window) != 2 {
		t.Fatalf("typed window = %+v, error = %v", definitions, err)
	}
}

func TestClassifyArgumentKind(t *testing.T) {
	tests := []struct {
		name string
		raw  map[string]json.RawMessage
		want argumentKind
	}{
		{
			name: "field present",
			raw:  map[string]json.RawMessage{"field": json.RawMessage(`"conclusion"`)},
			want: argumentKindField,
		},
		{
			name: "value present",
			raw:  map[string]json.RawMessage{"value": json.RawMessage(`"failure"`)},
			want: argumentKindValue,
		},
		{
			name: "context present",
			raw:  map[string]json.RawMessage{"context": json.RawMessage(`"evaluatedAt"`)},
			want: argumentKindContext,
		},
		{
			name: "field takes priority over value and context",
			raw: map[string]json.RawMessage{
				"field":   json.RawMessage(`"conclusion"`),
				"value":   json.RawMessage(`"failure"`),
				"context": json.RawMessage(`"evaluatedAt"`),
			},
			want: argumentKindField,
		},
		{
			name: "value takes priority over context",
			raw: map[string]json.RawMessage{
				"value":   json.RawMessage(`"failure"`),
				"context": json.RawMessage(`"evaluatedAt"`),
			},
			want: argumentKindValue,
		},
		{
			name: "no recognized key is invalid",
			raw:  map[string]json.RawMessage{"other": json.RawMessage(`"x"`)},
			want: argumentKindInvalid,
		},
		{
			name: "empty object is invalid",
			raw:  map[string]json.RawMessage{},
			want: argumentKindInvalid,
		},
		{
			name: "nil map is invalid",
			raw:  nil,
			want: argumentKindInvalid,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyArgumentKind(tt.raw); got != tt.want {
				t.Errorf("classifyArgumentKind() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestArgumentUnmarshalJSON_Field(t *testing.T) {
	var argument Argument
	if err := json.Unmarshal([]byte(`{"field":"conclusion"}`), &argument); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if argument.Field == nil || *argument.Field != "conclusion" {
		t.Fatalf("Field = %v, want %q", argument.Field, "conclusion")
	}
	if argument.Value != nil || argument.Context != "" {
		t.Errorf("unexpected Value=%v Context=%q set alongside Field", argument.Value, argument.Context)
	}
}

func TestArgumentUnmarshalJSON_Value(t *testing.T) {
	var argument Argument
	if err := json.Unmarshal([]byte(`{"value":"failure"}`), &argument); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if argument.Value != "failure" {
		t.Fatalf("Value = %v, want %q", argument.Value, "failure")
	}
	if argument.Field != nil || argument.Context != "" {
		t.Errorf("unexpected Field=%v Context=%q set alongside Value", argument.Field, argument.Context)
	}
}

func TestArgumentUnmarshalJSON_Context(t *testing.T) {
	var argument Argument
	if err := json.Unmarshal([]byte(`{"context":"evaluatedAt"}`), &argument); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if argument.Context != "evaluatedAt" {
		t.Fatalf("Context = %q, want %q", argument.Context, "evaluatedAt")
	}
	if argument.Field != nil || argument.Value != nil {
		t.Errorf("unexpected Field=%v Value=%v set alongside Context", argument.Field, argument.Value)
	}
}

func TestArgumentUnmarshalJSON_MissingAllKeysReturnsError(t *testing.T) {
	var argument Argument
	err := json.Unmarshal([]byte(`{"unrecognized":"x"}`), &argument)
	if err == nil {
		t.Fatal("expected an error for an argument object with no field, value, or context key")
	}
}

func TestArgumentUnmarshalJSON_EmptyObjectReturnsError(t *testing.T) {
	var argument Argument
	if err := json.Unmarshal([]byte(`{}`), &argument); err == nil {
		t.Fatal("expected an error for an empty argument object")
	}
}

func TestArgumentUnmarshalJSON_MalformedJSONPropagatesDecodeError(t *testing.T) {
	var argument Argument
	if err := json.Unmarshal([]byte(`not-json`), &argument); err == nil {
		t.Fatal("expected a decode error for malformed JSON")
	}
}

func TestArgumentUnmarshalJSON_FieldWinsOverValueAndContext(t *testing.T) {
	var argument Argument
	if err := json.Unmarshal([]byte(`{"field":"conclusion","value":"failure","context":"evaluatedAt"}`), &argument); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if argument.Field == nil || *argument.Field != "conclusion" {
		t.Fatalf("Field = %v, want %q", argument.Field, "conclusion")
	}
}
