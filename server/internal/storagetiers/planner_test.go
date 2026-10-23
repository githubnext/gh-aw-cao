package storagetiers

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"reflect"
	"testing"
	"time"
)

func pointer[T any](value T) *T { return &value }

func parseFixtureTime(t *testing.T, text *string) *int64 {
	t.Helper()
	if text == nil {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *text)
	if err != nil {
		t.Fatal(err)
	}
	value := parsed.UnixMilli()
	return &value
}

func TestPlannerJavaScriptParity(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Fatal("Node.js is required for the shared storage-tier parity contract")
	}
	const script = `
import { planStorageTiers } from '../../../dashboard/site/src/data/storage/tiering.js';
const watermark = Date.parse('2026-10-21T12:00:00Z');
const ids = ['😀', '\uE000', 'quote:"', 'slash:\\', 'line:\n', '<>&', 'separators:\u2028\u2029', '\u0000\b\t\f\r', '\u0085', ...Array.from({length:97}, (_,i)=>'run:'+i)];
const runs = ids.map((id, i) => ({
  id, startedAt: new Date(watermark-(i%10-1)*86400000).toISOString(), observedAt:'2026-10-21T00:00:00Z',
  conclusion:['failure','success','cancelled','timed_out','startup_failure','action_required'][i%6]
}));
runs.push({id:'fallback',completedAt:'2026-10-19T00:00:00Z',observedAt:'2026-10-21T00:00:00Z'});
const cases = [];
for (const capacities of [{hot:0,statistical:0},{hot:1,statistical:3},{hot:11,statistical:23},{hot:500,statistical:500}]) {
  const options={backend:'postgres',namespace:'space:<>&😀\u2028',seed:'seed:\\\n\u2029',watermark,capacities};
  cases.push({options,runs,expected:planStorageTiers(runs, options)});
}
console.log(JSON.stringify(cases));`
	command := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", script)
	content, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("JavaScript parity fixture: %v\n%s", err, content)
	}
	var cases []struct {
		Options struct {
			Namespace  string
			Seed       string
			Watermark  int64
			Capacities Capacities
		}
		Runs []struct {
			ID          string
			StartedAt   *string
			CompletedAt *string
			Conclusion  string
		}
		Expected Plan
	}
	if err := json.Unmarshal(content, &cases); err != nil {
		t.Fatal(err)
	}
	for index, fixture := range cases {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			planner, err := New(fixture.Options.Namespace, Options{
				Watermark: &fixture.Options.Watermark, Seed: fixture.Options.Seed,
				Hot: &fixture.Options.Capacities.Hot, Statistical: &fixture.Options.Capacities.Statistical,
			})
			if err != nil {
				t.Fatal(err)
			}
			for i := len(fixture.Runs) - 1; i >= 0; i-- {
				record := fixture.Runs[i]
				run := Run{ID: record.ID, Conclusion: record.Conclusion}
				run.StartedAt = parseFixtureTime(t, record.StartedAt)
				run.CompletedAt = parseFixtureTime(t, record.CompletedAt)
				if err := planner.Add(run); err != nil {
					t.Fatal(err)
				}
				if planner.RetainedCandidates() > fixture.Options.Capacities.Hot+fixture.Options.Capacities.Statistical {
					t.Fatal("candidate storage exceeds capacity")
				}
			}
			actual, err := planner.Finish()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, fixture.Expected) {
				got, _ := json.Marshal(actual)
				want, _ := json.Marshal(fixture.Expected)
				t.Fatalf("Go/JavaScript tier parity mismatch:\ngot %s\nwant %s", got, want)
			}
		})
	}
}

func TestPlannerRejectsInvalidOptionsAndRuns(t *testing.T) {
	for _, options := range []Options{
		{Seed: "seed"},
		{Seed: "", Watermark: pointer(int64(0))},
		{Seed: "seed", Watermark: pointer(maximumJSTime + 1)},
		{Seed: "seed", Watermark: pointer(int64(0)), Hot: pointer(-1)},
		{Seed: "seed", Watermark: pointer(int64(0)), Statistical: pointer(-1)},
	} {
		if _, err := New("namespace", options); err == nil {
			t.Fatalf("accepted invalid options %+v", options)
		}
	}
	planner, err := New("namespace", Options{Seed: "seed", Watermark: pointer(int64(0))})
	if err != nil {
		t.Fatal(err)
	}
	if err := planner.Add(Run{ID: "missing-event"}); err == nil {
		t.Fatal("accepted a missing event timestamp")
	}
	if _, err := planner.Finish(); err == nil {
		t.Fatal("published a failed prefix")
	}
}

func TestPlannerEpochAndClosedState(t *testing.T) {
	planner, err := New("namespace", Options{Seed: "seed", Watermark: pointer(int64(0))})
	if err != nil {
		t.Fatal(err)
	}
	if err := planner.Add(Run{ID: "epoch", StartedAt: pointer(int64(0))}); err != nil {
		t.Fatal(err)
	}
	plan, err := planner.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan.Hot, []string{"epoch"}) || !plan.WeightsValid || plan.EvictionEnabled {
		t.Fatalf("unexpected epoch plan: %+v", plan)
	}
	if _, err := planner.Finish(); err == nil {
		t.Fatal("published a second plan")
	}
	if err := planner.Add(Run{ID: "after-finish", StartedAt: pointer(int64(0))}); err == nil {
		t.Fatal("accepted input after finish")
	}
}

func TestPlannerIndependentCapacitiesAndBoundedPopulation(t *testing.T) {
	for _, fixture := range []struct {
		options Options
		want    Capacities
	}{
		{Options{}, Capacities{Hot: 16_000, Statistical: 64_000}},
		{Options{Hot: pointer(17)}, Capacities{Hot: 17, Statistical: 64_000}},
		{Options{Statistical: pointer(19)}, Capacities{Hot: 16_000, Statistical: 19}},
	} {
		fixture.options.Seed = "seed"
		fixture.options.Watermark = pointer(int64(0))
		planner, err := New("namespace", fixture.options)
		if err != nil {
			t.Fatal(err)
		}
		plan, err := planner.Finish()
		if err != nil || plan.Capacities != fixture.want || !plan.WeightsValid ||
			plan.Hot == nil || plan.Statistical == nil || len(plan.Hot)+len(plan.Statistical) != 0 {
			t.Fatalf("invalid empty/default plan: %+v: %v", plan, err)
		}
	}
	planner, err := New("namespace", Options{
		Watermark: pointer(int64(0)), Seed: "seed", Hot: pointer(7), Statistical: pointer(13),
	})
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 100_000; index++ {
		if err := planner.Add(Run{ID: fmt.Sprintf("run:%d", index), StartedAt: pointer(int64(0))}); err != nil {
			t.Fatal(err)
		}
		if planner.RetainedCandidates() > 20 {
			t.Fatal("retained candidates exceeded independent capacities")
		}
	}
	plan, err := planner.Finish()
	if err != nil || plan.StatisticalPopulation != 100_000 || len(plan.Hot) != 7 ||
		len(plan.Statistical) != 13 || plan.WeightsValid || plan.EvictionEnabled {
		t.Fatalf("unexpected bounded plan %+v: %v", plan, err)
	}
}
