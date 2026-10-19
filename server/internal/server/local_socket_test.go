package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestLocalSocketBrowserTraceIsBoundedAndReadOnly(t *testing.T) {
	local, server := localTestServer(t)
	notifications := make(chan map[string]any, 1)
	local.config.OnBrowserTrace = func(event map[string]any) { notifications <- event }
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(ctx,
		strings.Replace(server.URL, "http:", "ws:", 1)+local.config.Prefix+"/__dashboard_socket",
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{server.URL}}})
	if response != nil && response.Body != nil {
		defer func() { _ = response.Body.Close() }()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.CloseNow() }()
	content := []byte(`{"type":"browser.trace","traceId":"render-1","event":"preview.render.failed","details":{"pageCount":2,"recovered":true,"activeHash":"credential-must-not-be-logged","errorLog":"` + strings.Repeat("private evidence", 50) + `"}}`)
	if err := connection.Write(ctx, websocket.MessageText, content); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-notifications:
		encoded, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "credential") || strings.Contains(string(encoded), "private evidence") ||
			!strings.Contains(string(encoded), `"recovered":true`) || event["traceId"] != "render-1" {
			t.Fatalf("unsafe or incomplete browser trace: %s", encoded)
		}
	case <-ctx.Done():
		t.Fatal("browser trace was not delivered")
	}
	local.Event(json.RawMessage(`{"event":"dashboard","dashboard":{"updated":true}}`))
	_, message, err := connection.Read(ctx)
	if err != nil || string(message) != `{"updated":true}` {
		t.Fatalf("trace disconnected dashboard updates: %q %v", message, err)
	}
	if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"execute","command":"gh aw run worker"}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := connection.Read(ctx); err == nil {
		t.Fatal("socket accepted an execution request")
	}
}
