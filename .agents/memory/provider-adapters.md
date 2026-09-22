---
name: Marketplace evidence boundary
description: Trust boundary for adding or changing marketplace search adapters
---

New marketplace adapters must classify every returned record explicitly: provider-owned structured price fields may become normalized observations, while search snippets, summaries, and inferred prices remain discovery-only.

**Why:** Treating a search reference as price evidence would weaken source verification and could make an unsupported value actionable.

**How to apply:** Keep the distinction in the adapter return type, preserve it through routing and API schemas, and add a regression test whenever a provider is added or its response parser changes.

Completed-sale adapters may use an authenticated order-history API rather than a public sold-search feed, but must filter to completed records and require provider-owned sale time, price, condition, identity, and URL before normalization.

**Why:** Catalog metadata and market/ask fields can identify an item without proving that a sale occurred at that price.

**How to apply:** Use catalog responses only to resolve structured identity and official URLs; accept sale evidence only from the provider’s completed-sale response and pass it through the shared sold-comp normalizer.

Some provider order-history feeds require two credentials: an application API key and a user OAuth bearer token. Short-lived access tokens should be refreshed with the provider’s documented refresh-token flow before source capability is advertised.

**Why:** An API key alone may identify the application but cannot authorize access to seller history; advertising the adapter early creates a provider that always fails in production.

**How to apply:** Treat the complete credential combination as the configured state, keep token refresh in memory with expiry/skew handling, and never log token request bodies or authorization headers.