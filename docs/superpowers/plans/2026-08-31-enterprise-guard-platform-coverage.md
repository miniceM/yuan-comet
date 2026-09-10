# Enterprise Guard Platform Coverage Implementation Plan

## Goal

Make Enterprise Guard coverage explicit and auditable across platforms. Claude Code is the only platform currently classified as project-level enforced coverage; all other platforms report rules injection plus CI fallback.

## Tasks

1. Add a shared platform coverage classifier and lifecycle downgrade behavior.
2. Update `comet doctor` to report enforced versus fallback coverage.
3. Publish the coverage matrix and add repository regression tests.
4. Bump the release metadata, update the changelog, and run targeted plus full verification.

## Verification

- Enterprise Guard coverage and lifecycle tests
- Doctor tests
- Enterprise Guard repository baseline and generated-asset tests
- Build, generated checks, lint, formatting, and full test suite
