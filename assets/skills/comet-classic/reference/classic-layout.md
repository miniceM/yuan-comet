# Classic Artifact Layout Protocol

At the start or recovery of every Classic phase, run this from the project root:

```bash
comet classic root show
```

Accept only `schema: comet.classic-layout.v1`. Bind the returned `openSpecRoot`, `changesRoot`, `archiveRoot`, `specsRoot`, and `superpowersRoot` as `<classic-open-spec-root>`, `<classic-changes-root>`, `<classic-archive-root>`, `<classic-specs-root>`, and `<classic-superpowers-root>`, respectively, then define `<classic-change-dir>` as `<classic-changes-root>/<name>`. These logical roots are the source of truth for this turn. Resolve them again after recovery or context compaction.

## Reuse Read Results Within the Same Execution

During one continuous execution, reuse successful, complete, still-valid status responses, configuration reads, and DOP candidate lists. Retain the associated project root, change, configuration, and identity context; reuse existing results without introducing a persistent cache.

- status: reread after artifact, schema, or relevant configuration writes. Use the post-write result for the next iteration; completeness checks may reuse it but must still validate core IDs, applyRequires, paths, and non-empty actual outputs
- Configuration and DOP: reread after relevant configuration, identity, or candidate changes. Revalidate when external changes are known, may have occurred while waiting for the user, or validity is uncertain
- Reread after workspace changes, session recovery, or context compaction; do not infer freshness from a summary. Failed or incomplete results cannot be reused
- Preserve each phase's root resolution, entry checks, recovery checks, and guard. Reuse only removes unchanged duplicate reads and never replaces safety checks

## Command rules

- This and every other Comet-owned Classic Skill must call the official OpenSpec CLI directly through:

  ```bash
  comet classic openspec -- <args...>
  ```

- The adapter runs the official CLI from the configured OpenSpec base and preserves stdout, stderr, and the exit code. Do not register or query an OpenSpec store for a root inside the same repository.
- Run `openspec` directly only when the user explicitly operates from the resolved OpenSpec base.

## Path rules

- Express change, tasks, delta spec, handoff, and archive paths with the `<classic-*>` logical roots bound above; for example, use `<classic-change-dir>/tasks.md`. Do not wrap one physical layout in a logical-path convention and keep using it as filesystem guidance.
- Resolve Superpowers files through `<classic-superpowers-root>/...`; do not derive them from the OpenSpec root or current cwd.
- `comet state`, `comet guard`, `comet handoff`, and `comet archive` resolve the layout internally. Never persist a physical root in `.comet/current-change.json`.
- If root show or a write command reports conflicting legacy/docs roots, invalid config, or an incomplete migration, stop. Use `comet doctor` for read-only inspection; do not scan both roots, guess change ownership, or dual-write.

## New, existing, and migrated projects

- New Classic projects default to `docs/openspec/`.
- A missing `classic.artifact_layout` defaults to `docs/openspec/`. When `comet update` detects existing root-level `openspec/` artifacts, it explicitly backfills `legacy` without moving them.
- Normal init/update never moves existing artifacts. Run `comet classic root move docs --dry-run` to inspect the current state; after confirmation, run `comet classic root move docs --apply` to migrate. The Runtime manages migration identity and locked revalidation internally.
- Migration moves the complete legacy-layout tree as-is, including active, unmanaged, and incompletely archived changes; change state does not block a root move.
