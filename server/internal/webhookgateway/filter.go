package webhookgateway

import (
	"bytes"
	"encoding/json"
	"io"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

// DefaultLimits returns the hard ceilings; callers may only tighten them.
func DefaultLimits() Limits {
	return Limits{MaxMetadataBytes: 262144, MaxEventBytes: 1048576,
		MaxJSONDepth: 32, MaxJSONNodes: 50000, MaxFilterDepth: 16,
		MaxFilterNodes: 128, MaxPathBytes: 512, MaxPathSegments: 32,
		MaxStringBytes: 65536, MaxArrayItems: 1024,
		MaxDispatchBytes: 65536, MaxDispatchProperties: 10}
}

func resolveLimits(l Limits) (Limits, error) {
	defaults := DefaultLimits()
	v, d := reflect.ValueOf(&l).Elem(), reflect.ValueOf(defaults)
	for i := 0; i < v.NumField(); i++ {
		n := v.Field(i).Int()
		if n == 0 {
			v.Field(i).SetInt(d.Field(i).Int())
		} else if n < 0 || n > d.Field(i).Int() {
			return Limits{}, ErrInvalid
		}
	}
	return l, nil
}

// boundedJSON checks resource limits and duplicate object keys before creating a tree.
func boundedJSON(data []byte, maxBytes int, l Limits) (any, error) {
	if len(data) == 0 || len(data) > maxBytes || !utf8.Valid(data) {
		return nil, ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	nodes := 0
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		nodes++
		if depth > l.MaxJSONDepth || nodes > l.MaxJSONNodes {
			return nil, ErrInvalid
		}
		token, err := d.Token()
		if err != nil {
			return nil, ErrInvalid
		}
		switch t := token.(type) {
		case json.Delim:
			switch t {
			case '{':
				m := make(map[string]any)
				for d.More() {
					key, err := d.Token()
					s, ok := key.(string)
					if err != nil || !ok || len(s) > l.MaxStringBytes {
						return nil, ErrInvalid
					}
					if _, exists := m[s]; exists {
						return nil, ErrInvalid
					}
					value, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					m[s] = value
				}
				end, err := d.Token()
				if err != nil || end != json.Delim('}') {
					return nil, ErrInvalid
				}
				return m, nil
			case '[':
				a := []any{}
				for d.More() {
					if len(a) >= l.MaxArrayItems {
						return nil, ErrInvalid
					}
					value, err := read(depth + 1)
					if err != nil {
						return nil, err
					}
					a = append(a, value)
				}
				end, err := d.Token()
				if err != nil || end != json.Delim(']') {
					return nil, ErrInvalid
				}
				return a, nil
			default:
				return nil, ErrInvalid
			}
		case string:
			if len(t) > l.MaxStringBytes {
				return nil, ErrInvalid
			}
		}
		return token, nil
	}
	result, err := read(1)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, ErrInvalid
	}
	return result, nil
}

func pointer(path string, l Limits) ([]string, error) {
	if len(path) == 0 || len(path) > l.MaxPathBytes || path[0] != '/' {
		return nil, ErrInvalid
	}
	parts := strings.Split(path[1:], "/")
	if len(parts) > l.MaxPathSegments {
		return nil, ErrInvalid
	}
	for i, part := range parts {
		var b strings.Builder
		for n := 0; n < len(part); n++ {
			if part[n] != '~' {
				b.WriteByte(part[n])
				continue
			}
			n++
			if n >= len(part) || (part[n] != '0' && part[n] != '1') {
				return nil, ErrInvalid
			}
			if part[n] == '0' {
				b.WriteByte('~')
			} else {
				b.WriteByte('/')
			}
		}
		parts[i] = b.String()
	}
	return parts, nil
}

func lookup(root any, path string, l Limits) (any, bool) {
	parts, err := pointer(path, l)
	if err != nil {
		return nil, false
	}
	value := root
	for _, p := range parts {
		switch v := value.(type) {
		case map[string]any:
			var exists bool
			value, exists = v[p]
			if !exists {
				return nil, false
			}
		case []any:
			if p == "" || (len(p) > 1 && p[0] == '0') {
				return nil, false
			}
			i, err := strconv.ParseUint(p, 10, 32)
			if err != nil || i >= uint64(len(v)) {
				return nil, false
			}
			value = v[i]
		default:
			return nil, false
		}
	}
	return value, true
}

func scalar(v any) bool {
	switch v.(type) {
	case nil, string, bool, json.Number:
		return true
	default:
		return false
	}
}

func equal(a, b any) (bool, bool) {
	if reflect.TypeOf(a) != reflect.TypeOf(b) || !scalar(a) {
		return false, false
	}
	if x, ok := a.(json.Number); ok {
		y := b.(json.Number)
		// Bound exponents before big.Rat allocation: JSON permits enormous exponents.
		if len(x) > 128 || len(y) > 128 {
			return false, false
		}
		for _, n := range []json.Number{x, y} {
			if i := strings.IndexAny(string(n), "eE"); i >= 0 {
				exponent, err := strconv.ParseInt(string(n)[i+1:], 10, 32)
				if err != nil || exponent > 1024 || exponent < -1024 {
					return false, false
				}
			}
		}
		rx, okx := new(big.Rat).SetString(string(x))
		ry, oky := new(big.Rat).SetString(string(y))
		if !okx || !oky {
			return false, false
		}
		return rx.Cmp(ry) == 0, true
	}
	return reflect.DeepEqual(a, b), true
}

func validateFilter(f Filter, l Limits, depth int, nodes *int) error {
	*nodes++
	if depth > l.MaxFilterDepth || *nodes > l.MaxFilterNodes {
		return ErrInvalid
	}
	switch f.Op {
	case "and", "or", "not":
		if f.Path != "" || len(f.Value) != 0 || len(f.Args) == 0 ||
			(f.Op == "not" && len(f.Args) != 1) {
			return ErrInvalid
		}
		for _, arg := range f.Args {
			if err := validateFilter(arg, l, depth+1, nodes); err != nil {
				return err
			}
		}
	case "eq", "ne", "in", "exists", "contains":
		if len(f.Args) != 0 {
			return ErrInvalid
		}
		if _, err := pointer(f.Path, l); err != nil {
			return err
		}
		value, err := boundedJSON(f.Value, l.MaxMetadataBytes, l)
		if err != nil {
			return err
		}
		switch f.Op {
		case "exists":
			if _, ok := value.(bool); !ok {
				return ErrInvalid
			}
		case "in":
			a, ok := value.([]any)
			if !ok || len(a) == 0 {
				return ErrInvalid
			}
			for _, item := range a {
				if !scalar(item) {
					return ErrInvalid
				}
			}
		default:
			if !scalar(value) {
				return ErrInvalid
			}
		}
	default:
		return ErrInvalid
	}
	return nil
}

func truth(v bool) Truth {
	if v {
		return True
	}
	return False
}

func evaluate(f Filter, root any, l Limits) Truth {
	if f.Op == "not" {
		switch evaluate(f.Args[0], root, l) {
		case True:
			return False
		case False:
			return True
		default:
			return Unknown
		}
	}
	if f.Op == "and" || f.Op == "or" {
		unknown := false
		for _, arg := range f.Args {
			t := evaluate(arg, root, l)
			if f.Op == "and" && t == False {
				return False
			}
			if f.Op == "or" && t == True {
				return True
			}
			unknown = unknown || t == Unknown
		}
		if unknown {
			return Unknown
		}
		return truth(f.Op == "and")
	}
	left, exists := lookup(root, f.Path, l)
	right, _ := boundedJSON(f.Value, l.MaxMetadataBytes, l)
	if f.Op == "exists" {
		return truth(exists == right.(bool))
	}
	if !exists {
		return Unknown
	}
	switch f.Op {
	case "eq", "ne":
		same, compatible := equal(left, right)
		if !compatible {
			return Unknown
		}
		return truth(same == (f.Op == "eq"))
	case "in":
		compatible := false
		for _, item := range right.([]any) {
			same, ok := equal(left, item)
			compatible = compatible || ok
			if ok && same {
				return True
			}
		}
		if compatible {
			return False
		}
	case "contains":
		switch value := left.(type) {
		case string:
			if needle, ok := right.(string); ok {
				return truth(strings.Contains(value, needle))
			}
		case []any:
			compatible := len(value) == 0
			for _, item := range value {
				same, ok := equal(item, right)
				compatible = compatible || ok
				if ok && same {
					return True
				}
			}
			if compatible {
				return False
			}
		}
	}
	return Unknown
}

// EvaluateFilter evaluates only validated expressions; Unknown never counts as a match.
func EvaluateFilter(f Filter, payload json.RawMessage, limits Limits) (Truth, error) {
	l, err := resolveLimits(limits)
	if err != nil {
		return Unknown, err
	}
	nodes := 0
	if err := validateFilter(f, l, 1, &nodes); err != nil {
		return Unknown, err
	}
	root, err := boundedJSON(payload, l.MaxEventBytes, l)
	if err != nil {
		return Unknown, err
	}
	return evaluate(f, root, l), nil
}
