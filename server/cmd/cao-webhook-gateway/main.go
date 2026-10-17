package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/postgres"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
	"github.com/githubnext/gh-aw-cao/server/internal/webhookgatewayhost"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:])
	stop()
	if err != nil && !errors.Is(err, context.Canceled) {
		// Never print errors from credential, policy, database, or HTTP libraries.
		fmt.Fprintln(os.Stderr, "webhook gateway stopped: configuration or infrastructure unavailable")
		os.Exit(1)
	}
}

type environmentSecrets struct{}

func (environmentSecrets) WebhookSecrets(context.Context, string) ([]byte, []byte, error) {
	current := []byte(os.Getenv("CAO_GATEWAY_WEBHOOK_SECRET"))
	previous := []byte(os.Getenv("CAO_GATEWAY_PREVIOUS_WEBHOOK_SECRET"))
	if len(current) < 32 || (len(previous) > 0 && len(previous) < 32) {
		return nil, nil, errors.New("gateway webhook secret is missing or too short")
	}
	return current, previous, nil
}

func loadKey(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("gateway App private key file is required")
	}
	file, err := os.Open(path) // #nosec G304 G703 -- credential path is supplied by the trusted deployment, never webhook input.
	if err != nil {
		return nil, errors.New("gateway App private key is unavailable")
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil || len(data) == 0 || len(data) > 64<<10 {
		return nil, errors.New("gateway App private key is invalid")
	}
	return data, nil
}

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("cao-webhook-gateway", flag.ContinueOnError)
	role := flags.String("role", "", "receive or dispatch; credentials must be isolated by role")
	policyPath := flags.String("policy", "", "absolute path to reviewed cao.json")
	listen := flags.String("listen", "127.0.0.1:8081", "receiving HTTP address")
	cert := flags.String("tls-cert", "", "receiving TLS certificate file")
	key := flags.String("tls-key", "", "receiving TLS private key file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if (*role != "receive" && *role != "dispatch") || flags.NArg() != 0 {
		return errors.New("gateway requires an isolated receive or dispatch role")
	}
	if err := validateRoleCredentials(*role); err != nil {
		return err
	}
	loader := gateway.NewPolicyLoader(*policyPath)
	policy, err := loader.Load(ctx)
	if err != nil {
		return err
	}
	if os.Getenv("OTEL_SERVICE_NAME") == "" {
		if err := os.Setenv("OTEL_SERVICE_NAME", "cao-webhook-gateway"); err != nil {
			return errors.New("gateway telemetry resource is unavailable")
		}
	}
	shutdown, err := telemetry.Setup(ctx, version)
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = shutdown(shutdownCtx)
	}()
	store, err := postgres.New(ctx, os.Getenv("CAO_POSTGRES_URL"), policy.Policy.Namespace, postgres.Config{})
	if err != nil {
		return errors.New("gateway operational storage is unavailable")
	}
	defer func() { _ = store.Close() }()
	queue, err := store.OpenWebhookQueue(ctx, "github-webhooks", policy.Policy.Queue)
	if err != nil {
		return err
	}
	if err := queue.ApplyRevision(ctx, policy.Revision); err != nil {
		return err
	}
	if *role == "receive" {
		return serve(ctx, *listen, *cert, *key, policy, loader, queue,
			webhookgatewayhost.ReceiveAuthority{Loader: loader, Queue: queue, State: store})
	}
	return dispatch(ctx, policy, loader, queue, store)
}

func validateRoleCredentials(role string) error {
	if role == "receive" &&
		(os.Getenv("CAO_GATEWAY_RECEIVE_KEY_FILE") != "" || os.Getenv("CAO_GATEWAY_DISPATCH_KEY_FILE") != "") {
		return errors.New("receiving process must not receive App private keys")
	}
	if role == "dispatch" &&
		(os.Getenv("CAO_GATEWAY_WEBHOOK_SECRET") != "" || os.Getenv("CAO_GATEWAY_PREVIOUS_WEBHOOK_SECRET") != "") {
		return errors.New("dispatch process must not receive webhook signing secrets")
	}
	return nil
}

func serve(ctx context.Context, address, certificate, privateKey string, policy gateway.PolicySnapshot, loader gateway.PolicyLoader, queue gateway.Queue, authorizer gateway.Authorizer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if certificate == "" || privateKey == "" {
		if certificate != "" || privateKey != "" {
			return errors.New("gateway TLS requires both certificate and private key")
		}
		host, _, err := net.SplitHostPort(address)
		if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			return errors.New("plaintext gateway must listen on numeric loopback behind an HTTPS proxy")
		}
	}
	secrets := environmentSecrets{}
	if _, _, err := secrets.WebhookSecrets(ctx, ""); err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		current, err := loader.Load(r.Context())
		if err != nil || !current.Revision.Enabled {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if err := queue.ApplyRevision(r.Context(), current.Revision); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		depth, supported := queue.(gateway.QueueDepthProvider)
		if !supported {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if _, err := depth.QueueDepth(r.Context()); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	sources := make(map[string]bool)
	slots := make(chan struct{}, 64)
	for _, subscription := range policy.Subscriptions {
		source := subscription.Source.ID
		if sources[source] {
			continue
		}
		sources[source] = true
		mux.Handle("/webhooks/"+source, boundedIngress(slots, &gateway.Ingress{
			SourceID: source, Secrets: secrets, Policies: loader, Queue: queue, Authorizer: authorizer,
		}))
	}
	server := &http.Server{
		Addr: address, Handler: otelhttp.NewHandler(mux, "cao.webhook-gateway"),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	var err error
	if certificate != "" {
		err = server.ListenAndServeTLS(certificate, privateKey)
	} else {
		err = server.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		<-stopped
		return nil
	}
	return errors.New("gateway HTTP listener is unavailable")
}

func boundedIngress(slots chan struct{}, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func dispatch(ctx context.Context, policy gateway.PolicySnapshot, loader gateway.PolicyLoader, queue gateway.Queue, store *postgres.Store) error {
	receiverKey, err := loadKey(os.Getenv("CAO_GATEWAY_RECEIVE_KEY_FILE"))
	if err != nil {
		return err
	}
	dispatchKey, err := loadKey(os.Getenv("CAO_GATEWAY_DISPATCH_KEY_FILE"))
	if err != nil {
		return err
	}
	transport := webhookgatewayhost.BudgetTransport{Limiter: store}
	receiver, err := githubapp.New(githubapp.Config{
		AppID: policy.Policy.ReceivingAppID, PrivateKeyPEM: receiverKey, Transport: transport, RequestTimeout: 10 * time.Second,
	})
	if err != nil {
		return errors.New("gateway receiving identity is unavailable")
	}
	dispatcher, err := githubapp.New(githubapp.Config{
		AppID: policy.Policy.DispatchAppID, PrivateKeyPEM: dispatchKey, Transport: transport, RequestTimeout: 10 * time.Second,
	})
	if err != nil {
		return errors.New("gateway dispatch identity is unavailable")
	}
	if err := receiver.ValidateWebhookGatewayRole(ctx, "receive"); err != nil {
		return err
	}
	if err := dispatcher.ValidateWebhookGatewayRole(ctx, "dispatch"); err != nil {
		return err
	}
	quota, err := githubquota.New(store, githubquota.Options{SafetyReserve: 100})
	if err != nil {
		return err
	}
	authority := webhookgatewayhost.LiveAuthority{Loader: loader, Queue: queue, Receiving: receiver, Dispatch: dispatcher, State: store}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	workers.Go(func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			refreshCtx, finish := context.WithTimeout(ctx, 20*time.Second)
			_ = authority.Refresh(refreshCtx)
			finish()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
	hostname, err := os.Hostname()
	if err != nil {
		return errors.New("gateway worker identity is unavailable")
	}
	for i := range policy.Policy.Workers {
		gate := &webhookgatewayhost.QuotaGate{Service: quota, Reader: dispatcher, AppID: policy.Policy.DispatchAppID,
			Dispatcher: githubapp.WebhookGatewayDispatcher{Client: dispatcher,
				ObserveQuota: func(ctx context.Context, installation int64, response githubquota.ResponseQuota) error {
					return webhookgatewayhost.ObserveQuota(ctx, quota, strconv.FormatInt(policy.Policy.DispatchAppID, 10), installation, response)
				}},
		}
		// Opaque bounded worker identity; hostnames never enter metric labels.
		owner := gateway.MetadataDigest([]byte(strings.Join([]string{hostname, strconv.Itoa(os.Getpid()), strconv.Itoa(i)}, ":")))[:32]
		worker := &gateway.Worker{Policies: loader, Queue: queue, Authorizer: authority, Dispatcher: gate, Budget: gate,
			Owner: owner, HTTPTimeout: 20 * time.Second, LeaseDuration: time.Minute}
		workers.Go(func() { _ = worker.Run(ctx) })
	}
	<-ctx.Done()
	workers.Wait()
	return ctx.Err()
}
