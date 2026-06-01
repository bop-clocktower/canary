# Example: k6 Performance — Checkout Load

Generates a k6 load test holding 50 requests/sec against a checkout endpoint for
30 seconds, with thresholds on latency and error rate.

## Prompt

```text
Generate a k6 load test for POST https://api.example.com/v1/checkout.

Profile:
- Hold a steady 50 requests/sec for 30 seconds
- Ramp up over 5 seconds at the start
- Use a small, fixed payload: {"items":[{"sku":"ABC-123","qty":1}],"currency":"USD"}
- Bearer token from env var K6_BEARER_TOKEN

Thresholds:
- p(95) request duration must stay under 500ms
- Error rate (HTTP status >= 400) must stay under 1%

Add 50ms sleep between iterations so the runner doesn't synthesize traffic
faster than the scenario describes. Single scenario, no scenarios block
nesting.
```

See [`prompt.txt`](prompt.txt) for a copy-pasteable version.

## Run it

```bash
cd examples/k6-perf-checkout
canary generate "$(cat prompt.txt)"
```

Canary classifies as `performance`, picks `k6`, writes a `*.load.js` file.

## Running the generated test

```bash
# macOS: brew install k6
# linux: see https://k6.io/docs/getting-started/installation/

export K6_BEARER_TOKEN=stub-for-now
canary run tests/generated/<filename>.load.js k6
```

The test will fail against `api.example.com` (no real endpoint). To adapt:

- Replace URL with your load-testing target (use a **staging** environment, not
  prod, unless you've coordinated)
- Update payload to match your real request shape
- Tune the RPS / duration to your actual SLO

## What to expect

Roughly:

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    checkout_load: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      startTime: '5s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    errors: ['rate<0.01'],
  },
};

const URL = 'https://api.example.com/v1/checkout';
const PAYLOAD = JSON.stringify({
  items: [{ sku: 'ABC-123', qty: 1 }],
  currency: 'USD',
});

export default function () {
  const res = http.post(URL, PAYLOAD, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${__ENV.K6_BEARER_TOKEN}`,
    },
  });

  const ok = check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  errorRate.add(!ok);
  sleep(0.05);
}
```

## Variations to try

- **Spike test:** rephrase as "spike to 500 RPS for 10s, then back to 50"
- **Soak test:** "hold 20 RPS for 1 hour, then ramp down"
- **Mixed traffic:** ask for 2 scenarios (one POST /checkout, one GET /catalog)
  with different rates

## Cautions

- Always run load tests against staging or a dedicated perf env, not prod
- Coordinate with whoever runs the target — 50 RPS for 30s is small, but scaling
  up without warning is rude
- The generated thresholds are placeholders; tune them to your real SLO

## See also

- [CLI Reference → `canary generate`](../../docs/wiki/CLI-Reference.md)
- [Writing Good Prompts](../../docs/wiki/Writing-Good-Prompts.md)
