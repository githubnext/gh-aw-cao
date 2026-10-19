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
	"strings"
)

type input struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type function struct {
	Body       string   `json:"body"`
	Statements []string `json:"statements"`
	Range      []string `json:"range,omitempty"`
	Outside    []string `json:"outside,omitempty"`
	Apply      string   `json:"apply,omitempty"`
}

func main() {
	var inputs []input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		panic(err)
	}
	results := map[string]map[string]function{}
	for _, item := range inputs {
		if _, duplicate := results[item.ID]; duplicate || item.ID == "" {
			panic("duplicate or missing source identity")
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, item.ID, item.Text, 0)
		if err != nil {
			panic(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			if block, ok := node.(*ast.BlockStmt); ok {
				kept := []ast.Stmt{}
				for _, statement := range block.List {
					logging := false
					if expression, ok := statement.(*ast.ExprStmt); ok {
						if call, ok := expression.X.(*ast.CallExpr); ok {
							if selector, ok := call.Fun.(*ast.SelectorExpr); ok {
								if name, ok := selector.X.(*ast.Ident); ok {
									logging = strings.HasSuffix(name.Name, "Log") &&
										(selector.Sel.Name == "Print" || selector.Sel.Name == "Printf")
								}
							}
						}
					}
					if !logging {
						kept = append(kept, statement)
					}
				}
				block.List = kept
			}
			return true
		})
		format := func(node ast.Node) string {
			var result bytes.Buffer
			if err := printer.Fprint(&result, fset, node); err != nil {
				panic(err)
			}
			return result.String()
		}
		functions := map[string]function{}
		for _, declaration := range file.Decls {
			fn, ok := declaration.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			value := function{Body: format(fn.Body), Statements: []string{}}
			for _, statement := range fn.Body.List {
				value.Statements = append(value.Statements, format(statement))
				if loop, ok := statement.(*ast.RangeStmt); ok && fn.Name.Name == "renameAppToGitHubApp" {
					for _, child := range loop.Body.List {
						value.Range = append(value.Range, format(child))
					}
				} else {
					value.Outside = append(value.Outside, format(statement))
				}
			}
			ast.Inspect(fn.Body, func(node ast.Node) bool {
				if pair, ok := node.(*ast.KeyValueExpr); ok {
					if key, ok := pair.Key.(*ast.Ident); ok && key.Name == "Apply" {
						if closure, ok := pair.Value.(*ast.FuncLit); ok {
							value.Apply = format(closure.Body)
						}
					}
				}
				return true
			})
			if _, duplicate := functions[fn.Name.Name]; duplicate {
				panic("ambiguous function identity")
			}
			functions[fn.Name.Name] = value
		}
		results[item.ID] = functions
	}
	legacy := "---\nengine: copilot\napp:\n  app-id: example-app-id\n  private-key: example-placeholder\n---\n# Example\napp: unchanged-body\n"
	parts := strings.SplitN(legacy, "\n---\n", 2)
	migrated := strings.Replace(parts[0], "\napp:\n", "\ngithub-app:\n", 1) + "\n---\n" + parts[1]
	witness := strings.Count(migrated, "\ngithub-app:\n") == 1 &&
		strings.Contains(migrated, "  app-id: example-app-id\n  private-key: example-placeholder\n") &&
		strings.HasSuffix(migrated, "# Example\napp: unchanged-body\n") &&
		legacy != migrated
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"sources": results, "independentBoundedWitness": witness,
		"witnessQualification": "Locally authored transformation only; target code is parsed, never executed.",
	}); err != nil {
		panic(fmt.Errorf("encode native analysis: %w", err))
	}
}
