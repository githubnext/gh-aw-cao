package postgresx

import (
	"errors"
	"strconv"
	"strings"
)

// sqlIdentifier marks a value as an SQL identifier rather than a bound value.
type sqlIdentifier string

// postgresSQL inserts numbered bind parameters into trusted SQL text. Only
// explicitly marked identifiers are quoted into the statement; returned data
// still requires HTML escaping when rendered.
func postgresSQL(template string, parameters ...any) (string, []any, error) {
	parts := strings.Split(template, "{}")
	if len(parts) != len(parameters)+1 {
		return "", nil, errors.New("postgres SQL placeholder count mismatch")
	}
	var statement strings.Builder
	statement.WriteString(parts[0])
	values := make([]any, 0, len(parameters))
	for i, parameter := range parameters {
		if name, ok := parameter.(sqlIdentifier); ok {
			if name == "" || strings.ContainsRune(string(name), 0) {
				return "", nil, errors.New("invalid postgres SQL identifier")
			}
			statement.WriteByte('"')
			statement.WriteString(strings.ReplaceAll(string(name), `"`, `""`))
			statement.WriteByte('"')
		} else {
			values = append(values, parameter)
			statement.WriteByte('$')
			statement.WriteString(strconv.Itoa(len(values)))
		}
		statement.WriteString(parts[i+1])
	}
	return statement.String(), values, nil
}
