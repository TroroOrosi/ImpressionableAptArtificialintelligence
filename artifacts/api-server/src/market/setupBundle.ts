export type ScheduleItem = { name: string; prompt: string; ical: string };

const safety = (baseUrl: string) =>
  `Market Intel MCP (${baseUrl}/api/mcp) と公開GET API (${baseUrl}/api/v1/public)を一次検証器として使う。` +
  "現在価格・通貨・fetched_at・verification status・source URLを必須表示する。" +
  "actionable=true かつ鮮度条件を満たす VERIFIED_STRONG/VERIFIED_SINGLE だけを候補にし、CONFLICT/STALE/UNVERIFIEDは除外する。" +
  "検索スニペットはDISCOVERY_ONLYで価格証拠にしない。手数料・送料・税を控除したROI、sold comps、流動性を確認し、欠損値を推測しない。";

const ical = (id: string, name: string, rule: string) =>
  `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Market Intel MCP//Schedule Pack//JA\nBEGIN:VEVENT\nUID:${id}@market-intel-mcp\nSUMMARY:${name}\nRRULE:${rule}\nEND:VEVENT\nEND:VCALENDAR`;

const task = (baseUrl: string, id: string, name: string, instruction: string, rule: string): ScheduleItem => ({
  name,
  prompt: `${safety(baseUrl)} ${instruction}`,
  ical: ical(id, name, rule),
});

export function buildSetupBundle(baseUrl: string) {
  const fullSchedulePack = [
    task(baseUrl,"ending-2h","終了2時間以内スキャン","終了2時間以内のオークションを検索し、終了30分以内は5分以内、10分以内は2分以内の観測で再検証する。","FREQ=HOURLY;INTERVAL=1"),
    task(baseUrl,"ending-12h","終了12時間以内スキャン","終了12時間以内の候補を広く収集し、入札上限と再確認時刻を提示する。","FREQ=DAILY;BYHOUR=7,13,19;BYMINUTE=0"),
    task(baseUrl,"c2c-gap","C2C価格差スキャン","Yahoo!オークション、メルカリ、ラクマ、Yahoo!フリマ間の同一商品だけを比較し、識別不一致を除外する。","FREQ=DAILY;BYHOUR=9,15,21;BYMINUTE=15"),
    task(baseUrl,"buyback-sale","固定買取・新品セール裁定スキャン","検証済み新品セール価格と公開された固定買取価格を比較し、全費用控除後の確定可能利益を算出する。","FREQ=DAILY;BYHOUR=10,18;BYMINUTE=0"),
    task(baseUrl,"morning-integration","朝の統合レポート","全監視結果を重複排除し、期待利益、ROI、sold comps、流動性、残り時間で保守的に順位付けする。","FREQ=DAILY;BYHOUR=8;BYMINUTE=0"),
    task(baseUrl,"daily-improvement","日次改善","当日の誤検知、競合、鮮度失敗、プロバイダー成功率、trusted-source registryの健全性と実測カバレッジを監査し、既存条件の改善案を出す。監査用の別タスクは作らない。","FREQ=DAILY;BYHOUR=22;BYMINUTE=0"),
    task(baseUrl,"yahoo-auctions","Yahoo!オークション重点監視","Yahoo!オークションの対象条件を検索し、現在価格、入札数、残り時間、同一性を検証する。","FREQ=DAILY;BYHOUR=11,17,20;BYMINUTE=30"),
    task(baseUrl,"mercari","メルカリ新着監視","メルカリの新着候補を検出し、即購入前に他市場価格とsold compsを再検証する。","FREQ=DAILY;BYHOUR=9,12,16,20;BYMINUTE=5"),
    task(baseUrl,"rakuma-fleamarket","ラクマ・Yahoo!フリマ監視","ラクマとYahoo!フリマの新着・値下げを確認し、C2C横断の価格差を検証する。","FREQ=DAILY;BYHOUR=10,14,19;BYMINUTE=20"),
    task(baseUrl,"ebay-crossborder","eBay越境価格差監視","eBayとの価格差を為替、国際送料、関税、販売手数料込みで保守的に計算する。","FREQ=DAILY;BYHOUR=6,18;BYMINUTE=45"),
    task(baseUrl,"retail-drop","新品小売価格下落監視","公式API優先で新品価格下落を検出し、在庫・型番・容量・色・地域版を照合する。","FREQ=DAILY;BYHOUR=7,12,18;BYMINUTE=10"),
    task(baseUrl,"sold-liquidity","落札相場・流動性再評価","監視対象のsold compsを正規化し、外れ値を避けた保守的価値と販売速度を更新する。","FREQ=DAILY;BYHOUR=16;BYMINUTE=0"),
    task(baseUrl,"collectibles","TCG・コイン監視","カード、コイン、鑑定品はgrade、cert company、cert number、editionを一致させて比較する。","FREQ=DAILY;BYHOUR=13;BYMINUTE=40"),
    task(baseUrl,"luxury","時計・宝飾・ブランド監視","時計、宝飾、ブランド品は型番、年式、付属品、鑑定情報、状態を厳格に照合する。","FREQ=DAILY;BYHOUR=14;BYMINUTE=30"),
  ];
  const coreNames = new Set(["終了2時間以内スキャン","終了12時間以内スキャン","C2C価格差スキャン","固定買取・新品セール裁定スキャン","朝の統合レポート","日次改善"]);
  const core6Pack = fullSchedulePack.filter((item) => coreNames.has(item.name));
  const chatgptSetupPrompt =
    `Remote MCP ${baseUrl}/api/mcp を接続し、このサービスを一次価格検証器として使用してください。` +
    `セットアップバンドル ${baseUrl}/api/v1/setup-bundle を取得し、Full Schedule Packの14件、または空き枠が少ない場合はCore 6 Packの6件を作成・更新してください。` +
    "同名タスクは重複作成せず更新してください。" + safety(baseUrl);
  const appReproductionPrompt =
    "Replitに日本語優先のMarket Intel MCPアプリを再作成してください。Provider Registry/Router、公式API優先アダプター、商品同一性、証拠投票、鮮度ポリシー、価格履歴、sold comps、source health、trusted-source coverage、公開read-only GET、Remote MCP、管理画面、14件Full Packと6件Core Packを実装してください。" +
    "価格を推測せず、検索スニペットはDISCOVERY_ONLY、未設定プロバイダーは安全に無効化し、認証情報はReplit Secretsだけで扱いレスポンスやログへ出さないでください。公開URLを実行時に全スケジュールへ自動挿入してください。";
  return {
    deployed_base_url: baseUrl,
    mcp_instructions: `ChatGPTのRemote MCP接続先に ${baseUrl}/api/mcp を登録します。認証情報はReplit Secretsだけに保存し、ChatGPTへ貼り付けません。`,
    automation_prompt: chatgptSetupPrompt,
    schedules: fullSchedulePack,
    full_schedule_pack: fullSchedulePack,
    core_6_pack: core6Pack,
    reproduction_prompt: appReproductionPrompt,
    app_reproduction_prompt: appReproductionPrompt,
    chatgpt_setup_prompt: chatgptSetupPrompt,
  };
}