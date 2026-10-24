// This executable supplies the Docker Actions test with a loopback-only GitHub
// simulator. Its TLS certificate is trusted only by that disposable runner.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/githubnext/gh-cao/server/internal/simulator"
)

func main() {
	if err := serve(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func serve() (result error) {
	var config struct {
		SHA      string `json:"sha"`
		Activity struct {
			Correction bool   `json:"correction"`
			AsOf       string `json:"asOf"`
		} `json:"activity"`
	}
	data, err := os.ReadFile("/fixture/simulator.json")
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return err
	}
	now, err := time.Parse(time.RFC3339, config.Activity.AsOf)
	if err != nil {
		return err
	}
	history := simulator.History{Days: 12, RunsPerDay: 1, AsOf: now.Format(time.RFC3339)}
	fixture, err := os.OpenRoot("/fixture")
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, fixture.Close()) }()
	api, err := simulator.NewAPIHandler(simulator.Scenario{
		Name: "activity-runtime", Repositories: 1, History: &history,
	}, 1)
	if err != nil {
		return err
	}
	repository := map[string]any{
		"id": 1001, "name": "repo-00001", "full_name": simulator.GatewayRepositoryName,
		"private": false, "visibility": "public", "default_branch": "main", "archived": false, "disabled": false,
		"owner": map[string]any{"id": 42, "login": "simulator", "type": "Organization"},
	}
	workflow := map[string]any{"id": 7, "name": "Sample", "path": ".github/workflows/sample.lock.yml", "state": "active"}
	runs := make([]map[string]any, 0, 12)
	for offset := range 12 {
		run := history.Run(0, offset)
		conclusions := []any{"success", "failure", "timed_out", "action_required", nil, "cancelled"}
		conclusion, status, attempt := conclusions[offset%6], "completed", 1
		if conclusion == nil {
			status = "in_progress"
		}
		if config.Activity.Correction && offset == 1 {
			conclusion, attempt = "success", 2
		}
		runs = append(runs, map[string]any{
			"id": run.ID, "run_number": run.ID, "run_attempt": attempt, "workflow_id": 7,
			"name": "Sample", "display_title": "Synthetic Activity run", "path": workflow["path"],
			"status": status, "conclusion": conclusion, "event": "workflow_dispatch",
			"created_at": run.CreatedAt, "run_started_at": run.CreatedAt, "updated_at": run.CreatedAt.Add(time.Duration(attempt) * time.Minute),
			"head_sha": config.SHA, "head_branch": "main", "repository": repository,
			"html_url": fmt.Sprintf("https://github.com/%s/actions/runs/%d", simulator.GatewayRepositoryName, run.ID),
		})
	}
	var server *httptest.Server
	var mutex sync.Mutex
	encoder := json.NewEncoder(os.Stdout)
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := strings.TrimPrefix(r.URL.Path, "/api/v3")
		mutex.Lock()
		_ = encoder.Encode(map[string]any{"method": r.Method, "path": route})
		mutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4999")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
		send := func(value any) { _ = json.NewEncoder(w).Encode(value) }
		unhandled := func() {
			mutex.Lock()
			_ = encoder.Encode(map[string]string{"unhandled": r.Method + " " + route})
			mutex.Unlock()
			w.WriteHeader(http.StatusNotImplemented)
		}
		prefix := "/repos/" + simulator.GatewayRepositoryName
		switch {
		case r.Method != http.MethodGet:
			w.WriteHeader(http.StatusForbidden)
			send(map[string]string{"message": "Activity simulator forbids mutations"})
		case route == "/rate_limit":
			api.ServeHTTP(w, r)
		case route == prefix:
			send(repository)
		case route == prefix+"/issues":
			// This fixture has no issues created by safe outputs.
			send([]any{})
		case route == "/repos/github/gh-aw/releases":
			send([]any{map[string]any{"tag_name": "v0.93.1", "draft": false, "prerelease": false}})
		case route == prefix+"/commits/main":
			send(map[string]any{"sha": config.SHA})
		case route == prefix+"/actions/workflows":
			send(map[string]any{"total_count": 1, "workflows": []any{workflow}})
		case route == prefix+"/actions/runs" || route == prefix+"/actions/workflows/sample.lock.yml/runs" ||
			route == prefix+"/actions/workflows/7/runs":
			send(map[string]any{"total_count": len(runs), "workflow_runs": runs})
		case strings.HasPrefix(route, prefix+"/contents/"):
			name := strings.TrimPrefix(route, prefix+"/contents/")
			if filepath.Clean(name) != name || strings.HasPrefix(name, "../") {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			content, err := fixture.ReadFile(name)
			if err != nil {
				w.WriteHeader(http.StatusNotFound)
				send(map[string]string{"message": "Fixture file not found"})
				return
			}
			if strings.Contains(r.Header.Get("Accept"), "raw") {
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
				return
			}
			send(map[string]any{"type": "file", "path": name, "encoding": "base64",
				"content": base64.StdEncoding.EncodeToString(content), "sha": config.SHA})
		case strings.HasPrefix(route, prefix+"/actions/runs/"):
			parts := strings.Split(strings.TrimPrefix(route, prefix+"/actions/runs/"), "/")
			id, err := strconv.Atoi(parts[0])
			if err != nil || id < 1 || id > len(runs) {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			run := runs[id-1]
			switch parts[len(parts)-1] {
			case "jobs":
				send(map[string]any{"total_count": 1, "jobs": []any{map[string]any{
					"id": id + 100, "name": "agent", "status": run["status"], "conclusion": run["conclusion"],
					"started_at": run["run_started_at"], "completed_at": run["updated_at"], "steps": []any{},
				}}})
			case "artifacts":
				send(map[string]any{"total_count": 1, "artifacts": []any{map[string]any{
					"id": id, "name": "usage", "expired": false, "size_in_bytes": 1024,
					"archive_download_url": fmt.Sprintf("%s/api/v3/repos/%s/actions/artifacts/%d/zip",
						server.URL, simulator.GatewayRepositoryName, id),
				}}})
			case "logs":
				http.Redirect(w, r, "/archives/"+strconv.Itoa(id), http.StatusFound)
			default:
				if len(parts) == 1 || len(parts) == 3 && parts[1] == "attempts" {
					send(run)
				} else {
					unhandled()
				}
			}
		case strings.HasPrefix(route, prefix+"/actions/artifacts/"):
			id, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(route, prefix+"/actions/artifacts/"), "/zip"))
			if err != nil || id < 1 || id > len(runs) {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			http.Redirect(w, r, "/usage/"+strconv.Itoa(id), http.StatusFound)
		case strings.HasPrefix(route, "/archives/") || strings.HasPrefix(route, "/usage/"):
			var buffer bytes.Buffer
			archive := zip.NewWriter(&buffer)
			name := "agent/1_sample.txt"
			content := now.Format(time.RFC3339) + " Synthetic deterministic agent log\n"
			if strings.HasPrefix(route, "/usage/") {
				id, err := strconv.Atoi(strings.TrimPrefix(route, "/usage/"))
				if err != nil || id < 1 || id > len(runs) {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				name = "aw_info.json"
				info, err := json.Marshal(map[string]any{
					"run_id": id, "run_attempt": runs[id-1]["run_attempt"], "repository": simulator.GatewayRepositoryName,
					"workflow_name": "Sample", "workflow_path": workflow["path"], "engine_id": "copilot",
				})
				if err != nil {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				content = string(info)
			}
			file, err := archive.Create(name)
			if err == nil {
				_, err = file.Write([]byte(content))
			}
			if err == nil {
				err = archive.Close()
			}
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(buffer.Bytes())
		case strings.Contains(route, "/git/"):
			w.WriteHeader(http.StatusNotFound)
			send(map[string]string{"message": "No repository memory in this fixture"})
		default:
			unhandled()
			send(map[string]string{"message": "Unsupported Activity simulator endpoint"})
		}
	}))
	defer server.Close()
	if err := os.WriteFile("/output/github-ca.pem", pem.EncodeToMemory(&pem.Block{
		Type: "CERTIFICATE", Bytes: server.Certificate().Raw,
	}), 0o600); err != nil {
		return err
	}
	mutex.Lock()
	err = encoder.Encode(map[string]string{"url": server.URL})
	mutex.Unlock()
	if err != nil {
		return err
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(stop)
	<-stop
	return nil
}
