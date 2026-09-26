package repositorymemory

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MaxFileCount = 400
	MaxFileSize  = 1024 * 1024
	MaxNesting   = 10
	MaxTotalSize = 64 * 1024 * 1024
)

var campaignPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,99}$`)
var objectIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{40,64}$`)
var allowedExtensions = map[string]struct{}{
	".json": {}, ".jsonl": {}, ".md": {}, ".txt": {}, ".yaml": {}, ".yml": {},
}

type File struct {
	Path   string `json:"path"`
	OID    string `json:"oid"`
	SHA256 string `json:"sha256,omitempty"`
	Size   int64  `json:"size"`
}

type Omissions struct {
	FileLimit       int `json:"fileLimit"`
	FileSize        int `json:"fileSize"`
	Extension       int `json:"extension"`
	Nesting         int `json:"nesting"`
	UnsafePath      int `json:"unsafePath"`
	InvalidContent  int `json:"invalidContent"`
	UnsupportedType int `json:"unsupportedType"`
}

type Campaign struct {
	Campaign string    `json:"campaign"`
	Branch   string    `json:"branch"`
	Commit   string    `json:"commit"`
	Files    []File    `json:"files"`
	Omitted  Omissions `json:"omitted"`
}

type Manifest struct {
	Version     int        `json:"version"`
	GeneratedAt string     `json:"generatedAt,omitempty"`
	Limits      any        `json:"limits,omitempty"`
	Campaigns   []Campaign `json:"campaigns"`
}

type Snapshot struct {
	Manifest []byte
	Files    map[string][]byte
	Revision string
}

func FileKey(campaign, path string) string {
	return campaign + "\x00" + path
}

func ValidCampaign(value string) bool {
	return campaignPattern.MatchString(value)
}

func ValidPath(value string) bool {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, `\`) {
		return false
	}
	segments := strings.Split(value, "/")
	if len(segments)-1 > MaxNesting {
		return false
	}
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	_, allowed := allowedExtensions[strings.ToLower(filepath.Ext(value))]
	return allowed
}

func Load(directory string) (Snapshot, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return Snapshot{}, fmt.Errorf("open repository-memory root: %w", err)
	}
	defer root.Close()
	manifestPath := filepath.Join("memory", "manifest.json")
	var content []byte
	manifestFile, err := openRegularFile(root, manifestPath)
	if errors.Is(err, os.ErrNotExist) {
		content = []byte(`{"version":1,"campaigns":[]}`)
	} else if err != nil {
		return Snapshot{}, fmt.Errorf("read repository-memory manifest: %w", err)
	} else {
		content, err = io.ReadAll(manifestFile)
		closeErr := manifestFile.Close()
		if err != nil || closeErr != nil {
			return Snapshot{}, errors.New("read repository-memory manifest: unavailable")
		}
	}
	var manifest Manifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return Snapshot{}, fmt.Errorf("parse repository-memory manifest: %w", err)
	}
	if manifest.Version != 1 || manifest.Campaigns == nil {
		return Snapshot{}, errors.New("repository-memory manifest is invalid")
	}
	var totalSize int64
	for _, campaign := range manifest.Campaigns {
		for _, file := range campaign.Files {
			if file.Size >= 0 && file.Size <= MaxFileSize {
				if file.Size > MaxTotalSize-totalSize {
					return Snapshot{}, errors.New("repository-memory files exceed the total size limit")
				}
				totalSize += file.Size
			}
		}
	}
	files := make(map[string][]byte)
	seenCampaigns := make(map[string]struct{})
	for campaignIndex := range manifest.Campaigns {
		campaign := &manifest.Campaigns[campaignIndex]
		if !ValidCampaign(campaign.Campaign) || campaign.Branch != "memory/"+campaign.Campaign ||
			!objectIDPattern.MatchString(campaign.Commit) ||
			len(campaign.Files) > MaxFileCount {
			return Snapshot{}, fmt.Errorf("repository-memory campaign %q is invalid", campaign.Campaign)
		}
		if _, exists := seenCampaigns[campaign.Campaign]; exists {
			return Snapshot{}, fmt.Errorf("repository-memory campaign %q is duplicated", campaign.Campaign)
		}
		seenCampaigns[campaign.Campaign] = struct{}{}
		if campaign.Omitted.FileLimit < 0 || campaign.Omitted.FileSize < 0 ||
			campaign.Omitted.Extension < 0 || campaign.Omitted.Nesting < 0 ||
			campaign.Omitted.UnsafePath < 0 || campaign.Omitted.InvalidContent < 0 ||
			campaign.Omitted.UnsupportedType < 0 {
			return Snapshot{}, fmt.Errorf("repository-memory campaign %q has invalid omission counts", campaign.Campaign)
		}
		for fileIndex := range campaign.Files {
			file := &campaign.Files[fileIndex]
			if !ValidPath(file.Path) || file.Size < 0 || file.Size > MaxFileSize ||
				!objectIDPattern.MatchString(file.OID) {
				return Snapshot{}, fmt.Errorf("repository-memory file %q is invalid", file.Path)
			}
			fullPath := filepath.Join("memory", campaign.Campaign, filepath.FromSlash(file.Path))
			handle, err := openRegularFile(root, fullPath)
			if err != nil {
				return Snapshot{}, fmt.Errorf("read repository-memory file %q: unavailable", file.Path)
			}
			payload, readErr := io.ReadAll(io.LimitReader(handle, MaxFileSize+1))
			closeErr := handle.Close()
			if readErr != nil || closeErr != nil || len(payload) > MaxFileSize ||
				int64(len(payload)) != file.Size || !utf8.Valid(payload) {
				return Snapshot{}, fmt.Errorf("read repository-memory file %q: invalid size", file.Path)
			}
			sum := sha256.Sum256(payload)
			digest := hex.EncodeToString(sum[:])
			if file.SHA256 != "" && !strings.EqualFold(file.SHA256, digest) {
				return Snapshot{}, fmt.Errorf("repository-memory file %q has a hash mismatch", file.Path)
			}
			file.SHA256 = digest
			files[FileKey(campaign.Campaign, file.Path)] = payload
		}
	}
	normalized, err := json.Marshal(manifest)
	if err != nil {
		return Snapshot{}, err
	}
	revisionManifest := manifest
	revisionManifest.GeneratedAt = ""
	revisionBytes, err := json.Marshal(revisionManifest)
	if err != nil {
		return Snapshot{}, err
	}
	revision := sha256.Sum256(revisionBytes)
	return Snapshot{Manifest: normalized, Files: files, Revision: hex.EncodeToString(revision[:])}, nil
}

func openRegularFile(root *os.Root, name string) (*os.File, error) {
	segments := strings.Split(filepath.Clean(name), string(filepath.Separator))
	for index := range segments {
		info, err := root.Lstat(filepath.Join(segments[:index+1]...))
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 ||
			(index < len(segments)-1 && !info.IsDir()) ||
			(index == len(segments)-1 && !info.Mode().IsRegular()) {
			return nil, errors.New("repository-memory path is not a regular file")
		}
	}
	return root.Open(name)
}
