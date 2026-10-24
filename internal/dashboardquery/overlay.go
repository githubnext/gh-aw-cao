package dashboardquery

import _ "embed"

// SQLiteOverlaySchema links an attached read-only "snapshot" to the writable
// main database. Only schema metadata is copied; records remain in the snapshot.
//
//go:embed overlay.sql
var SQLiteOverlaySchema string
