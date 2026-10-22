package marketplace

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/inputlimits"
)

const (
	maxGitHubJSONBytes     = inputlimits.DefaultMarketplaceJSONBytes
	maxGitHubTreeJSONBytes = inputlimits.DefaultMarketplaceTreeJSONBytes
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

func TestGitHubJSONAllowsMaximumManifestBlob(t *testing.T) {
	manifest := "name: Demo\n#" + strings.Repeat("x", maxManifestBytes-len("name: Demo\n#"))
	encoded, err := json.Marshal(map[string]any{
		"encoding": "base64",
		"content":  base64.StdEncoding.EncodeToString([]byte(manifest)),
	})
	if err != nil {
		t.Fatal(err)
	}
	body := &trackedJSONBody{Reader: strings.NewReader(string(encoded))}
	payload, err := githubJSON(t.Context(), Options{HTTPClient: jsonResponseDoer{body: body}},
		http.MethodGet, "https://api.github.com/test", "")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeManifestBlob(payload)
	if err != nil || decoded != manifest {
		t.Fatalf("maximum manifest blob was not preserved: %v", err)
	}
	if _, err := ParsePackageManifest(decoded, Coordinates{}); err != nil {
		t.Fatal(err)
	}
}

type treeResponseDoer struct {
	HTTPDoer
	body *trackedJSONBody
}

func (d treeResponseDoer) Do(request *http.Request) (*http.Response, error) {
	if strings.Contains(request.URL.Path, "/git/trees/") {
		return jsonResponseDoer{body: d.body, contentLength: -1}.Do(request)
	}
	return d.HTTPDoer.Do(request)
}

func TestGitHubTreeJSONByteLimit(t *testing.T) {
	const valid = `{"tree":[]}`
	for _, test := range []struct {
		name     string
		size     int
		override string
		want     string
	}{
		{name: "above ordinary response limit", size: maxGitHubJSONBytes + 1},
		{name: "below tree limit", size: maxGitHubTreeJSONBytes - 1},
		{name: "exact tree limit", size: maxGitHubTreeJSONBytes},
		{name: "one byte over tree limit", size: maxGitHubTreeJSONBytes + 1, want: "exceeds size limit"},
		{name: "overridden exact tree limit", size: 64, override: "64"},
		{name: "overridden tree limit exceeded", size: 65, override: "64", want: "exceeds size limit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := newFakeGitHubServer(t, fakeGitHubConfig{})
			body := &trackedJSONBody{Reader: strings.NewReader(
				valid + strings.Repeat(" ", test.size-len(valid)),
			)}
			opts := Options{HTTPClient: treeResponseDoer{HTTPDoer: server.server.Client(), body: body}}
			limit := maxGitHubTreeJSONBytes
			if test.override != "" {
				opts.Env = fakeEnv{string(inputlimits.MarketplaceTreeJSON): test.override}.lookup
				limit = 64
			}
			packages, err := ResolveRegistry(t.Context(), Registry{
				ID: "test", Repository: "example/packages", Ref: "main", APIURL: server.baseURL(),
			}, 0, opts)
			if !body.closed || body.read != min(test.size, limit+1) {
				t.Fatalf("closed=%t, read=%d, want closed bounded tree response", body.closed, body.read)
			}
			if test.want != "" {
				if err == nil || !strings.Contains(err.Error(), test.want) || packages != nil {
					t.Fatalf("error = %v, want substring %q and no packages", err, test.want)
				}
			} else if err != nil || len(packages) != 0 {
				t.Fatalf("unexpected tree result: packages=%d, err=%v", len(packages), err)
			}
		})
	}
}

func TestGitHubJSONLimitEnvironment(t *testing.T) {
	const valid = `{"sha":"ok"}`
	for _, setting := range []inputlimits.ByteLimit{inputlimits.MarketplaceJSON, inputlimits.MarketplaceTreeJSON} {
		t.Run(string(setting), func(t *testing.T) {
			for _, test := range []struct {
				name string
				env  string
				size int
				want string
			}{
				{name: "exact override", env: "64", size: 64},
				{name: "override exceeded", env: "64", size: 65, want: "exceeds size limit"},
				{name: "invalid override", env: "invalid", size: len(valid), want: string(setting)},
				{name: "empty override", size: len(valid), want: string(setting)},
			} {
				t.Run(test.name, func(t *testing.T) {
					body := &trackedJSONBody{Reader: strings.NewReader(valid + strings.Repeat(" ", test.size-len(valid)))}
					opts := Options{
						HTTPClient: jsonResponseDoer{body: body},
						Env:        fakeEnv{string(setting): test.env}.lookup,
					}
					payload, err := githubJSONWithLimit(t.Context(), opts, http.MethodGet, "https://api.github.com/test", "", setting)
					if test.want == "" {
						if err != nil || payload["sha"] != "ok" {
							t.Fatalf("payload=%#v, err=%v", payload, err)
						}
					} else if err == nil || !strings.Contains(err.Error(), test.want) || payload != nil {
						t.Fatalf("error = %v, want substring %q and no payload", err, test.want)
					}
					if test.want == string(setting) {
						if body.read != 0 || body.closed {
							t.Fatal("invalid configuration issued an HTTP request")
						}
					} else if !body.closed || body.read != min(test.size, 65) {
						t.Fatalf("closed=%t, read=%d, want closed bounded response", body.closed, body.read)
					}
				})
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
