package doctor

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Render writes the report in the requested format.
//
// Both formats carry the same check identifiers and the same facts. The text
// format is the default because it is readable by a person and still
// line-oriented enough to grep; the JSON format is for a program that wants
// the whole structure.
func Render(writer io.Writer, report Report, format string) error {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "", "text":
		return renderText(writer, report)
	case "json":
		encoder := json.NewEncoder(writer)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	default:
		return fmt.Errorf("unknown report format %q; expected text or json", format)
	}
}

// marker is the fixed-width status marker. It is uppercase and bracketed so a
// reader can scan the left margin and a script can match on it.
func marker(status Status) string {
	switch status {
	case StatusPass:
		return "[ PASS ]"
	case StatusWarn:
		return "[ WARN ]"
	case StatusFail:
		return "[ FAIL ]"
	case StatusSkip:
		return "[ SKIP ]"
	default:
		return "[ ???? ]"
	}
}

func renderText(writer io.Writer, report Report) error {
	buffer := &strings.Builder{}
	fmt.Fprintf(buffer, "CAO server check-up\n")
	fmt.Fprintf(buffer, "  generated   %s\n", report.GeneratedAt)
	fmt.Fprintf(buffer, "  version     %s\n", report.Version)
	fmt.Fprintf(buffer, "  profile     %s\n", report.Profile)
	fmt.Fprintf(buffer, "  redis       %s\n", report.Redis)
	fmt.Fprintf(buffer, "  namespace   %s\n", report.Namespace)
	fmt.Fprintf(buffer, "  depth       %s\n", depthLabel(report.Deep))

	area := ""
	for _, check := range report.Checks {
		if check.Area != area {
			area = check.Area
			fmt.Fprintf(buffer, "\n%s\n", strings.ToUpper(area))
		}
		fmt.Fprintf(buffer, "  %s %-28s %s\n", marker(check.Status), check.ID, check.Summary)
		for _, item := range check.Details {
			fmt.Fprintf(buffer, "           %-26s %s\n", item.Name, item.Value)
		}
		if check.Remedy != "" {
			fmt.Fprintf(buffer, "           %-26s %s\n", "remedy", check.Remedy)
		}
	}

	fmt.Fprintf(buffer, "\nSUMMARY\n")
	fmt.Fprintf(buffer, "  %s %d checks in %dms: %d pass, %d warn, %d fail, %d skip\n",
		marker(report.Summary.Status), report.Summary.Total, report.Summary.DurationMS,
		report.Summary.Pass, report.Summary.Warn, report.Summary.Fail, report.Summary.Skip)

	// Repeating the problems at the end means the reader never has to scroll
	// back through a long passing report to find what needs attention, and an
	// agent can read only this section.
	problems := make([]Check, 0, report.Summary.Fail+report.Summary.Warn)
	for _, check := range report.Checks {
		if check.Status == StatusFail || check.Status == StatusWarn {
			problems = append(problems, check)
		}
	}
	if len(problems) > 0 {
		fmt.Fprintf(buffer, "\nACTION REQUIRED\n")
		for _, check := range problems {
			fmt.Fprintf(buffer, "  %s %s: %s\n", marker(check.Status), check.ID, check.Summary)
			if check.Remedy != "" {
				fmt.Fprintf(buffer, "           %s\n", check.Remedy)
			}
		}
	}
	_, err := io.WriteString(writer, buffer.String())
	return err
}

func depthLabel(deep bool) string {
	if deep {
		return "deep (includes source read probes)"
	}
	return "standard (no source read probes; pass --deep to include them)"
}
