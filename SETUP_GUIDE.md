# セットアップガイド

## 1. Replitアプリを作成

このプロジェクトをReplitで開き、WebアプリとAPIを起動します。必要に応じて次の認証情報をReplit Secretsへ追加します。すべて任意です。

- `YAHOO_CLIENT_ID`
- `RAKUTEN_APP_ID`
- `EBAY_CLIENT_ID`
- `AMAZON_CREATORS_KEY`
- `KEEPA_API_KEY`
- `SERPAPI_KEY`
- `APIFY_TOKEN`
- `BRIGHT_DATA_TOKEN`
- `ENABLE_PLAYWRIGHT`（最終手段。規約上許可される対象だけ）

認証情報がないプロバイダーは安全に無効化されます。

## 2. 公開

ReplitのPublishから公開します。公開後、次を確認します。

- `https://公開URL/api/healthz`
- `https://公開URL/api/v1/public/source-health`
- `https://公開URL/api/v1/setup-bundle`

公開GET APIには1分30件、1日500件／IPの制限と短時間キャッシュがあります。個人利用向けの初期値です。

## 3. ChatGPTへRemote MCPを接続

ChatGPTのRemote MCP接続先に次を指定します。

`https://公開URL/api/mcp`

利用可能ツール:

`search_products`, `search_auctions`, `fetch_listing`, `get_price_history`, `get_sold_comps`, `compare_offers`, `verify_current_price`, `get_source_health`, `get_source_coverage`

## 4. スケジュールを作成・更新

管理画面の「ChatGPTセットアップ」または `/api/v1/setup-bundle` にある `chatgpt_setup_prompt` をChatGPTへ貼り付けます。通常は現在の監視構成を再現する `full_schedule_pack`（14件）、タスク枠が少ない場合は `core_6_pack`（6件）を使います。同名予定は重複作成せず更新してください。

セットアップAPIは受信した公開ホスト情報から `deployed_base_url` を生成し、MCP URLと公開GET URLを全スケジュールプロンプトへ自動挿入します。URLを手作業で置換する必要はありません。

Core 6 Pack:

1. 終了2時間以内スキャン
2. 終了12時間以内スキャン
3. C2C価格差スキャン
4. 固定買取・新品セール裁定スキャン
5. 朝の統合レポート
6. 日次改善

全タスクで次を必須にします。

- このサービスを一次価格検証器として使う
- 現在価格、`fetched_at`、検証状態を表示する
- `VERIFIED_STRONG` または鮮度条件を満たす `VERIFIED_SINGLE` だけを候補にする
- `CONFLICT` / `STALE` / `UNVERIFIED` を除外する
- 手数料、送料、税を含めたROIを計算する
- sold comps と流動性を確認する
- 終了30分以内は5分以内、10分以内は2分以内の観測で再検証する
- ソース健全性・カバレッジ監査は日次改善タスクに統合し、追加枠を消費しない

## 他ユーザー向け一括再現プロンプト

最初のプロンプト:

> 日本語優先のMarket Intel MCPアプリをReplitに作成してください。Remote MCP、読み取り専用REST GET、証拠投票、鮮度判定、商品識別、価格履歴、sold comps、trusted-source registryの実測カバレッジ、ソース健全性、管理画面、ChatGPTセットアップバンドルを含めてください。認証情報は任意のReplit Secretsだけで扱い、未設定プロバイダーは安全に無効化してください。公開可能な状態まで構築してください。

公開・MCP接続後の2つ目のプロンプト:

> 接続済みのMarket Intel MCPからsetup bundleを取得し、automation_promptとiCalを使って短期リセール調査のスケジュールを最大15件まで作成または更新してください。同名タスクは重複させず、現在価格・fetched_at・検証状態・手数料控除後ROI・sold comps・流動性を必須化し、CONFLICT/STALE/UNVERIFIEDを除外してください。終了間近のオークションは鮮度ポリシーに従い再検証してください。日次のソース健全性・カバレッジ監査は既存の日次改善タスクに統合してください。