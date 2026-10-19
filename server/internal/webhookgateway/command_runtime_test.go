package webhookgateway

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
)

func TestCommandPublishedRuntimeInteroperability(t *testing.T) {
	if os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR") == "" {
		t.Skip("set WEBHOOK_COMPILER_RUNTIME_DIR to the pinned command runtime")
	}
	for _, server := range []string{"https://github.com", "https://github.example/github"} {
		for _, family := range []string{"slash_command", "label_command"} {
			t.Run(server+"/"+family, func(t *testing.T) {
				_, _, policy, s := commandFixture(t, family)
				s.Source.ServerURL = server
				var jobs []Job
				for _, semantic := range s.Compiler.CommandFilter.Events {
					actions, body := commandEvents[semantic].actions, "/review secret-MUST-NOT-PERSIST"
					if family == "label_command" {
						actions, body = []string{"labeled"}, "ready"
					}
					for _, action := range actions {
						event := commandOriginal(t, s, semantic, action, body)
						event.DeliveryID += "-" + action
						jobs = append(jobs, commandJob(t, policy, s, event))
					}
				}
				batch, err := BuildDispatchBatch(jobs)
				if err != nil {
					t.Fatal(err)
				}
				subscriptions, err := json.Marshal([]CompilerTrigger{*s.Compiler})
				if err != nil {
					t.Fatal(err)
				}
				const script = `
const assert=require('node:assert/strict'), path=require('node:path');
// SHA-256 pins from github/gh-aw@40c476c070ecb53d9b31ae88c6cc9fab3c9e9045.
for(const [file,hash] of Object.entries({
 'gateway_command_webhook.cjs':'2a6e7860dbc0c7d470f83f7db8e5b37392ce3df87383ed6a4620900bf9bade7d',
 'validate_webhook.cjs':'62d05d02ef3dc60099c1a51dbe1c318dfebf284e5c2ee6a2ac0c4e900334894b',
 'webhook_resource.cjs':'afaf459b619e9b135c8a7e40cf1808608d4e76065439430e5cc3574e9e875ad0',
 'webhook_context.cjs':'f304514f81fe8b196792bc5ac1072f55e487607b7e677c2ce860fd50e5c3e385',
 'slash_command_matcher.cjs':'ff7fa0a2cbf6cb67041137613122923d7b187f5092235177ca9c216b9054eb53',
})) assert.equal(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,file))).digest('hex'),hash,file);
const {validateWebhook}=require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,'validate_webhook.cjs'));
const {normalizeWebhookContext}=require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,'webhook_context.cjs'));
const request=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const event={action:request.event_type,client_payload:request.client_payload};
assert.equal(validateWebhook(event).skipped,false);
const normalized=normalizeWebhookContext(request.client_payload.aw_context);
assert.deepEqual(normalized.webhook.deliveries,request.client_payload.aw_context.webhook.deliveries);
for(const delivery of normalized.webhook.deliveries) assert.deepEqual(Object.keys(delivery).sort(),['delivery_id','payload']);
assert.ok(normalized.items.every(item=>item.repo==='approved/exact'));
assert.equal(JSON.stringify(normalized).includes('MUST-NOT-PERSIST'),false);
const original=request.client_payload.aw_context.webhook.deliveries[0].payload;
const key=normalized.webhook.event==='slash_command'?'command':'label';
for(const invalid of [
  {...original,body:'forbidden'},
  {...original,type:['deleted']},
  {...original,filters:{...original.filters,[key]:['unselected']}},
  {...original,filters:{...original.filters,[key]:[...original.filters[key],'unselected']}},
  {...original,filters:{...original.filters,event:['pull_request_review']}},
  {...original,filters:{...original.filters,arguments:['secret']}},
  {...original,url:original.url.replace(process.env.GITHUB_SERVER_URL,'https://other.example')},
]) {
 const bad=JSON.parse(JSON.stringify(event));
 bad.client_payload.aw_context.webhook.deliveries[0].payload=invalid;
 assert.throws(()=>validateWebhook(bad));
}
for(const policy of ['resource-url-types/v1','resource-url-types-filters/v1']) {
 const declarations=JSON.parse(process.env.GH_AW_WEBHOOK_SUBSCRIPTIONS);
 declarations[0].dispatch.payload_projection.policy=policy;
 assert.throws(()=>validateWebhook(event,{...process.env,GH_AW_WEBHOOK_SUBSCRIPTIONS:JSON.stringify(declarations)}));
}
`
				command := exec.CommandContext(t.Context(), "node", "-e", script)
				command.Env = append(os.Environ(), "GITHUB_EVENT_NAME=repository_dispatch",
					"GITHUB_SERVER_URL="+server, "GH_AW_WEBHOOK_SUBSCRIPTIONS="+string(subscriptions))
				command.Stdin = bytes.NewReader(batch)
				if output, err := command.CombinedOutput(); err != nil {
					t.Fatalf("pinned command validator/normalizer mismatch: %v\n%s", err, output)
				}
			})
		}
	}
}
