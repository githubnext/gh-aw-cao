package redisx

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func installRedisTelemetry(t *testing.T) (*tracetest.InMemoryExporter, *sdkmetric.ManualReader) {
	t.Helper()
	previousTracer, previousMeter := otel.GetTracerProvider(), otel.GetMeterProvider()
	exporter := tracetest.NewInMemoryExporter()
	tracer := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	reader := sdkmetric.NewManualReader()
	meter := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetTracerProvider(tracer)
	otel.SetMeterProvider(meter)
	t.Cleanup(func() {
		_ = meter.Shutdown(t.Context())
		_ = tracer.Shutdown(t.Context())
		otel.SetTracerProvider(previousTracer)
		otel.SetMeterProvider(previousMeter)
	})
	return exporter, reader
}

func TestRedisTelemetryStandardDurationAndPrivacy(t *testing.T) {
	exporter, reader := installRedisTelemetry(t)
	client, err := NewWithOptions("redis://127.0.0.1:1", Options{SingleSession: true})
	if err != nil {
		t.Fatal(err)
	}
	connection, peer := net.Pipe()
	t.Cleanup(func() { _ = connection.Close(); _ = peer.Close() })
	client.pool <- &redisConnection{connection: connection, reader: bufio.NewReader(connection), writer: bufio.NewWriter(connection)}
	serverErr := make(chan error, 1)
	go func() {
		incoming := bufio.NewReader(peer)
		for _, reply := range []string{
			"+private-value\r\n", ":1\r\n", "-WRONGTYPE private-key\r\n",
			"+OK\r\n", "+OK\r\n", "+OK\r\n", "+OK\r\n", "+OK\r\n",
			"-ERR private-script\r\n", "+OK\r\n", "-private-error-prefix private-value\r\n",
		} {
			if _, readErr := readRESP(incoming); readErr != nil {
				serverErr <- readErr
				return
			}
			if _, writeErr := fmt.Fprint(peer, reply); writeErr != nil {
				serverErr <- writeErr
				return
			}
		}
		serverErr <- nil
	}()

	_, err = client.Do(t.Context(), "get", "private-key")
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(t.Context(), "EVAL", "private-script", "1", "private-key")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(t.Context(), "GET", "private-key"); err == nil {
		t.Fatal("Redis response failure was not returned")
	}
	for _, commands := range [][][]string{
		{{"HGETALL", "private-key"}, {"HGETALL", "private-key"}},
		{{"GET", "private-key"}, {"SET", "private-key", "private-value"}},
		{{"GET", "private-key"}},
		{},
	} {
		if _, err := client.DoMany(t.Context(), commands); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := client.DoMany(t.Context(), [][]string{{"EVAL", "private-script"}, {"PING"}}); err == nil {
		t.Fatal("pipeline response failure was not returned")
	}
	if _, err := client.Do(t.Context(), "private-command"); err == nil {
		t.Fatal("unknown response failure was not returned")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := client.Do(ctx, "PING"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled operation returned %v", err)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}

	spans := exporter.GetSpans()
	wantNames := []string{"GET", "EVAL", "GET", "PIPELINE HGETALL", "PIPELINE", "GET", "PIPELINE", "PIPELINE", "_OTHER", "PING"}
	wantBatchSizes := []int64{-1, -1, -1, 2, 2, -1, 0, 2, -1, -1}
	wantErrors := []string{"", "", "WRONGTYPE", "", "", "", "", "ERR", "_OTHER", "canceled"}
	if len(spans) != len(wantNames) {
		t.Fatalf("spans = %d, want %d", len(spans), len(wantNames))
	}
	expected := map[string]uint64{}
	expectedDuration := map[string]float64{}
	for i, span := range spans {
		attrs := attribute.NewSet(span.Attributes...)
		failure, failed := attrs.Value(attribute.Key("error.type"))
		if span.Name != wantNames[i] || span.SpanKind != trace.SpanKindClient ||
			failure.AsString() != wantErrors[i] || failed != (wantErrors[i] != "") ||
			(failed && span.Status.Code != codes.Error) {
			t.Fatalf("unexpected Redis span: %+v", span)
		}
		if batch, present := attrs.Value(attribute.Key("db.operation.batch.size")); present != (wantBatchSizes[i] >= 0) ||
			(present && batch.AsInt64() != wantBatchSizes[i]) {
			t.Fatalf("incorrect pipeline size: %+v", span.Attributes)
		}
		key := span.Name + "/" + failure.AsString()
		expected[key]++
		expectedDuration[key] += span.EndTime.Sub(span.StartTime).Seconds()
	}
	var measured metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &measured); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, scope := range measured.ScopeMetrics {
		for _, recorded := range scope.Metrics {
			if recorded.Name != "db.client.operation.duration" {
				continue
			}
			found = true
			if recorded.Unit != "s" {
				t.Fatalf("duration unit = %q, want s", recorded.Unit)
			}
			for _, point := range recorded.Data.(metricdata.Histogram[float64]).DataPoints {
				command, _ := point.Attributes.Value(attribute.Key("db.operation.name"))
				failure, _ := point.Attributes.Value(attribute.Key("error.type"))
				system, _ := point.Attributes.Value(attribute.Key("db.system.name"))
				key := command.AsString() + "/" + failure.AsString()
				if system.AsString() != "redis" || point.Count != expected[key] || point.Sum != expectedDuration[key] ||
					!slices.Equal(point.Bounds, []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10}) {
					t.Fatalf("invalid standard duration: %+v", point)
				}
				if _, present := point.Attributes.Value(attribute.Key("db.operation.batch.size")); present {
					t.Fatal("batch size must not multiply metric cardinality")
				}
				delete(expected, key)
			}
		}
	}
	if !found || len(expected) != 0 {
		t.Fatalf("missing standard durations: %v", expected)
	}
	encoded, err := json.Marshal(struct {
		Spans   tracetest.SpanStubs
		Metrics metricdata.ResourceMetrics
	}{spans, measured})
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-", "127.0.0.1", "db.query.text", "db.namespace", "server.address"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("Redis telemetry leaked %q", private)
		}
	}
}

func TestRedisTelemetryCountsRetryOnce(t *testing.T) {
	exporter, reader := installRedisTelemetry(t)
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	client, err := New("redis://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	stale, peer := net.Pipe()
	_ = peer.Close()
	t.Cleanup(func() { _ = stale.Close() })
	client.pool <- &redisConnection{
		connection: stale, reader: bufio.NewReader(stale), writer: bufio.NewWriter(stale), lastUsed: time.Now(),
	}
	serverErr := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer func() { _ = connection.Close() }()
		if _, readErr := readRESP(bufio.NewReader(connection)); readErr != nil {
			serverErr <- readErr
			return
		}
		_, writeErr := fmt.Fprint(connection, "+PONG\r\n")
		serverErr <- writeErr
	}()
	if value, err := client.Do(t.Context(), "PING"); err != nil || value != "PONG" {
		t.Fatalf("retry failed: value=%v err=%v", value, err)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].Status.Code == codes.Error {
		t.Fatalf("retry must produce one successful operation span: %+v", spans)
	}
	var measured metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &measured); err != nil {
		t.Fatal(err)
	}
	var count uint64
	for _, scope := range measured.ScopeMetrics {
		for _, recorded := range scope.Metrics {
			if recorded.Name == "db.client.operation.duration" {
				for _, point := range recorded.Data.(metricdata.Histogram[float64]).DataPoints {
					if _, failed := point.Attributes.Value(attribute.Key("error.type")); failed {
						t.Fatal("recovered retry must not count as an operation failure")
					}
					count += point.Count
				}
			}
		}
	}
	if count != 1 {
		t.Fatalf("retry recorded %d operations, want 1", count)
	}
}
