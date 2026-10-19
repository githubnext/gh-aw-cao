package main

import (
	"bufio"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

type input struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

type functionSpan struct {
	Line       int    `json:"line"`
	BodyLines  int    `json:"bodyLines"`
	Kind       string `json:"kind"`
	Suppressed bool   `json:"suppressed"`
}

type feature struct {
	ID                string         `json:"id"`
	ContentSHA256     string         `json:"contentSha256"`
	SyntaxValid       bool           `json:"syntaxValid"`
	Generated         bool           `json:"generated"`
	HasLineDirectives bool           `json:"hasLineDirectives"`
	Functions         []functionSpan `json:"functions"`
	MissingReason     string         `json:"missingReason,omitempty"`
}

func measure(value input) (feature, error) {
	bytes := []byte(value.Content)
	gitHash := sha1.New()
	fmt.Fprintf(gitHash, "blob %d\x00", len(bytes))
	gitHash.Write(bytes)
	if hex.EncodeToString(gitHash.Sum(nil)) != value.ID {
		return feature{}, fmt.Errorf("immutable Go blob identity mismatch")
	}
	result := feature{ID: value.ID, ContentSHA256: fmt.Sprintf("%x", sha256.Sum256(bytes)), Functions: []functionSpan{}}
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, value.ID+".go", bytes, parser.ParseComments|parser.AllErrors)
	if err != nil {
		result.MissingReason = "Go source does not parse."
		return result, nil
	}
	result.SyntaxValid = true
	result.Generated = ast.IsGenerated(file)
	suppressions := make(map[int]bool)
	for _, group := range file.Comments {
		for _, comment := range group.List {
			if strings.HasPrefix(comment.Text, "//line ") || strings.HasPrefix(comment.Text, "/*line ") {
				result.HasLineDirectives = true
			}
			text := strings.TrimSpace(strings.TrimPrefix(comment.Text, "//"))
			if !strings.HasPrefix(text, "nolint:") {
				continue
			}
			payload := strings.TrimPrefix(text, "nolint:")
			if at := strings.Index(payload, "//"); at >= 0 {
				payload = payload[:at]
			}
			if at := strings.IndexAny(payload, " \t"); at >= 0 {
				payload = payload[:at]
			}
			for _, name := range strings.Split(payload, ",") {
				if strings.TrimSpace(name) == "largefunc" || strings.TrimSpace(name) == "all" {
					suppressions[positions.PositionFor(comment.Slash, false).Line] = true
				}
			}
		}
	}
	ast.Inspect(file, func(node ast.Node) bool {
		var body *ast.BlockStmt
		var report token.Pos
		kind := "declaration"
		switch fn := node.(type) {
		case *ast.FuncDecl:
			body, report = fn.Body, fn.Name.Pos()
		case *ast.FuncLit:
			body, kind = fn.Body, "literal"
			report = body.Pos()
		default:
			return true
		}
		if body != nil {
			line := positions.PositionFor(report, false).Line
			result.Functions = append(result.Functions, functionSpan{Line: line,
				BodyLines: positions.Position(body.Rbrace).Line - positions.Position(body.Lbrace).Line - 1,
				Kind:      kind, Suppressed: suppressions[line] || suppressions[line-1]})
		}
		return true
	})
	return result, nil
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 16*1024*1024)
	output := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var value input
		if err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
			fmt.Fprintln(os.Stderr, "Invalid native Go source request.")
			os.Exit(1)
		}
		result, err := measure(value)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := output.Encode(result); err != nil {
			fmt.Fprintln(os.Stderr, "Cannot write native Go source features.")
			os.Exit(1)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "Cannot read bounded native Go source requests.")
		os.Exit(1)
	}
}
