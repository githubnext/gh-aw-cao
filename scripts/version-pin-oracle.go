package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
)

type source struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

type fact struct {
	ID        string            `json:"id"`
	Constants map[string]string `json:"constants"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	var sources []source
	if err := json.NewDecoder(os.Stdin).Decode(&sources); err != nil {
		return err
	}
	facts := make([]fact, 0, len(sources))
	for _, source := range sources {
		file, err := parser.ParseFile(token.NewFileSet(), source.ID+".go", source.Content, 0)
		if err != nil {
			return err
		}
		result := fact{ID: source.ID, Constants: make(map[string]string)}
		for _, declaration := range file.Decls {
			group, ok := declaration.(*ast.GenDecl)
			if !ok || group.Tok != token.CONST {
				continue
			}
			for _, specification := range group.Specs {
				value := specification.(*ast.ValueSpec)
				if len(value.Names) != len(value.Values) {
					continue
				}
				for i, name := range value.Names {
					literal, ok := value.Values[i].(*ast.BasicLit)
					if !ok || literal.Kind != token.STRING {
						continue
					}
					text, err := strconv.Unquote(literal.Value)
					if err != nil {
						return err
					}
					result.Constants[name.Name] = text
				}
			}
		}
		facts = append(facts, result)
	}
	return json.NewEncoder(os.Stdout).Encode(facts)
}
