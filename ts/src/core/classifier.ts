/**
 * Test Classifier — rule-based intent/test-type detection from a prompt.
 *
 * Faithful TypeScript port of `agent/core/classifier.py`. Confidence values are
 * hand-picked heuristic priors (ordinal signal strength), NOT calibrated
 * probabilities — see the Python module docstring. `TestClassifier` is a domain
 * class name, not a test suite.
 */

// HTTP verb + slash-prefixed path: "GET /users", "POST /items/{id}".
const HTTP_VERB_PATH_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//i;
// Bare uppercase HTTP verb (case-sensitive, to avoid English-word false hits).
const HTTP_VERB_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/;

// Explicit framework name → implied test_type. Order matters: the alternation
// is tried leftmost-first at the earliest match position (as in Python).
const FRAMEWORK_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['playwright', 'e2e_ui'],
  ['cypress', 'e2e_ui'],
  ['vitest', 'frontend_unit'],
  ['jest', 'frontend_unit'],
  ['pytest', 'api'],
  ['hurl', 'api'],
  ['k6', 'performance'],
  ['axe', 'accessibility'],
  ['axe-core', 'accessibility'],
  ['pa11y', 'accessibility'],
  ['zap', 'security'],
  ['backstopjs', 'visual'],
  ['percy', 'visual'],
  ['pact', 'contract'],
  ['schemathesis', 'contract'],
  ['chaos-toolkit', 'chaos'],
  ['faker', 'synthetic_data'],
  ['sdv', 'synthetic_data'],
  ['opentelemetry', 'observability'],
  ['maestro', 'mobile'],
  ['appium', 'mobile'],
  ['wdio', 'mobile'],
  ['webdriverio', 'mobile'],
  ['locust', 'load'],
  ['gatling', 'load'],
  ['stryker', 'mutation'],
  ['mutmut', 'mutation'],
  ['semgrep', 'static_analysis'],
  ['testcontainers', 'integration'],
  ['fast-check', 'property'],
  ['fastcheck', 'property'],
  ['hypothesis', 'property'],
  ['promptfoo', 'llm_eval'],
];

const HINT_TYPE = new Map(FRAMEWORK_HINTS);

// Specialized categories keyed by high-specificity phrases; first match wins.
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['accessibility', ['accessibility', 'a11y', 'wcag', 'screen reader']],
  [
    'security',
    [
      'security test',
      'pentest',
      'penetration test',
      'vulnerability scan',
      'owasp',
      'dast',
      'sast',
    ],
  ],
  [
    'visual',
    [
      'visual regression',
      'visual test',
      'screenshot test',
      'snapshot test',
      'pixel diff',
    ],
  ],
  [
    'contract',
    [
      'contract test',
      'consumer-driven contract',
      'pact test',
      'openapi contract',
      'schema contract',
    ],
  ],
  [
    'chaos',
    ['chaos engineering', 'chaos test', 'fault injection', 'resilience test'],
  ],
  [
    'synthetic_data',
    ['synthetic data', 'fake data', 'test data generation', 'data generation'],
  ],
  [
    'observability',
    [
      'observability',
      'telemetry',
      'distributed tracing',
      'instrumentation test',
    ],
  ],
  [
    'mobile',
    [
      'mobile test',
      'android test',
      'ios test',
      'react native test',
      'mobile app test',
    ],
  ],
  ['mutation', ['mutation test', 'mutation testing', 'mutation score']],
  [
    'static_analysis',
    ['static analysis', 'lint rule', 'code smell', 'sonarqube'],
  ],
  ['load', ['soak test', 'spike test', 'concurrent users', 'load profile']],
  [
    'integration',
    ['integration test', 'integration testing', 'end-to-end integration'],
  ],
  [
    'property',
    [
      'property-based',
      'property based',
      'property test',
      'invariant test',
      'quickcheck',
      'generative test',
    ],
  ],
  [
    'llm_eval',
    [
      'llm eval',
      'llm evaluation',
      'prompt regression',
      'prompt eval',
      'llm behavior',
      'llm regression',
    ],
  ],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FRAMEWORK_HINT_RE = new RegExp(
  '\\b(' + FRAMEWORK_HINTS.map(([k]) => escapeRe(k)).join('|') + ')\\b',
  'i',
);

export interface ClassificationResult {
  intent: string;
  test_type: string;
  confidence: number;
}

/** The lowercase framework name explicitly named in the prompt, if any. */
export function extractFrameworkHint(prompt: string): string | null {
  const m = FRAMEWORK_HINT_RE.exec(prompt);
  return m ? m[1]!.toLowerCase() : null;
}

function result(testType: string, confidence: number): ClassificationResult {
  return { intent: 'generate_tests', test_type: testType, confidence };
}

function matchesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

const PERFORMANCE_KEYWORDS = ['performance', 'load test', 'stress test'];

// [keywords, testType, confidence] — the generic fallbacks checked after the
// framework-hint and HTTP-signal rules; first match wins.
const TRAILING_RULES: ReadonlyArray<
  readonly [readonly string[], string, number]
> = [
  [['api', 'endpoint', 'request'], 'api', 0.85],
  [['component', 'react', 'frontend'], 'frontend_unit', 0.9],
  [['login', 'checkout', 'user flow'], 'e2e_ui', 0.8],
];

export class TestClassifier {
  classify(prompt: string): ClassificationResult {
    const lower = prompt.toLowerCase();

    if (matchesAny(lower, PERFORMANCE_KEYWORDS))
      return result('performance', 0.95);

    for (const [testType, keywords] of CATEGORY_KEYWORDS) {
      if (matchesAny(lower, keywords)) return result(testType, 0.88);
    }

    const hint = FRAMEWORK_HINT_RE.exec(prompt);
    if (hint) return result(HINT_TYPE.get(hint[1]!.toLowerCase())!, 0.95);

    if (HTTP_VERB_PATH_RE.test(prompt)) return result('api', 0.95);
    if (HTTP_VERB_RE.test(prompt)) return result('api', 0.85);

    for (const [keywords, testType, confidence] of TRAILING_RULES) {
      if (matchesAny(lower, keywords)) return result(testType, confidence);
    }
    return result('e2e_ui', 0.5);
  }
}
