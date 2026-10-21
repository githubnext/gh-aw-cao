package webhookgateway

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
)

func assertNotificationRuntime(t *testing.T, s Subscription, batch []byte) {
	t.Helper()
	if os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR") == "" {
		return
	}
	declarations, err := json.Marshal([]CompilerTrigger{*s.Compiler})
	if err != nil {
		t.Fatal(err)
	}
	const script = `
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
// Published github/gh-aw@fe4f420f3f4f40bb1ebbcca85af0903d3a967bf3.
for(const [file,hash] of Object.entries({
 'github_notification_webhooks.json':'445397744970a1bfd6c187211ddc04a8aea9e4ad1dff6f88741e423e70be61ca',
 'github_notification_webhook.cjs':'d9a82beee450d329ce0b9d90b569213931a5fed0f1f934c06f8e90e6b8d93613',
 'validate_webhook.cjs':'52f2448f6147436e5b480aac5c6610862b0e01665e2fd1bdf8cf5db814e07833',
 'webhook_context.cjs':'c2b9433ae31302e483fbdf92391153ea60ae7cbf722eddf0100a175232bdfb4a',
 'webhook_resource.cjs':'0460fc31a103ea74493ea9f97c2bdbc667454316e1c2034849f28bde19e5df85',
 'provider_issue_webhook.cjs':'2b682fb8bb4dbbb6b55ac6cfbc0531ba2f0eacda5fa5f1176efd01cf1799fe6d',
})) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,file))).digest('hex'),hash,file);
const catalog=require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,'github_notification_webhooks.json'));
assert.deepEqual(JSON.parse(JSON.stringify(catalog,(key,value)=>key==='description'?undefined:value)),JSON.parse(process.env.CAO_NOTIFICATION_CATALOG));
const {validateWebhook}=require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,'validate_webhook.cjs'));
const {normalizeWebhookContext}=require(path.join(process.env.WEBHOOK_COMPILER_RUNTIME_DIR,'webhook_context.cjs'));
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const event={action:request.event_type,client_payload:request.client_payload};
assert.equal(validateWebhook(event).skipped,false);
const normalized=normalizeWebhookContext(request.client_payload.aw_context);
assert.deepEqual(normalized.webhook.deliveries,request.client_payload.aw_context.webhook.deliveries);
assert.ok(normalized.items.every(item=>item.repo==='approved/exact'));
assert.equal(JSON.stringify(normalized).includes('MUST-NOT-PERSIST'),false);
for(const delivery of normalized.webhook.deliveries) assert.deepEqual(Object.keys(delivery).sort(),['delivery_id','payload']);
const original=normalized.webhook.deliveries[0].payload;
const invalid=[
 {...original,body:'forbidden'},
 {...original,type:['unknown']},
 {...original,url:original.url.replace(process.env.GITHUB_SERVER_URL,'https://other.example')},
 {...original,filters:{...(original.filters||{}),undeclared:['value']}},
];
for(const [key,values] of Object.entries(original.filters||{})) {
 invalid.push({...original,filters:{...original.filters,[key]:[...values,'unselected']}});
 const missing={...original.filters};delete missing[key];invalid.push({...original,filters:missing});
}
for(const projection of invalid) {
 const bad=JSON.parse(JSON.stringify(event));
 bad.client_payload.aw_context.webhook.deliveries[0].payload=projection;
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
		"GITHUB_SERVER_URL="+s.Source.ServerURL, "GH_AW_WEBHOOK_SUBSCRIPTIONS="+string(declarations),
		"CAO_NOTIFICATION_CATALOG="+string(notificationCatalogJSON))
	command.Stdin = bytes.NewReader(batch)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned notification runtime/catalog mismatch: %v\n%s", err, output)
	}
}

func TestNotificationPublishedRuntimeInteroperability(t *testing.T) {
	if os.Getenv("WEBHOOK_COMPILER_RUNTIME_DIR") == "" {
		t.Skip("set WEBHOOK_COMPILER_RUNTIME_DIR to gh-aw@fe4f420f's runtime")
	}
	for _, server := range []string{"https://github.com", "https://github.example:8443/github/base"} {
		for family, definition := range notifications.Events {
			t.Run(server+"/"+family, func(t *testing.T) {
				_, _, policy, s := notificationFixture(t, family)
				s.Source.ServerURL = server
				var jobs []Job
				for _, action := range definition.Actions {
					jobs = append(jobs, commandJob(t, policy, s, notificationOriginal(t, s, action)))
				}
				batch, err := BuildDispatchBatch(jobs)
				if err != nil {
					t.Fatal(err)
				}
				assertNotificationRuntime(t, s, batch)
			})
		}
	}
}
