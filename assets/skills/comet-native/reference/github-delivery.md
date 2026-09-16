# GitHub delivery

Use when the user requests delivery through GitHub issues and PRs. Reuse existing explicit authorization. For any missing write authorization, prepare the content and evidence before obtaining that authorization. Local workflows without a binding do not require gh.

## Integration points

- Native Shape: after requirements are clear and formal requirement/spec artifacts exist, bind delivery. Check the entire scope of an existing issue, or create an issue when authorized.
- Native requirement revision: synchronize scope. Preserve existing AC keys; omit the key for new criteria to allocate one. Do not delete old criteria; mark removed goals retired and provide a new scope confirmation reference.
- Verify: collect actual per-AC verification results, commit the candidate, then record verify. Timeouts, unavailable environments and unexecuted checks are not-run, never passed.
- Review: use a separate review execution and record its identity and evidence. A formal PR requires review for every delivery. Do not invoke external Skills without the user's permission.
- Archive: retain the existing archive and precise commit steps. The final HEAD needs valid verification and review. Use delivery push/pr instead of direct git push/gh pr create. Bound Native pull-request finish enforces the same shared checks.
- Recovery: locate the record with delivery list/status and reconcile using observe. Report archive, push, PR creation, merge and issue closure separately.

## Binding and authorization

Commands output JSON. `--path` identifies the bound worktree; `--input` is a JSON file, not shell-interpolated content. Records live in the Git common directory and survive archive and linked-worktree removal. Losing the entire clone does not transfer local authorization or evidence to a new clone.

```bash
comet delivery bind --path <project-root> --input <binding.json> --json
comet delivery list --path <project-root> --json
comet delivery status --path <project-root> --id <delivery-id> --json
```

Example binding.json (use the actual repository, current branch and requirement file; the target branch must exist locally):

```json
{
  "repository": "owner/repo",
  "workflow": "native",
  "change": "my-change",
  "base": "enterprise/main",
  "head": "codex/my-change",
  "remote": "origin",
  "summary": {
    "title": "Change title",
    "background": "Current problem",
    "changes": "Final changes",
    "impact": "Affected behavior",
    "nonGoals": "Explicit exclusions",
    "compatibility": "Compatibility, migration and rollback; explain when not applicable"
  },
  "scope": {
    "confirmation": "Reference to explicit requirements confirmation",
    "items": [
      {
        "internalRef": "original-scenario-id",
        "source": "docs/requirements.md",
        "text": "Actual acceptance text present in the source file"
      }
    ]
  }
}
```

For Native use workflow=native and the actual acceptance ID as internalRef; public AC keys remain independent. The initial scope includes all active ACs by default. For partial delivery supply committedKeys while retaining every issue criterion. Full resolution requires covering every active issue criterion.

Record an existing authorization:

```bash
comet delivery grant --path <project-root> --id <delivery-id> --input <grant.json> --json
```

grant.json: `{"action":"issue:create","source":"reference to explicit user authorization"}`. Supported actions: issue:create, issue:update, push, pull-request:create, pull-request:update. Bind an issue before granting issue:update; the grant applies only to that issue. Bind a PR before granting pull-request:update; the grant applies only to that PR number, so a replacement PR requires a new grant. Agent assumptions or decisions are not user authorization.

```bash
comet delivery issue --path <project-root> --id <delivery-id> --json
```

To bind an existing issue, first use `delivery inspect-issue --id <delivery-id> --input <number.json>` to read its body and bodyHash (number.json is `{"number":51}`). After reviewing it, supply `{"number":51,"expectedBodyHash":"...","scopeConfirmation":"reference confirming the entire issue scope"}`. Do not overwrite human content. Revise scope with `delivery scope --input <scope.json>` using the binding.scope structure, retaining existing keys and supplying a new explicit confirmation reference.

Use `delivery sync-issue --input <sync.json>` with the current expectedBodyHash and issue:update authorization. Only the Comet managed block is updated. Reconcile detected remote edits rather than overwriting them. Before creating a PR, ensure the local scope includes all issue requirements, including any requirements added outside the managed block.

## Verification and review inputs

Read scope.hash and criterion revisions from status. Use actual Git commits. Verify records evidence already obtained by the execution host; it does not run tests.

```bash
comet delivery verify --path <project-root> --id <delivery-id> --input <verification.json> --json
```

```json
{
  "head": "actual commit SHA",
  "manifest": "current scope.hash",
  "items": [
    {
      "key": "AC-01",
      "revision": 1,
      "status": "passed",
      "evidence": ["actual test report or acceptance evidence reference"],
      "reason": "what ran and its result"
    }
  ]
}
```

Report exactly one result per committed key. Explain failed/not-run results. Reconcile scope when source requirements change; a new review cannot make old verification valid.

```bash
comet delivery review --path <project-root> --id <delivery-id> --input <review.json> --json
```

```json
{
  "kind": "full",
  "base": "binding.baseSha",
  "head": "actual commit SHA",
  "manifest": "current scope.hash",
  "verification": "latest verifications entry hash",
  "reviewer": "independent reviewer execution id",
  "builder": "builder execution id",
  "evidence": "actual review report reference",
  "findings": []
}
```

Each finding contains severity (critical/important/suggestion), resolved (boolean), and text. Unresolved critical/important findings block PR creation. After fixing them, reverify and perform a full review; do not mark old findings resolved without evidence.

For an identical-content requirement-document rename into an archive directory, or an empty commit, use `delivery carry --input <carry.json>`: `{"head":"final SHA","parent":"previous verification hash","evidence":"inspection proving continued applicability"}`. Only renames of recorded requirement sources are accepted; implementation, Skill and configuration paths are excluded. Other changes require verification again. Then record a delta review with kind=delta, parent=previous review.id, base=previous review.head and the final context. A changed Manifest requires full review.

## Delivery and recovery

```bash
comet delivery preflight --path <project-root> --id <delivery-id> --resolution full --json
comet delivery push --path <project-root> --id <delivery-id> --resolution full --json
comet delivery pr --path <project-root> --id <delivery-id> --resolution full --json
comet delivery observe --path <project-root> --id <delivery-id> --json
```

Use resolution=partial for partial delivery: the PR uses Related to and keeps the issue open. Only full uses Closes. PR creation never automatically merges. CI is Pending in the body, not a passed local check. After a new HEAD is verified, reviewed, and pushed to an open PR, refreshing its final evidence requires pull-request:update authorization. If the remote body no longer matches the last body written by Comet, stop and reconcile the human edit instead of overwriting reviewer content.

For any uncertain remote operation such as a timeout, connection loss, or lost response, use observe before any retry. A prepared or uncertain mutation blocks push and every later remote mutation. Do not repeat archive/commit or directly run gh create; an empty query is not permission to create again. Failures that definitely performed no write, such as missing gh, no login, denied permission, an unavailable repository, or a concurrent body edit detected before the write, are recorded as failed and may be retried under the existing authorization after fixing the prerequisite. Closed and merged PRs are still existing remote results; every state must retain the original verified/reviewed SHA, record any observed drift, and block completion.

The GitHub CLI provider currently supports same-repository branches on github.com with HTTPS or SSH remotes, not cross-fork heads or GitHub Enterprise hostnames. Unbound Native repository-command behavior remains compatible. Bound providers retain the existing input envelope and receive an additional delivery object with schema=comet.github-delivery.provider.v1 and repository/base/head/headSha/title/body. They must use the prepared body unchanged; gh independently verifies the result. Confirm that the custom provider handles this payload before enabling it.
