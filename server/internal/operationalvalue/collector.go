// Package operationalvalue implements the server-side operational-value
// orchestration contract shared with the Activity CLI.
package operationalvalue

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var collectLog = logger.New("cao:operationalvalue")

const (
	baselineObservations   = 3
	maxHistoryObservations = 366
	defaultWorkerTimeout   = 2 * time.Minute
	day                    = 24 * time.Hour
	maxWorkerOutput        = 16 * 1024 * 1024
)

var (
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$`)
	identifierPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)
	slugPattern       = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

// Config describes one operational-value collection.
type Config struct {
	Root             string
	Database         string
	Output           string
	ObservedAt       time.Time
	Repositories     []string
	HistoryCampaign  string
	Retention        time.Duration
	NodeBinary       string
	GitHubBinary     string
	Environment      []string
	RedactValues     []string
	RateLimitReserve int
	WorkerTimeout    time.Duration
}

// Result summarizes values collected during one invocation.
type Result struct {
	Values        int
	HistoryValues int
	Warnings      []string
}

type script struct {
	campaign string
	path     string
}

type definition struct {
	WorkflowSlug   string
	AdoptedAt      time.Time
	EvaluationMode string
	CadenceDays    float64
	Repositories   []string
	ValueIDs       []string
}

type definitionRecord struct {
	Kind           string   `json:"kind"`
	WorkflowSlug   string   `json:"workflowSlug"`
	AdoptedAt      string   `json:"adoptedAt"`
	EvaluationMode string   `json:"evaluationMode"`
	CadenceDays    float64  `json:"cadenceDays"`
	Repositories   []string `json:"repositories"`
	ValueIDs       []string `json:"valueIds"`
}

type valueRecord struct {
	Timestamp         string   `json:"timestamp"`
	Repository        string   `json:"repository"`
	ValueID           string   `json:"valueId"`
	Value             *float64 `json:"value"`
	MetricRole        *string  `json:"metricRole"`
	MetricName        *string  `json:"metricName"`
	MetricUnit        *string  `json:"metricUnit"`
	MetricDirection   *string  `json:"metricDirection"`
	MaturityStatus    *string  `json:"maturityStatus"`
	AdoptionAt        *string  `json:"adoptionAt"`
	EvaluationMode    *string  `json:"evaluationMode"`
	WorkflowSlug      *string  `json:"workflowSlug"`
	WorkflowName      *string  `json:"workflowName"`
	RollupNumerator   *float64 `json:"rollupNumerator"`
	RollupDenominator *float64 `json:"rollupDenominator"`
}

type parsedOutput struct {
	definitions []definition
	values      []valueRecord
}

type envelope struct {
	SchemaVersion    int              `json:"schema_version"`
	Kind             string           `json:"kind"`
	OperationalValue operationalValue `json:"operational_value"`
}

type operationalValue struct {
	Timestamp         string   `json:"timestamp"`
	Repository        string   `json:"repository"`
	Campaign          string   `json:"campaign"`
	CampaignID        string   `json:"campaign_id"`
	ValueID           string   `json:"value_id"`
	Value             float64  `json:"value"`
	MetricRole        string   `json:"metric_role"`
	MetricName        string   `json:"metric_name"`
	MetricUnit        *string  `json:"metric_unit,omitempty"`
	MetricDirection   string   `json:"metric_direction"`
	MaturityStatus    string   `json:"maturity_status"`
	AdoptionAt        *string  `json:"adoption_at,omitempty"`
	EvaluationMode    *string  `json:"evaluation_mode,omitempty"`
	WorkflowSlug      *string  `json:"workflow_slug,omitempty"`
	WorkflowName      *string  `json:"workflow_name,omitempty"`
	RollupNumerator   *float64 `json:"rollup_numerator,omitempty"`
	RollupDenominator *float64 `json:"rollup_denominator,omitempty"`
}

// Collect discovers campaign adapters, executes them, reconstructs requested
// history, and atomically updates the retained operational-value shard.
func Collect(ctx context.Context, config Config) (Result, error) {
	var result Result
	if len(config.Repositories) == 0 {
		return result, errors.New("operational value requires at least one repository")
	}
	if config.HistoryCampaign != "" && config.Retention <= 0 {
		return result, errors.New("operational value history requires a retention window")
	}
	observedAt := config.ObservedAt.UTC()
	if observedAt.IsZero() {
		observedAt = time.Now().UTC()
	}
	config.ObservedAt = observedAt
	repositories, err := normalizeRepositories(config.Repositories)
	if err != nil {
		return result, err
	}
	scripts, err := discoverScripts(config.Root)
	if err != nil {
		return result, err
	}
	collectLog.Printf("discovered campaign adapters count=%d", len(scripts))
	if config.HistoryCampaign != "" && !hasCampaign(scripts, config.HistoryCampaign) {
		return result, fmt.Errorf("operational value history campaign not found: %s", config.HistoryCampaign)
	}
	cutoff := time.Time{}
	if config.Retention > 0 {
		cutoff = observedAt.Add(-config.Retention)
	}
	retained, err := readRetained(config.Output, cutoff)
	if err != nil {
		return result, err
	}
	retainedKeys := make(map[string]struct{}, len(retained))
	for _, item := range retained {
		retainedKeys[valueKey(item.OperationalValue)] = struct{}{}
	}
	activeIDs := map[string]map[string]struct{}{}
	definitions := map[string]definition{}
	values := make([]envelope, 0)
	for _, entry := range scripts {
		if config.RateLimitReserve > 0 {
			remaining, rateErr := githubAPIRemaining(ctx, config)
			if rateErr != nil {
				result.Warnings = append(result.Warnings, rateErr.Error())
				continue
			}
			if remaining <= config.RateLimitReserve {
				result.Warnings = append(result.Warnings, fmt.Sprintf(
					"GitHub API core remaining is at or below the reserved %d requests",
					config.RateLimitReserve,
				))
				continue
			}
		}
		current, workerErr := runAdapter(ctx, config, entry, observedAt, repositories, "")
		if workerErr != nil {
			result.Warnings = append(result.Warnings, workerErr.Error())
			continue
		}
		values = append(values, envelopes(entry.campaign, current.values)...)
		if len(current.definitions) > 0 {
			activeIDs[entry.campaign] = map[string]struct{}{}
			for _, item := range current.definitions {
				for _, valueID := range item.ValueIDs {
					activeIDs[entry.campaign][valueID] = struct{}{}
					definitions[definitionKey(entry.campaign, valueID)] = item
				}
			}
		}
		if entry.campaign != config.HistoryCampaign {
			continue
		}
	historyDefinitions:
		for _, item := range current.definitions {
			supported := supportedRepositories(repositories, item.Repositories)
			if len(supported) == 0 {
				continue
			}
			times, historyErr := historicalTimes(item, observedAt, config.Retention)
			if historyErr != nil {
				result.Warnings = append(result.Warnings, historyErr.Error())
				break historyDefinitions
			}
			for _, timestamp := range times {
				if historyComplete(entry.campaign, supported, item.ValueIDs, timestamp, retainedKeys) {
					continue
				}
				history, historyErr := runAdapter(
					ctx, config, entry, timestamp, supported, item.WorkflowSlug,
				)
				if historyErr != nil {
					result.Warnings = append(result.Warnings, historyErr.Error())
					break historyDefinitions
				}
				expected := make(map[string]struct{}, len(item.ValueIDs))
				for _, valueID := range item.ValueIDs {
					expected[valueID] = struct{}{}
				}
				valid := true
				for _, value := range history.values {
					if value.Timestamp != formatTimestamp(timestamp) {
						valid = false
					}
					if _, ok := expected[value.ValueID]; !ok {
						valid = false
					}
				}
				if !valid {
					result.Warnings = append(result.Warnings,
						fmt.Sprintf("%s emitted values outside the requested history observation", entry.path))
					break historyDefinitions
				}
				historyEnvelopes := envelopes(entry.campaign, history.values)
				values = append(values, historyEnvelopes...)
				result.HistoryValues += len(historyEnvelopes)
				for _, value := range historyEnvelopes {
					retainedKeys[valueKey(value.OperationalValue)] = struct{}{}
				}
			}
		}
	}
	if config.RateLimitReserve > 0 {
		remaining, rateErr := githubAPIRemaining(ctx, config)
		if rateErr != nil {
			result.Warnings = append(result.Warnings, rateErr.Error())
		} else if remaining < config.RateLimitReserve {
			result.Warnings = append(result.Warnings, fmt.Sprintf(
				"operational value crossed the reserved GitHub API floor of %d requests",
				config.RateLimitReserve,
			))
		}
	}
	result.Values = len(values)
	if config.Output != "" {
		merged := persistValues(retained, values, activeIDs, definitions)
		if err := writeEnvelopes(config.Output, merged); err != nil {
			return result, err
		}
		collectLog.Printf("persisted operational values total=%d history=%d", len(merged), result.HistoryValues)
	}
	return result, nil
}

// persistValues combines this run's freshly collected values with the
// previously retained shard, retiring any retained value whose campaign no
// longer declares it active and resolving duplicates by cadence bucket or
// exact key. It is a pure function so the retire-then-merge decision is
// testable independently of the temp-file rename writeEnvelopes performs.
func persistValues(
	retained, values []envelope, activeIDs map[string]map[string]struct{}, definitions map[string]definition,
) []envelope {
	currentRetained := retireValues(retained, activeIDs)
	return mergeValues(append(currentRetained, values...), definitions)
}

func discoverScripts(root string) ([]script, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var scripts []script
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		candidate := filepath.Join(root, entry.Name(), "operational-value.mjs")
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() {
			scripts = append(scripts, script{campaign: entry.Name(), path: candidate})
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	sort.Slice(scripts, func(i, j int) bool { return scripts[i].campaign < scripts[j].campaign })
	return scripts, nil
}

func runAdapter(
	ctx context.Context,
	config Config,
	entry script,
	timestamp time.Time,
	repositories []string,
	module string,
) (parsedOutput, error) {
	request, err := json.Marshal(map[string]any{
		"schemaVersion": 1,
		"timestamp":     formatTimestamp(timestamp),
		"repositories":  repositories,
		"database":      absolute(config.Database),
	})
	if err != nil {
		return parsedOutput{}, err
	}
	node := config.NodeBinary
	if strings.TrimSpace(node) == "" {
		node = "node"
	}
	timeout := config.WorkerTimeout
	if timeout <= 0 {
		timeout = defaultWorkerTimeout
	}
	workerCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(workerCtx, node, entry.path) // #nosec G204 -- operator-configured Node and discovered adapter.
	configureProcessTree(command)
	command.Cancel = func() error {
		return terminateProcessTree(command.Process)
	}
	command.WaitDelay = 5 * time.Second
	command.Dir = config.Root
	command.Env = append([]string{}, config.Environment...)
	command.Env = append(command.Env,
		"CAO_DATABASE="+absolute(config.Database),
		"CAO_OPERATIONAL_VALUE_TIMESTAMP="+formatTimestamp(config.ObservedAt),
	)
	if module != "" {
		command.Env = append(command.Env, "CAO_OPERATIONAL_VALUE_MODULE="+module)
	}
	command.Stdin = bytes.NewReader(append(request, '\n'))
	stdout := newLimitedBuffer(maxWorkerOutput, cancel)
	stderr := newLimitedBuffer(maxWorkerOutput, cancel)
	command.Stdout = stdout
	command.Stderr = stderr
	runErr := command.Run()
	_ = terminateProcessTree(command.Process)
	if runErr != nil {
		message := strings.TrimSpace(stderr.String())
		switch {
		case errors.Is(workerCtx.Err(), context.DeadlineExceeded):
			message = fmt.Sprintf("timed out after %d ms", timeout.Milliseconds())
		case stdout.Exceeded():
			message = "stdout exceeded maxBuffer"
		case stderr.Exceeded():
			message = "stderr exceeded maxBuffer"
		case message == "":
			message = runErr.Error()
		}
		return parsedOutput{}, fmt.Errorf("%s failed: %s", entry.path, redact(message, config.RedactValues))
	}
	return parseOutput(stdout.Bytes(), entry.path, repositories)
}

type limitedBuffer struct {
	mu       sync.Mutex
	buffer   bytes.Buffer
	limit    int
	exceeded bool
	cancel   context.CancelFunc
}

func newLimitedBuffer(limit int, cancel context.CancelFunc) *limitedBuffer {
	return &limitedBuffer{limit: limit, cancel: cancel}
}

func (b *limitedBuffer) Write(content []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - b.buffer.Len()
	if remaining <= 0 {
		b.exceeded = true
		b.cancel()
		return len(content), nil
	}
	write := content
	if len(write) > remaining {
		write = write[:remaining]
		b.exceeded = true
	}
	_, _ = b.buffer.Write(write)
	if b.exceeded {
		b.cancel()
	}
	return len(content), nil
}

func (b *limitedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte{}, b.buffer.Bytes()...)
}

func (b *limitedBuffer) String() string {
	return string(b.Bytes())
}

func (b *limitedBuffer) Exceeded() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.exceeded
}

func githubAPIRemaining(ctx context.Context, config Config) (int, error) {
	gh := config.GitHubBinary
	if strings.TrimSpace(gh) == "" {
		gh = "gh"
	}
	rateCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(rateCtx, gh, // #nosec G204 -- operator-configured GitHub CLI.
		"api", "rate_limit", "--jq", ".resources.core.remaining")
	command.Env = append([]string{}, config.Environment...)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if errors.Is(rateCtx.Err(), context.DeadlineExceeded) {
			message = "timed out after 30000 ms"
		} else if message == "" {
			message = err.Error()
		}
		return 0, fmt.Errorf("unable to read GitHub API rate limit: %s",
			redact(message, config.RedactValues))
	}
	remaining, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil || remaining < 0 {
		return 0, errors.New("GitHub API returned an invalid core rate limit")
	}
	return remaining, nil
}

func parseOutput(content []byte, source string, repositories []string) (parsedOutput, error) {
	var output parsedOutput
	allowed := map[string]struct{}{}
	for _, repository := range repositories {
		allowed[strings.ToLower(repository)] = struct{}{}
	}
	defined := map[string]struct{}{}
	scanner := bufio.NewScanner(bytes.NewReader(content))
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var header struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
			return output, fmt.Errorf("%s:%d emitted invalid JSON: %w", source, line, err)
		}
		if header.Kind == "operational_value_definition" {
			var record definitionRecord
			if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
				return output, err
			}
			item, err := validateDefinition(record, source, line, defined)
			if err != nil {
				return output, err
			}
			output.definitions = append(output.definitions, item)
			continue
		}
		var record valueRecord
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(scanner.Bytes(), &fields); err != nil {
			return output, err
		}
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			return output, err
		}
		if err := validateValue(&record, fields, source, line, allowed); err != nil {
			return output, err
		}
		output.values = append(output.values, record)
	}
	if err := scanner.Err(); err != nil {
		return output, err
	}
	return output, nil
}

func validateDefinition(
	record definitionRecord, source string, line int, defined map[string]struct{},
) (definition, error) {
	adoptedAt, err := parseTimestamp(record.AdoptedAt)
	valid := err == nil &&
		slugPattern.MatchString(record.WorkflowSlug) &&
		(record.EvaluationMode == "baseline-comparable" || record.EvaluationMode == "attainment-only") &&
		!math.IsNaN(record.CadenceDays) && !math.IsInf(record.CadenceDays, 0) && record.CadenceDays > 0 &&
		len(record.Repositories) > 0 && len(record.ValueIDs) > 0
	for _, repository := range record.Repositories {
		valid = valid && repositoryPattern.MatchString(repository)
	}
	for _, valueID := range record.ValueIDs {
		valid = valid && identifierPattern.MatchString(valueID) &&
			strings.HasPrefix(valueID, record.WorkflowSlug+".")
		if _, exists := defined[valueID]; exists {
			return definition{}, fmt.Errorf("%s:%d emitted a duplicate operational value definition ID: %s",
				source, line, valueID)
		}
		defined[valueID] = struct{}{}
	}
	if !valid {
		return definition{}, fmt.Errorf("%s:%d must emit a valid operational value definition", source, line)
	}
	repositories := uniqueLower(record.Repositories)
	return definition{
		WorkflowSlug: record.WorkflowSlug, AdoptedAt: adoptedAt,
		EvaluationMode: record.EvaluationMode, CadenceDays: record.CadenceDays,
		Repositories: repositories, ValueIDs: append([]string{}, record.ValueIDs...),
	}, nil
}

func validateValue(
	record *valueRecord,
	fields map[string]json.RawMessage,
	source string,
	line int,
	allowed map[string]struct{},
) error {
	timestamp, err := parseTimestamp(record.Timestamp)
	if err != nil {
		return fmt.Errorf("%s:%d.timestamp must be an ISO-8601 timestamp", source, line)
	}
	record.Timestamp = formatTimestamp(timestamp)
	if !repositoryPattern.MatchString(record.Repository) {
		return fmt.Errorf("%s:%d.repository must identify a requested repository", source, line)
	}
	if _, ok := allowed[strings.ToLower(record.Repository)]; !ok {
		return fmt.Errorf("%s:%d.repository must identify a requested repository", source, line)
	}
	if !identifierPattern.MatchString(record.ValueID) {
		return fmt.Errorf("%s:%d.valueId must be a lowercase metric identifier", source, line)
	}
	if record.Value == nil || math.IsNaN(*record.Value) || math.IsInf(*record.Value, 0) {
		return fmt.Errorf("%s:%d.value must be a finite number", source, line)
	}
	if record.MetricRole != nil && *record.MetricRole != "primary" && *record.MetricRole != "diagnostic" {
		return fmt.Errorf("%s:%d.metricRole must be primary or diagnostic", source, line)
	}
	if record.MetricName != nil {
		name := strings.TrimSpace(*record.MetricName)
		if name == "" {
			return fmt.Errorf("%s:%d.metricName must be a non-empty string", source, line)
		}
		record.MetricName = &name
	}
	if fieldIsNull(fields, "metricUnit") ||
		(record.MetricUnit != nil && strings.TrimSpace(*record.MetricUnit) == "") {
		return fmt.Errorf("%s:%d.metricUnit must be a non-empty string", source, line)
	}
	if record.MetricUnit != nil {
		trimmed := strings.TrimSpace(*record.MetricUnit)
		record.MetricUnit = &trimmed
	}
	if record.MetricDirection != nil && !oneOf(*record.MetricDirection, "increase", "decrease", "maintain", "target") {
		return fmt.Errorf("%s:%d.metricDirection is invalid", source, line)
	}
	if record.MaturityStatus != nil && !oneOf(*record.MaturityStatus, "matured", "interim", "unavailable") {
		return fmt.Errorf("%s:%d.maturityStatus is invalid", source, line)
	}
	if fieldIsNull(fields, "adoptionAt") {
		return fmt.Errorf("%s:%d.adoptionAt must be an ISO-8601 timestamp", source, line)
	}
	if record.AdoptionAt != nil {
		value, err := parseTimestamp(*record.AdoptionAt)
		if err != nil {
			return fmt.Errorf("%s:%d.adoptionAt must be an ISO-8601 timestamp", source, line)
		}
		canonical := formatTimestamp(value)
		record.AdoptionAt = &canonical
	}
	if fieldIsNull(fields, "evaluationMode") ||
		(record.EvaluationMode != nil &&
			!oneOf(*record.EvaluationMode, "baseline-comparable", "attainment-only")) {
		return fmt.Errorf("%s:%d.evaluationMode is invalid", source, line)
	}
	for name, value := range map[string]*string{
		"workflowSlug": record.WorkflowSlug, "workflowName": record.WorkflowName,
	} {
		if fieldIsNull(fields, name) {
			return fmt.Errorf("%s:%d.%s must be a non-empty string", source, line, name)
		}
		if value != nil {
			trimmed := strings.TrimSpace(*value)
			if trimmed == "" {
				return fmt.Errorf("%s:%d.%s must be a non-empty string", source, line, name)
			}
			*value = trimmed
		}
	}
	_, hasNumerator := fields["rollupNumerator"]
	_, hasDenominator := fields["rollupDenominator"]
	if hasNumerator != hasDenominator ||
		(hasNumerator &&
			(record.RollupNumerator == nil || record.RollupDenominator == nil ||
				!finiteNonNegative(*record.RollupNumerator) ||
				!finitePositive(*record.RollupDenominator))) {
		return fmt.Errorf("%s:%d must emit a valid rollup numerator and denominator together", source, line)
	}
	return nil
}

func envelopes(campaign string, records []valueRecord) []envelope {
	output := make([]envelope, 0, len(records))
	for _, record := range records {
		role, name, direction, maturity := "primary", record.ValueID, "increase", "matured"
		if record.MetricRole != nil {
			role = *record.MetricRole
		}
		if record.MetricName != nil {
			name = *record.MetricName
		}
		if record.MetricDirection != nil {
			direction = *record.MetricDirection
		}
		if record.MaturityStatus != nil {
			maturity = *record.MaturityStatus
		}
		output = append(output, envelope{
			SchemaVersion: 2, Kind: "operational_value",
			OperationalValue: operationalValue{
				Timestamp: record.Timestamp, Repository: record.Repository,
				Campaign: campaign, CampaignID: "campaign:" + campaign,
				ValueID: record.ValueID, Value: *record.Value,
				MetricRole: role, MetricName: name, MetricUnit: record.MetricUnit,
				MetricDirection: direction, MaturityStatus: maturity,
				AdoptionAt: record.AdoptionAt, EvaluationMode: record.EvaluationMode,
				WorkflowSlug: record.WorkflowSlug, WorkflowName: record.WorkflowName,
				RollupNumerator:   record.RollupNumerator,
				RollupDenominator: record.RollupDenominator,
			},
		})
	}
	return output
}

func readRetained(path string, cutoff time.Time) ([]envelope, error) {
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path) // #nosec G304 -- operator-configured evidence-lake path.
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	var retained []envelope
	scanner := bufio.NewScanner(file)
	line := 0
	for scanner.Scan() {
		line++
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var item envelope
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			return nil, err
		}
		if item.SchemaVersion != 2 || item.Kind != "operational_value" {
			return nil, fmt.Errorf("%s:%d is not an operational value envelope", path, line)
		}
		timestamp, err := parseTimestamp(item.OperationalValue.Timestamp)
		if err != nil {
			return nil, fmt.Errorf("%s:%d has an invalid operational value timestamp", path, line)
		}
		if (cutoff.IsZero() || !timestamp.Before(cutoff)) &&
			strings.TrimSpace(item.OperationalValue.Campaign) != "" {
			retained = append(retained, item)
		}
	}
	return retained, scanner.Err()
}

func retireValues(values []envelope, active map[string]map[string]struct{}) []envelope {
	output := values[:0]
	for _, item := range values {
		ids, found := active[item.OperationalValue.Campaign]
		if !found {
			output = append(output, item)
			continue
		}
		if _, exists := ids[item.OperationalValue.ValueID]; exists {
			output = append(output, item)
		}
	}
	return output
}

func mergeValues(values []envelope, definitions map[string]definition) []envelope {
	index := map[string]int{}
	merged := make([]envelope, 0, len(values))
	for _, item := range values {
		key := valueKey(item.OperationalValue)
		if definition, ok := definitions[definitionKey(
			item.OperationalValue.Campaign, item.OperationalValue.ValueID,
		)]; ok {
			key = cadenceKey(item.OperationalValue, definition)
		}
		if position, exists := index[key]; exists {
			current, _ := parseTimestamp(merged[position].OperationalValue.Timestamp)
			candidate, _ := parseTimestamp(item.OperationalValue.Timestamp)
			if !candidate.Before(current) {
				merged[position] = item
			}
			continue
		}
		index[key] = len(merged)
		merged = append(merged, item)
	}
	return merged
}

func writeEnvelopes(path string, values []envelope) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	var content bytes.Buffer
	encoder := json.NewEncoder(&content)
	encoder.SetEscapeHTML(false)
	for _, item := range values {
		if err := encoder.Encode(item); err != nil {
			return err
		}
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".operational-values-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(content.Bytes()); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func historicalTimes(
	item definition, observedAt time.Time, retention time.Duration,
) ([]time.Time, error) {
	cadence := time.Duration(item.CadenceDays * float64(day))
	origin := item.AdoptedAt
	if item.EvaluationMode == "baseline-comparable" {
		origin = origin.Add(-baselineObservations * cadence)
	}
	cutoff := origin
	if retainedCutoff := observedAt.Add(-retention); retainedCutoff.After(cutoff) {
		cutoff = retainedCutoff
	}
	var times []time.Time
	for timestamp := origin; timestamp.Before(observedAt); timestamp = timestamp.Add(cadence) {
		if !timestamp.Before(cutoff) {
			times = append(times, timestamp)
		}
		if len(times) > maxHistoryObservations {
			return nil, fmt.Errorf("operational value history exceeds %d observations",
				maxHistoryObservations)
		}
	}
	return times, nil
}

func historyComplete(
	campaign string, repositories, valueIDs []string, timestamp time.Time, retained map[string]struct{},
) bool {
	for _, repository := range repositories {
		for _, valueID := range valueIDs {
			key := strings.ToLower(campaign) + "\x00" + strings.ToLower(repository) +
				"\x00" + valueID + "\x00" + formatTimestamp(timestamp)
			if _, exists := retained[key]; !exists {
				return false
			}
		}
	}
	return true
}

func valueKey(value operationalValue) string {
	return strings.ToLower(strings.TrimSpace(value.Campaign)) + "\x00" +
		strings.ToLower(value.Repository) + "\x00" + value.ValueID + "\x00" + value.Timestamp
}

func definitionKey(campaign, valueID string) string {
	return strings.ToLower(campaign) + "\x00" + valueID
}

func cadenceKey(value operationalValue, item definition) string {
	cadence := time.Duration(item.CadenceDays * float64(day))
	timestamp, _ := parseTimestamp(value.Timestamp)
	bucket := math.Ceil(float64(timestamp.Sub(item.AdoptedAt)) / float64(cadence))
	end := item.AdoptedAt.Add(time.Duration(bucket) * cadence)
	return strings.ToLower(value.Campaign) + "\x00" + strings.ToLower(value.Repository) +
		"\x00" + value.ValueID + "\x00" + formatTimestamp(end)
}

func normalizeRepositories(repositories []string) ([]string, error) {
	seen := map[string]string{}
	for _, repository := range repositories {
		if !repositoryPattern.MatchString(repository) {
			return nil, fmt.Errorf("invalid repository: %s", repository)
		}
		key := strings.ToLower(repository)
		if _, exists := seen[key]; !exists {
			seen[key] = repository
		}
	}
	output := make([]string, 0, len(seen))
	for _, repository := range seen {
		output = append(output, repository)
	}
	sort.Slice(output, func(i, j int) bool {
		return strings.ToLower(output[i]) < strings.ToLower(output[j])
	})
	return output, nil
}

func supportedRepositories(requested, supported []string) []string {
	allowed := map[string]struct{}{}
	for _, repository := range supported {
		allowed[strings.ToLower(repository)] = struct{}{}
	}
	var output []string
	for _, repository := range requested {
		if _, ok := allowed[strings.ToLower(repository)]; ok {
			output = append(output, repository)
		}
	}
	return output
}

func uniqueLower(values []string) []string {
	seen := map[string]struct{}{}
	output := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.ToLower(value)
		if _, exists := seen[value]; !exists {
			seen[value] = struct{}{}
			output = append(output, value)
		}
	}
	return output
}

func hasCampaign(scripts []script, campaign string) bool {
	for _, script := range scripts {
		if script.campaign == campaign {
			return true
		}
	}
	return false
}

func parseTimestamp(value string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, value)
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func absolute(path string) string {
	value, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return value
}

func finiteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func finitePositive(value float64) bool {
	return finiteNonNegative(value) && value > 0
}

func oneOf(value string, options ...string) bool {
	for _, option := range options {
		if value == option {
			return true
		}
	}
	return false
}

func fieldIsNull(fields map[string]json.RawMessage, name string) bool {
	value, exists := fields[name]
	return exists && bytes.Equal(bytes.TrimSpace(value), []byte("null"))
}

func redact(value string, secrets []string) string {
	for _, secret := range secrets {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "***")
		}
	}
	return value
}
