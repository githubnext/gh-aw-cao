package postgresx

import "testing"

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
