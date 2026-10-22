package marketplace

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type jsonResponseDoer struct {
	body          io.ReadCloser
	contentLength int64
}

func (d jsonResponseDoer) Do(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: d.body, ContentLength: d.contentLength}, nil
}

type trackedJSONBody struct {
	io.Reader
	read   int
	closed bool
}

func (b *trackedJSONBody) Read(p []byte) (int, error) {
	n, err := b.Reader.Read(p)
	b.read += n
	return n, err
}

func (b *trackedJSONBody) Close() error {
	b.closed = true
	return nil
}

func TestGitHubJSONByteLimit(t *testing.T) {
	const valid = `{"sha":"ok"}`
	for _, test := range []struct {
		name          string
		body          string
		contentLength int64
		want          string
	}{
		{name: "below limit", body: valid + strings.Repeat(" ", maxGitHubJSONBytes-1-len(valid)), contentLength: -1},
		{name: "exact limit", body: valid + strings.Repeat(" ", maxGitHubJSONBytes-len(valid)), contentLength: maxGitHubJSONBytes},
		{name: "one byte over", body: valid + strings.Repeat(" ", maxGitHubJSONBytes+1-len(valid)), contentLength: -1, want: "exceeds size limit"},
		{name: "underreported length", body: valid + strings.Repeat(" ", maxGitHubJSONBytes*2-len(valid)), contentLength: int64(len(valid)), want: "exceeds size limit"},
		{name: "oversized malformed", body: strings.Repeat("{", maxGitHubJSONBytes+1), want: "exceeds size limit"},
		{name: "malformed", body: `{"sha":`, want: "decode GitHub API response"},
		{name: "empty", want: "decode GitHub API response"},
		{name: "trailing JSON", body: valid + `{}`, want: "decode GitHub API response"},
		{name: "trailing garbage", body: valid + `x`, want: "decode GitHub API response"},
		{name: "array", body: `[]`, want: "decode GitHub API response"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := &trackedJSONBody{Reader: strings.NewReader(test.body)}
			payload, err := githubJSON(t.Context(), Options{HTTPClient: jsonResponseDoer{
				body: body, contentLength: test.contentLength,
			}}, http.MethodGet, "https://api.github.com/test", "")
			if !body.closed {
				t.Fatal("response body was not closed")
			}
			if body.read != min(len(test.body), maxGitHubJSONBytes+1) {
				t.Fatalf("read %d bytes, want %d", body.read, min(len(test.body), maxGitHubJSONBytes+1))
			}
			if test.want != "" {
				if err == nil || !strings.Contains(err.Error(), test.want) {
					t.Fatalf("error = %v, want substring %q", err, test.want)
				}
				if payload != nil {
					t.Fatal("rejected response returned a partial payload")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if payload["sha"] != "ok" {
				t.Fatal("unexpected payload at byte boundary")
			}
		})
	}
}

func TestGitHubJSONOversizeCallerBehavior(t *testing.T) {
	for _, optional := range []bool{false, true} {
		name := "required registry response"
		if optional {
			name = "optional readme response"
		}
		t.Run(name, func(t *testing.T) {
			body := &trackedJSONBody{Reader: strings.NewReader(
				`{}` + strings.Repeat(" ", maxGitHubJSONBytes),
			)}
			opts := Options{HTTPClient: jsonResponseDoer{body: body, contentLength: -1}}
			if optional {
				if content := fetchReadme(t.Context(), opts, "https://api.github.com", "example/packages", "", "blob"); content != "" {
					t.Fatal("oversized optional README was published")
				}
			} else {
				result := Resolve(t.Context(), &Config{Registries: []Registry{{
					ID: "test", Repository: "example/packages", Ref: "main",
				}}}, "test", nil, opts)
				if len(result.Packages) != 0 || len(result.Diagnostics) != 1 ||
					result.Diagnostics[0].Status != "unavailable" ||
					result.Diagnostics[0].Message != "GitHub API response exceeds size limit" {
					t.Fatalf("unexpected registry failure diagnostic: %#v", result.Diagnostics)
				}
			}
			if !body.closed || body.read != maxGitHubJSONBytes+1 {
				t.Fatalf("closed=%t, read=%d, want closed bounded response", body.closed, body.read)
			}
		})
	}
}

type failingJSONReader struct {
	err error
}

func (r failingJSONReader) Read([]byte) (int, error) { return 0, r.err }

func TestGitHubJSONReadFailure(t *testing.T) {
	readErr := errors.New("synthetic read failure")
	for _, want := range []error{readErr, context.Canceled, context.DeadlineExceeded} {
		t.Run(want.Error(), func(t *testing.T) {
			body := &trackedJSONBody{Reader: io.MultiReader(
				strings.NewReader(`{"sha":"ok"}`), failingJSONReader{err: want},
			)}
			payload, err := githubJSON(t.Context(), Options{HTTPClient: jsonResponseDoer{body: body}},
				http.MethodGet, "https://api.github.com/test", "")
			if !errors.Is(err, want) || payload != nil || !body.closed {
				t.Fatalf("read failure: err=%v, payload nil=%t, closed=%t", err, payload == nil, body.closed)
			}
		})
	}
}

func TestGitHubJSONCancellationDuringRead(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"sha":`)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := githubJSON(ctx, Options{HTTPClient: server.Client()}, http.MethodGet, server.URL, "")
		result <- err
	}()
	select {
	case <-started:
	case err := <-result:
		t.Fatalf("request failed before response read: %v", err)
	case <-ctx.Done():
		t.Fatal("request did not reach response read")
	}
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want cancellation during response read", err)
	}
}
