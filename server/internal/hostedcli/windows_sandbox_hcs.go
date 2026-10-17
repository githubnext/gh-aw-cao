package hostedcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// HcsEnumerateComputeSystems(NULL, operation) enumerates all HCS compute
// systems, without filtering by owner, name, or ID. Its documented result is
// an array of Properties with Id and SystemType ("Container"/"VirtualMachine").
// Other Properties fields are not used to infer absence: even a stopped or
// paused VirtualMachine counts against this exclusive-HCS-VM profile.
//
// https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsenumeratecomputesystems
// https://learn.microsoft.com/en-us/virtualization/api/hcs/schemareference#Properties
func parseWindowsSandboxHCSInventory(data []byte) (int, error) {
	invalid := errors.New("hosted CLI Windows Sandbox HCS inventory is malformed or unsupported")
	data = bytes.TrimSpace(data)
	if len(data) == 0 || len(data) > windowsSandboxResponseMax || data[0] != '[' {
		return 0, invalid
	}
	var entries []json.RawMessage
	if json.Unmarshal(data, &entries) != nil || entries == nil || len(entries) > 1024 {
		return 0, invalid
	}
	ids := make(map[string]bool, len(entries))
	count := 0
	for _, entry := range entries {
		decoder := json.NewDecoder(bytes.NewReader(entry))
		token, err := decoder.Token()
		if err != nil || token != json.Delim('{') {
			return 0, invalid
		}
		fields := map[string]bool{}
		var id, systemType string
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				return 0, invalid
			}
			key, ok := token.(string)
			key = strings.ToLower(key)
			if !ok || fields[key] {
				return 0, invalid
			}
			fields[key] = true
			switch key {
			case "id":
				if decoder.Decode(&id) != nil {
					return 0, invalid
				}
			case "systemtype":
				if decoder.Decode(&systemType) != nil {
					return 0, invalid
				}
			default:
				if decoder.Decode(new(json.RawMessage)) != nil {
					return 0, invalid
				}
			}
		}
		if _, err := decoder.Token(); err != nil {
			return 0, invalid
		}
		id = strings.ToLower(id)
		if strings.TrimSpace(id) == "" || len(id) > 128 || strings.ContainsAny(id, "\x00\r\n") || ids[id] {
			return 0, invalid
		}
		ids[id] = true
		switch systemType {
		case "VirtualMachine":
			count++
		case "Container":
		default:
			return 0, invalid
		}
	}
	return count, nil
}

func (r *windowsSandboxLifecycle) hcsVMCount(ctx context.Context) (int, error) {
	if r.host.computeSystems == nil {
		return 0, errors.New("hosted CLI Windows Sandbox requires independent HCS VM inventory")
	}
	data, err := r.host.computeSystems(ctx)
	if err != nil {
		// Native diagnostics can contain other workloads' metadata. Do not
		// forward the result document or raw platform error to command logs.
		return 0, errors.New("hosted CLI Windows Sandbox independent HCS VM inventory is unavailable")
	}
	return parseWindowsSandboxHCSInventory(data)
}
