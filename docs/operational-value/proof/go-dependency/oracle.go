package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"strconv"
)

type Input struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type Site struct {
	Function string `json:"function"`
	Key      string `json:"key"`
	Kind     string `json:"kind"`
	Line     int    `json:"line"`
}

type Result struct {
	ID    string `json:"id"`
	Valid bool   `json:"valid"`
	Error string `json:"error,omitempty"`
	Sites []Site `json:"sites"`
}

func expression(node ast.Node) string {
	var out bytes.Buffer
	if err := format.Node(&out, token.NewFileSet(), node); err != nil {
		panic(err)
	}
	return out.String()
}

func analyze(input Input) Result {
	result := Result{ID: input.ID, Sites: []Site{}}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, input.ID, input.Text, parser.ParseComments)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Valid = true
	aliases := map[string]string{}
	for _, spec := range file.Imports {
		value, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			panic(err)
		}
		name := ""
		switch value {
		case "github.com/stretchr/testify/assert":
			name = "assert"
		case "github.com/stretchr/testify/require":
			name = "require"
		}
		if name == "" {
			continue
		}
		if spec.Name != nil {
			name = spec.Name.Name
		}
		aliases[name] = value
	}
	for _, declaration := range file.Decls {
		fn, ok := declaration.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		function := fn.Name.Name
		if fn.Recv != nil && len(fn.Recv.List) > 0 {
			function = expression(fn.Recv.List[0].Type) + "." + function
		}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) < 3 || call.Ellipsis.IsValid() {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			alias, ok := selector.X.(*ast.Ident)
			if !ok || alias.Obj != nil || aliases[alias.Name] == "" {
				return true
			}
			var errorValue ast.Expr
			kind := ""
			if selector.Sel.Name == "Contains" {
				errorCall, ok := call.Args[1].(*ast.CallExpr)
				if !ok || len(errorCall.Args) != 0 {
					return true
				}
				errorSelector, ok := errorCall.Fun.(*ast.SelectorExpr)
				if !ok || errorSelector.Sel.Name != "Error" {
					return true
				}
				errorValue = errorSelector.X
				kind = "error-string-contains"
			} else if selector.Sel.Name == "ErrorContains" {
				errorValue = call.Args[1]
				kind = "error-contains"
			} else {
				return true
			}
			args := []ast.Expr{call.Args[0], errorValue}
			args = append(args, call.Args[2:]...)
			normalized := &ast.CallExpr{Fun: ast.NewIdent("errorAssertion"), Args: args}
			result.Sites = append(result.Sites, Site{Function: function, Key: expression(normalized),
				Kind: kind, Line: fset.Position(call.Pos()).Line})
			return true
		})
	}
	return result
}

func main() {
	var inputs []Input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	results := make([]Result, 0, len(inputs))
	for _, input := range inputs {
		results = append(results, analyze(input))
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
