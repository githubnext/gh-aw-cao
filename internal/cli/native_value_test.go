package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const nativeValueTestID = "operational-value-evidence:org%2Frepo%3Adaily-review%3Aremoved-lines%3Av1"
const nativeValueTestObserved = "2026-10-20T12:00:00.000Z"

func nativeValueTestPacket() string {
	return `{"schema_version":2,"kind":"operational_value_evidence","operational_value_evidence":{
  "schemaVersion":1,"id":"` + nativeValueTestID + `","repository":"Org/Repo","workflow":"daily-review",
  "sourcePath":".github/workflows/daily-review.md","observedAt":"` + nativeValueTestObserved + `",
  "windowStart":"2026-10-01T00:00:00.000Z","windowEnd":"2026-10-20T00:00:00.000Z",
  "contractDigest":"` + strings.Repeat("a", 64) + `","facts":[
    {"fact-kind":"contract","fact-id":"contract","goal":"Reduce maintenance","acceptance":"Accepted deletion",
     "workflow-name":"Daily review","metric-id":"removed-lines","metric-name":"Removed lines","metric-unit":"lines",
     "metric-direction":"increase","metric-version":"v1","metric-formula":"accepted lines removed",
     "measurement-basis":"workflow-contribution","cadence-days":7,
     "outputs-available":false,"repository-state-available":false,"checks-available":false},
    {"fact-kind":"coverage","fact-id":"window","at":"2026-10-01T00:00:00.000Z",
     "end-at":"2026-10-20T00:00:00.000Z","coverage-status":"complete"}
  ]}}
`
}

func nativeValueTestReceipt(updated bool) string {
	return fmt.Sprintf(`{"id":%q,"revision":17,"updated":%t,"observedAt":%q}`, nativeValueTestID, updated, nativeValueTestObserved)
}

func nativeValueTestAuth(t *testing.T, bearer bool) {
	t.Helper()
	t.Setenv("CAO_SERVER_SESSION", "")
	t.Setenv("CAO_SERVER_CSRF", "")
	t.Setenv("CAO_SERVER_TOKEN", "")
	if bearer {
		t.Setenv("CAO_SERVER_TOKEN", "secret-local-token")
	} else {
		t.Setenv("CAO_SERVER_SESSION", "secret-session==")
		t.Setenv("CAO_SERVER_CSRF", "secret-csrf")
	}
}

func nativeValueTestInput(t *testing.T, content string) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "evidence.jsonl")
	if err := os.WriteFile(filename, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestNativeValuePublish(t *testing.T) {
	for _, bearer := range []bool{false, true} {
		t.Run(fmt.Sprintf("bearer=%t", bearer), func(t *testing.T) {
			nativeValueTestAuth(t, bearer)
			packet := nativeValueTestPacket()
			input := nativeValueTestInput(t, packet)
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count := requests.Add(1)
				if r.Method != http.MethodPost || r.URL.RequestURI() != "/deployment/cao/api/v1/value" {
					t.Errorf("unexpected method/route: %s %s", r.Method, r.URL)
				}
				if r.Header.Get("Content-Type") != "application/x-ndjson" || r.Header.Get("Accept") != "application/json" {
					t.Errorf("unexpected content negotiation")
				}
				if bearer {
					if r.Header.Get("Authorization") != "Bearer secret-local-token" || r.Header.Get("Cookie") != "" {
						t.Error("incorrect bearer authentication")
					}
				} else {
					cookie, err := r.Cookie("cao_session")
					if err != nil || cookie.Value != "secret-session==" || r.Header.Get("X-CSRF-Token") != "secret-csrf" || r.Header.Get("Authorization") != "" {
						t.Error("incorrect session authentication")
					}
				}
				body, err := io.ReadAll(r.Body)
				if err != nil || string(body) != packet {
					t.Error("publication did not preserve original evidence bytes")
				}
				_, _ = io.WriteString(w, nativeValueTestReceipt(count == 1))
			}))
			defer server.Close()
			for _, updated := range []bool{true, false} {
				root, stdout, stderr := testCommand(t, nil, nativeOperator(nil))
				root.SetArgs([]string{"value", "publish", "ORG/REPO", "daily-review", "--server", server.URL + "/deployment/cao/", "--input", input})
				if err := root.Execute(); err != nil {
					t.Fatal(err)
				}
				var receipt nativeValueResult
				if err := json.Unmarshal(stdout.Bytes(), &receipt); err != nil || receipt.ID != nativeValueTestID ||
					receipt.Revision != 17 || receipt.Updated != updated || receipt.ObservedAt != nativeValueTestObserved {
					t.Fatalf("incorrect success receipt: %s (%v)", stdout, err)
				}
				if stderr.Len() != 0 || strings.Contains(stdout.String(), "secret-") {
					t.Fatalf("unexpected/unsafe output: %s %s", stdout, stderr)
				}
			}
			if requests.Load() != 2 {
				t.Fatalf("unexpected automatic retries: %d", requests.Load())
			}
		})
	}
}

func TestNativeValueInputValidationBeforeNetworking(t *testing.T) {
	nativeValueTestAuth(t, false)
	packet := nativeValueTestPacket()
	tests := []struct{ name, content, repo, workflow string }{
		{"empty", "", "org/repo", "daily-review"},
		{"malformed", `{"secret-payload":`, "org/repo", "daily-review"},
		{"trailing", packet + "secret-payload", "org/repo", "daily-review"},
		{"multiple objects", packet + packet, "org/repo", "daily-review"},
		{"array", "[" + packet + "]", "org/repo", "daily-review"},
		{"null", "null", "org/repo", "daily-review"},
		{"wrong envelope schema", strings.Replace(packet, `"schema_version":2`, `"schema_version":1`, 1), "org/repo", "daily-review"},
		{"wrong packet schema", strings.Replace(packet, `"schemaVersion":1`, `"schemaVersion":2`, 1), "org/repo", "daily-review"},
		{"wrong kind", strings.Replace(packet, `"operational_value_evidence"`, `"operational_value"`, 1), "org/repo", "daily-review"},
		{"extra envelope field", strings.Replace(packet, `"schema_version":2`, `"schema_version":2,"secret-payload":true`, 1), "org/repo", "daily-review"},
		{"duplicate field", strings.Replace(packet, `"schema_version":2`, `"schema_version":1,"schema_version":2`, 1), "org/repo", "daily-review"},
		{"nested duplicate", strings.Replace(packet, `"repository":"Org/Repo"`, `"repository":"else/where","repository":"Org/Repo"`, 1), "org/repo", "daily-review"},
		{"wrong repository", packet, "another/repo", "daily-review"},
		{"wrong workflow", packet, "org/repo", "other"},
		{"workflow case", packet, "org/repo", "Daily-review"},
		{"workflow path", packet, "org/repo", ".github/workflows/daily-review.md"},
		{"invalid repository", packet, "org/*", "daily-review"},
		{"wrong source path", strings.Replace(packet, `daily-review.md`, `daily-review.lock.yml`, 1), "org/repo", "daily-review"},
		{"wrong id", strings.Replace(packet, nativeValueTestID, "secret-payload", 1), "org/repo", "daily-review"},
		{"wrong id repository", strings.Replace(packet, "org%2Frepo", "other%2Frepo", 1), "org/repo", "daily-review"},
		{"wrong id metric", strings.Replace(packet, `"metric-id":"removed-lines"`, `"metric-id":"other-metric"`, 1), "org/repo", "daily-review"},
		{"wrong id version", strings.Replace(packet, `"metric-version":"v1"`, `"metric-version":"v2"`, 1), "org/repo", "daily-review"},
		{"missing contract identity", strings.Replace(packet, `"fact-kind":"contract"`, `"fact-kind":"other"`, 1), "org/repo", "daily-review"},
		{"wrong repository parent", strings.Replace(packet, `"schemaVersion":1`, `"schemaVersion":1,"repositoryId":"secret-payload"`, 1), "org/repo", "daily-review"},
		{"wrong workflow parent", strings.Replace(packet, `"schemaVersion":1`, `"schemaVersion":1,"workflowId":"secret-payload"`, 1), "org/repo", "daily-review"},
		{"bad timestamp", strings.Replace(packet, nativeValueTestObserved, "yesterday", 1), "org/repo", "daily-review"},
		{"noncanonical timestamp", strings.Replace(packet, nativeValueTestObserved, "2026-10-20T1:00:00Z", 1), "org/repo", "daily-review"},
		{"invalid UTF8", packet + "\xff", "org/repo", "daily-review"},
		{"oversized", packet + strings.Repeat(" ", nativeValueMaxInput), "org/repo", "daily-review"},
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := nativeValueTestInput(t, test.content)
			root, stdout, stderr := testCommand(t, nil, nativeOperator(nil))
			root.SetArgs([]string{"value", "publish", test.repo, test.workflow, "--server", server.URL, "--input", input})
			err := root.Execute()
			if err == nil || strings.Contains(err.Error(), "secret-payload") || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("expected safe validation failure, got %v / %s / %s", err, stdout, stderr)
			}
		})
	}
	if requests.Load() != 0 {
		t.Fatalf("invalid input reached server: %d", requests.Load())
	}
	// The byte limit includes the envelope and trailing whitespace.
	bounded := packet + strings.Repeat(" ", nativeValueMaxInput-len(packet))
	content, err := nativeValueReadInput(nativeValueTestInput(t, bounded))
	if err != nil || len(content) != nativeValueMaxInput {
		t.Fatalf("exactly 8 MiB was not accepted: %v", err)
	}
	if _, err := nativeValuePacket(content, "org/repo", "daily-review"); err != nil {
		t.Fatalf("bounded evidence rejected: %v", err)
	}
	for _, filename := range []string{filepath.Join(t.TempDir(), "absent-secret"), t.TempDir()} {
		if _, err := nativeValueReadInput(filename); err == nil || strings.Contains(err.Error(), filename) {
			t.Fatalf("unsafe or missing file error: %v", err)
		}
	}
}

func TestNativeValueOptionalParentIdentities(t *testing.T) {
	packet := strings.Replace(nativeValueTestPacket(), `"schemaVersion":1`, `"schemaVersion":1,
		"repositoryId":"repository:org%2Frepo",
		"workflowId":"workflow:org%2Frepo%3A.github%2Fworkflows%2Fdaily-review.md"`, 1)
	if _, err := nativeValuePacket([]byte(packet), "ORG/REPO", "daily-review"); err != nil {
		t.Fatalf("correct structural parent identities rejected: %v", err)
	}
}

func TestNativeValueURLSecurity(t *testing.T) {
	tests := []struct {
		raw, want string
		local     bool
	}{
		{"https://cao.example", "https://cao.example/api/v1/value", false},
		{"https://cao.example/prefix/cao/", "https://cao.example/prefix/cao/api/v1/value", false},
		{"http://127.0.0.1:9090/cao", "http://127.0.0.1:9090/cao/api/v1/value", true},
		{"http://127.20.30.40", "http://127.20.30.40/api/v1/value", true},
		{"http://[::1]:9090", "http://[::1]:9090/api/v1/value", true},
		{"https://[::ffff:127.0.0.1]", "https://[::ffff:127.0.0.1]/api/v1/value", true},
		{"http://LOCALHOST:9090/", "http://LOCALHOST:9090/api/v1/value", true},
	}
	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			target, local, err := nativeValueEndpoint(test.raw)
			if err != nil || target.String() != test.want || local != test.local {
				t.Fatalf("endpoint = %v local=%t error=%v", target, local, err)
			}
		})
	}
	for _, raw := range []string{
		"", "/relative", "//cao.example", "http://cao.example", "http://localhost.evil.example",
		"http://localhost.", "http://127.0.0.1.evil.example", "http://2130706433", "http://127.1",
		"http://10.0.0.1", "http://[::]", "http://[::1%25zone]", "ftp://localhost",
		"https://secret-user:secret-password@cao.example", "https://cao.example/?secret-query",
		"https://cao.example/?", "https://cao.example/#secret-fragment", "https://cao.example/#",
		"https://cao.example/prefix/../other", "https://cao.example/prefix//other",
		"https://cao.example/prefix%2fother", "https://cao.example/%2e%2e/other",
		"https://cao.example/prefix\\other", "https://cao.example:0", "https://cao.example:65536",
		"https://cao.example:bad", "https://cao.example:", "https://cao.example/%ZZ",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, _, err := nativeValueEndpoint(raw); err == nil || strings.Contains(err.Error(), "secret-") {
				t.Fatalf("unsafe URL accepted or disclosed: %v", err)
			}
		})
	}
}

func TestNativeValueAuthSecurity(t *testing.T) {
	for _, test := range []struct {
		name, session, csrf, token string
		local                      bool
	}{
		{name: "missing"},
		{name: "session only", session: "secret-session"},
		{name: "csrf only", csrf: "secret-csrf"},
		{name: "combined", session: "secret-session", csrf: "secret-csrf", token: "secret-token", local: true},
		{name: "remote bearer", token: "secret-token"},
		{name: "cookie injection", session: "secret-session;other=1", csrf: "secret-csrf"},
		{name: "cookie quote", session: `"secret-session"`, csrf: "secret-csrf"},
		{name: "cookie comma", session: "secret-session,other", csrf: "secret-csrf"},
		{name: "csrf header injection", session: "secret-session", csrf: "secret-csrf\r\nX-Evil: yes"},
		{name: "token header injection", token: "secret-token\nX-Evil:yes", local: true},
		{name: "token whitespace", token: "secret-token extra", local: true},
		{name: "session whitespace", session: " secret-session", csrf: "secret-csrf"},
		{name: "nonascii", session: "secret-é", csrf: "secret-csrf"},
		{name: "oversized", session: strings.Repeat("s", 16385), csrf: "secret-csrf"},
	} {
		t.Run(test.name, func(t *testing.T) {
			getenv := func(name string) string {
				return map[string]string{"CAO_SERVER_SESSION": test.session, "CAO_SERVER_CSRF": test.csrf, "CAO_SERVER_TOKEN": test.token}[name]
			}
			if _, err := nativeValueAuth(test.local, getenv); err == nil || strings.Contains(err.Error(), "secret-") {
				t.Fatalf("unsafe authentication accepted or disclosed: %v", err)
			}
		})
	}
	// Authentication must fail before a valid packet can be published.
	nativeValueTestAuth(t, false)
	t.Setenv("CAO_SERVER_CSRF", "")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { requests.Add(1) }))
	defer server.Close()
	root, stdout, _ := testCommand(t, nil, nativeOperator(nil))
	root.SetArgs([]string{"value", "publish", "org/repo", "daily-review", "--server", server.URL, "--input", nativeValueTestInput(t, nativeValueTestPacket())})
	if err := root.Execute(); err == nil || stdout.Len() != 0 || requests.Load() != 0 {
		t.Fatal("partial authentication was not rejected before networking")
	}
}

func TestNativeValueServerErrorsAndReceipts(t *testing.T) {
	nativeValueTestAuth(t, false)
	tests := []struct {
		name, body, want string
		status           int
	}{
		{"unauthorized", "secret-server-payload", "authentication", 401},
		{"forbidden", "secret-server-payload", "OAuth step-up", 403},
		{"unknown", "secret-server-payload", "unknown repository or workflow", 404},
		{"stale", "secret-server-payload", "stale capture", 409},
		{"unavailable", "secret-server-payload", "unavailable", 503},
		{"invalid evidence", "secret-server-payload", "HTTP 400", 400},
		{"server failure", "secret-server-payload", "HTTP 500", 500},
		{"malformed receipt", "secret-server-payload", "invalid value publication response", 200},
		{"trailing receipt", nativeValueTestReceipt(true) + `{}`, "invalid value publication response", 200},
		{"missing id", `{}`, "invalid value publication response", 200},
		{"wrong id", strings.Replace(nativeValueTestReceipt(true), nativeValueTestID, "secret-server-payload", 1), "invalid value publication response", 200},
		{"wrong observedAt", strings.Replace(nativeValueTestReceipt(true), nativeValueTestObserved, "secret-server-payload", 1), "invalid value publication response", 200},
		{"different observed instant", strings.Replace(nativeValueTestReceipt(true), nativeValueTestObserved, "2026-10-20T12:00:00.001Z", 1), "invalid value publication response", 200},
		{"missing updated", strings.Replace(nativeValueTestReceipt(true), `"updated":true,`, "", 1), "invalid value publication response", 200},
		{"wrong updated type", strings.Replace(nativeValueTestReceipt(true), `"updated":true`, `"updated":"true"`, 1), "invalid value publication response", 200},
		{"zero revision", strings.Replace(nativeValueTestReceipt(true), `"revision":17`, `"revision":0`, 1), "invalid value publication response", 200},
		{"negative revision", strings.Replace(nativeValueTestReceipt(true), `"revision":17`, `"revision":-1`, 1), "invalid value publication response", 200},
		{"fraction revision", strings.Replace(nativeValueTestReceipt(true), `"revision":17`, `"revision":1.1`, 1), "invalid value publication response", 200},
		{"overflow revision", strings.Replace(nativeValueTestReceipt(true), `"revision":17`, `"revision":9223372036854775808`, 1), "invalid value publication response", 200},
		{"string revision", strings.Replace(nativeValueTestReceipt(true), `"revision":17`, `"revision":"17"`, 1), "invalid value publication response", 200},
		{"duplicate receipt", strings.Replace(nativeValueTestReceipt(true), `"revision":17`, `"revision":17,"revision":18`, 1), "invalid value publication response", 200},
		{"extra receipt field", strings.Replace(nativeValueTestReceipt(true), `"revision":17`, `"revision":17,"debug":"secret-server-payload"`, 1), "invalid value publication response", 200},
		{"oversized receipt", strings.Repeat("x", nativeValueMaxResponse+1), "oversized", 200},
	}
	input := nativeValueTestInput(t, nativeValueTestPacket())
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			root, stdout, stderr := testCommand(t, nil, nativeOperator(nil))
			root.SetArgs([]string{"value", "publish", "org/repo", "daily-review", "--server", server.URL, "--input", input})
			err := root.Execute()
			if err == nil || !strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "secret-") ||
				stdout.Len() != 0 || stderr.Len() != 0 || requests.Load() != 1 {
				t.Fatalf("unsafe/incorrect response handling: %v, %s, %s, requests=%d", err, stdout, stderr, requests.Load())
			}
		})
	}
}

func TestNativeValueRedirectsNeverFollowed(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var reached atomic.Int32
			destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Add(1) }))
			defer destination.Close()
			// The source is HTTPS and the redirect is HTTP: even a loopback
			// downgrade must not forward credentials or prepared evidence.
			source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", destination.URL+"/secret-location")
				w.WriteHeader(status)
			}))
			defer source.Close()
			endpoint, _ := url.Parse(source.URL)
			_, err := nativeValuePost(context.Background(), endpoint, []byte(nativeValueTestPacket()),
				nativeValueIdentity{nativeValueTestID, nativeValueTestObserved}, http.Header{"Cookie": {"cao_session=secret-session"}}, source.Client())
			if err == nil || strings.Contains(err.Error(), "secret-") || reached.Load() != 0 {
				t.Fatalf("redirect followed or disclosed: %v, reached=%d", err, reached.Load())
			}
		})
	}
}

func TestNativeValueCancellationAndTransportErrors(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer server.Close()
	endpoint, _ := url.Parse(server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-started
		cancel()
	}()
	_, err := nativeValuePost(ctx, endpoint, []byte(nativeValueTestPacket()), nativeValueIdentity{},
		http.Header{"Authorization": {"Bearer secret-token"}}, &http.Client{Timeout: time.Second})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("request did not propagate cancellation: %v", err)
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("server request was not cancelled")
	}
	tlsServer := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("untrusted TLS request must not reach handler")
	}))
	defer tlsServer.Close()
	endpoint, _ = url.Parse(tlsServer.URL)
	tlsServer.Config.ErrorLog = stdlog.New(io.Discard, "", 0)
	_, err = nativeValuePost(context.Background(), endpoint, nil, nativeValueIdentity{},
		http.Header{"Authorization": {"Bearer secret-token"}}, &http.Client{Timeout: time.Second})
	if err == nil || strings.Contains(err.Error(), "secret-") || strings.Contains(err.Error(), tlsServer.URL) {
		t.Fatalf("unsafe TLS transport failure: %v", err)
	}
}

func TestNativeValueRequestTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	}))
	defer server.Close()
	endpoint, _ := url.Parse(server.URL)
	_, err := nativeValuePost(context.Background(), endpoint, []byte(nativeValueTestPacket()), nativeValueIdentity{},
		http.Header{"Cookie": {"cao_session=secret-session"}}, &http.Client{Timeout: 50 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "secret-") || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("unsafe timeout failure: %v", err)
	}
}

func TestNativeValueResponseBodyCancellation(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-started
		cancel()
	}()
	endpoint, _ := url.Parse(server.URL)
	_, err := nativeValuePost(ctx, endpoint, []byte(nativeValueTestPacket()), nativeValueIdentity{},
		http.Header{"Cookie": {"cao_session=secret-session"}}, &http.Client{Timeout: time.Second})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("response body did not propagate cancellation: %v", err)
	}
}

func TestNativeValueRoutesAndArguments(t *testing.T) {
	root, _, _ := testCommand(t, nil, nil)
	value, _, err := root.Find([]string{"value"})
	if err != nil || len(value.Commands()) != 3 {
		t.Fatal("value must expose explicit publish, enable and disable routes")
	}

	for _, args := range [][]string{
		{"value"}, {"value", "update"}, {"value", "publish"},
		{"value", "publish", "org/repo", "daily-review"},
		{"value", "publish", "org/repo", "daily-review", "--server", "http://localhost"},
		{"value", "publish", "org/repo", "daily-review", "--input", "input.jsonl"},
		{"value", "publish", "org/repo", "daily-review", "--token", "not-supported"},
		{"value", "publish", "org/repo", "daily-review", "--server", "one", "--server", "two", "--input", "input"},
		{"value", "publish", "org/repo", "daily-review", "--server", "one", "--input", "one", "--input", "two"},
		{"value", "publish", "org/repo", "daily-review", "extra", "--server", "http://localhost", "--input", "input"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			root, _, _ := testCommand(t, nil, nil)
			root.SetArgs(args)
			if err := root.Execute(); err == nil {
				t.Fatal("invalid value route unexpectedly executed")
			}
		})
	}
	root, stdout, _ := testCommand(t, nil, nil)
	root.SetArgs([]string{"value", "publish", "--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"already measured", "does not evaluate", "CAO_SERVER_SESSION", "CAO_SERVER_CSRF", "CAO_SERVER_TOKEN", "--server", "--input"} {
		if !strings.Contains(stdout.String(), text) {
			t.Fatalf("help missing %q", text)
		}
	}
}

func TestNativeValueReceiptEquivalentUTCFormatting(t *testing.T) {
	for _, times := range [][2]string{
		{"2026-10-20T11:13:27.410Z", "2026-10-20T11:13:27.41Z"},
		{"2026-10-20T12:00:00.000Z", "2026-10-20T12:00:00Z"},
		{"2026-10-20T11:13:27.123456Z", "2026-10-20T11:13:27.123456000Z"},
	} {
		t.Run(times[0], func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = fmt.Fprintf(w, `{"id":%q,"revision":17,"updated":true,"observedAt":%q}`, nativeValueTestID, times[1])
			}))
			defer server.Close()
			endpoint, _ := url.Parse(server.URL)
			result, err := nativeValuePost(context.Background(), endpoint, []byte(nativeValueTestPacket()),
				nativeValueIdentity{nativeValueTestID, times[0]}, http.Header{}, server.Client())
			if err != nil || result.ObservedAt != times[0] {
				t.Fatalf("equivalent UTC receipt rejected or original timestamp changed: result=%+v err=%v", result, err)
			}
		})
	}
}
