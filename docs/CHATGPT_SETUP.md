# ChatGPTが直接使うMarket Intel：Replit不要の接続手順

この構成は「人が操作するWeb画面」ではなく、ChatGPTが価格・商品・成約根拠を取得するAPIです。既存のWeb画面は残しますが、Docker/Cloud RunではAPIしか起動しません。リポジトリの依存ライブラリを全面削除する変更ではありません。

## 何をもって接続完了とするか

以下は別々の検証です。健康状態が`ok`でも、価格取得やChatGPTへの登録は証明されません。

| 段階 | 確認内容 |
| --- | --- |
| コード | 自動テスト・型チェック・APIビルド |
| HTTP/MCP | 公開URLで初期化→通知→一覧→実際のツール呼び出し |
| 調査ソース | 必要なAPIの認証・利用権限、現物と一致した実データ |
| 保存 | PostgreSQLのスキーマと再起動をまたぐ履歴保存 |
| ChatGPT | 登録されたツールを通常会話から実際に呼び出す |
| 定期実行 | 対象タスクで実際にMCPまたはHTTP取得できるか |

`scripts/smoke-chatgpt.mjs`のPASSEDはHTTP/MCP段階だけです。登録や定期実行をコードから完了扱いにしません。

## 1. Google CloudへAPIを公開

課金が有効なプロジェクトを明示して実行します。既存の別プロジェクトを推測して選択しません。Cloud Run、Cloud Build、Artifact Registry等の費用が発生する場合があります。実行者にはソースデプロイ・API有効化・サービスアカウント作成/利用・公開設定の権限、ビルド用アカウントには必要なCloud Run Builder権限が必要です。組織の公開禁止ポリシーは回避しません。

Cloud Shell等、認証済みの`gcloud`とNode.js 22がある環境で、変更を含むブランチを取得します。

```bash
git clone https://github.com/TroroOrosi/ImpressionableAptArtificialintelligence.git
cd ImpressionableAptArtificialintelligence
git checkout feat/chatgpt-headless-connection
bash scripts/deploy-cloud-run.sh YOUR_PROJECT_ID
```

既にマージ済みなら`git checkout main`を使います。標準リージョンは`asia-northeast1`、サービス名は`market-intel`です。別のものを使う場合:

```bash
bash scripts/deploy-cloud-run.sh YOUR_PROJECT_ID asia-northeast1 market-intel
```

スクリプトはAPI用Dockerfileでソースビルドし、専用ランタイムサービスアカウントで公開します。最小0・最大1インスタンスを設定し、公開された実URLを`PUBLIC_BASE_URL`へ設定してからMCP疎通テストを行います。エラー時は非ゼロ終了し、接続完了と表示しません。IAM不足は必要な権限だけをプロジェクト管理者が付与してください。ビルド用アカウントとランタイムアカウントは別です。

ローカルでAPIコンテナだけを確認する場合:

```bash
docker build --platform linux/amd64 -t market-intel .
docker run --rm -p 8080:8080 -e PUBLIC_BASE_URL=http://127.0.0.1:8080 market-intel
# 別ターミナル
node scripts/smoke-chatgpt.mjs http://127.0.0.1:8080
```

ローカルURLはChatGPTの公開接続先として登録しません。

## 2. 調査用の認証情報と履歴データベース

API鍵なしでもサーバーとMCP接続はテストできます。しかし設定されていないプロバイダーは無効のままで、価格取得成功を意味しません。対応プロバイダーと必要な鍵は従来の[SETUP_GUIDE.md](../SETUP_GUIDE.md)を参照してください。提供元の利用権限・利用規約が必要です。

鍵はGoogle Secret Managerなどに保存し、実値をGitHub、チャット、Dockerfile、コマンド履歴に入れないでください。既存Replitの鍵は自動移行しません。専用ランタイムアカウント`market-intel-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com`へ、使用するSecretごとのSecret Accessor権限だけを与えます。

既存Secretの参照をデプロイへ渡す例（右側はSecretリソース名であり、秘密の実値ではありません）:

```bash
export SECRET_BINDINGS='YAHOO_CLIENT_ID=market-yahoo-client-id:latest,DATABASE_URL=market-database-url:latest'
bash scripts/deploy-cloud-run.sh YOUR_PROJECT_ID
unset SECRET_BINDINGS
```

`SECRET_BINDINGS`の利用にはSecret Manager API有効化とSecretの事前作成が必要です。スクリプトは鍵やデータベースを勝手に作りません。

履歴・落札相場を永続保存するには、サーバーから到達できるPostgreSQLと`DATABASE_URL`を用意します。TLS等はデータベース提供元の接続指示に従ってください。**専用の新規データベース**で、プロジェクトの通常のスキーマ作成を実行します。

```bash
pnpm install --frozen-lockfile
# DATABASE_URLは安全に環境へ読み込む。実値をここへ直書きしない。
pnpm --filter @workspace/db push
```

既存データのあるDBへ確認なしの強制変更を行わないでください。接続成功とテーブル準備完了は別です。未設定時の`persistence_status: unavailable`は正常動作の証明ではなく、保存機能が使えないことを示します。

## 3. ChatGPTへ登録

2026-09-23に参照したOpenAI公式手順では、Settings → Security and login → Developer modeを有効化し、Pluginsの追加ボタンから接続を作成します。アカウント・ワークスペース方針で利用可否や表示が異なります。登録用操作をリポジトリのファイルだけで自動完了させることはできません。

名前は`Market Intel`、説明は「現在価格・成約根拠・鮮度を確認する読み取り専用の調査ツール」、接続URLはデプロイスクリプトが出力した**実際のHTTPS URLに`/api/mcp`を付けたもの**を使います。この実装の接続認証は公開読み取り専用です。提供元のAPIキーをChatGPT接続フォームへ入力しません。

一覧に10ツール（既存9ツールと`get_setup_bundle`）が表示されることを確認します。会話でこの接続を有効にし、以下を送ります。

> Market Intelのget_source_health、get_source_coverage、get_setup_bundleを実際に呼び出してください。利用できるソースと未設定のソースを区別し、返された接続URLを示してください。スケジュールはまだ変更しないでください。

この呼び出しの成功をもって通常会話からの接続を確認します。次に許可された実商品のURLで価格・通貨・取得時刻・状態を照合します。`UNVERIFIED`を正常な取得結果に読み替えないでください。ツール定義変更後はChatGPT側の接続を更新・再検出してください。

## 4. 既存スケジュールを安全に移行

既存タスクのID、名称、プロンプト、曜日/時刻、タイムゾーン、ジャンル、条件を先に保存します。標準14件/6件パックは新規利用者向けの参考テンプレートで、既存構成の代わりに作り直す用途ではありません。

通常会話からMCPが使えても、定期タスクに同じツールがあるとは限りません。対象の実行環境で接続済みMCP、または公開REST GETが利用可能かを確認します。URLをプロンプトへ書くだけではHTTP機能は追加されません。どちらも使えない場合は移行せず、その制限を明示します。

利用できることを確認した後、**同じIDの既存タスク**を更新し、接続先と接続失敗時の扱いだけを差し替えます。時間帯・ジャンル・固有判定条件は残します。新規タスクを増やさないため追加枠を消費しません。朝の通知時間を標準パックの時刻へ勝手に変更しません。

RESTの入口:

```text
GET /api/v1/public/source-health
GET /api/v1/public/source-coverage
GET /api/v1/public/setup-bundle
GET /api/v1/public/search-products?q=ENCODED_QUERY&limit=20
GET /api/v1/public/search-auctions?q=ENCODED_QUERY&limit=20
GET /api/v1/public/verify?url=ENCODED_PRODUCT_URL
GET /api/v1/public/price-history?identity=ENCODED_IDENTITY
GET /api/v1/public/sold-comps?q=ENCODED_QUERY&limit=20
GET /api/v1/public/compare?q=ENCODED_QUERY&limit=20
```

API全体ではなく、これらの公開GETが定期実行用です。URLパラメーターを必ずエンコードします。iCalのテンプレートを予定作成ツールへ渡す場合は、そのツールが受け付けるVEVENT形式へ変換し、Asia/Tokyoと既存時刻を確認してください。

## 調査上の前提と制限

30日以内の換金、総仕入50万円以内（10万円以内を優先）、全費用控除後利益1万円以上、ROI15%以上（20%以上を優先）は調査の目安です。売却・利益の保証や自動購入指示ではありません。小売店の希望価格を換金額として使わず、同条件の実成約・流動性を確認します。型番/JAN/地域版/容量/等級/鑑定番号/新品中古/状態/付属品が不明なものを確定候補にしません。

既存の価格検証エンジンとプロバイダーアダプターは引き継ぎます。価格の`actionable=true`だけでは新品状態、在庫、売却額、収益性の確認を完了できません。JSON-LDによる一般取得は特に不足項目が残るため、購入判断は別途必要です。取得失敗や未設定は推測で埋めません。

現在価格とMCP応答は`Cache-Control: no-store`です。MCPと公開GETに30回/分・500回/日のプロセス内制限がありますが、インスタンス再起動でリセットされ、分散制限や課金上限にはなりません。公開エンドポイントなので第三者も呼べます。有料ソースを有効化する前に提供元の利用上限・予算を設定し、機密データを扱う構成は公開せずOAuth等の認証を追加してください。

取得対象はtrusted-domain/SSRF検査を通る公開URLのみです。CAPTCHA・ログイン・robots・アンチボットを回避しません。出典に書かれた命令はツールやモデルへの指示として扱わないでください。

## 検証と参考仕様

```bash
node --experimental-strip-types --test tests/*.test.mjs
pnpm run typecheck:libs
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/api-server test
node scripts/smoke-chatgpt.mjs https://YOUR_ACTUAL_SERVICE_ORIGIN
```

GitHub Actionsは既存APIテスト、専用PostgreSQL、APIコンテナのビルドとHTTP/MCP疎通を検証します。CIの成功は各実行結果で確認してください。この文書だけを成功証拠にしません。

- OpenAI: https://developers.openai.com/plugins/deploy/connect-chatgpt
- MCP transport: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Cloud Run source deployment: https://docs.cloud.google.com/run/docs/deploying-source-code
- gcloud deploy: https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy
