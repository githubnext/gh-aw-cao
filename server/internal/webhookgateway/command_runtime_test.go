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
// SHA-256 pins from github/gh-aw@fe4f420f3f4f40bb1ebbcca85af0903d3a967bf3.
for(const [file,hash] of Object.entries({
 'gateway_command_webhook.cjs':'f0b37f9898e63a456120b9961c0392db524abecbb9e93d006c88ed341a0b8202',
 'validate_webhook.cjs':'52f2448f6147436e5b480aac5c6610862b0e01665e2fd1bdf8cf5db814e07833',
 'webhook_resource.cjs':'0460fc31a103ea74493ea9f97c2bdbc667454316e1c2034849f28bde19e5df85',
 'webhook_context.cjs':'c2b9433ae31302e483fbdf92391153ea60ae7cbf722eddf0100a175232bdfb4a',
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
