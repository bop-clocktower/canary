// otel_bootstrap/instrument.mjs
//
// Node OTel SDK bootstrap for canary-instrument. Import via:
//   NODE_OPTIONS="--import ./otel_bootstrap/instrument.mjs" npx playwright test
//
// Default: writes one JSON span per line to
//   test-results/trace/otel-spans.<TEST_WORKER_INDEX>.jsonl
// (no collector required — this is what scripts/span_reader.py reads).
// When OTEL_EXPORTER_OTLP_ENDPOINT is set, spans are *additionally*
// streamed to that collector via OTLPTraceExporter; the file path above is
// unaffected either way.
//
// Auto-instruments HTTP/undici only — fs instrumentation is disabled so
// Playwright's own file I/O doesn't show up as noise spans.
//
// Consumer-supplied dependencies (not vendored by this skill):
//   @opentelemetry/sdk-node @opentelemetry/api
//   @opentelemetry/auto-instrumentations-node
//   @opentelemetry/exporter-trace-otlp-http

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import fs from 'node:fs';
import path from 'node:path';

const workerIndex = process.env.TEST_WORKER_INDEX ?? '0';
const outDir = path.join(process.cwd(), 'test-results', 'trace');
fs.mkdirSync(outDir, { recursive: true });
// Synchronous fd, not fs.createWriteStream: Playwright's worker process
// calls process.exit() once its assigned tests finish (it does not wait for
// the event loop to drain), which cuts off any pending async stream writes
// before they reach disk. fs.writeSync makes each export() call durable
// immediately, so span data survives that hard exit — see
// docs/changes/canary-instrument/proposal.md's ADR reference for why this
// skill can't assume a graceful shutdown hook will run.
const outFd = fs.openSync(
  path.join(outDir, `otel-spans.${workerIndex}.jsonl`),
  'a',
);

/** Minimal file exporter — one JSON span per line, matches span_reader.py. */
class JsonlFileSpanExporter {
  export(spans, resultCallback) {
    for (const span of spans) {
      const [startSec, startNs] = span.startTime;
      const [durSec, durNs] = span.duration;
      fs.writeSync(outFd, JSON.stringify({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        // ReadableSpan.parentSpanId was replaced by parentSpanContext in
        // the current @opentelemetry/sdk-trace* line this skill installs
        // (span.parentSpanId is undefined there, so JSON.stringify silently
        // dropped the key entirely) — read the id off parentSpanContext.
        parentSpanId: span.parentSpanContext?.spanId ?? null,
        name: span.name,
        startTime: new Date(startSec * 1000 + startNs / 1e6).toISOString(),
        duration_ms: durSec * 1000 + durNs / 1e6,
        attributes: span.attributes,
      }) + '\n');
    }
    resultCallback({ code: 0 });
  }

  shutdown() {
    try {
      fs.closeSync(outFd);
    } catch {
      // already closed (e.g. shutdown() invoked twice) — fine.
    }
    return Promise.resolve();
  }
}

const spanProcessors = [new SimpleSpanProcessor(new JsonlFileSpanExporter())];

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  spanProcessors.push(
    new SimpleSpanProcessor(
      new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    ),
  );
}

const sdk = new NodeSDK({
  spanProcessors,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();
process.on('exit', () => sdk.shutdown());
