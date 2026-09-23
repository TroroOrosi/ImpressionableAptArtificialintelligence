# Market Intel MCP

AIによる価格比較、オークション監視、短期リセール調査のための日本語優先サービスです。現在価格を推測せず、各観測の出典・取得時刻・鮮度・識別情報・証拠ハッシュを保持します。**価格の検証状態だけで購入可能・利益確定とは判定しません。**

## ChatGPTから直接使う（UI・Replit不要）

APIだけをCloud Run等へ配置し、通常会話からRemote MCPを呼び出す構成を追加しました。

**公開・接続・確認の手順は [docs/CHATGPT_SETUP.md](docs/CHATGPT_SETUP.md) を参照してください。**

- APIだけのDockerfile、Cloud Runデプロイスクリプト、外部HTTP/MCP疎通テストを同梱。
- 初期化・通知・ツールごとの引数検証・読み取り専用の定義を備えた10ツール。
- 既存スケジュールはID・時刻・ジャンル・個別条件を維持して接続先を移行。未検証URLへ自動変更しません。
- HTTP/MCP疎通、ChatGPTへの登録、定期実行、実データ取得、永続保存はそれぞれ確認が必要です。

## 主な機能

- Remote MCP: `/api/mcp`
- 公開読み取り専用API: `/api/v1/public/*`
- 検証状態: `VERIFIED_STRONG` / `VERIFIED_SINGLE` / `CONFLICT` / `STALE` / `UNVERIFIED`
- 商品識別、証拠投票、オークション鮮度ポリシー、価格履歴、落札相場、ソース健全性
- trusted-source registryに対するカバレッジ（インターネット全体の100%網羅は主張しません）
- 新規利用者向けのFull Schedule Pack（14件）とCore 6 Pack。既存タスクを上書きするものではありません。
- 設定済み公開ベースURLから接続先を生成

## セキュリティ

API認証情報はホスティング先のSecretストア・環境変数だけに保存してください。レスポンスには含めません。ログイン、非公開データ、robots制限、CAPTCHA、アンチボット対策、利用規約を回避しません。検索スニペットは発見用途に限定し、価格検証の証拠にはしません。

公開URL取得はtrusted-domain allowlist、DNS/IP検査、redirect先再検査、タイムアウト、2MB応答上限を適用します。未知のドメインは取得せず`UNVERIFIED`として返します。同一upstream sourceまたは同一evidence hashの観測は重複確認として数えず、`VERIFIED_STRONG`には独立した証拠を要求します。

現在の接続は公開読み取り専用です。有料APIを有効化する場合は提供元の利用上限・予算管理が必要です。プロセス内レート制限は分散制限・課金上限ではありません。

## 既存のWeb構成

従来のWeb/APIの2サービス構成も残しています。`/api/healthz`がAPIの健康状態確認です。プロバイダー用Secretがない場合、そのプロバイダーは無効になり、利用可能な汎用検証だけが継続します。健康状態の成功はプロバイダーの取得成功ではありません。

従来のReplit運用とプロバイダー設定一覧は [SETUP_GUIDE.md](SETUP_GUIDE.md) にあります。新しいChatGPT接続は上記の専用手順を優先してください。
