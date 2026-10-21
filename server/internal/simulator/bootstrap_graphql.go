package simulator

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"text/scanner"
)

func bootstrapArgument(query, name string, variables map[string]any) string {
	match := regexp.MustCompile(`\b` + name + `\s*:\s*(\$[A-Za-z_][A-Za-z_0-9]*|"(?:[^"\\]|\\.)*")`).FindStringSubmatch(query)
	if len(match) != 2 {
		return ""
	}
	if variable, ok := strings.CutPrefix(match[1], "$"); ok {
		value, _ := variables[variable].(string)
		return value
	}
	value, err := strconv.Unquote(match[1])
	if err != nil {
		return ""
	}
	return value
}

type bootstrapField struct {
	name, alias string
	children    []bootstrapField
}

// gh's typed GraphQL decoder rejects unrequested fields. This deliberately
// limited selection reader supports gh's aliases and named fragments, not a
// general GraphQL service. Unknown fields and syntax fail explicitly.
func bootstrapFields(query string) ([]bootstrapField, error) {
	var lexer scanner.Scanner
	lexer.Init(strings.NewReader(query))
	lexer.Mode = scanner.ScanIdents | scanner.ScanStrings
	fragments := map[string][]bootstrapField{}
	var operation []bootstrapField
	fragment := ""
	depth := 0
	for token := lexer.Scan(); token != scanner.EOF; token = lexer.Scan() {
		switch token {
		case scanner.Ident:
			if depth == 0 && lexer.TokenText() == "fragment" {
				if lexer.Scan() != scanner.Ident {
					return nil, fmt.Errorf("invalid simulator GraphQL fragment")
				}
				fragment = lexer.TokenText()
			}
		case '(':
			depth++
		case ')':
			depth--
		case '{':
			if depth != 0 {
				continue
			}
			fields, err := bootstrapSelection(&lexer, 0)
			if err != nil {
				return nil, err
			}
			switch {
			case fragment != "":
				fragments[fragment] = fields
				fragment = ""
			case operation == nil:
				operation = fields
			default:
				return nil, fmt.Errorf("multiple simulator GraphQL operations are unsupported")
			}
		}
	}
	if len(operation) == 0 {
		return nil, fmt.Errorf("simulator GraphQL query has no selection")
	}
	return bootstrapExpand(operation, fragments, 0)
}

func bootstrapWhitespace(lexer *scanner.Scanner) {
	for strings.ContainsRune(" \n\t\r,", lexer.Peek()) {
		lexer.Next()
	}
}

func bootstrapSelection(lexer *scanner.Scanner, level int) ([]bootstrapField, error) {
	if level > 16 {
		return nil, fmt.Errorf("simulator GraphQL selection exceeds depth limit")
	}
	var fields []bootstrapField
	bootstrapWhitespace(lexer)
	for token := lexer.Scan(); token != '}'; token = lexer.Scan() {
		if token == '.' {
			for range 2 {
				if lexer.Scan() != '.' {
					return nil, fmt.Errorf("unsupported simulator GraphQL fragment")
				}
			}
			if lexer.Scan() != scanner.Ident {
				return nil, fmt.Errorf("unsupported simulator GraphQL fragment")
			}
			fields = append(fields, bootstrapField{name: "..." + lexer.TokenText()})
			bootstrapWhitespace(lexer)
			continue
		}
		if token != scanner.Ident {
			return nil, fmt.Errorf("unsupported simulator GraphQL selection")
		}
		field := bootstrapField{name: lexer.TokenText(), alias: lexer.TokenText()}
		bootstrapWhitespace(lexer)
		if lexer.Peek() == ':' {
			lexer.Scan()
			if lexer.Scan() != scanner.Ident {
				return nil, fmt.Errorf("invalid simulator GraphQL alias")
			}
			field.name = lexer.TokenText()
			bootstrapWhitespace(lexer)
		}
		if lexer.Peek() == '(' {
			lexer.Scan()
			depth := 1
			for depth > 0 {
				switch lexer.Scan() {
				case '(':
					depth++
				case ')':
					depth--
				case scanner.EOF:
					return nil, fmt.Errorf("unterminated simulator GraphQL arguments")
				}
			}
		}
		bootstrapWhitespace(lexer)
		if lexer.Peek() == '{' {
			lexer.Scan()
			children, err := bootstrapSelection(lexer, level+1)
			if err != nil {
				return nil, err
			}
			field.children = children
		}
		fields = append(fields, field)
		bootstrapWhitespace(lexer)
	}
	return fields, nil
}

func bootstrapExpand(fields []bootstrapField, fragments map[string][]bootstrapField, level int) ([]bootstrapField, error) {
	if level > 16 {
		return nil, fmt.Errorf("simulator GraphQL fragment exceeds depth limit")
	}
	var result []bootstrapField
	for _, field := range fields {
		if fragment, spread := strings.CutPrefix(field.name, "..."); spread {
			selection, exists := fragments[fragment]
			if !exists {
				return nil, fmt.Errorf("undefined simulator GraphQL fragment")
			}
			expanded, err := bootstrapExpand(selection, fragments, level+1)
			if err != nil {
				return nil, err
			}
			result = append(result, expanded...)
		} else {
			children, err := bootstrapExpand(field.children, fragments, level+1)
			if err != nil {
				return nil, err
			}
			field.children = children
			result = append(result, field)
		}
	}
	return result, nil
}

func bootstrapProjection(value any, fields []bootstrapField) (any, error) {
	switch typed := value.(type) {
	case map[string]string:
		object := make(map[string]any, len(typed))
		for key, child := range typed {
			object[key] = child
		}
		return bootstrapProjection(object, fields)
	case map[string]any:
		result := map[string]any{}
		for _, field := range fields {
			child, exists := typed[field.name]
			if !exists {
				return nil, fmt.Errorf("unsupported simulator GraphQL field %s", field.name)
			}
			if len(field.children) != 0 {
				projected, err := bootstrapProjection(child, field.children)
				if err != nil {
					return nil, err
				}
				child = projected
			}
			result[field.alias] = child
		}
		return result, nil
	case []any:
		result := make([]any, len(typed))
		for i, child := range typed {
			projected, err := bootstrapProjection(child, fields)
			if err != nil {
				return nil, err
			}
			result[i] = projected
		}
		return result, nil
	case nil:
		return nil, nil
	default:
		return nil, fmt.Errorf("simulator GraphQL selection requires an object")
	}
}
