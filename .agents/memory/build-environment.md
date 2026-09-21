---
name: Artifact build environment
description: Environment requirement for validating this monorepo's artifact builds
---

Manual builds of artifact-owned services need the same PORT and BASE_PATH values that managed workflows inject automatically.

**Why:** The Vite configurations intentionally fail fast when those deployment-routing values are absent, even though the managed workflows start successfully.

**How to apply:** Use the artifact workflow for runtime verification; when running the root build manually, provide non-secret local values for both variables.