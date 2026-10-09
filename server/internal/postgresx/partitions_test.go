package postgresx

import (
	"testing"
	"time"
)

func TestWeekStart(t *testing.T) {
	for _, tt := range []struct {
		name string
		at   time.Time
		want time.Time
	}{
		{
			name: "monday unchanged",
			at:   time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC),
			want: time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "mid-week truncates to preceding monday",
			at:   time.Date(2024, time.January, 3, 15, 30, 0, 0, time.UTC),
			want: time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "sunday belongs to the prior monday's week",
			at:   time.Date(2024, time.January, 7, 23, 59, 59, 0, time.UTC),
			want: time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC),
		},
		{
			name: "non-UTC input is normalized before truncation",
			at:   time.Date(2024, time.January, 2, 1, 0, 0, 0, time.FixedZone("UTC-5", -5*60*60)),
			want: time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC),
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := weekStart(tt.at)
			if !got.Equal(tt.want) || got.Location() != time.UTC {
				t.Fatalf("weekStart(%v) = %v, want %v", tt.at, got, tt.want)
			}
		})
	}
}

func TestConfiguredRetentionDays(t *testing.T) {
	for _, tt := range []struct {
		name    string
		value   string
		want    int
		wantErr bool
	}{
		{name: "default", want: 30},
		{name: "blank", value: " \t ", want: 30},
		{name: "override", value: "400", want: 400},
		{name: "trimmed override", value: " 14 ", want: 14},
		{name: "minimum", value: "7", want: 7},
		{name: "maximum", value: "3650", want: 3650},
		{name: "below minimum", value: "6", wantErr: true},
		{name: "above maximum", value: "3651", wantErr: true},
		{name: "invalid", value: "30days", wantErr: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("CAO_POSTGRES_RUN_RETENTION_DAYS", tt.value)
			got, err := configuredRetentionDays()
			if tt.wantErr {
				if err == nil {
					t.Fatal("invalid retention was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("configuredRetentionDays() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestConfiguredLinkedRetentionDays(t *testing.T) {
	for _, tt := range []struct {
		value   string
		want    int
		wantErr bool
	}{
		{want: 7},
		{value: " \t ", want: 7},
		{value: " 14 ", want: 14},
		{value: "3650", want: 3650},
		{value: "6", wantErr: true},
		{value: "3651", wantErr: true},
		{value: "invalid", wantErr: true},
	} {
		t.Run(tt.value, func(t *testing.T) {
			t.Setenv("CAO_POSTGRES_LINKED_RETENTION_DAYS", tt.value)
			got, err := configuredLinkedRetentionDays()
			if (err != nil) != tt.wantErr || (!tt.wantErr && got != tt.want) {
				t.Fatalf("configuredLinkedRetentionDays() = %d, %v; want %d, error=%v", got, err, tt.want, tt.wantErr)
			}
		})
	}
}

func TestRetentionBounds(t *testing.T) {
	for _, tt := range []struct {
		run, linked int
	}{
		{6, 7}, {30, 6}, {30, 31},
	} {
		store := &Store{}
		if err := store.RunPartitionMaintenance(t.Context(), time.Now(), tt.run, tt.linked); err == nil {
			t.Fatalf("accepted invalid retention run=%d linked=%d", tt.run, tt.linked)
		}
	}
}
