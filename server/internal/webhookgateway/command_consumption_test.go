package webhookgateway

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestLabelCommandsCannotDisableConsumption(t *testing.T) {
	base, registry, policy, subscription := commandFixture(t, "label_command")
	*subscription.Compiler.CommandFilter.RemoveLabel = false
	if ValidateSubscription(subscription, DefaultLimits()) == nil || policy.CompilerSourceAllowed(subscription) {
		t.Fatal("false removal metadata granted a read-only label command")
	}
	workflow := &registry.Records[0].Workflows[0]
	for i := range workflow.Triggers {
		filter := workflow.Triggers[i].CommandFilter
		if filter.RemoveLabel != nil {
			*filter.RemoveLabel = false
		}
	}
	if _, err := RegistryDigest(registry.Control, registry.Records); err == nil {
		t.Fatal("nonconsuming label metadata received a valid inventory digest")
	}
	if _, err := RegistryPolicy(base, registry, time.Now()); err == nil {
		t.Fatal("invalid persisted inventory activated a nonconsuming label command")
	}
	manifest, err := json.Marshal(map[string]any{"version": 1, "webhook_subscriptions": []CompilerTrigger{*subscription.Compiler}})
	if err != nil {
		t.Fatal(err)
	}
	artifact := bytes.Join([][]byte{[]byte("# gh-aw-manifest: "), manifest, []byte("\nname: invalid\n")}, nil)
	if _, err := ParseWorkflowManifest(artifact, subscription.Compiler.Dispatch.Workflow, DefaultLimits()); err == nil {
		t.Fatal("compiler discovery accepted remove_label:false")
	}
}
