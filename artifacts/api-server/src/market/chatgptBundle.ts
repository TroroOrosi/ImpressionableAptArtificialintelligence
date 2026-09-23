type Schedule = { name: string; prompt: string; ical: string };
type LegacyBundle = { schedules: Schedule[]; full_schedule_pack: Schedule[]; core_6_pack: Schedule[]; [key: string]: unknown };

/** This describes connection steps; it cannot register an app or change ChatGPT tasks. */
export function buildChatgptBundle(baseUrl: string, legacy: LegacyBundle) {
  const policy = "30日以内の換金を目標とする調査。総仕入額は500,000円以内、100,000円以内を優先。全費用控除後利益10,000円以上、ROI15%以上（20%以上を優先）を目安とし、利益や売却を保証しない。新品/中古、型番、JAN、地域版、等級、鑑定番号、状態、付属品を区別する。小売希望価格ではなく同条件の実成約と流動性を確認する。価格がVERIFIEDでも購入許可ではない。条件・在庫・換金額が未確認なら見送る。CONFLICT/STALE/UNVERIFIEDを候補にせず、欠損値を推測しない。";
  const transport = `接続済みMCP ${baseUrl}/api/mcp を使用する。定期実行環境にMCPがなければ、HTTP取得が実際に利用できる場合だけ公開GET ${baseUrl}/api/v1/public を使用する。どちらも使えなければ接続未確認と報告し、取得済みを装わない。`;
  const decorate = (items: Schedule[]) => items.map(item => ({ ...item, prompt: `${item.prompt} ${transport} ${policy}` }));
  const setup = `${transport} まずget_source_health/get_source_coverage/get_setup_bundleを呼び、実際の利用可否を示す。既存スケジュールはID・名称・時刻・タイムゾーン・ジャンル・固有条件を維持し、標準パックで上書きしない。接続先変更前に旧設定を保存し、新URLの疎通と定期実行環境のHTTP取得を確認する。14件のFull Packと6件のCore Packは新規利用者向けテンプレートであり、自動作成・自動置換しない。 ${policy}`;
  const reproduction = "GitHub上のこのリポジトリを基にAPIだけをCloud Run等へデプロイする。UI・Replitサービスは必須にしない。認証情報はホスティング先のSecretストアで管理する（既存Replit利用者はReplit Secretsを利用できる）。取得時刻・出典・商品同一性・実成約・欠損を保持し、HTTP/MCP疎通、ChatGPTへの登録、定期実行からの利用をそれぞれ検証する。";
  return {
    ...legacy,
    deployed_base_url: baseUrl,
    connection: {
      mcp_url: `${baseUrl}/api/mcp`,
      rest_base_url: `${baseUrl}/api/v1/public`,
      setup_url: `${baseUrl}/api/v1/public/setup-bundle`,
      health_url: `${baseUrl}/api/healthz`,
      transport: "streamable-http-json",
      authentication: "public_read_only",
      chatgpt_registration: "NOT_VERIFIED",
      scheduled_http_access: "NOT_VERIFIED",
    },
    schedule_migration: {
      mode: "preserve_existing", auto_create: false, timezone: "Asia/Tokyo",
      preserve: ["id", "name", "schedule", "timezone", "category", "research_conditions"],
      prerequisites: ["backup_existing_tasks", "new_endpoint_smoke_passed", "scheduled_http_access_verified"],
    },
    research_policy: policy,
    mcp_instructions: `ChatGPTのカスタムMCP接続先へ ${baseUrl}/api/mcp を登録する。URLを書くだけでは登録されない。提供元APIの認証情報をチャットへ貼り付けない。`,
    schedules: decorate(legacy.schedules),
    full_schedule_pack: decorate(legacy.full_schedule_pack),
    core_6_pack: decorate(legacy.core_6_pack),
    automation_prompt: setup,
    chatgpt_setup_prompt: setup,
    reproduction_prompt: reproduction,
    app_reproduction_prompt: reproduction,
  };
}
