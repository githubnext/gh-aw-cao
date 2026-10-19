package server

import (
	"compress/gzip"
	"encoding/json"
	"html"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var localHead = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
var localBackendMetadata = regexp.MustCompile(`(?is)<meta\b[^>]*\bname\s*=\s*["'](?:dashboard-github-api-base|dashboard-data-backend|dashboard-storage-backend|dashboard-api-base)["'][^>]*>`)
var localCaoMetadata = regexp.MustCompile(`(?is)<meta\b[^>]*\bname\s*=\s*["']cao-url["'][^>]*>`)
var localSensitiveKey = regexp.MustCompile(`(?i)(?:^|[-_])(api[-_]?key|authorization|client[-_]?secret|password|private[-_]?key|secret|token)(?:$|[-_])`)
var localSecrets = []*regexp.Regexp{
	regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`),
	regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*`),
	regexp.MustCompile(`\bAKIA[A-Z0-9]{16}\b`),
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
}

func localRedact(content []byte) []byte {
	for _, pattern := range localSecrets {
		content = pattern.ReplaceAllLiteral(content, []byte("[REDACTED]"))
	}
	return content
}

func localRedactJSON(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, entry := range typed {
			if localSensitiveKey.MatchString(key) {
				typed[key] = "[REDACTED]"
			} else {
				typed[key] = localRedactJSON(entry)
			}
		}
	case []any:
		for index, entry := range typed {
			typed[index] = localRedactJSON(entry)
		}
	case string:
		return string(localRedact([]byte(typed)))
	}
	return value
}

var localContentTypes = map[string]string{
	".avif": "image/avif", ".css": "text/css; charset=utf-8", ".gif": "image/gif",
	".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".jpeg": "image/jpeg",
	".jpg": "image/jpeg", ".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8", ".jsonl": "application/x-ndjson; charset=utf-8",
	".md": "text/markdown; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
}

func (s *LocalServer) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Path
	if (path == "/" || path == "/index.html") && !r.URL.Query().Has("local-preview") {
		params := r.URL.Query()
		mode := "enabled"
		if s.config.Canvas {
			mode = "canvas"
		} else if s.config.Admin {
			mode = "admin"
		}
		params.Set("local-preview", mode)
		w.Header().Set("Location", s.config.Prefix+"/?"+params.Encode())
		w.WriteHeader(http.StatusFound)
		return
	}
	if path == "/" {
		path = "/index.html"
	}
	if strings.EqualFold(filepath.Base(path), "compiler-overrides.json") {
		http.NotFound(w, r)
		return
	}
	// Never clean traversal into an otherwise valid workspace asset.
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." || segment == "." {
			http.NotFound(w, r)
			return
		}
	}
	memory := strings.HasPrefix(path, "/memory/")
	roots := []string{s.config.OverlayDirectory, s.config.SiteDirectory}
	if memory {
		roots = []string{s.config.SourceDirectory}
	}
	var selected *os.File
	for _, root := range roots {
		if root == "" {
			continue
		}
		directory, err := os.OpenRoot(root)
		if err != nil {
			continue
		}
		name := filepath.FromSlash(strings.TrimPrefix(path, "/"))
		file, err := directory.Open(name)
		if err != nil {
			_ = directory.Close()
			continue
		}
		info, err := file.Stat()
		if err == nil && info.IsDir() {
			_ = file.Close()
			file, err = directory.Open(filepath.Join(name, "index.html"))
			if err == nil {
				info, err = file.Stat()
			}
		}
		_ = directory.Close()
		if err == nil && info.Mode().IsRegular() {
			selected = file
			break
		}
		if file != nil {
			_ = file.Close()
		}
	}
	if selected == nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = selected.Close() }()
	extension := strings.ToLower(filepath.Ext(selected.Name()))
	contentType, supported := localContentTypes[extension]
	if memory && (extension == ".txt" || extension == ".yaml" || extension == ".yml") {
		contentType, supported = mime.TypeByExtension(extension), true
		if contentType == "" {
			contentType = "text/plain; charset=utf-8"
		}
	}
	if memory {
		switch extension {
		case ".json", ".jsonl", ".md", ".txt", ".yaml", ".yml":
		default:
			supported = false
		}
	}
	if !supported {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	compressible := strings.HasPrefix(contentType, "text/") || extension == ".json" || extension == ".jsonl" || extension == ".svg"
	if compressible {
		w.Header().Set("Vary", "Accept-Encoding")
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	if extension == ".jsonl" && !memory {
		s.writeLocalContent(w, r, selected, true)
		return
	}
	content, err := io.ReadAll(selected)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Dashboard asset is unavailable.")
		return
	}
	if extension == ".json" {
		var value any
		if json.Unmarshal(content, &value) != nil {
			writeError(w, http.StatusServiceUnavailable, "Dashboard JSON is invalid.")
			return
		}
		content, err = json.Marshal(localRedactJSON(value))
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "Dashboard JSON is invalid.")
			return
		}
	} else if compressible || memory {
		content = localRedact(content)
	}
	if extension == ".html" {
		content = localBackendMetadata.ReplaceAll(content, nil)
		metadata := `<meta name="dashboard-github-api-base" content="` + s.config.Prefix + `/">`
		if s.config.CaoURL != "" {
			content = localCaoMetadata.ReplaceAll(content, nil)
			metadata += "\n" + `<meta name="cao-url" content="` + html.EscapeString(s.config.CaoURL) + `">`
		}
		if s.config.Queue {
			metadata += "\n<script>globalThis.__CLI_QUEUE__ = true;</script>"
		}
		if s.app.localDatabase != nil {
			metadata += "\n" + `<meta name="dashboard-data-backend" content="server-http">` +
				"\n" + `<meta name="dashboard-storage-backend" content="sqlite">` +
				"\n" + `<meta name="dashboard-api-base" content="` + s.config.Prefix + `/">`
		}
		if localHead.Match(content) {
			content = localHead.ReplaceAllFunc(content, func(head []byte) []byte { return []byte(string(head) + "\n" + metadata) })
		} else {
			content = append([]byte(metadata+"\n"), content...)
		}
	}
	s.writeLocalContent(w, r, strings.NewReader(string(content)), compressible && len(content) >= 1024)
}

func (s *LocalServer) writeLocalContent(w http.ResponseWriter, r *http.Request, source io.Reader, compressible bool) {
	accepts := false
	for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		parts := strings.Split(strings.TrimSpace(encoding), ";")
		if !strings.EqualFold(parts[0], "gzip") {
			continue
		}
		quality := 1.0
		for _, parameter := range parts[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if ok && strings.EqualFold(key, "q") {
				var err error
				quality, err = strconv.ParseFloat(value, 64)
				if err != nil || quality < 0 || quality > 1 {
					quality = 0
				}
			}
		}
		accepts = quality > 0
		break
	}
	if compressible && accepts {
		w.Header().Set("Content-Encoding", "gzip")
		compressor := gzip.NewWriter(w)
		if _, err := io.Copy(compressor, source); err != nil {
			serverLog.Printf("local compressed response failed")
		}
		if err := compressor.Close(); err != nil {
			serverLog.Printf("local compression close failed")
		}
		return
	}
	if _, err := io.Copy(w, source); err != nil {
		serverLog.Printf("local response failed")
	}
}
