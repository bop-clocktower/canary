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
const outStream = fs.createWriteStream(
  path.join(outDir, `otel-spans.${workerIndex}.jsonl`),
  { flags: 'a' },
);

/** Minimal file exporter — one JSON span per line, matches span_reader.py. */
class JsonlFileSpanExporter {
  export(spans, resultCallback) {
    for (const span of spans) {
      const [startSec, startNs] = span.startTime;
      const [durSec, durNs] = span.duration;
      outStream.write(JSON.stringify({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startTime: new Date(startSec * 1000 + startNs / 1e6).toISOString(),
        duration_ms: durSec * 1000 + durNs / 1e6,
        attributes: span.attributes,
      }) + '\n');
    }
    resultCallback({ code: 0 });
  }

  shutdown() {
    return new Promise((resolve) => outStream.end(resolve));
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
