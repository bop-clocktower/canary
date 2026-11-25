/** `canary testtracker` help text, kept apart so testtracker.ts stays a router. */
export const USAGE = `usage: canary testtracker push --junit <file…> --suite <name> [options]
       canary testtracker push-perf --k6-summary <file> --client <slug> --suite <slug> --env <env>   (k6; see push-perf --help)

Push JUnit XML test reports to a TestTracker /api/ingest endpoint, with the
same payload, retry and size budget as the Playwright reporter.

  --junit <file…>    one or more JUnit XML reports (repeatable)
  --suite <name>     dashboard suite (else CANARY_INGEST_SUITE)
  --workflow <label> workflow label (else CANARY_INGEST_WORKFLOW, default "junit")
  --no-collected     do not send the catalog; use when the reports are a
                     subset of the suite (a shard, a name filter)
  --level <level>    the suite's test level, sent as the run's level, e.g.
                     unit, integration, contract, e2e (else CANARY_INGEST_LEVEL)
  --features-map <file>
                     JSON object of glob → feature slug(s) for each test's
                     file, first match wins (else CANARY_INGEST_FEATURE_MAP);
                     an unmatched test sends no features; a missing or
                     unreadable file exits 1 with nothing pushed
  --strict-budget    refuse to push (exit 1, nothing sent) when fitting the
                     payload under the 4 MB budget would drop the catalog or
                     still leave it over budget; on by default when CI is set
  --no-strict-budget push a degraded payload anyway, even under CI
  --quarantine-ledger <path>
                     canary-katana ledger: tag each skipped result with a
                     matching (file, test) row "quarantined" and
                     "quarantine:<issue>", and name rows that matched nothing
                     (else CANARY_INGEST_QUARANTINE_LEDGER); a missing or
                     unreadable ledger exits 1 with nothing pushed
  --dry-run          print the payload instead of pushing
  -h, --help         show this help

Environment: CANARY_INGEST_URL and CANARY_INGEST_TOKEN (required to push),
CANARY_INGEST_ENVIRONMENT, CANARY_INGEST_AREA_MAP, CANARY_INGEST_FEATURE_MAP,
CANARY_INGEST_LEVEL, CANARY_INGEST_TEST_FILE_PREFIX.

Producing a report:
  vitest     vitest run --reporter=junit --outputFile=junit.xml
  node       node --test --test-reporter=junit --test-reporter-destination=junit.xml
  newman     newman run collection.json -r junit --reporter-junit-export junit.xml
  maestro    maestro test flows/ --format junit --output junit.xml

Exit: 0 pushed, 1 unreadable report or ledger, push not ingested, or refused by the
strict budget (nothing pushed), 2 usage, 3 abstained (a report holds zero
testcases; nothing pushed).
`;
