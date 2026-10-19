package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
)

type Input struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}
type Function struct {
	Name     string   `json:"name"`
	Receiver bool     `json:"receiver"`
	Line     int      `json:"line"`
	Entry    bool     `json:"entry"`
	Type     string   `json:"type"`
	Body     []string `json:"body"`
}
type Output struct {
	ID          string            `json:"id"`
	Valid       bool              `json:"valid"`
	Package     string            `json:"package"`
	Identifiers map[string]int    `json:"identifiers"`
	Functions   []Function        `json:"functions"`
	Directives  []string          `json:"directives"`
	Cgo         bool              `json:"cgo"`
	Generated   bool              `json:"generated"`
	Imports     map[string]string `json:"imports"`
}

func main() {
	var inputs []Input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		panic(err)
	}
	outputs := make([]Output, 0, len(inputs))
	for _, input := range inputs {
		out := Output{ID: input.ID, Identifiers: map[string]int{}, Functions: []Function{}, Directives: []string{}, Imports: map[string]string{}}
		set := token.NewFileSet()
		file, err := parser.ParseFile(set, input.ID, input.Text, parser.ParseComments|parser.AllErrors)
		if err == nil {
			render := func(node ast.Node) string {
				var buffer bytes.Buffer
				if err := format.Node(&buffer, set, node); err != nil {
					panic(err)
				}
				return buffer.String()
			}
			out.Valid = true
			out.Package = file.Name.Name
			out.Generated = ast.IsGenerated(file)
			for _, spec := range file.Imports {
				value, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					panic(err)
				}
				out.Cgo = out.Cgo || value == "C"
				alias := value[strings.LastIndex(value, "/")+1:]
				if spec.Name != nil {
					alias = spec.Name.Name
				}
				out.Imports[alias] = value
			}
			for _, group := range file.Comments {
				for _, comment := range group.List {
					if strings.Contains(comment.Text, "go:") || strings.Contains(comment.Text, "export ") {
						out.Directives = append(out.Directives, comment.Text)
					}
				}
			}
			ast.Inspect(file, func(node ast.Node) bool {
				if ident, ok := node.(*ast.Ident); ok {
					out.Identifiers[ident.Name]++
				}
				return true
			})
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok {
					continue
				}
				entry := fn.Body == nil
				if fn.Doc != nil {
					for _, comment := range fn.Doc.List {
						entry = entry || strings.Contains(comment.Text, "go:") || strings.Contains(comment.Text, "export ")
					}
				}
				statements := []string{}
				if fn.Body != nil {
					for _, statement := range fn.Body.List {
						statements = append(statements, render(statement))
					}
				}
				out.Functions = append(out.Functions, Function{Name: fn.Name.Name, Receiver: fn.Recv != nil,
					Line: set.Position(fn.Pos()).Line, Entry: entry, Type: render(fn.Type), Body: statements})
			}
		}
		outputs = append(outputs, out)
	}
	if err := json.NewEncoder(os.Stdout).Encode(outputs); err != nil {
		panic(err)
	}
}
