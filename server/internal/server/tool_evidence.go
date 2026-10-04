package server

import (
	"bytes"
	"compress/gzip"
	"container/heap"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

type ToolEventEvidence struct {
	Rows           []model.Row `json:"rows"`
	TotalEvents    int         `json:"totalEvents"`
	ReturnedEvents int         `json:"returnedEvents"`
	OmittedEvents  int         `json:"omittedEvents"`
}

type retainedToolEvent struct {
	row   model.Row
	bytes int
}

type toolEventHeap []retainedToolEvent

func (h toolEventHeap) Len() int { return len(h) }
func (h toolEventHeap) Less(i, j int) bool {
	left, right := fmt.Sprint(h[i].row["timestamp"]), fmt.Sprint(h[j].row["timestamp"])
	if left == right {
		return fmt.Sprint(h[i].row["id"]) > fmt.Sprint(h[j].row["id"])
	}
	return left < right
}
func (h toolEventHeap) Swap(i, j int)   { h[i], h[j] = h[j], h[i] }
func (h *toolEventHeap) Push(value any) { *h = append(*h, value.(retainedToolEvent)) }
func (h *toolEventHeap) Pop() any {
	last := (*h)[len(*h)-1]
	*h = (*h)[:len(*h)-1]
	return last
}

var toolEvidenceDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func evidenceCount(value any) (int, error) {
	text := fmt.Sprint(value)
	count, err := strconv.Atoi(text)
	if err != nil || count < 0 {
		return 0, errors.New("invalid Tool evidence count")
	}
	return count, nil
}

func readToolEventEvidence(ctx context.Context, directory, runID string, references []model.Row, limit int, eventType string) (ToolEventEvidence, error) {
	result := ToolEventEvidence{Rows: []model.Row{}}
	if limit < 1 || limit > 2000 {
		return result, errors.New("tool evidence limit must be between 1 and 2000")
	}
	if directory == "" || len(references) == 0 || len(references) > 256 {
		return result, errors.New("exact Tool evidence is unavailable or exceeds its shard budget")
	}
	retained := &toolEventHeap{}
	retainedBytes := 0
	seen := map[string]bool{}
	for _, reference := range references {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		digest, _ := reference["payload-hash"].(string)
		ref, _ := reference["payload-ref"].(string)
		if !toolEvidenceDigest.MatchString(digest) || ref != "gh-aw-logs-tools/"+digest+".jsonl.gz" || reference["run-id"] != runID {
			return result, errors.New("invalid Run-owned Tool evidence locator")
		}
		expected, err := evidenceCount(reference["event-count"])
		if err != nil {
			return result, err
		}
		// #nosec G304 -- the manifested digest fixes the file name beneath the configured evidence directory.
		file, err := os.Open(filepath.Join(directory, "gh-aw-logs-tools", digest+".jsonl.gz"))
		if err != nil {
			return result, err
		}
		compressed, readErr := io.ReadAll(io.LimitReader(file, 2*1024*1024+1))
		closeErr := file.Close()
		if readErr != nil {
			return result, readErr
		}
		if closeErr != nil {
			return result, closeErr
		}
		sum := sha256.Sum256(compressed)
		if len(compressed) > 2*1024*1024 || hex.EncodeToString(sum[:]) != digest {
			return result, errors.New("tool evidence checksum or byte budget is invalid")
		}
		reader, err := gzip.NewReader(bytes.NewReader(compressed))
		if err != nil {
			return result, err
		}
		content, readErr := io.ReadAll(io.LimitReader(reader, 1024*1024+1025))
		closeErr = reader.Close()
		if readErr != nil {
			return result, readErr
		}
		if closeErr != nil {
			return result, closeErr
		}
		if len(content) > 1024*1024+1024 {
			return result, errors.New("tool evidence exceeds the decompressed byte budget")
		}
		lines := bytes.Split(bytes.TrimSuffix(content, []byte("\n")), []byte("\n"))
		var header struct {
			Kind          string `json:"kind"`
			SchemaVersion int    `json:"schemaVersion"`
			Events        *int   `json:"events"`
		}
		if len(lines) == 0 || json.Unmarshal(lines[0], &header) != nil || header.Kind != "tool-evidence" ||
			header.SchemaVersion != model.CanonicalSchemaVersion || header.Events == nil || *header.Events != len(lines)-1 {
			return result, errors.New("unsupported or incomplete Tool evidence shard")
		}
		owned := 0
		for _, line := range lines[1:] {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			var envelope struct {
				Kind   string    `json:"kind"`
				Record model.Row `json:"record"`
			}
			decoder := json.NewDecoder(bytes.NewReader(line))
			decoder.UseNumber()
			if decoder.Decode(&envelope) != nil || envelope.Kind != "tool-event" || envelope.Record == nil {
				return result, errors.New("invalid Tool evidence event")
			}
			var extra any
			if err := decoder.Decode(&extra); err != io.EOF {
				return result, errors.New("tool evidence must contain exactly one event per line")
			}
			event := envelope.Record
			id, ok := event["id"].(string)
			if !ok || id == "" {
				return result, errors.New("tool evidence event requires an identity")
			}
			if event["runId"] != runID {
				continue
			}
			owned++
			if seen[id] {
				return result, errors.New("duplicate Tool evidence event")
			}
			seen[id] = true
			if len(seen) > 200000 {
				return result, errors.New("tool evidence exceeds the event scan budget")
			}
			if eventType != "" && event["type"] != eventType {
				continue
			}
			result.TotalEvents++
			encoded, err := json.Marshal(event)
			if err != nil {
				return result, err
			}
			retainedBytes += len(encoded)
			heap.Push(retained, retainedToolEvent{row: event, bytes: len(encoded)})
			if retained.Len() > limit {
				retainedBytes -= heap.Pop(retained).(retainedToolEvent).bytes
			}
			if retainedBytes > 8*1024*1024 {
				return result, errors.New("tool evidence result exceeds the bounded output byte budget")
			}
		}
		if owned != expected {
			return result, errors.New("tool evidence event count does not match its owning Run")
		}
	}
	result.Rows = make([]model.Row, retained.Len())
	for index := len(result.Rows) - 1; index >= 0; index-- {
		result.Rows[index] = heap.Pop(retained).(retainedToolEvent).row
	}
	result.ReturnedEvents = len(result.Rows)
	result.OmittedEvents = result.TotalEvents - result.ReturnedEvents
	return result, nil
}

func (a *App) toolEvents(response http.ResponseWriter, request *http.Request) {
	limit := 20
	if value := request.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 2000 {
			writeError(response, http.StatusBadRequest, "Tool evidence limit must be between 1 and 2000")
			return
		}
		limit = parsed
	}
	eventType := request.URL.Query().Get("type")
	if len(eventType) > 128 || strings.ContainsAny(eventType, "\r\n") {
		writeError(response, http.StatusBadRequest, "invalid Tool event type")
		return
	}
	runID := request.PathValue("id")
	if _, err := a.canonical.entity(request.Context(), "runs", runID); err != nil {
		a.writeCanonicalRows(response, nil, err)
		return
	}
	references, err := a.canonical.filteredRows(request.Context(), "tool-evidence", map[string]any{"run-id": runID})
	if err != nil {
		a.writeCanonicalRows(response, nil, err)
		return
	}
	directory := a.config.SourceDirectory
	if collector := a.Collector(); collector != nil {
		directory = collector.lake.Directory
	}
	result, err := readToolEventEvidence(request.Context(), directory, runID, references, limit, eventType)
	if err != nil {
		canonicalLog.Printf("exact Tool evidence read failed")
		writeError(response, http.StatusServiceUnavailable, "exact Tool evidence is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, result)
}
