# Canary — AI-Powered Test Generation

Canary turns plain-English descriptions of what you want to test
into working test code. You describe the behavior; Canary writes
the test.

## What Canary Does

You type something like:

> "Test that the login page rejects invalid passwords"

Canary figures out the right test type and framework, generates
a runnable test file, and — optionally — executes it for you
right away.

No boilerplate hunting. No framework wiring. Just describe the
test you need.

## Who It's For

- **Manual testers** moving toward automation: describe tests
  the way you always have, let Canary handle the code.
- **Developers** who want quick test scaffolding without
  context switching.
- **QA leads** who need consistent test structure across a team.

## Start Here

New to Canary? The [Getting Started](Getting-Started.md) guide
walks you through installation and your first generated test in
under five minutes.

Coming from manual testing?
[For Manual Testers](For-Manual-Testers.md) explains how your
existing skills translate directly into great Canary prompts.

## Guides

- [Getting Started](Getting-Started.md) — install Canary and
  generate your first test
- [For Manual Testers](For-Manual-Testers.md) — if you're new
  to test automation
- [Writing Good Prompts](Writing-Good-Prompts.md) — how to
  describe tests so Canary gets it right the first time
- [Understanding the Harness](Understanding-the-Harness.md) —
  what the CI checks mean and what to do when they fail
- [Troubleshooting](Troubleshooting.md) — common errors and
  how to fix them

## Technical Reference

- [Architecture Deep Dive](Architecture-Deep-Dive.md)
- [Harness Engineering Integration](Harness-Engineering-Integration.md)
- [LLM Providers & Configuration](LLM-Providers-and-Configuration.md)
- [Self-Healing & Feedback Loop](Self-Healing-and-Feedback-Loop.md)
