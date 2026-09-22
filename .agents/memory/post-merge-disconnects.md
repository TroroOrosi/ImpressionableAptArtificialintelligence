---
name: Post-merge disconnects
description: How to interpret transient post-merge setup disconnects in this workspace.
---

An `UNEXPECTED_DISCONNECT` from post-merge setup does not by itself indicate a broken setup script. When the configured script is already non-interactive and idempotent, retry the setup before editing it.

**Why:** A retry can complete dependency/schema reconciliation successfully after the managed setup service disconnects transiently; changing a working script can introduce avoidable failures.

**How to apply:** Confirm the configured script and timeout, rerun post-merge setup, then verify workflow reconciliation and each managed workflow's running state.