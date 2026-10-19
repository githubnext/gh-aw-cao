package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strconv"
	"strings"
	"unicode"
)

type input struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

type testFact struct {
	Name              string `json:"name"`
	LeadingParallel   bool   `json:"leadingParallel"`
	ProcessStateCalls int    `json:"processStateCalls"`
	GlobalReferences  int    `json:"globalReferences"`
	BodySHA256        string `json:"bodySha256"`
}

type output struct {
	ID              string     `json:"id"`
	SyntaxValid     bool       `json:"syntaxValid"`
	Generated       bool       `json:"generated"`
	NeedsGofmt      *bool      `json:"needsGofmt"`
	ContentSHA256   string     `json:"contentSha256"`
	FormattedSHA256 string     `json:"formattedSha256"`
	Package         string     `json:"package"`
	BuildSHA256     string     `json:"buildSha256"`
	Tests           []testFact `json:"tests"`
}

func bodyHash(body *ast.BlockStmt, leading bool) string {
	statements := body.List
	if leading {
		body.List = body.List[1:]
	}
	if len(body.List) == 0 {
		body.List = nil
	}
	defer func() { body.List = statements }()
	var buffer bytes.Buffer
	err := ast.Fprint(&buffer, nil, body, func(name string, value reflect.Value) bool {
		return value.Type() != reflect.TypeOf(token.Pos(0)) &&
			name != "Obj" && name != "Scope" && name != "Doc" && name != "Comment" && name != "Comments"
	})
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(buffer.Bytes())
	return hex.EncodeToString(sum[:])
}

func analyze(value input) output {
	result := output{ID: value.ID, Tests: []testFact{}}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, value.ID, value.Content, parser.ParseComments)
	if file != nil {
		result.Generated = ast.IsGenerated(file)
	}
	if err != nil {
		return result
	}
	result.SyntaxValid = true
	result.Package = file.Name.Name
	var constraints []string
	for _, group := range file.Comments {
		for _, comment := range group.List {
			if strings.HasPrefix(comment.Text, "//go:build") || strings.HasPrefix(comment.Text, "// +build") {
				constraints = append(constraints, comment.Text)
			}
		}
	}
	buildSum := sha256.Sum256([]byte(strings.Join(constraints, "\n")))
	result.BuildSHA256 = hex.EncodeToString(buildSum[:])
	formatted, err := format.Source([]byte(value.Content))
	if err != nil {
		result.SyntaxValid = false
		return result
	}
	different := !bytes.Equal(formatted, []byte(value.Content))
	result.NeedsGofmt = &different
	contentSum := sha256.Sum256([]byte(value.Content))
	formattedSum := sha256.Sum256(formatted)
	result.ContentSHA256 = hex.EncodeToString(contentSum[:])
	result.FormattedSHA256 = hex.EncodeToString(formattedSum[:])
	testingNames, osNames := map[string]bool{}, map[string]bool{}
	for _, spec := range file.Imports {
		importPath, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			continue
		}
		name := importPath
		if spec.Name != nil {
			name = spec.Name.Name
		}
		if importPath == "testing" {
			testingNames[name] = true
		}
		if importPath == "os" {
			osNames[name] = true
		}
	}
	globals := map[*ast.Object]bool{}
	for _, declaration := range file.Decls {
		if group, ok := declaration.(*ast.GenDecl); ok && group.Tok == token.VAR {
			for _, spec := range group.Specs {
				for _, name := range spec.(*ast.ValueSpec).Names {
					if name.Obj != nil {
						globals[name.Obj] = true
					}
				}
			}
		}
	}
	seen := map[string]bool{}
	for _, declaration := range file.Decls {
		fn, ok := declaration.(*ast.FuncDecl)
		if !ok || fn.Recv != nil || fn.Body == nil || !strings.HasPrefix(fn.Name.Name, "Test") ||
			fn.Type.Params == nil || len(fn.Type.Params.List) != 1 ||
			(fn.Type.Results != nil && len(fn.Type.Results.List) != 0) {
			continue
		}
		if suffix := []rune(strings.TrimPrefix(fn.Name.Name, "Test")); len(suffix) > 0 && unicode.IsLower(suffix[0]) {
			continue
		}
		param := fn.Type.Params.List[0]
		pointer, ok := param.Type.(*ast.StarExpr)
		if !ok || len(param.Names) != 1 {
			continue
		}
		typeOK := false
		switch typ := pointer.X.(type) {
		case *ast.SelectorExpr:
			qualifier, ok := typ.X.(*ast.Ident)
			typeOK = ok && qualifier.Obj == nil && testingNames[qualifier.Name] && typ.Sel.Name == "T"
		case *ast.Ident:
			typeOK = testingNames["."] && typ.Name == "T" && typ.Obj == nil
		}
		if !typeOK {
			continue
		}
		if seen[fn.Name.Name] {
			result.SyntaxValid = false
			return result
		}
		seen[fn.Name.Name] = true
		fact := testFact{Name: fn.Name.Name}
		if len(fn.Body.List) > 0 {
			if statement, ok := fn.Body.List[0].(*ast.ExprStmt); ok {
				if call, ok := statement.X.(*ast.CallExpr); ok && len(call.Args) == 0 {
					if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "Parallel" {
						receiver, ok := selector.X.(*ast.Ident)
						fact.LeadingParallel = ok && param.Names[0].Obj != nil &&
							receiver.Name == param.Names[0].Name && receiver.Obj == param.Names[0].Obj
					}
				}
			}
		}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			if ident, ok := node.(*ast.Ident); ok && globals[ident.Obj] {
				fact.GlobalReferences++
			}
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			if direct, ok := call.Fun.(*ast.Ident); ok && direct.Obj == nil && osNames["."] &&
				(direct.Name == "Setenv" || direct.Name == "Unsetenv" || direct.Name == "Chdir") {
				fact.ProcessStateCalls++
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			receiver, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			if receiver.Obj != nil && (selector.Sel.Name == "Setenv" || selector.Sel.Name == "Chdir") {
				if field, ok := receiver.Obj.Decl.(*ast.Field); ok {
					if pointer, ok := field.Type.(*ast.StarExpr); ok {
						switch typ := pointer.X.(type) {
						case *ast.SelectorExpr:
							qualifier, ok := typ.X.(*ast.Ident)
							if ok && qualifier.Obj == nil && testingNames[qualifier.Name] && typ.Sel.Name == "T" {
								fact.ProcessStateCalls++
							}
						case *ast.Ident:
							if testingNames["."] && typ.Name == "T" && typ.Obj == nil {
								fact.ProcessStateCalls++
							}
						}
					}
				}
			}
			if receiver.Obj == nil && osNames[receiver.Name] &&
				(selector.Sel.Name == "Setenv" || selector.Sel.Name == "Unsetenv" || selector.Sel.Name == "Chdir") {
				fact.ProcessStateCalls++
			}
			return true
		})
		fact.BodySHA256 = bodyHash(fn.Body, fact.LeadingParallel)
		result.Tests = append(result.Tests, fact)
	}
	return result
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 16*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var value input
		if err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid native Go oracle input")
			os.Exit(1)
		}
		if err := encoder.Encode(analyze(value)); err != nil {
			fmt.Fprintln(os.Stderr, "Unable to encode native Go evidence")
			os.Exit(1)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "Unable to read bounded native Go evidence")
		os.Exit(1)
	}
}
