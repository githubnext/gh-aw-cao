package hostedcli

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

const (
	windowsSandboxArchiveLimit = 512 << 20
	windowsSandboxOutputLimit  = 16 << 20
	windowsSandboxResponseMax  = 64 << 10
)

var windowsSandboxDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var windowsSandboxGUID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func windowsSandboxID(execution operational.CLICommandExecution) (string, error) {
	if execution.Validate() != nil {
		return "", errors.New("hosted CLI Windows Sandbox execution identity is invalid")
	}
	id := strings.TrimPrefix(execution.Name, "cao-hosted-cli-")
	return id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:], nil
}

type windowsSandboxInstance struct {
	ID     string
	Status string
}

// Microsoft documents --raw, ID, running/stopped, and current-user inventory,
// but not its JSON schema. This deliberately accepts only an array of objects
// with Id/Status and optional Uptime (case-insensitive keys). A different CLI
// version must fail closed, never turn an unrecognized envelope into absence.
// The wire shape still requires validation on the installed Windows 24H2 CLI.
func parseWindowsSandboxInventory(data []byte) ([]windowsSandboxInstance, error) {
	invalid := errors.New("hosted CLI Windows Sandbox inventory is unavailable or has an unsupported JSON schema")
	data = bytes.TrimSpace(data)
	if len(data) == 0 || len(data) > windowsSandboxResponseMax || data[0] != '[' {
		return nil, invalid
	}
	var entries []json.RawMessage
	if json.Unmarshal(data, &entries) != nil || entries == nil || len(entries) > 1 {
		return nil, invalid
	}
	result := make([]windowsSandboxInstance, 0, len(entries))
	for _, entry := range entries {
		// Token decoding also rejects duplicate keys; map unmarshalling does not.
		decoder := json.NewDecoder(bytes.NewReader(entry))
		token, err := decoder.Token()
		if err != nil || token != json.Delim('{') {
			return nil, invalid
		}
		values := map[string]string{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, invalid
			}
			name, ok := key.(string)
			name = strings.ToLower(name)
			if !ok || (name != "id" && name != "status" && name != "uptime") {
				return nil, invalid
			}
			if _, duplicate := values[name]; duplicate {
				return nil, invalid
			}
			var value string
			if decoder.Decode(&value) != nil {
				return nil, invalid
			}
			values[name] = value
		}
		if _, err := decoder.Token(); err != nil {
			return nil, invalid
		}
		status := strings.ToLower(values["status"])
		if !windowsSandboxGUID.MatchString(values["id"]) || (status != "running" && status != "stopped") {
			return nil, invalid
		}
		result = append(result, windowsSandboxInstance{ID: strings.ToLower(values["id"]), Status: status})
	}
	return result, nil
}

func (r *windowsSandboxLifecycle) capture(ctx context.Context, args ...string) ([]byte, error) {
	var output bytes.Buffer
	var mutex sync.Mutex
	overflow := false
	code, err := r.commands.Run(ctx, Process{
		Program: r.binary, Args: append(args, "--raw"), Env: r.host.env,
	}, func(stream string, data []byte) {
		mutex.Lock()
		defer mutex.Unlock()
		if stream != "stdout" {
			return
		}
		if output.Len()+len(data) > windowsSandboxResponseMax {
			overflow = true
			return
		}
		_, _ = output.Write(data)
	})
	if err != nil || code != 0 || overflow {
		// Runtime diagnostics can include invocation data. Never return them.
		return nil, errors.New("hosted CLI Windows Sandbox control request failed")
	}
	return output.Bytes(), nil
}

func (r *windowsSandboxLifecycle) inventory(ctx context.Context) ([]windowsSandboxInstance, error) {
	data, err := r.capture(ctx, "list")
	if err != nil {
		return nil, err
	}
	return parseWindowsSandboxInventory(data)
}

func windowsSandboxConfig(input, workspace string) (string, error) {
	type folder struct {
		HostFolder    string
		SandboxFolder string
		ReadOnly      bool
	}
	config := struct {
		XMLName              xml.Name `xml:"Configuration"`
		VGPU                 string   `xml:"vGPU"`
		Networking           string
		AudioInput           string
		VideoInput           string
		ProtectedClient      string
		PrinterRedirection   string
		ClipboardRedirection string
		MemoryInMB           int
		Folders              []folder `xml:"MappedFolders>MappedFolder"`
	}{
		VGPU: "Disable", Networking: "Enable", AudioInput: "Disable", VideoInput: "Disable",
		ProtectedClient: "Enable", PrinterRedirection: "Disable", ClipboardRedirection: "Disable",
		MemoryInMB: 2048,
		Folders: []folder{
			{HostFolder: input, SandboxFolder: `C:\cao-input`, ReadOnly: true},
			{HostFolder: workspace, SandboxFolder: `C:\cao-workspace`, ReadOnly: false},
		},
	}
	data, err := xml.Marshal(config)
	return string(data), err
}

type windowsSandboxInvocation struct {
	Execution operational.CLICommandExecution `json:"execution"`
	SHA256    string                          `json:"sha256"`
	Program   string                          `json:"program"`
	Args      []string                        `json:"args"`
	Directory string                          `json:"directory"`
	Env       map[string]string               `json:"env"`
}

func windowsSandboxEnvironment(entries []string) (map[string]string, error) {
	size := 0
	for _, entry := range entries {
		if len(entry) > 32<<10 || size > (32<<10)-len(entry) {
			return nil, errors.New("hosted CLI Windows Sandbox environment exceeds its limit")
		}
		size += len(entry)
	}
	if len(entries) > 64 {
		return nil, errors.New("hosted CLI Windows Sandbox environment exceeds its limit")
	}
	allowed := map[string]bool{
		"HOME": true, "XDG_CONFIG_HOME": true, "XDG_CACHE_HOME": true, "XDG_DATA_HOME": true, "GH_CONFIG_DIR": true,
		"LANG": true, "NO_COLOR": true, "GH_PROMPT_DISABLED": true, "GH_NO_UPDATE_NOTIFIER": true,
		"GH_NO_EXTENSION_UPDATE_NOTIFIER": true, "GH_TOKEN": true, "GH_HOST": true, "GH_ENTERPRISE_TOKEN": true,
		"GIT_TERMINAL_PROMPT": true, "GIT_CONFIG_NOSYSTEM": true, "GIT_CONFIG_SYSTEM": true,
		"GIT_AUTHOR_NAME": true, "GIT_AUTHOR_EMAIL": true, "GIT_COMMITTER_NAME": true, "GIT_COMMITTER_EMAIL": true,
		"TRACEPARENT": true,
	}
	fixed := map[string]string{
		"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "",
		"GIT_CONFIG_KEY_1": "credential.helper", "GIT_CONFIG_VALUE_1": "!gh auth git-credential",
	}
	result := make(map[string]string, len(entries))
	for _, entry := range entries {
		name, value, ok := strings.Cut(entry, "=")
		expected, isFixed := fixed[name]
		_, duplicate := result[name]
		if !ok || duplicate || (!allowed[name] && !isFixed) || (isFixed && value != expected) ||
			strings.ContainsAny(value, "\x00\r\n") {
			return nil, errors.New("hosted CLI Windows Sandbox command environment is invalid")
		}
		switch name {
		case "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "GH_CONFIG_DIR":
			if !strings.HasPrefix(value, "/workspace/") || path.Clean(value) != value || strings.ContainsAny(value, `\:%`) {
				return nil, errors.New("hosted CLI Windows Sandbox environment path is invalid")
			}
			value = `C:\cao-workspace\` + strings.ReplaceAll(strings.TrimPrefix(value, "/workspace/"), "/", `\`)
		case "GIT_CONFIG_SYSTEM":
			if value != "/dev/null" {
				return nil, errors.New("hosted CLI Windows Sandbox system Git configuration must be disabled")
			}
			value = "NUL"
		}
		result[name] = value
	}
	return result, nil
}

func windowsSandboxPaths(workspace, directory string) (string, string, error) {
	workspace, guest, err := containerPaths(workspace, directory)
	if err != nil {
		return "", "", err
	}
	// .wsb expands %variables%; reject them rather than mounting a wider path.
	if strings.ContainsAny(workspace, "%\x00\r\n") || strings.HasPrefix(workspace, `\\`) ||
		strings.ContainsAny(guest, "%:\x00\r\n") {
		return "", "", errors.New("hosted CLI Windows Sandbox requires local, unambiguous workspace paths")
	}
	return workspace, strings.ReplaceAll(strings.Replace(guest, "/workspace", `C:\cao-workspace`, 1), "/", `\`), nil
}

// The ZIP is a self-contained, architecture-matched portable Windows payload:
// gh/gh.exe, gh-aw/gh-aw.exe, git/cmd/git.exe, git/usr/bin/sh.exe, and all their
// DLLs, certificates and Git helpers in the same vendor directory layouts.
// No installers, scripts from the host, or host executable fallback are used.
// Pin the entire ZIP, not just a manifest. The guest rehashes the staged ZIP.
func validateWindowsSandboxArchive(file *os.File, digest string) error {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > windowsSandboxArchiveLimit {
		return errors.New("hosted CLI Windows Sandbox tools archive is not a bounded regular ZIP")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, io.NewSectionReader(file, 0, info.Size())); err != nil ||
		hex.EncodeToString(hash.Sum(nil)) != digest {
		return errors.New("hosted CLI Windows Sandbox tools archive SHA256 does not match")
	}
	reader, err := zip.NewReader(file, info.Size())
	if err != nil || len(reader.File) > 20000 {
		return errors.New("hosted CLI Windows Sandbox tools archive is invalid")
	}
	required := map[string]bool{"gh/gh.exe": false, "gh-aw/gh-aw.exe": false, "git/cmd/git.exe": false, "git/usr/bin/sh.exe": false}
	seen := make(map[string]bool, len(reader.File))
	var total uint64
	for _, entry := range reader.File {
		name := strings.TrimSuffix(strings.ToLower(entry.Name), "/")
		if !windowsSandboxZIPPath(name) || seen[name] || (!entry.Mode().IsRegular() && !entry.FileInfo().IsDir()) {
			return errors.New("hosted CLI Windows Sandbox tools archive contains an unsafe path")
		}
		seen[name] = true
		if entry.UncompressedSize64 > 1<<30 || total > (1<<30)-entry.UncompressedSize64 {
			return errors.New("hosted CLI Windows Sandbox expanded tools exceed their limit")
		}
		total += entry.UncompressedSize64
		if _, ok := required[name]; ok && entry.Mode().IsRegular() {
			required[name] = true
		}
	}
	for _, found := range required {
		if !found {
			return errors.New("hosted CLI Windows Sandbox tools archive is missing a required native executable")
		}
	}
	return nil
}

func windowsSandboxZIPPath(name string) bool {
	if name == "" || path.Clean(name) != name || strings.ContainsAny(name, `\:*?"<>|`+"\x00\r\n") {
		return false
	}
	parts := strings.Split(name, "/")
	if parts[0] != "gh" && parts[0] != "gh-aw" && parts[0] != "git" {
		return false
	}
	for _, part := range parts {
		base := strings.SplitN(part, ".", 2)[0]
		if part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") ||
			base == "con" || base == "prn" || base == "aux" || base == "nul" ||
			(len(base) == 4 && (strings.HasPrefix(base, "com") || strings.HasPrefix(base, "lpt")) && base[3] >= '0' && base[3] <= '9') {
			return false
		}
	}
	return true
}

func windowsSandboxReadJSON(root *os.Root, name string, value any) error {
	file, err := root.Open(name)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > windowsSandboxResponseMax {
		return errors.New("hosted CLI Windows Sandbox evidence is not a bounded regular file")
	}
	decoder := json.NewDecoder(io.LimitReader(file, windowsSandboxResponseMax+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("hosted CLI Windows Sandbox evidence is invalid")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("hosted CLI Windows Sandbox evidence has trailing data")
	}
	return nil
}

func windowsSandboxWriteJSON(root *os.Root, name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) > windowsSandboxResponseMax {
		return errors.New("hosted CLI Windows Sandbox invocation or state exceeds its limit")
	}
	next := name + ".next"
	file, err := root.OpenFile(next, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("hosted CLI Windows Sandbox state could not be staged")
	}
	defer func() {
		_ = file.Close()
		_ = root.Remove(next)
	}()
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return root.Rename(next, name)
}

func windowsSandboxRecordPath(execution operational.CLICommandExecution) string {
	return filepath.Join(execution.Name, "state.json")
}
