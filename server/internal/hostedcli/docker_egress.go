package hostedcli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/cliegress"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type DockerEgress struct {
	policy       *cliegress.Policy
	relay        []byte
	architecture string
}

// LoadDockerEgress snapshots the reviewed policy and verified static executable.
// Later file replacement cannot change either during this executor lifetime.
func LoadDockerEgress(policyPath, relayPath, digest string) (*DockerEgress, error) {
	if policyPath == "" || relayPath == "" || len(digest) != 64 {
		return nil, errors.New("hosted CLI Docker requires CAO_HOSTED_CLI_EGRESS_POLICY_FILE, CAO_HOSTED_CLI_EGRESS_RELAY and CAO_HOSTED_CLI_EGRESS_RELAY_SHA256; deploy the reviewed relay artifact and exact-host policy")
	}
	data, err := readBoundedFile(policyPath, cliegress.MaxPolicyBytes)
	if err != nil {
		return nil, errors.New("CAO_HOSTED_CLI_EGRESS_POLICY_FILE is unavailable or exceeds 16 KiB")
	}
	policy, err := cliegress.ParsePolicy(data)
	if err != nil {
		return nil, err
	}
	relay, err := readBoundedFile(relayPath, 16<<20)
	if err != nil {
		return nil, errors.New("CAO_HOSTED_CLI_EGRESS_RELAY must be a regular file of at most 16 MiB")
	}
	sum := sha256.Sum256(relay)
	if digest != hex.EncodeToString(sum[:]) {
		return nil, errors.New("CAO_HOSTED_CLI_EGRESS_RELAY_SHA256 does not match the reviewed relay")
	}
	binary, err := elf.NewFile(bytes.NewReader(relay))
	if err != nil || binary.Class != elf.ELFCLASS64 || binary.Data != elf.ELFDATA2LSB || binary.Type != elf.ET_EXEC {
		return nil, errors.New("hosted CLI relay must be a static Linux ELF executable")
	}
	var architecture string
	switch binary.Machine {
	case elf.EM_X86_64:
		architecture = "x86_64"
	case elf.EM_AARCH64:
		architecture = "aarch64"
	default:
		return nil, errors.New("hosted CLI relay architecture must be Linux amd64 or arm64")
	}
	for _, program := range binary.Progs {
		if program.Type == elf.PT_INTERP {
			return nil, errors.New("hosted CLI relay must not require a dynamic loader")
		}
	}
	return &DockerEgress{policy: policy, relay: relay, architecture: architecture}, nil
}

func readBoundedFile(path string, limit int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("invalid file")
	}
	// #nosec G304 -- explicit operator configuration, bounded regular-file read; relay integrity is independently verified.
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("invalid file")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("invalid file")
	}
	return data, nil
}

func (r *DockerContainerLifecycle) prepareEgress(ctx context.Context, execution operational.CLICommandExecution, workspace string) (string, error) {
	value, code, err := r.capture(ctx, []string{"info", "--format={{.OSType}}/{{.Architecture}}"})
	if err != nil || code != 0 || strings.TrimSpace(value) != "linux/"+r.Egress.architecture {
		return "", errors.New("hosted CLI egress requires a Linux Docker daemon matching the verified relay architecture")
	}
	directory := filepath.Join(workspace, ".cao-egress")
	if err := os.Mkdir(directory, 0o700); err != nil {
		return "", errors.New("hosted CLI private egress directory could not be created")
	}
	// #nosec G306 -- verified executable, owner read/execute only, mounted read-only.
	if err := os.WriteFile(filepath.Join(directory, "relay"), r.Egress.relay, 0o500); err != nil {
		return "", errors.New("hosted CLI verified relay could not be prepared")
	}
	socket := filepath.Join(directory, "proxy.sock")
	listener, err := (&net.ListenConfig{}).Listen(ctx, "unix", socket)
	if err != nil {
		return "", errors.New("hosted CLI private egress socket is unavailable; use a short local --work-root path on the Docker host")
	}
	if err := os.Chmod(socket, 0o600); err != nil {
		_ = listener.Close()
		return "", errors.New("hosted CLI private egress socket could not be protected")
	}
	closeProxy := cliegress.Serve(ctx, listener, r.Egress.policy)
	r.egressMu.Lock()
	if r.egressClosers == nil {
		r.egressClosers = map[string]func(){}
	}
	r.egressClosers[execution.Name] = closeProxy
	r.egressMu.Unlock()
	context.AfterFunc(ctx, func() { r.stopEgress(execution.Name) })
	return directory, nil
}

func (r *DockerContainerLifecycle) stopEgress(name string) {
	r.egressMu.Lock()
	closeProxy := r.egressClosers[name]
	delete(r.egressClosers, name)
	r.egressMu.Unlock()
	if closeProxy != nil {
		closeProxy()
	}
}
