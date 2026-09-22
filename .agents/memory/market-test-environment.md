---
name: Market test database readiness
description: Environment constraint around database-backed market tests and provider-only validation
---

The workspace can expose a `DATABASE_URL` before the market tables exist. A successful database connection therefore does not prove that persistence is ready.

**Why:** Provider and route behavior can be validated independently, while database-backed tests otherwise fail with missing-relation errors unrelated to the code under test.

**How to apply:** Treat database schema readiness as a separate prerequisite from API/provider validation; do not interpret missing market-table errors as provider parsing failures.