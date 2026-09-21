---
name: Marketplace evidence boundary
description: Trust boundary for adding or changing marketplace search adapters
---

New marketplace adapters must classify every returned record explicitly: provider-owned structured price fields may become normalized observations, while search snippets, summaries, and inferred prices remain discovery-only.

**Why:** Treating a search reference as price evidence would weaken source verification and could make an unsupported value actionable.

**How to apply:** Keep the distinction in the adapter return type, preserve it through routing and API schemas, and add a regression test whenever a provider is added or its response parser changes.