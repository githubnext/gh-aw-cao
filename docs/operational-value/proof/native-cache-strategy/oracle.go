package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
)

func fail(message string) {
	panic(message)
}

var positionType = reflect.TypeOf(token.NoPos)

func canonical(value reflect.Value) any {
	if !value.IsValid() || value.Type() == positionType {
		return nil
	}
	switch value.Kind() {
	case reflect.Interface, reflect.Pointer:
		if value.IsNil() {
			return nil
		}
		return canonical(value.Elem())
	case reflect.Struct:
		result := map[string]any{"$type": value.Type().String()}
		for i := 0; i < value.NumField(); i++ {
			field := value.Type().Field(i)
			if field.Type != positionType && field.Name != "Doc" && field.Name != "Comment" && field.Name != "Obj" {
				result[field.Name] = canonical(value.Field(i))
			}
		}
		return result
	case reflect.Slice, reflect.Array:
		result := make([]any, value.Len())
		for i := range result {
			result[i] = canonical(value.Index(i))
		}
		return result
	default:
		return value.Interface()
	}
}

func fingerprint(value any) string {
	bytes, err := json.Marshal(canonical(reflect.ValueOf(value)))
	if err != nil {
		panic(err)
	}
	return string(bytes)
}

func function(source string) *ast.FuncDecl {
	file, err := parser.ParseFile(token.NewFileSet(), "threat_detection.go", source, parser.SkipObjectResolution)
	if err != nil {
		panic(err)
	}
	var found *ast.FuncDecl
	for _, declaration := range file.Decls {
		if value, ok := declaration.(*ast.FuncDecl); ok && value.Name.Name == "buildDetectionJob" {
			if found != nil {
				fail("ambiguous compiler function")
			}
			found = value
		}
	}
	if found == nil || found.Body == nil {
		fail("missing compiler function")
	}
	return found
}

func assignments(body *ast.BlockStmt) map[string]*ast.AssignStmt {
	result := map[string]*ast.AssignStmt{}
	for _, statement := range body.List {
		value, ok := statement.(*ast.AssignStmt)
		if !ok || value.Tok != token.DEFINE || len(value.Lhs) != 1 || len(value.Rhs) != 1 {
			continue
		}
		name, ok := value.Lhs[0].(*ast.Ident)
		if !ok {
			continue
		}
		if result[name.Name] != nil {
			fail("ambiguous local declaration")
		}
		result[name.Name] = value
	}
	return result
}

func requireExpression(values map[string]*ast.AssignStmt, name, expected string) {
	expression, err := parser.ParseExpr(expected)
	if err != nil {
		panic(err)
	}
	if values[name] == nil || fingerprint(values[name].Rhs[0]) != fingerprint(expression) {
		fail("unexpected native expression: " + name)
	}
}

func main() {
	var input struct{ Before, After string }
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		panic(err)
	}
	before, after := function(input.Before), function(input.After)
	old, next := assignments(before.Body), assignments(after.Body)
	requireExpression(old, "alwaysFunc", `BuildFunctionCall("always")`)
	requireExpression(old, "agentNotSkipped", `BuildNotEquals(BuildPropertyAccess(fmt.Sprintf("needs.%s.result", constants.AgentJobName)), BuildStringLiteral("skipped"))`)
	requireExpression(old, "outputTypesNotEmpty", `BuildNotEquals(BuildPropertyAccess(fmt.Sprintf("needs.%s.outputs.output_types", constants.AgentJobName)), BuildStringLiteral(""))`)
	requireExpression(old, "hasPatchTrue", `BuildEquals(BuildPropertyAccess(fmt.Sprintf("needs.%s.outputs.has_patch", constants.AgentJobName)), BuildStringLiteral("true"))`)
	requireExpression(old, "hasContent", `BuildOr(outputTypesNotEmpty, hasPatchTrue)`)
	requireExpression(old, "jobConditionNode", `BuildAnd(BuildAnd(alwaysFunc, agentNotSkipped), hasContent)`)
	if fingerprint(before) == fingerprint(after) {
		fmt.Println(`{"nativeUnits":0,"removedContentGate":false,"otherFunctionChanges":false,"targetCodeExecuted":false}`)
		return
	}
	requireExpression(next, "jobConditionNode", `BuildAnd(alwaysFunc, agentNotSkipped)`)
	removed := map[string]bool{"outputTypesNotEmpty": true, "hasPatchTrue": true, "hasContent": true}
	expected := &ast.BlockStmt{}
	for _, statement := range before.Body.List {
		value, ok := statement.(*ast.AssignStmt)
		if ok && value.Tok == token.DEFINE && len(value.Lhs) == 1 {
			if name, ok := value.Lhs[0].(*ast.Ident); ok {
				if removed[name.Name] {
					if next[name.Name] != nil {
						fail("obsolete gating declaration survived")
					}
					continue
				}
				if name.Name == "jobConditionNode" {
					copy := *value
					copy.Rhs = next[name.Name].Rhs
					statement = &copy
				}
			}
		}
		expected.List = append(expected.List, statement)
	}
	if fingerprint(expected) != fingerprint(after.Body) {
		fail("other compiler body changes")
	}
	before.Body, after.Body = nil, nil
	if fingerprint(before) != fingerprint(after) {
		fail("compiler signature changed")
	}
	fmt.Println(`{"nativeUnits":1,"removedContentGate":true,"otherFunctionChanges":false,"targetCodeExecuted":false}`)
}
