package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational/sqlite"
	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
	"github.com/githubnext/gh-cao/server/internal/webhookgatewaylocal"
)

type localOptions struct {
	repository, path, apiURL string
	events                   []string
	interval                 time.Duration
	once                     bool
}

func runLocal(ctx context.Context, options localOptions, output io.Writer) (err error) {
	// SQLite can surface a driver interruption instead of the cancellation.
	defer func(parent context.Context) {
		if err != nil && parent.Err() != nil {
			err = parent.Err()
		}
	}(ctx)
	if !filepath.IsAbs(options.path) || options.interval < time.Second {
		return errors.New("local simulation requires an absolute SQLite path and a polling interval of at least one second")
	}
	client, err := webhookgatewaylocal.NewClient(options.apiURL, options.repository, os.Getenv("GH_TOKEN"))
	if err != nil {
		return err
	}
	repository, err := client.Repository(ctx)
	if err != nil {
		return err
	}
	simulation, err := webhookgatewaylocal.NewSimulation(repository, options.events)
	if err != nil {
		return err
	}
	policy, err := simulation.Load(ctx)
	if err != nil {
		return err
	}
	namespace := policy.Policy.Namespace + "-" + wg.MetadataDigest([]byte(options.apiURL))[:16]
	queue, err := sqlite.OpenWebhookQueue(ctx, options.path, namespace, policy.Policy.Queue)
	if err != nil {
		return err
	}
	defer func() { _ = queue.Close() }()
	if err := queue.ApplyRevision(ctx, policy.Revision); err != nil {
		return err
	}
	if _, err := queue.Maintain(ctx, 10000); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(output, "LOCAL SIMULATION: GitHub reads only; signed in-process ingress; dispatch acceptance is simulated, not remote workflow execution."); err != nil {
		return err
	}
	poller := &webhookgatewaylocal.Poller{
		Client: client, Repository: repository, Simulation: simulation, Interval: options.interval,
		Receipts: queue,
		Handler:  &wg.Ingress{SourceID: "local", Secrets: simulation, Policies: simulation, Queue: queue, Authorizer: simulation},
	}
	worker := &wg.Worker{Policies: simulation, Queue: queue, Authorizer: simulation, Dispatcher: simulation,
		Owner: "local-" + rand.Text(), HTTPTimeout: time.Second, LeaseDuration: time.Minute}
	if !options.once {
		worker.BatchWindow = wg.DispatchBatchWindow
	}
	if options.once {
		if _, err := poller.Poll(ctx); err != nil {
			return err
		}
		for range policy.Policy.Queue.MaxRows {
			worked, err := worker.RunOnce(ctx)
			if err != nil {
				if errors.Is(err, wg.ErrCapacity) {
					break
				}
				return err
			}
			if !worked {
				break
			}
		}
		return reportLocal(ctx, queue, output)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	polled := make(chan error, 1)
	go func() { polled <- poller.Run(ctx) }()
	// Unlike the hosted resilient loop, local development fails visibly on
	// infrastructure errors rather than concealing them behind endless retries.
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		worked, err := worker.RunOnce(ctx)
		if err != nil && !errors.Is(err, wg.ErrCapacity) {
			cancel()
			<-polled
			return err
		}
		if err == nil && worked {
			select {
			case err := <-polled:
				cancel()
				return err
			default:
				continue
			}
		}
		select {
		case err := <-polled:
			cancel()
			return err
		case <-ctx.Done():
			cancel()
			<-polled
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func reportLocal(ctx context.Context, queue *sqlite.Queue, output io.Writer) error {
	counts, err := queue.Counts(ctx)
	if err != nil {
		return err
	}
	pending := counts[wg.Ready] + counts[wg.Claimed] + counts[wg.Dispatching]
	if _, err := fmt.Fprintf(output, "Simulated queue: succeeded=%d ambiguous=%d rejected=%d failed=%d expired=%d cancelled=%d pending=%d\n",
		counts[wg.Succeeded], counts[wg.Ambiguous], counts[wg.Rejected], counts[wg.Failed], counts[wg.Expired], counts[wg.Cancelled], pending); err != nil {
		return err
	}
	if pending > 0 {
		return errors.New("local simulation is incomplete: retained work is deferred by leases or budgets")
	}
	return nil
}
