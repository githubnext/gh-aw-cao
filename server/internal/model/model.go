package model

import "time"

const SchemaVersion = 13

type Row map[string]any

type Metadata map[string]any

type Source struct {
	Source            string   `json:"source"`
	Rows              []Row    `json:"rows"`
	Metadata          Metadata `json:"metadata"`
	ContinuationToken string   `json:"continuationToken,omitempty"`
}

type Metrics struct {
	DurationMS         int64    `json:"durationMs"`
	PushedDown         []string `json:"pushedDown"`
	RedisCommands      int      `json:"redisCommands"`
	RedisRows          int      `json:"redisRows"`
	FallbackOperations []string `json:"fallbackOperations"`
}

type ActiveGeneration struct {
	Generation   string         `json:"generation"`
	Revision     int64          `json:"revision"`
	DataRevision string         `json:"dataRevision,omitempty"`
	EvaluatedAt  time.Time      `json:"evaluatedAt"`
	Counts       map[string]int `json:"counts"`
	Activated    time.Time      `json:"activatedAt"`
}

type Diagnostics struct {
	SchemaVersion      int                 `json:"schemaVersion"`
	Counts             map[string]int      `json:"counts"`
	RelationshipErrors []string            `json:"relationshipErrors"`
	DuplicateRecordIDs map[string][]string `json:"duplicateRecordIds"`
}
