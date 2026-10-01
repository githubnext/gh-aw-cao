package server

import (
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

const simulationDaysSourceName = "simulation-days"

func simulationDaysSource() model.Source {
	rows := make([]model.Row, 30)
	start := time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)
	for index := range rows {
		rows[index] = model.Row{
			"day":  index + 1,
			"date": start.AddDate(0, 0, index).Format("2006-01-02T15:04:05.000Z"),
		}
	}
	return model.Source{
		Source: simulationDaysSourceName,
		Rows:   rows,
		Metadata: model.Metadata{
			"source-id":    simulationDaysSourceName,
			"source-kind":  "synthetic",
			"as-of":        "1970-01-01T00:00:00.000Z",
			"retrieved-at": "1970-01-01T00:00:00.000Z",
			"availability": "available",
			"completeness": "complete",
			"freshness":    "fresh",
		},
	}
}
