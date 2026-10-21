package admission_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/githubnext/gh-cao/server/internal/admission"
	"github.com/githubnext/gh-cao/server/internal/operational/postgres"
	"github.com/githubnext/gh-cao/server/internal/simulator"
	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
	"github.com/githubnext/gh-cao/server/internal/webhookgatewaylocal"
)

type brokerTransport struct {
	local  *simulator.LocalTransport
	target *url.URL
}

func (b brokerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.String() != admission.Issuer+"/.well-known/jwks" || r.Header.Get("Authorization") != "" {
		return nil, errors.New("unexpected simulator JWKS request")
	}
	r = r.Clone(r.Context())
	r.URL.Scheme, r.URL.Host = b.target.Scheme, b.target.Host
	return b.local.RoundTrip(r)
}

type localPolicy struct {
	deny    atomic.Bool
	credits atomic.Int32
}

func (p *localPolicy) Evaluate(context.Context, admission.Identity) (admission.Allowances, error) {
	if p.deny.Load() {
		return admission.Allowances{}, admission.ErrDenied
	}
	return admission.Allowances{Primary: p.credits.Load()}, nil
}

func (*localPolicy) AuthorizeConclusion(context.Context, admission.Identity) error { return nil }

type localPublication struct {
	fail  atomic.Bool
	calls atomic.Int32
}

func (p *localPublication) RecordConcludedRun(context.Context, admission.Identity, admission.ConclusionRequest, time.Time) error {
	p.calls.Add(1)
	if p.fail.Load() {
		return admission.ErrUnavailable
	}
	return nil
}

func TestLocalActionsPostgresIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		if os.Getenv("CAO_ACTIONS_SIMULATOR_POSTGRES") == "1" {
			t.Fatal("POSTGRES_URL is required for the PostgreSQL simulator integration")
		}
		t.Skip("set POSTGRES_URL to a disposable local PostgreSQL database")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid local PostgreSQL configuration")
	}
	// Never let the integration provision or remove state on a remote database.
	for _, host := range append([]string{config.Host}, postgresFallbackHosts(config)...) {
		if !strings.HasPrefix(host, "/") && !net.ParseIP(host).IsLoopback() {
			t.Fatal("PostgreSQL simulation requires numeric loopback or a local Unix socket")
		}
	}
	namespace := "actions-simulator-" + strings.ToLower(rand.Text())
	store, err := postgres.New(t.Context(), dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal("provision local PostgreSQL simulator storage")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanup, err := postgres.Open(ctx, dsn, namespace, postgres.Config{})
		if err != nil {
			t.Error("reopen simulator namespace for cleanup")
		} else {
			if err := cleanup.DeleteNamespace(ctx); err != nil {
				t.Error("remove simulator namespace")
			}
			if err := cleanup.Close(); err != nil {
				t.Error("close simulator cleanup connection")
			}
		}
		if err := store.Close(); err != nil {
			t.Error("close simulator PostgreSQL storage")
		}
	})
	trace := &simulator.Trace{}
	now := time.Now().UTC().Truncate(time.Second)
	api, err := simulator.NewActionsAPI(simulator.Scenario{Name: "postgres-actions", Repositories: 1}, 1,
		func() time.Time { return now }, trace)
	if err != nil {
		t.Fatal(err)
	}
	workflow := "simulator/repo-00001/.github/workflows/triage.lock.yml@refs/heads/main"
	input := admission.Request{
		Repo: "simulator/repo-00001", WorkflowID: workflow,
		WorkflowHash:   strings.Repeat("a", 64) + ":" + strings.Repeat("b", 64),
		WorkflowCallID: "1234-1:" + workflow, RunID: "1234", RunAttempt: "1", Ref: "refs/heads/main",
		EventType: "workflow_dispatch", Actor: "simulator", TriggeringActor: "simulator",
	}
	bootstrap, err := api.OIDC.Register(map[string]string{
		"repository": input.Repo, "repository_id": "1001", "repository_owner_id": "42",
		"sub": "repo:" + input.Repo + ":ref:" + input.Ref, "run_id": input.RunID, "run_attempt": input.RunAttempt,
		"ref": input.Ref, "event_name": input.EventType, "actor": input.Actor, "actor_id": "101",
		"workflow_ref": workflow, "workflow_sha": strings.Repeat("a", 40),
	})
	if err != nil {
		t.Fatal(err)
	}
	issuer := httptest.NewServer(api)
	defer issuer.Close()
	local, err := simulator.NewLocalTransport(issuer.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer local.CloseIdleConnections()
	target, err := url.Parse(issuer.URL)
	if err != nil {
		t.Fatal(err)
	}
	policy, publication := &localPolicy{}, &localPublication{}
	policy.credits.Store(7)
	service := &admission.Service{
		Policies: policy, Decisions: store, Conclusions: store, ConclusionPolicies: policy, ConclusionRuns: publication,
	}
	mux := http.NewServeMux()
	mux.Handle("/api/admission", service)
	mux.HandleFunc("/api/conclusion", service.Conclude)
	server := httptest.NewUnstartedServer(mux)
	audience := "http://" + server.Listener.Addr().String() + "/api/admission"
	service.Verifier, err = admission.NewVerifierForTest(audience, brokerTransport{local, target})
	if err != nil {
		t.Fatal(err)
	}
	server.Start()
	defer server.Close()
	action := simulator.Actions{TokenURL: issuer.URL + "/token", Bootstrap: bootstrap, Audience: audience, Trace: trace}
	encode := func(value any) json.RawMessage {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	post := func(stage, endpoint string, value any, expected int) {
		t.Helper()
		result, err := action.Post(t.Context(), stage, endpoint, encode(value))
		if result.Status != expected || (err == nil) != (expected < 300) {
			t.Fatalf("PostgreSQL lifecycle %s: status=%d expected=%d err=%v", stage, result.Status, expected, err)
		}
		if stage == "admission" && expected == 200 && string(result.Body) != `{"max_ai_credits":7}` {
			t.Fatal("PostgreSQL retry changed the original allowance")
		}
	}
	post("admission", audience, input, 200)
	policy.credits.Store(99)
	reopen := func() {
		t.Helper()
		if err := store.Close(); err != nil {
			t.Fatal("close PostgreSQL store before restart")
		}
		reopened, openErr := postgres.Open(t.Context(), dsn, namespace, postgres.Config{})
		if openErr != nil {
			t.Fatal("reopen PostgreSQL simulator namespace")
		}
		store = reopened
		service.Decisions, service.Conclusions = store, store
	}
	reopen()
	post("admission", audience, input, 200)
	// A closed database pool must produce an outage, not an in-memory approval.
	if err := store.Close(); err != nil {
		t.Fatal("close local PostgreSQL store for outage")
	}
	post("admission", audience, input, 503)
	reopen()
	post("admission", audience, input, 200)
	runPostgresGateway(t, dsn, namespace, store, action)
	conclusion := admission.ConclusionRequest{
		Request: input, Session: "{\"type\":\"session.format\",\"data\":{\"version\":1}}\n",
		SessionCompaction: admission.SessionCompaction{Version: 1, IncludedEvents: 1}, UsageArtifactIDs: []string{},
	}
	// A receipt must remain pending until canonical publication succeeds.
	publication.fail.Store(true)
	post("conclusion_admission", server.URL+"/api/conclusion", conclusion, 503)
	reopen()
	publication.fail.Store(false)
	post("conclusion_admission", server.URL+"/api/conclusion", conclusion, 204)
	reopen()
	post("conclusion_admission", server.URL+"/api/conclusion", conclusion, 204)
	if publication.calls.Load() != 2 {
		t.Fatal("completed PostgreSQL receipt was republished after restart")
	}
	changed := conclusion
	changed.UsageArtifactIDs = []string{"2"}
	post("conclusion_admission", server.URL+"/api/conclusion", changed, 403)
	policy.deny.Store(true)
	post("admission", audience, input, 403)
	reopen()
	policy.deny.Store(false)
	post("admission", audience, input, 403)
	t.Logf("PostgreSQL-backed localhost lifecycle trace: %s", encode(trace.Events()))
}

func postgresFallbackHosts(config *pgx.ConnConfig) []string {
	hosts := make([]string, 0, len(config.Fallbacks))
	for _, fallback := range config.Fallbacks {
		hosts = append(hosts, fallback.Host)
	}
	return hosts
}

func runPostgresGateway(t *testing.T, dsn, namespace string, store *postgres.Store, action simulator.Actions) {
	t.Helper()
	var repository webhookgatewaylocal.Repository
	if err := json.Unmarshal([]byte(`{"id":1001,"full_name":"simulator/repo-00001","owner":{"id":42,"type":"Organization"}}`), &repository); err != nil {
		t.Fatal(err)
	}
	simulation, err := webhookgatewaylocal.NewSimulation(repository, []string{"issues"})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := simulation.Load(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	queue, err := store.OpenWebhookQueue(t.Context(), "actions-simulator", policy.Policy.Queue)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(&wg.Ingress{SourceID: "local", Secrets: simulation, Policies: simulation, Queue: queue, Authorizer: simulation})
	defer gateway.Close()
	secret, _, err := simulation.WebhookSecrets(t.Context(), "local")
	if err != nil {
		t.Fatal(err)
	}
	delivery := simulator.Delivery{ID: "postgres-actions-event", Event: "issues",
		Payload: []byte(`{"action":"opened","repository":{"id":1001,"full_name":"simulator/repo-00001","owner":{"id":42}},"organization":{"id":42},"installation":{"id":1},"issue":{"number":1}}`)}
	for range 2 {
		status, err := action.DeliverWebhook(t.Context(), gateway.URL+"/webhooks/local", string(secret), delivery)
		if err != nil || status != http.StatusAccepted {
			t.Fatalf("PostgreSQL gateway: status=%d err=%v", status, err)
		}
	}
	replica, err := postgres.Open(t.Context(), dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal("open gateway dispatch replica")
	}
	defer func() { _ = replica.Close() }()
	queue, err = replica.OpenWebhookQueue(t.Context(), "actions-simulator", policy.Policy.Queue)
	if err != nil {
		t.Fatal(err)
	}
	worker := &wg.Worker{Policies: simulation, Queue: queue, Authorizer: simulation, Dispatcher: simulation,
		Owner: "postgres-actions", HTTPTimeout: time.Second, LeaseDuration: time.Minute}
	worked, err := worker.RunOnce(t.Context())
	if err != nil || !worked {
		t.Fatalf("PostgreSQL worker: worked=%t err=%v", worked, err)
	}
	connection, err := pgx.Connect(t.Context(), dsn)
	if err != nil {
		t.Fatal("connect to inspect local gateway state")
	}
	defer func() { _ = connection.Close(t.Context()) }()
	var total, succeeded int
	err = connection.QueryRow(t.Context(), `SELECT count(*),count(*) FILTER (WHERE state='succeeded')
		FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue='actions-simulator'`, namespace).Scan(&total, &succeeded)
	if err != nil || total != 1 || succeeded != 1 {
		t.Fatalf("PostgreSQL gateway did not finish exactly one job: total=%d succeeded=%d", total, succeeded)
	}
}
