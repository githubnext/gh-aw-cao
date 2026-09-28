package collect

import (
	"errors"
	"testing"
)

func TestResolveConsumerName_PrefersExplicitValue(t *testing.T) {
	hostnameCalled := false
	tokenCalled := false
	name, source := resolveConsumerName("configured-consumer",
		func() (string, error) { hostnameCalled = true; return "host", nil },
		func() (string, error) { tokenCalled = true; return "0123456789abcdef", nil },
	)
	if name != "configured-consumer" {
		t.Errorf("name = %q, want %q", name, "configured-consumer")
	}
	if source != consumerNameSourceExplicit {
		t.Errorf("source = %q, want %q", source, consumerNameSourceExplicit)
	}
	if hostnameCalled || tokenCalled {
		t.Error("resolveConsumerName should not consult hostname or token when an explicit value is supplied")
	}
}

func TestResolveConsumerName_GeneratesFromHostnameAndToken(t *testing.T) {
	name, source := resolveConsumerName("",
		func() (string, error) { return "worker-host", nil },
		func() (string, error) { return "0123456789abcdef", nil },
	)
	if want := "worker-host-01234567"; name != want {
		t.Errorf("name = %q, want %q", name, want)
	}
	if source != consumerNameSourceGenerated {
		t.Errorf("source = %q, want %q", source, consumerNameSourceGenerated)
	}
}

func TestResolveConsumerName_FallsBackToWorkerOnHostnameError(t *testing.T) {
	name, source := resolveConsumerName("",
		func() (string, error) { return "", errors.New("no hostname") },
		func() (string, error) { return "0123456789abcdef", nil },
	)
	if want := "worker-01234567"; name != want {
		t.Errorf("name = %q, want %q", name, want)
	}
	if source != consumerNameSourceGenerated {
		t.Errorf("source = %q, want %q", source, consumerNameSourceGenerated)
	}
}

func TestResolveConsumerName_FallsBackToWorkerOnBlankHostname(t *testing.T) {
	name, _ := resolveConsumerName("",
		func() (string, error) { return "", nil },
		func() (string, error) { return "0123456789abcdef", nil },
	)
	if want := "worker-01234567"; name != want {
		t.Errorf("name = %q, want %q", name, want)
	}
}

func TestResolveConsumerName_ReturnsHostnameAloneWhenTokenFails(t *testing.T) {
	name, source := resolveConsumerName("",
		func() (string, error) { return "worker-host", nil },
		func() (string, error) { return "", errors.New("no randomness") },
	)
	if name != "worker-host" {
		t.Errorf("name = %q, want %q", name, "worker-host")
	}
	if source != consumerNameSourceGenerated {
		t.Errorf("source = %q, want %q", source, consumerNameSourceGenerated)
	}
}
