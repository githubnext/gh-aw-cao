// Package storagetiers plans canonical Run retention without authorizing eviction.
package storagetiers

import (
	"container/heap"
	"errors"
	"math"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/githubnext/gh-cao/internal/dashboardquery"
)

const (
	PolicyVersion      = 1
	StatisticalWindow  = int64(7 * 24 * 60 * 60 * 1000)
	DefaultHot         = 16_000
	DefaultStatistical = 64_000
	maximumJSTime      = int64(8_640_000_000_000_000)
)

type Options struct {
	Watermark   *int64
	Seed        string
	Hot         *int
	Statistical *int
}

// Run is a reconciled canonical identity, not an evidence revision or patch.
type Run struct {
	ID          string
	StartedAt   *int64
	CompletedAt *int64
	Conclusion  string
}

type Capacities struct {
	Hot         int `json:"hot"`
	Statistical int `json:"statistical"`
}

type StatisticalRun struct {
	ID                       string   `json:"id"`
	PriorityWeight           int      `json:"priorityWeight"`
	Priority                 float64  `json:"priority"`
	InclusionProbability     *float64 `json:"inclusionProbability"`
	InverseProbabilityWeight *float64 `json:"inverseProbabilityWeight"`
}

type Window struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

type Plan struct {
	PolicyVersion         int              `json:"policyVersion"`
	Namespace             string           `json:"namespace"`
	Watermark             int64            `json:"watermark"`
	Capacities            Capacities       `json:"capacities"`
	Hot                   []string         `json:"hot"`
	Statistical           []StatisticalRun `json:"statistical"`
	StatisticalPopulation int64            `json:"statisticalPopulation"`
	StatisticalWindow     Window           `json:"statisticalWindow"`
	WeightsValid          bool             `json:"weightsValid"`
	WeightValidity        string           `json:"weightValidity"`
	DeferredFutureRuns    int64            `json:"deferredFutureRuns"`
	EvictionEnabled       bool             `json:"evictionEnabled"`
}

type hotRun struct {
	id        string
	timestamp int64
}

type selection[T any] struct {
	entries []T
	limit   int
	better  func(T, T) bool
}

func (s selection[T]) Len() int           { return len(s.entries) }
func (s selection[T]) Less(i, j int) bool { return s.better(s.entries[j], s.entries[i]) }
func (s selection[T]) Swap(i, j int)      { s.entries[i], s.entries[j] = s.entries[j], s.entries[i] }
func (s *selection[T]) Push(value any)    { s.entries = append(s.entries, value.(T)) }
func (s *selection[T]) Pop() any {
	last := len(s.entries) - 1
	value := s.entries[last]
	var zero T
	s.entries[last] = zero
	s.entries = s.entries[:last]
	return value
}

func (s *selection[T]) add(value T) {
	if s.limit == 0 {
		return
	}
	if s.Len() < s.limit {
		heap.Push(s, value)
	} else if s.better(value, s.entries[0]) {
		s.entries[0] = value
		heap.Fix(s, 0)
	}
}

func (s selection[T]) sorted() []T {
	result := append([]T{}, s.entries...)
	slices.SortFunc(result, func(a, b T) int {
		if s.better(a, b) {
			return -1
		}
		if s.better(b, a) {
			return 1
		}
		return 0
	})
	return result
}

type Planner struct {
	plan        Plan
	seed        string
	hot         selection[hotRun]
	statistical selection[StatisticalRun]
	closed      bool
}

func New(namespace string, options Options) (*Planner, error) {
	if !validIdentifier(namespace) || !validIdentifier(options.Seed) {
		return nil, errors.New("tier namespace and seed must be nonempty UTF-8 strings")
	}
	if options.Watermark == nil || !validTime(*options.Watermark) {
		return nil, errors.New("an explicit logical watermark in epoch milliseconds is required")
	}
	capacities := Capacities{Hot: DefaultHot, Statistical: DefaultStatistical}
	if options.Hot != nil {
		capacities.Hot = *options.Hot
	}
	if options.Statistical != nil {
		capacities.Statistical = *options.Statistical
	}
	if capacities.Hot < 0 || capacities.Statistical < 0 ||
		int64(capacities.Hot) > 9_007_199_254_740_991 || int64(capacities.Statistical) > 9_007_199_254_740_991 {
		return nil, errors.New("tier capacities must be non-negative JavaScript-safe integers")
	}
	return &Planner{
		plan: Plan{
			PolicyVersion: PolicyVersion, Namespace: namespace, Watermark: *options.Watermark,
			Capacities: capacities, Hot: []string{}, Statistical: []StatisticalRun{},
			StatisticalWindow: Window{Start: *options.Watermark - StatisticalWindow, End: *options.Watermark},
		},
		seed: options.Seed,
		hot: selection[hotRun]{limit: capacities.Hot, better: func(a, b hotRun) bool {
			return a.timestamp > b.timestamp || a.timestamp == b.timestamp && idBefore(a.id, b.id)
		}},
		statistical: selection[StatisticalRun]{limit: capacities.Statistical, better: func(a, b StatisticalRun) bool {
			return a.Priority > b.Priority || a.Priority == b.Priority && idBefore(a.ID, b.ID)
		}},
	}, nil
}

func validIdentifier(value string) bool {
	return utf8.ValidString(value) && strings.TrimFunc(value, func(char rune) bool {
		return char == '\uFEFF' || char != '\u0085' && unicode.IsSpace(char)
	}) != ""
}
func validTime(value int64) bool { return value >= -maximumJSTime && value <= maximumJSTime }
func idBefore(a, b string) bool  { return dashboardquery.CompareRecordKeys(a, b) < 0 }

// Add accepts distinct canonical identities in any order. The storage adapter
// must reject duplicate identities before feeding a snapshot to this planner.
func (p *Planner) Add(run Run) error {
	if p.closed {
		return errors.New("storage tier planner is closed")
	}
	timestamp := run.StartedAt
	if timestamp == nil || !validTime(*timestamp) {
		timestamp = run.CompletedAt
	}
	if !validIdentifier(run.ID) || timestamp == nil || !validTime(*timestamp) {
		p.closed = true
		return errors.New("canonical run requires an ID and a valid startedAt or completedAt")
	}
	if *timestamp > p.plan.Watermark {
		p.plan.DeferredFutureRuns++
		return nil
	}
	p.hot.add(hotRun{id: run.ID, timestamp: *timestamp})
	if *timestamp >= p.plan.StatisticalWindow.Start {
		p.plan.StatisticalPopulation++
		weight := outcomeWeight(run.Conclusion)
		p.statistical.add(StatisticalRun{
			ID: run.ID, PriorityWeight: weight,
			Priority: float64(weight) / priorityUnit(p.plan.Namespace, p.seed, run.ID),
		})
	}
	return nil
}

func (p *Planner) RetainedCandidates() int { return p.hot.Len() + p.statistical.Len() }

func (p *Planner) Finish() (Plan, error) {
	if p.closed {
		return Plan{}, errors.New("storage tier planner is closed")
	}
	p.closed = true
	for _, run := range p.hot.sorted() {
		p.plan.Hot = append(p.plan.Hot, run.id)
	}
	p.plan.Statistical = p.statistical.sorted()
	p.plan.WeightsValid = p.plan.StatisticalPopulation <= int64(p.plan.Capacities.Statistical)
	p.plan.WeightValidity = "deterministic-priority-only"
	if p.plan.WeightsValid {
		p.plan.WeightValidity = "census"
		for index := range p.plan.Statistical {
			one := 1.0
			p.plan.Statistical[index].InclusionProbability = &one
			p.plan.Statistical[index].InverseProbabilityWeight = &one
		}
	}
	return p.plan, nil
}

func outcomeWeight(conclusion string) int {
	switch conclusion {
	case "failure", "timed-out", "startup-failure", "action-required", "timed_out", "startup_failure", "action_required":
		return 4
	case "cancelled":
		return 2
	default:
		return 1
	}
}

// JSON.stringify's tuple and UTF-16 code units define the browser hash input,
// including literal HTML characters and U+2028/U+2029 rather than Go JSON escapes.
func priorityUnit(namespace, seed, id string) float64 {
	var tuple strings.Builder
	tuple.WriteByte('[')
	for index, value := range []string{namespace, seed, id} {
		if index > 0 {
			tuple.WriteByte(',')
		}
		tuple.WriteByte('"')
		for _, char := range value {
			switch {
			case char == '"' || char == '\\':
				tuple.WriteByte('\\')
				tuple.WriteRune(char)
			case char == '\b':
				tuple.WriteString(`\b`)
			case char == '\t':
				tuple.WriteString(`\t`)
			case char == '\n':
				tuple.WriteString(`\n`)
			case char == '\f':
				tuple.WriteString(`\f`)
			case char == '\r':
				tuple.WriteString(`\r`)
			case char < 0x20:
				const hex = "0123456789abcdef"
				tuple.WriteString(`\u00`)
				tuple.WriteByte(hex[char>>4])
				tuple.WriteByte(hex[char&15])
			default:
				tuple.WriteRune(char)
			}
		}
		tuple.WriteByte('"')
	}
	tuple.WriteByte(']')
	first, second := uint32(0x811c9dc5), uint32(0x9e3779b9)
	for _, code := range utf16.Encode([]rune(tuple.String())) {
		first = (first ^ uint32(code)) * 0x01000193
		second = (second ^ uint32(code)) * 0x85ebca6b
	}
	return (float64(first)*0x200000 + float64(second>>11) + 1) / (math.Pow(2, 53) + 2)
}
