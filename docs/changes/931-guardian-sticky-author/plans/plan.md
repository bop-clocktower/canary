# Plan: guardian sticky comment is author-aware (#931)

Route: bug (debugging discipline + TDD). Design fixed by the issue.

## Defect

`findSticky` (`ts/src/guardian/pr-comment.ts`) returned the first comment whose
body _contained_ `<!-- canary-pr-guardian -->`, from any author.
`upsertStickyComment` then PATCHed it, so a human who quoted guardian's output
had their comment overwritten. `collectAdjudications` reused the same lookup, so
it could read reactions off the human's comment.

## Tasks

1. Red tests in `ts/test/guardian-pr-comment.test.ts`:
   - human comment with the marker mid-body: guardian creates, human untouched
   - human comment starting with the marker: still not updated
   - bot comment that only contains the marker: not the sticky
   - existing bot sticky: updated in place, no duplicate (SC-9)
   - two bot stickies: the newest (`created_at`) is updated
   - `Bot` author through a configured app slug qualifies only when configured
   - fake client stamps the bot author on created comments
   - degraded notice names the 403 and does not guess "fork PR?"
2. Red test in `ts/test/guardian-adjudication.test.ts`: reactions come from the
   bot sticky, not a human comment carrying the marker.
3. Implement in `findSticky` only (single helper; `adjudication.ts` already
   calls it, so no second implementation):
   - extend `Comment` with optional `user`, `performed_via_github_app`,
     `created_at` (fields the REST list endpoint already returns)
   - add `GuardianIdentity { login, appSlug? }`, default
     `{ login: 'github-actions[bot]' }`
   - qualify = body (after leading whitespace) starts with marker AND
     (`user.login === identity.login` OR `user.type === 'Bot'` with
     `performed_via_github_app.slug === identity.appSlug`)
   - newest qualifying `created_at` wins
4. Re-seed existing fixtures that model guardian's own sticky with the bot
   author.
5. Keep net `ts/src` non-blank lines at or below base (module-size floor) by
   trimming stale Python-port commentary in `pr-comment.ts`.

## Out of scope

`cli.ts`, `pr-check.ts`, `report-tier.ts` (#928), `weak-test.ts` (#929),
`guardian.yml` (#930). The identity is not yet wired to an env var or flag; that
would touch `cli.ts`.
