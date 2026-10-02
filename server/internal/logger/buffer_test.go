package logger

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestBufferRetainsLastTenThousandJSONRecords(t *testing.T) {
	buffer := new(Buffer)
	now := time.Now()
	for i := 0; i < bufferCapacity+2; i++ {
		buffer.append(now, "cao:server", fmt.Sprintf("line %d\nquoted \"value\"", i))
	}
	lines := buffer.Snapshot()
	if len(lines) != bufferCapacity {
		t.Fatalf("got %d lines, want %d", len(lines), bufferCapacity)
	}
	for index, want := range []string{"line 2\nquoted \"value\"", "line 3\nquoted \"value\""} {
		var record struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(lines[index], &record); err != nil || record.Message != want {
			t.Fatalf("record %d: %s (%v)", index, lines[index], err)
		}
	}
	encoded, err := json.Marshal(lines)
	if err != nil {
		t.Fatal(err)
	}
	var records []struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(encoded, &records); err != nil {
		t.Fatal(err)
	}
	if len(records) != bufferCapacity || records[0].Message != "line 2\nquoted \"value\"" ||
		records[len(records)-1].Message != fmt.Sprintf("line %d\nquoted \"value\"", bufferCapacity+1) {
		t.Fatal("snapshot did not encode as an ordered JSON array")
	}
}

func TestBufferBoundsMessageSize(t *testing.T) {
	buffer := new(Buffer)
	buffer.append(time.Now(), "cao:server", fmt.Sprintf("%0*d", maxMessageBytes+1, 1))
	var record struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(buffer.Snapshot()[0], &record); err != nil || len(record.Message) != maxMessageBytes {
		t.Fatalf("message length = %d, error = %v", len(record.Message), err)
	}
}
