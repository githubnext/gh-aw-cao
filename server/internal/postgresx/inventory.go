package postgresx

import (
	"errors"
	"fmt"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

type inventoryBinding struct {
	field                           string
	inputs                          []string
	defaultPresent                  bool
	defaultValue                    any
	trim, omitEmpty                 bool
	equalsPresent, notEqualsPresent bool
	equals, notEquals               any
}

// NormalizeInventoryFields applies the scalar observation mappings generated
// from ingestion.json, restricted to fields in the TypeSpec native model.
func NormalizeInventoryFields(name string, input model.Row) (model.Row, error) {
	bindings, exists := inventoryBindings[name]
	if !exists {
		return nil, errors.New("inventory observation kind is not registered")
	}
	row := model.Row{}
	for _, binding := range bindings {
		var value any
		present := false
		for _, field := range binding.inputs {
			if candidate, exists := input[field]; exists && candidate != nil {
				value, present = candidate, true
				break
			}
		}
		if !present && binding.defaultPresent {
			value, present = binding.defaultValue, true
		}
		if binding.trim && value != nil {
			value = strings.TrimSpace(fmt.Sprint(value))
		}
		if value == "" && binding.defaultPresent {
			value = binding.defaultValue
		}
		if binding.omitEmpty && value == "" {
			continue
		}
		if binding.equalsPresent {
			value, present = value == binding.equals, true
		}
		if binding.notEqualsPresent {
			value, present = value != binding.notEquals, true
		}
		if present {
			row[binding.field] = value
		}
	}
	return row, nil
}
