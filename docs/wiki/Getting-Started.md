# Getting Started with Canary

This guide takes you from zero to your first generated test. It should take
about five minutes.

The install steps live in one place, the README, so this page links to them
instead of copying them. A copy is how this page once ended up teaching an
install path that no longer existed.

## Prerequisites

You'll need:

- Node.js 22 or later (`node --version` to check). Older versions are past
  end-of-life and are not supported.
- Claude Code (Canary runs as a plugin, so there is no separate API key)
- Git

You do not need Python. Canary can _generate_ Pytest suites, but Canary itself
has run on TypeScript since v6.0.0, and there is no `pip` or `pipx` package.

## Step 1: Install the CLI

Install `canary-test-cli` from npm with Volta, mise, or npm. Pick one from the
README's [Installation section][install]. The package provides the `canary` CLI
and the `canary-mcp` server that the plugin starts.

Check that it worked:

```bash
canary --version
```

If your shell says `canary: command not found`, see
[Troubleshooting](Troubleshooting.md#canary-command-not-found).

## Step 2: Add the Claude Code plugin

In Claude Code, add the `bop-clocktower` marketplace and install the `canary`
plugin. The two commands are in the README's [Claude Code plugin
section][plugin].

Claude Code's own session does the LLM work, so there is no key to configure.

## Step 3: Generate your first test

In Claude Code, run the test-author command:

```text
/canary-write-test Test that GET /api/health returns 200
```

The `canary-test-author` agent reads your repo first. It finds the test
framework you already use and follows your existing test layout and fixtures. It
writes the test and tells you the file path. When there is no framework to
follow, it asks you once or hands off to the framework advisor.

## Step 4: Review the generated file

Open the file it wrote. Check that:

- The endpoint matches what you intended
- The assertion matches the expected behavior
- There are no placeholder values left for you to fill in

## Step 5: Run the test

Run it through Canary's executor. This is deterministic and needs no key:

```bash
canary run <path-to-test-file> <framework>
```

Use `canary frameworks` to see the framework names Canary accepts and how it
runs each one. You can also run the framework directly, for example
`npx playwright test <file>` or `pytest <file>`.

## Promoting a generated test

Before a generated test joins your committed suite, it should pass review. The
[canary-promote-test][promote-skill] skill has the full promotion checklist, and
`canary promote-check <path>` gives a deterministic verdict.

## Want a preview without generating?

`canary recommend` shows which framework Canary would pick and why. It is a
deterministic CLI command and makes no LLM call:

```bash
canary recommend "load test the search endpoint"
```

## Next Steps

- [Writing Good Prompts](Writing-Good-Prompts.md): get the test you actually
  want on the first try
- [For Manual Testers](For-Manual-Testers.md): if you're coming from a manual
  testing background
- [Troubleshooting](Troubleshooting.md): if something went wrong above

[install]: https://github.com/bop-clocktower/canary#-installation
[plugin]: https://github.com/bop-clocktower/canary#claude-code-plugin
[promote-skill]:
  https://github.com/bop-clocktower/canary/blob/main/agents/skills/claude-code/canary-promote-test/SKILL.md
