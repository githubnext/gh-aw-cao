package localops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type compilerRoundTripper func(*http.Request) (*http.Response, error)

func (f compilerRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func compilerFixture(t *testing.T) *Service {
	t.Helper()
	s := service(t, nil)
	directory := filepath.Join(s.options.Workspace, ".github", "workflows")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "cao.json"), []byte(`{"gh-aw-version":"v9.8.7"}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOCALOPS_COMPILER_INSTALL", s.options.Workspace)
	return s
}

func TestCompilerPinnedExtensionInstallAndNativeDownloadFallback(t *testing.T) {
	t.Run("extension", func(t *testing.T) {
		s := compilerFixture(t)
		path, err := ensureGhAW(t.Context(), s.options)
		if err != nil || path != "" {
			t.Fatal(path, err)
		}
		raw, err := os.ReadFile(filepath.Join(s.options.Workspace, "commands.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		calls := make([][]string, 0, 3)
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			var args []string
			if err = json.Unmarshal([]byte(line), &args); err != nil {
				t.Fatal(err)
			}
			calls = append(calls, args)
		}
		expected := [][]string{{"aw", "--help"}, {"extension", "install", "github/gh-aw", "--pin", "v9.8.7"}, {"aw", "--help"}}
		if !reflect.DeepEqual(calls, expected) {
			t.Fatal(calls)
		}
	})
	t.Run("checksummed-native-fallback", func(t *testing.T) {
		s := compilerFixture(t)
		t.Setenv("LOCALOPS_COMPILER_INSTALL_FAIL", "1")
		binary := []byte("inert external compiler fixture")
		digest := sha256.Sum256(binary)
		requests := []string{}
		s.options.compilerHTTPClient = &http.Client{Transport: compilerRoundTripper(func(request *http.Request) (*http.Response, error) {
			requests = append(requests, request.URL.String())
			if request.Header.Get("Authorization") != "" || request.URL.Scheme != "https" || request.URL.Host != "github.com" {
				t.Error("compiler bootstrap sent credentials or used an untrusted origin")
			}
			body := binary
			if strings.HasSuffix(request.URL.Path, "/checksums.txt") {
				body = fmt.Appendf(nil, "%s  %s\n", hex.EncodeToString(digest[:]), compilerAsset())
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Header: http.Header{}}, nil
		})}
		path, err := ensureGhAW(t.Context(), s.options)
		if err != nil {
			t.Fatal(err)
		}
		expected := "https://github.com/github/gh-aw/releases/download/v9.8.7/"
		if !reflect.DeepEqual(requests, []string{expected + "checksums.txt", expected + compilerAsset()}) {
			t.Fatal(requests)
		}
		raw, err := os.ReadFile(path) // #nosec G304 -- verified compiler fixture path inside this test's owned workspace.
		if err != nil || !bytes.Equal(raw, binary) || !strings.HasPrefix(path, s.options.Workspace+string(filepath.Separator)) {
			t.Fatal("native fallback did not publish the verified workspace compiler", err)
		}
		cached, err := ensureGhAW(t.Context(), s.options)
		if err != nil || cached != path || len(requests) != 2 {
			t.Fatal("verified compiler cache was not reused", cached, err, requests)
		}
		if err = os.WriteFile(path, []byte("tampered compiler"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = ensureGhAW(t.Context(), s.options); err == nil {
			t.Fatal("unverified compiler was executable")
		}
	})
}

func TestCompilerDownloadBoundsIntegrityAndCancellation(t *testing.T) {
	for _, mode := range []string{"checksum-mismatch", "missing-asset", "oversize", "canceled"} {
		t.Run(mode, func(t *testing.T) {
			s := compilerFixture(t)
			t.Setenv("LOCALOPS_COMPILER_INSTALL_FAIL", "1")
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			s.options.compilerHTTPClient = &http.Client{Transport: compilerRoundTripper(func(request *http.Request) (*http.Response, error) {
				body := "fixture"
				length := int64(len(body))
				if strings.HasSuffix(request.URL.Path, "/checksums.txt") {
					body = strings.Repeat("0", 64) + "  " + compilerAsset()
					if mode == "missing-asset" {
						body = "invalid checksums"
					}
					length = int64(len(body))
				} else if mode == "oversize" {
					length = maximumCompilerBytes + 1
				}
				if mode == "canceled" {
					cancel()
					return nil, context.Canceled
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), ContentLength: length, Header: http.Header{}}, nil
			})}
			if _, err := ensureGhAW(ctx, s.options); err == nil {
				t.Fatal("unsafe compiler download was accepted")
			}
			directory := filepath.Join(s.options.Workspace, ".cao", "tools")
			entries, err := os.ReadDir(directory)
			if err != nil || len(entries) != 0 {
				t.Fatal("failed download left an executable or staging artifact", entries, err)
			}
		})
	}
}
