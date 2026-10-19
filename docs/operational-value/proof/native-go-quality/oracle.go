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
	"reflect"
	"runtime"
	"strconv"
	"strings"
)

type Input struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Mode string `json:"mode"`
}
type Site struct {
	Function    string `json:"function"`
	Key         string `json:"key"`
	Argument    string `json:"argument"`
	Kind        string `json:"kind"`
	Line        int    `json:"line"`
	Guarded     bool   `json:"guarded"`
	Fatal       bool   `json:"fatal"`
	Initializer string `json:"initializer,omitempty"`
	Field       string `json:"field,omitempty"`
}
type Declaration struct {
	Name     string `json:"name"`
	Receiver string `json:"receiver"`
	Type     string `json:"type"`
	Body     string `json:"body"`
}
type Result struct {
	ID             string                       `json:"id"`
	Valid          bool                         `json:"valid"`
	Error          string                       `json:"error,omitempty"`
	Sites          []Site                       `json:"sites"`
	DashFields     []Site                       `json:"dashFields"`
	LoggerRuntime  bool                         `json:"loggerRuntime"`
	Declarations   []Declaration                `json:"declarations"`
	Imports        map[string]string            `json:"imports"`
	StructFields   map[string]map[string]string `json:"structFields"`
	JSONProjection *string                      `json:"jsonProjection"`
	Witness        map[string]bool              `json:"witness,omitempty"`
}

func failureContainmentWitness() map[string]bool {
	probe := func(fatal bool) (panicked bool) {
		done := make(chan bool, 1)
		go func() {
			defer func() { done <- recover() != nil }()
			var flag *struct{ DefValue string }
			if flag == nil && fatal {
				runtime.Goexit()
			}
			_ = flag.DefValue
		}()
		return <-done
	}
	return map[string]bool{"nonfatalContinuationPanics": probe(false), "fatalContinuationAvoidsPanic": !probe(true)}
}

func text(n ast.Node) string {
	if n == nil {
		return ""
	}
	var b bytes.Buffer
	if err := format.Node(&b, token.NewFileSet(), n); err != nil {
		return ""
	}
	return b.String()
}
func importName(file *ast.File, wanted string) string {
	for _, spec := range file.Imports {
		value, err := strconv.Unquote(spec.Path.Value)
		if err != nil || value != wanted {
			continue
		}
		if spec.Name != nil {
			if spec.Name.Name == "_" || spec.Name.Name == "." {
				return ""
			}
			return spec.Name.Name
		}
		parts := strings.Split(value, "/")
		return parts[len(parts)-1]
	}
	return ""
}
func imported(call *ast.CallExpr, alias, member string) bool {
	if alias == "" {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != member {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == alias && id.Obj == nil
}
func functionName(fn *ast.FuncDecl) string {
	if fn.Recv != nil {
		return text(fn.Recv.List[0].Type) + "." + fn.Name.Name
	}
	return fn.Name.Name
}
func loggerVariables(file *ast.File) map[string]*ast.Object {
	alias := importName(file, "github.com/github/gh-aw/pkg/logger")
	vars := map[string]*ast.Object{}
	for _, decl := range file.Decls {
		general, ok := decl.(*ast.GenDecl)
		if !ok || general.Tok != token.VAR {
			continue
		}
		for _, spec := range general.Specs {
			value, ok := spec.(*ast.ValueSpec)
			if !ok || len(value.Names) != 1 || len(value.Values) != 1 {
				continue
			}
			call, ok := value.Values[0].(*ast.CallExpr)
			if ok && imported(call, alias, "New") && len(call.Args) == 1 {
				literal, ok := call.Args[0].(*ast.BasicLit)
				if ok && literal.Kind == token.STRING {
					vars[value.Names[0].Name] = value.Names[0].Obj
				}
			}
		}
	}
	return vars
}
func loggerReceiver(expr ast.Expr, vars map[string]*ast.Object) (string, bool) {
	id, ok := expr.(*ast.Ident)
	if !ok {
		return "", false
	}
	obj, exists := vars[id.Name]
	return id.Name, exists && id.Obj == obj
}
func enabled(expr ast.Expr, vars map[string]*ast.Object) string {
	call, ok := expr.(*ast.CallExpr)
	if !ok || len(call.Args) != 0 {
		return ""
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Enabled" {
		return ""
	}
	name, valid := loggerReceiver(sel.X, vars)
	if !valid {
		return ""
	}
	return name
}
func computations(expr ast.Expr) bool {
	found := false
	ast.Inspect(expr, func(n ast.Node) bool {
		if _, ok := n.(*ast.FuncLit); ok {
			return false
		}
		if call, ok := n.(*ast.CallExpr); ok {
			id, builtin := call.Fun.(*ast.Ident)
			if !builtin || (id.Name != "len" && id.Name != "cap") || id.Obj != nil {
				found = true
			}
		}
		return true
	})
	return found
}
func logging(block *ast.BlockStmt, fn string, guards map[string]bool, vars map[string]*ast.Object, fset *token.FileSet, out *[]Site) {
	if block == nil {
		return
	}
	for _, stmt := range block.List {
		if conditional, ok := stmt.(*ast.IfStmt); ok {
			next := map[string]bool{}
			for k, v := range guards {
				next[k] = v
			}
			if conditional.Init == nil {
				if name := enabled(conditional.Cond, vars); name != "" {
					next[name] = true
				}
			}
			logging(conditional.Body, fn, next, vars, fset, out)
			if other, ok := conditional.Else.(*ast.BlockStmt); ok {
				logging(other, fn, guards, vars, fset, out)
			}
			continue
		}
		expr, ok := stmt.(*ast.ExprStmt)
		if !ok {
			continue
		}
		call, ok := expr.X.(*ast.CallExpr)
		if !ok {
			continue
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || (sel.Sel.Name != "Printf" && sel.Sel.Name != "Print") {
			continue
		}
		name, valid := loggerReceiver(sel.X, vars)
		if !valid {
			continue
		}
		for index, arg := range call.Args {
			if computations(arg) {
				*out = append(*out, Site{Function: fn, Key: text(call) + fmt.Sprintf("|arg=%d", index),
					Argument: text(arg), Kind: "logger-computation", Line: fset.Position(call.Pos()).Line, Guarded: guards[name]})
			}
		}
	}
}
func independentUnsafe(stmt ast.Stmt, variable, kind string, length int64) (bool, string) {
	unsafe := false
	field := ""
	callees := map[ast.Node]bool{}
	ast.Inspect(stmt, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			callees[call.Fun] = true
		}
		return true
	})
	ast.Inspect(stmt, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.FuncLit, *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.DeferStmt, *ast.GoStmt:
			return false
		case *ast.IndexExpr:
			if kind == "Len" || kind == "NotEmpty" {
				literal, ok := node.Index.(*ast.BasicLit)
				if !ok {
					break
				}
				index, err := strconv.ParseInt(literal.Value, 0, 64)
				if err == nil && index >= 0 && index < length && text(node.X) == variable {
					unsafe = true
				}
			}
		case *ast.StarExpr:
			if kind == "NotNil" && text(node.X) == variable {
				unsafe = true
			}
		case *ast.SelectorExpr:
			if kind == "NotNil" && text(node.X) == variable && !callees[node] {
				unsafe = true
				field = node.Sel.Name
			}
		}
		return true
	})
	return unsafe, field
}
func prerequisites(block *ast.BlockStmt, fn, assertAlias, requireAlias, testingAlias string, fset *token.FileSet, out *[]Site) {
	if block == nil {
		return
	}
	for index, stmt := range block.List {
		if expr, ok := stmt.(*ast.ExprStmt); ok && index+1 < len(block.List) {
			if call, ok := expr.X.(*ast.CallExpr); ok {
				for _, kind := range []string{"NotNil", "Len", "NotEmpty"} {
					fatal := imported(call, requireAlias, kind)
					if !fatal && !imported(call, assertAlias, kind) {
						continue
					}
					if len(call.Args) < 2 || (kind == "Len" && len(call.Args) < 3) {
						continue
					}
					testingID, ok := call.Args[0].(*ast.Ident)
					if !ok || testingID.Obj == nil {
						continue
					}
					testingField, ok := testingID.Obj.Decl.(*ast.Field)
					if !ok || testingAlias == "" || text(testingField.Type) != "*"+testingAlias+".T" {
						continue
					}
					variable := text(call.Args[1])
					if _, ok := call.Args[1].(*ast.Ident); !ok {
						continue
					}
					length := int64(1)
					if kind == "Len" {
						literal, ok := call.Args[2].(*ast.BasicLit)
						if !ok {
							continue
						}
						value, err := strconv.ParseInt(literal.Value, 0, 64)
						if err != nil || value <= 0 {
							continue
						}
						length = value
					}
					// Only an immediate, unconditional dependent statement is certified.
					next := block.List[index+1]
					if _, ok := next.(*ast.ExprStmt); !ok {
						continue
					}
					isUnsafe, field := independentUnsafe(next, variable, kind, length)
					if !isUnsafe {
						continue
					}
					initializer := ""
					id := call.Args[1].(*ast.Ident)
					if id.Obj != nil {
						if assignment, ok := id.Obj.Decl.(*ast.AssignStmt); ok && len(assignment.Lhs) == 1 && len(assignment.Rhs) == 1 {
							initializer = text(assignment.Rhs[0])
						}
					}
					var arguments []string
					for _, arg := range call.Args {
						arguments = append(arguments, text(arg))
					}
					*out = append(*out, Site{Function: fn, Key: kind + "(" + strings.Join(arguments, ",") + ")|" + text(next),
						Argument: variable, Kind: "test-prerequisite", Line: fset.Position(call.Pos()).Line, Fatal: fatal,
						Initializer: initializer, Field: field})
				}
			}
		}
		ast.Inspect(stmt, func(n ast.Node) bool {
			if n == stmt {
				return true
			}
			if child, ok := n.(*ast.BlockStmt); ok {
				prerequisites(child, fn, assertAlias, requireAlias, testingAlias, fset, out)
				return false
			}
			return true
		})
	}
}
func validRuntime(file *ast.File) bool {
	enabledOK, printfOK, printOK := false, false, false
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv == nil || len(fn.Recv.List) != 1 || text(fn.Recv.List[0].Type) != "*Logger" || fn.Body == nil {
			continue
		}
		receiver := fn.Recv.List[0].Names[0].Name
		body := text(fn.Body)
		if fn.Name.Name == "Enabled" && body == "{\n\treturn "+receiver+".enabled\n}" {
			enabledOK = true
		}
		if len(fn.Body.List) > 0 {
			guard, ok := fn.Body.List[0].(*ast.IfStmt)
			if !ok || guard.Init != nil || text(guard.Cond) != "!"+receiver+".enabled" || guard.Else != nil || text(guard.Body) != "{\n\treturn\n}" {
				continue
			}
			if fn.Name.Name == "Printf" {
				printfOK = true
			}
			if fn.Name.Name == "Print" {
				printOK = true
			}
		}
	}
	return enabledOK && printfOK && printOK
}
func analyze(input Input) Result {
	out := Result{ID: input.ID, Sites: []Site{}, DashFields: []Site{}, Declarations: []Declaration{},
		Imports: map[string]string{}, StructFields: map[string]map[string]string{}}
	if input.Mode == "failure-containment-witness" {
		out.Valid = true
		out.Witness = failureContainmentWitness()
		return out
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, input.ID, input.Text, parser.AllErrors)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Valid = true
	out.LoggerRuntime = validRuntime(file)
	for _, spec := range file.Imports {
		value, _ := strconv.Unquote(spec.Path.Value)
		out.Imports[value] = importName(file, value)
	}
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.TypeSpec)
		if !ok {
			return true
		}
		fields, ok := spec.Type.(*ast.StructType)
		if !ok {
			return true
		}
		members := map[string]string{}
		for _, field := range fields.Fields.List {
			for _, name := range field.Names {
				members[name.Name] = text(field.Type)
			}
		}
		out.StructFields[spec.Name.Name] = members
		if spec.Name.Name == "Record" && len(fields.Fields.List) == 1 {
			field := fields.Fields.List[0]
			if len(field.Names) == 1 && field.Names[0].Name == "Name" && text(field.Type) == "string" {
				tag := ""
				if field.Tag != nil {
					var err error
					tag, err = strconv.Unquote(field.Tag.Value)
					if err != nil {
						return false
					}
				}
				typ := reflect.StructOf([]reflect.StructField{{Name: "Name", Type: reflect.TypeOf(""), Tag: reflect.StructTag(tag)}})
				value := reflect.New(typ).Elem()
				value.Field(0).SetString("value")
				encoded, err := json.Marshal(value.Interface())
				if err == nil {
					projection := string(encoded)
					out.JSONProjection = &projection
				}
			}
		}
		return true
	})
	vars := loggerVariables(file)
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		name := functionName(fn)
		for _, wanted := range []string{"Flags", "Lookup", "NotNil", "NewHealthCommand"} {
			if fn.Name.Name == wanted {
				receiver := ""
				if fn.Recv != nil {
					receiver = text(fn.Recv.List[0].Type)
				}
				out.Declarations = append(out.Declarations, Declaration{Name: fn.Name.Name, Receiver: receiver, Type: text(fn.Type), Body: text(fn.Body)})
			}
		}
		logging(fn.Body, name, map[string]bool{}, vars, fset, &out.Sites)
		if strings.HasPrefix(fn.Name.Name, "Test") && fn.Recv == nil {
			prerequisites(fn.Body, name, importName(file, "github.com/stretchr/testify/assert"),
				importName(file, "github.com/stretchr/testify/require"), importName(file, "testing"), fset, &out.Sites)
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		field, ok := n.(*ast.Field)
		if !ok || field.Tag == nil {
			return true
		}
		tag, err := strconv.Unquote(field.Tag.Value)
		if err == nil && reflect.StructTag(tag).Get("json") == "-" {
			for _, name := range field.Names {
				out.DashFields = append(out.DashFields, Site{Key: name.Name, Argument: text(field.Type), Kind: "json-dash",
					Line: fset.Position(field.Pos()).Line})
			}
		}
		return true
	})
	return out
}
func main() {
	var inputs []Input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		panic(err)
	}
	results := make([]Result, len(inputs))
	for i, input := range inputs {
		results[i] = analyze(input)
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		panic(err)
	}
}
