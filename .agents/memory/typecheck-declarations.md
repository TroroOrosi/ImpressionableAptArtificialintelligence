---
name: Workspace declaration freshness
description: Typecheck behavior when a dependent package resolves generated declaration output
---

When a dependent package reports missing exports that are present in the referenced package source, refresh the referenced package's project-reference declaration output before treating the error as an application regression.

**Why:** Workspace package resolution can use generated declaration files instead of the current source, and an incremental build may leave those declarations stale after schema work.

**How to apply:** Rebuild the referenced project declarations through the workspace project-reference build, then rerun the dependent typecheck.