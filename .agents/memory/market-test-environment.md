---
name: Market test database readiness
description: Environment constraint around database-backed market tests and provider-only validation
---

The workspace can expose a `DATABASE_URL` before the market tables exist. A successful database connection therefore does not prove that persistence is ready.

**Why:** Provider and route behavior can be validated independently, while database-backed tests otherwise fail with missing-relation errors unrelated to the code under test.

**How to apply:** Treat database schema readiness as a separate prerequisite from API/provider validation; do not interpret missing market-table errors as provider parsing failures.

Database-backed route tests must isolate the API process when earlier contract tests can import persistence with a different `DATABASE_URL`; the storage module caches its database module for the process lifetime. Keep shared test pools open until all tests in a file finish, then close them once.

**Why:** Test files can exercise source-health or unavailable-persistence paths before a route test, and the first configured database import otherwise makes a later temporary database look empty or unavailable.

**How to apply:** Seed an isolated database in a fixture process, run the route in a fresh API child process, and close any parent-owned pool in a file-level teardown rather than each test.