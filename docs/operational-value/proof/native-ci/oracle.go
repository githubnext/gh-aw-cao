package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type input struct {
	Files      map[string]string `json:"files"`
	Selections []selection       `json:"selections"`
}

type selection struct {
	Package string   `json:"package"`
	Pattern string   `json:"pattern"`
	Matches []string `json:"matches"`
}

type target struct {
	Path     string `json:"path"`
	Package  string `json:"package"`
	Name     string `json:"name"`
	FuzzBody bool   `json:"fuzzBody"`
}

func run() error {
	var in input
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 64*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		return err
	}
	if len(in.Files) == 0 || len(in.Files) > 2000 {
		return fmt.Errorf("invalid source population")
	}
	context := build.Default
	context.GOOS, context.GOARCH, context.CgoEnabled = "linux", "amd64", true
	context.BuildTags, context.ToolTags = nil, nil
	context.OpenFile = func(filename string) (io.ReadCloser, error) {
		text, ok := in.Files[strings.TrimPrefix(filename, "/source/")]
		if !ok {
			return nil, fmt.Errorf("unretained source %s", filename)
		}
		return io.NopCloser(strings.NewReader(text)), nil
	}
	var names []string
	for filename := range in.Files {
		if path.Clean(filename) != filename || strings.HasPrefix(filename, "/") ||
			strings.Contains(filename, "..") || !strings.HasSuffix(filename, "_test.go") {
			return fmt.Errorf("invalid source path %s", filename)
		}
		names = append(names, filename)
	}
	sort.Strings(names)
	targets := make([]target, 0)
	excluded := make([]string, 0)
	for _, filename := range names {
		file, err := parser.ParseFile(token.NewFileSet(), filename, in.Files[filename], parser.ParseComments|parser.AllErrors)
		if err != nil {
			return err
		}
		eligible, err := context.MatchFile("/source/"+path.Dir(filename), path.Base(filename))
		if err != nil {
			return err
		}
		if !eligible {
			excluded = append(excluded, filename)
			continue
		}
		testing := ""
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			if imported == "testing" {
				testing = "testing"
				if spec.Name != nil {
					testing = spec.Name.Name
				}
			}
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv != nil || !strings.HasPrefix(function.Name.Name, "Fuzz") {
				continue
			}
			if len(function.Name.Name) > len("Fuzz") {
				next, _ := utf8.DecodeRuneInString(function.Name.Name[len("Fuzz"):])
				if unicode.IsLower(next) {
					continue
				}
			}
			if function.Type.TypeParams != nil || function.Type.Results != nil ||
				len(function.Type.Params.List) != 1 || len(function.Type.Params.List[0].Names) != 1 {
				return fmt.Errorf("unsupported fuzz signature %s:%s", filename, function.Name.Name)
			}
			star, ok := function.Type.Params.List[0].Type.(*ast.StarExpr)
			if !ok {
				return fmt.Errorf("invalid fuzz parameter %s:%s", filename, function.Name.Name)
			}
			selector, ok := star.X.(*ast.SelectorExpr)
			if !ok {
				return fmt.Errorf("invalid fuzz type %s:%s", filename, function.Name.Name)
			}
			qualifier, ok := selector.X.(*ast.Ident)
			if !ok || qualifier.Name != testing || testing == "" || selector.Sel.Name != "F" {
				return fmt.Errorf("non-native fuzz signature %s:%s", filename, function.Name.Name)
			}
			parameter := function.Type.Params.List[0].Names[0]
			fuzzBody := false
			if function.Body == nil {
				return fmt.Errorf("missing fuzz body %s:%s", filename, function.Name.Name)
			}
			for _, statement := range function.Body.List {
				expression, ok := statement.(*ast.ExprStmt)
				if !ok {
					continue
				}
				call, ok := expression.X.(*ast.CallExpr)
				if !ok {
					continue
				}
				method, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || method.Sel.Name != "Fuzz" {
					continue
				}
				receiver, ok := method.X.(*ast.Ident)
				if ok && receiver.Name == parameter.Name && receiver.Obj == parameter.Obj {
					fuzzBody = true
				}
			}
			targets = append(targets, target{filename, file.Name.Name, function.Name.Name, fuzzBody})
		}
	}
	for index := range in.Selections {
		row := &in.Selections[index]
		pattern, err := regexp.Compile(row.Pattern)
		if err != nil {
			return err
		}
		row.Matches = make([]string, 0)
		for _, candidate := range targets {
			if "./"+path.Dir(candidate.Path)+"/" == row.Package && pattern.MatchString(candidate.Name) {
				row.Matches = append(row.Matches, candidate.Name)
			}
		}
		sort.Strings(row.Matches)
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"parsedFiles": len(names), "excludedFiles": excluded, "targets": targets,
		"goos": context.GOOS, "goarch": context.GOARCH, "releaseTags": context.ReleaseTags,
		"targetCodeExecuted": false,
		"selections":         in.Selections,
	})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
