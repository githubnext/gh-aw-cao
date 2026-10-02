# SQL identifier model

This local CodeQL model pack marks only `sqlbuilder.QuoteIdentifier` as an SQL
injection barrier. The function encloses an identifier in double quotes and
doubles every embedded double quote. Its output is used only in identifier
positions by the SQL compiler and builder.

Do not mark `Fragment`, `Build`, or the whole statement as sanitized: those
functions compose compiler-owned SQL, and a broad barrier would hide an
accidental request-text fragment. Values remain positional bind parameters.
`sqlbuilder` tests cover quote-breaking inputs, placeholder numbering, and
invalid identifier rejection.

Include this pack when running Go code scanning:

```sh
codeql database analyze DATABASE codeql/go-queries \
  --additional-packs .github/codeql/sqlbuilder \
  --model-packs githubnext/cao-sqlbuilder-models \
  --format=sarif-latest --output=results.sarif
```

The pack does not change runtime validation or authorize SQL text supplied by
clients.
