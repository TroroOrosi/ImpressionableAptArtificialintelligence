# ChatGPT headless connection

Goal: preserve the existing evidence/price/provider logic and expose it as a reliable read-only Remote MCP service plus REST, without needing the Replit UI.

Context recovered from the project: short resale research, cash conversion within 30 days, total acquisition <= JPY 500,000 (prefer <=100,000), net profit >=10,000 and ROI >=15% (prefer >=20%); distinguish new/used and exact variants; retailer asking prices are not realized sales. These are research filters, not guaranteed profit or purchase authorization.

Implementation sequence:
1. Add dependency-free MCP protocol tests for initialize, notification acknowledgment, ping, per-tool schemas/validation, read-only hints, error handling, object structuredContent, Origin/protocol checks, and HTTP behavior. Run red then green.
2. Replace only the existing MCP handler; reuse the current search/verification/history/sold-comps functions. Add public REST aliases and no-store caching, keep legacy routes, add per-process MCP rate limits.
3. Preserve schedule packs for new users, but add a migration-only policy for existing schedules. Never claim that including a URL installs an app or gives a scheduled task HTTP capabilities.
4. Add an API-only Docker build, Cloud Run deployment script, independent external smoke CLI, and CI for the API and container smoke. Credentials remain in the chosen host's secret store.
5. Publish a reviewable GitHub branch/PR and report local tests, CI, public deployment, native ChatGPT registration, and scheduled-run verification separately. Do not replace working schedule URLs until the new endpoint has passed real calls.

Review focus: cached auction prices; guessed missing fields; source text injection; provider secrets in errors/build context; false readiness from a green health endpoint; accidental unrelated schedule/Cloud project changes.
