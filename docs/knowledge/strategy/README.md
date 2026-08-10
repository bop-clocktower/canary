# Strategy knowledge nodes

These files are **generated**, not authored. Each one is a section of
[`STRATEGY.md`](../../../STRATEGY.md) materialized as a `business_rule` node by
`harness knowledge-pipeline --fix`, so the knowledge graph can link strategy
statements to the code that implements them.

## Source of truth

`STRATEGY.md` is authoritative. **Edit it, not these files.** A change made here
is silently overwritten the next time the pipeline runs with `--fix`, and until
then the graph and the strategy disagree with no signal that they do.

To refresh after editing `STRATEGY.md`:

```bash
harness knowledge-pipeline --fix
```

## Why only strategy is materialized

A full `--fix` run materializes every extracted node, but the code-signal
extractors produce restatements of type aliases, entries scraped from test
fixtures, and outright parse artifacts — see upstream
[harness-engineering#1331](https://github.com/Intense-Visions/harness-engineering/issues/1331).
Only the `STRATEGY.md`-sourced nodes carry content that is not already stated
more precisely in code, so only those are kept under version control.

Note also that materialized docs become extraction inputs on the next run, so
the "documented" and "extracted" counts in the pipeline's gap report are not
independent once this directory exists.

## Related

Harness's knowledge pipeline looks for ADRs at `docs/knowledge/decisions/`,
which this repo does not use — canary's ADRs live in [`docs/adr/`](../../adr/).
The pipeline therefore reports `0 decisions` despite twelve ADRs existing;
tracked upstream as
[harness-engineering#1330](https://github.com/Intense-Visions/harness-engineering/issues/1330).
