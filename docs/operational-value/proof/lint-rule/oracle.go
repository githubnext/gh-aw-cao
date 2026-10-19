package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strconv"
	"strings"
)

type Input struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

type Output struct {
	Known       bool   `json:"known"`
	Reason      string `json:"reason,omitempty"`
	RawExits    int    `json:"rawExits"`
	ReturnCodes int    `json:"returnCodes"`
	Package     string `json:"package"`
	Exits       []Site `json:"exits"`
	Returns     []Site `json:"returns"`
}

type Site struct {
	Function string `json:"function"`
	Code     string `json:"code"`
}

func inspect(input Input) Output {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, input.Path, input.Source, parser.ParseComments)
	if err != nil {
		return Output{Reason: "Go syntax unavailable: " + err.Error()}
	}
	out := Output{Known: true, Package: f.Name.Name, Exits: []Site{}, Returns: []Site{}}
	if !strings.HasPrefix(input.Path, "pkg/") || strings.HasSuffix(input.Path, "_test.go") ||
		f.Name.Name == "main" || ast.IsGenerated(f) {
		out.Known = false
		out.Reason = "Outside frozen non-generated library-source facet"
		return out
	}
	osAlias := ""
	for _, spec := range f.Imports {
		p, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			return Output{Reason: "Invalid import"}
		}
		if spec.Name != nil && spec.Name.Name == "." {
			return Output{Reason: "Dot import outside partial oracle"}
		}
		if p == "os" {
			osAlias = "os"
			if spec.Name != nil {
				osAlias = spec.Name.Name
			}
		}
	}
	var stack []ast.Node
	expression := func(n ast.Node) string {
		var buf bytes.Buffer
		if err := printer.Fprint(&buf, fset, n); err != nil {
			panic(err)
		}
		return buf.String()
	}
	ast.Inspect(f, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		stack = append(stack, n)
		function := ""
		for i := len(stack) - 1; i >= 0; i-- {
			if _, ok := stack[i].(*ast.FuncLit); ok {
				break
			}
			if decl, ok := stack[i].(*ast.FuncDecl); ok {
				function = decl.Name.Name
				break
			}
		}
		if call, ok := n.(*ast.CallExpr); ok {
			if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Exit" {
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == osAlias && id.Obj == nil {
					out.RawExits++
					if function != "" && len(call.Args) == 1 {
						out.Exits = append(out.Exits, Site{Function: function, Code: expression(call.Args[0])})
					}
				}
			}
		}
		if ret, ok := n.(*ast.ReturnStmt); ok && len(ret.Results) == 1 {
			if unary, ok := ret.Results[0].(*ast.UnaryExpr); ok && unary.Op == token.AND {
				if literal, ok := unary.X.(*ast.CompositeLit); ok {
					if id, ok := literal.Type.(*ast.Ident); ok && id.Name == "ExitCodeError" {
						out.ReturnCodes++
						if function != "" && len(literal.Elts) == 1 {
							if field, ok := literal.Elts[0].(*ast.KeyValueExpr); ok {
								if name, ok := field.Key.(*ast.Ident); ok && name.Name == "Code" {
									out.Returns = append(out.Returns, Site{Function: function, Code: expression(field.Value)})
								}
							}
						}
					}
				}
			}
		}
		return true
	})
	return out
}

func main() {
	var inputs []Input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	outputs := make([]Output, len(inputs))
	for i, input := range inputs {
		outputs[i] = inspect(input)
	}
	if err := json.NewEncoder(os.Stdout).Encode(outputs); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
