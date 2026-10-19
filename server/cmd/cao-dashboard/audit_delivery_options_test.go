package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDeliveryOptionsRejectsTimeoutOutsideBounds(t *testing.T) {
	for _, timeout := range []time.Duration{0, time.Second - 1, 30*time.Minute + 1} {
		if _, err := deliveryOptions("stream", 100, time.Hour, timeout, ""); err == nil {
			t.Fatalf("timeout %s accepted", timeout)
		}
	}
}

func TestDeliveryOptionsRejectsInvalidOptions(t *testing.T) {
	if _, err := deliveryOptions("stream", 0, time.Hour, time.Minute, ""); err == nil {
		t.Fatal("zero max events accepted")
	}
	if _, err := deliveryOptions("stream", 100, time.Second, time.Minute, ""); err == nil {
		t.Fatal("max anchor age below one minute accepted")
	}
}

func TestDeliveryOptionsAcceptsBoundaryTimeoutsWithoutBootstrap(t *testing.T) {
	for _, timeout := range []time.Duration{time.Second, 30 * time.Minute} {
		options, err := deliveryOptions("stream", 100, time.Hour, timeout, "")
		if err != nil {
			t.Fatalf("timeout %s rejected: %v", timeout, err)
		}
		if options.Stream != "stream" || options.MaxEvents != 100 || options.MaxAnchorAge != time.Hour || options.Bootstrap != nil {
			t.Fatalf("unexpected options: %+v", options)
		}
	}
}

func TestDeliveryOptionsLoadsBootstrapAnchor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "anchor.json")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	options, err := deliveryOptions("stream", 100, time.Hour, time.Minute, path)
	if err != nil {
		t.Fatal(err)
	}
	if options.Bootstrap == nil {
		t.Fatal("bootstrap anchor was not attached")
	}
	if _, err := deliveryOptions("stream", 100, time.Hour, time.Minute, filepath.Join(filepath.Dir(path), "missing.json")); err == nil {
		t.Fatal("missing bootstrap anchor accepted")
	}
}
