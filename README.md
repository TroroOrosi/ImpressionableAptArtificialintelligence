# Market Intel MCP

AIによる価格比較、オークション監視、短期リセール調査のための日本語優先サービスです。現在価格を推測せず、各観測の出典・取得時刻・鮮度・識別情報・証拠ハッシュを保持し、検証済みの情報だけをアクション可能として返します。

## 主な機能

- Remote MCP: `/api/mcp`
- 公開読み取り専用API: `/api/v1/public/*`
- 検証状態: `VERIFIED_STRONG` / `VERIFIED_SINGLE` / `CONFLICT` / `STALE` / `UNVERIFIED`
- 商品識別、証拠投票、オークション鮮度ポリシー、価格履歴、落札相場、ソース健全性
- trusted-source registry に対する実測カバレッジ（インターネット全体の100%網羅は主張しません）
- ChatGPT接続手順、現在の監視構成を再現するFull Schedule Pack（14件）、枠が少ないユーザー向けCore 6 Pack
- 実行時の公開ベースURL自動挿入

## セキュリティ

API認証情報はReplit Secrets／環境変数だけに保存してください。レスポンスには含めません。ログイン回避、非公開データ取得、robots制限、CAPTCHA、アンチボット対策、利用規約を回避する独自スクレイピングは行いません。検索スニペットは発見用途に限定し、価格検証の証拠にはしません。

公開URL取得はtrusted-domain allowlist、DNS/IP検査、redirect先再検査、タイムアウト、2MB応答上限を適用します。未知のドメインは取得せず`UNVERIFIED`として返します。同一upstream sourceまたは同一evidence hashの観測は重複確認として数えず、`VERIFIED_STRONG`には独立した証拠を要求します。

## 起動

アプリはWebとAPIの2サービスで動作します。`/api/healthz` が正常性確認です。プロバイダー用Secretがない場合、そのプロバイダーだけが無効になり、汎用JSON-LD検証など利用可能な機能は継続します。

詳細は [SETUP_GUIDE.md](./SETUP_GUIDE.md) を参照してください。