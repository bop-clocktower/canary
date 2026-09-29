# Contributing to Canary

Thanks for looking at Canary. Pull requests from forks are welcome and run the
same required checks as branches in this repository.

## Where things live

[AGENTS.md](AGENTS.md) is the canonical knowledge map for this repository —
architecture, repository layout, agent behaviour, and the development workflow
all live there rather than being restated here, so the two cannot drift.

The parts you are most likely to want:

- **First-time clone setup** and the shared pre-commit hook — `AGENTS.md`,
  _Development Workflow_.
- **The four quality gates.** They run from `ts/`, not the repository root, and
  should be run separately so a failure is attributable:

  ```bash
  cd ts
  npm run build
  npm run typecheck
  npm run format:check
  npm test
  ```

  There is deliberately no `lint` gate. `AGENTS.md` explains why, and why the
  repository root is not a gate surface.

- **Which CI checks can block a merge**, and the stated reason for every check
  that cannot — [`.github/required-checks.json`](.github/required-checks.json).

### Commits and branches

- Commits follow [Conventional Commits][conventional]: `type(scope): summary`,
  with types `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`,
  `perf`.
- Branches are `<prefix>/<kebab-slug>`, optionally led by a ticket id — for
  example `fix/843-fork-pr-note`.
- `main` is protected. Every change lands through a pull request, including
  documentation-only ones.

### Reporting a problem with a gate

If a check fails in a way you cannot act on, that is worth an issue on its own.
A gate that cannot reach what it is meant to inspect should say so loudly rather
than pass quietly, and when one gets that wrong we want to know — see
[`docs/knowledge/gates/false-green-detection.md`](docs/knowledge/gates/false-green-detection.md).

[conventional]: https://www.conventionalcommits.org/
