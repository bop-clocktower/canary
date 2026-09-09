# Contributing to Canary

Thanks for looking at Canary. Please read the fork limitation below **before**
you start work — it currently decides whether your change can be merged at all.

## Fork pull requests cannot be merged right now

If you fork this repository and open a pull request, it will fail the required
check **`No removed-symbol or proprietary leaks`** and there is nothing you can
do in your PR to fix it. This is a known defect in our CI, tracked in
[#843][fork-issue] — it is not a problem with your change, and it is not
something a rebase, a retry, or a maintainer re-run will clear.

**Why.** That check scans commits for a private denylist of company identifiers,
supplied to CI through the `CANARY_PROPRIETARY_DENYLIST` secret. GitHub
deliberately does not pass repository secrets to workflows triggered by a fork,
so on a fork PR the gate resolves an empty denylist. It then refuses to report a
pass, which is the correct behaviour — a gate that matched zero patterns has not
verified anything, and calling that green is exactly the false-green failure the
gate exists to prevent. So it fails instead, and the required check never goes
green.

The gate is not misbehaving. It is in the wrong place: it runs where it cannot
reach its own configuration. Fixing that means moving it to base-branch context,
which is what [#843][fork-issue] covers.

**What to do in the meantime.** Please still open the PR or an issue — the
discussion and the diff are useful and nothing is wasted. To actually land it, a
maintainer needs to push your branch to this repository and open the PR from
there, so if you would like your change merged, say so on the PR and we will
arrange it. Small changes are usually fastest as an issue with the diff pasted
in.

We will delete this section when [#843][fork-issue] lands.
`ts/test/contributing-fork-note.test.ts` couples the two, so the warning cannot
outlive the defect it describes, and cannot quietly disappear while the defect
is still real.

## Everything else

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

[fork-issue]: https://github.com/bop-clocktower/canary/issues/843
[conventional]: https://www.conventionalcommits.org/
