# Market Intel MCP

日本語優先の価格比較・オークション監視サービス。証拠と鮮度に基づく検証結果をRESTとRemote MCPで提供します。

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — REST契約
- `artifacts/api-server/src/market/` — ルーティング、商品識別、証拠投票、鮮度ポリシー
- `artifacts/api-server/src/routes/market.ts` — RESTとRemote MCP
- `artifacts/market-intel-mcp/` — 日本語管理画面

## Architecture decisions

- 検索スニペットは発見用途のみ。現在価格の証拠にはしない。
- アクション可能なのは鮮度条件を満たす VERIFIED_STRONG / VERIFIED_SINGLE のみ。
- カバレッジはtrusted-source registryに対して測定し、インターネット全体の網羅率とは表現しない。
- 未設定の任意プロバイダーはエラーにせず無効化する。
- 履歴保持は observations が fetched time 基準で180日、sold comps が sold time 基準で730日。API起動時と日次で古い行を500行ずつ、1テーブルあたり最大5,000行まで削除し、次回実行へ繰り越す。
- 履歴の読み取りと削除は各テーブルの timestamp index と同じ保持 cutoff を使う。`market_source_health` は cleanup の対象外。

## Product

価格URL検証、商品・オークション検索、価格比較、落札相場、履歴、ソース健全性、カバレッジ、ChatGPT自動化セットアップ。

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
