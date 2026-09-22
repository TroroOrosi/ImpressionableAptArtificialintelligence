import React, { useState } from "react"
import { useGetPriceHistory, useGetSoldComps, getGetPriceHistoryQueryKey, getGetSoldCompsQueryKey } from "@workspace/api-client-react"
import { PageHeader, PageContent } from "@/components/layout/Shell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Search, Loader2 } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle } from "lucide-react"

const SOLD_COMP_MARKET_PRESETS = [
  { value: "EBAY_US", label: "eBay US" },
]
const SOLD_COMP_MARKET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export default function HistoryPage() {
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [market, setMarket] = useState("")
  const [submittedMarket, setSubmittedMarket] = useState("")
  const [activeTab, setActiveTab] = useState("sold-comps")

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const nextQuery = query.trim()
    const nextMarket = market.trim()
    if (!nextQuery || (nextMarket && !SOLD_COMP_MARKET_KEY_PATTERN.test(nextMarket))) return

    setSubmittedQuery(nextQuery)
    setSubmittedMarket(nextMarket)
  }

  const submittedMarketKey = submittedMarket || undefined
  const soldCompsParams = {
    q: submittedQuery,
    ...(submittedMarketKey ? { market: submittedMarketKey } : {}),
  }
  const marketKeyIsValid = !market.trim() || SOLD_COMP_MARKET_KEY_PATTERN.test(market.trim())

  const { data: compsData, isLoading: isLoadingComps } = useGetSoldComps(
    soldCompsParams,
    { query: { enabled: !!submittedQuery && activeTab === "sold-comps", queryKey: getGetSoldCompsQueryKey(soldCompsParams) } }
  )

  const { data: historyData, isLoading: isLoadingHistory } = useGetPriceHistory(
    { identity: submittedQuery },
    { query: { enabled: !!submittedQuery && activeTab === "price-history", queryKey: getGetPriceHistoryQueryKey({ identity: submittedQuery }) } }
  )

  return (
    <>
      <PageHeader 
        title="履歴・相場 (History & Comps)" 
        description="過去の販売実績と価格推移の調査" 
      />
      <PageContent className="space-y-6 max-w-5xl mx-auto">
        
        <Card className="bg-card">
          <CardContent className="p-6">
            <form onSubmit={handleSearch} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(14rem,0.4fr)_auto] md:items-end">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  aria-label="検索語"
                  placeholder="製品名、JANコード、または識別子を入力..." 
                  className="pl-9 bg-background"
                  data-testid="input-history-query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="history-market" className="text-sm font-medium">
                  市場キー (任意)
                </label>
                <Input
                  id="history-market"
                  aria-describedby="history-market-help"
                  aria-invalid={!marketKeyIsValid}
                  autoComplete="off"
                  data-testid="input-history-market"
                  list="history-market-options"
                  maxLength={64}
                  placeholder="例: EBAY_US"
                  value={market}
                  onChange={(e) => setMarket(e.target.value)}
                />
                <datalist id="history-market-options">
                  {SOLD_COMP_MARKET_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value} label={preset.label} />
                  ))}
                </datalist>
                <p id="history-market-help" className="text-xs text-muted-foreground">
                  プリセットから選ぶか入力。未入力なら全体設定を使用
                </p>
                {!marketKeyIsValid && (
                  <p className="text-xs text-destructive">
                    英数字、ハイフン、アンダースコア、ピリオドで入力してください
                  </p>
                )}
              </div>
              <Button
                type="submit"
                data-testid="button-history-search"
                disabled={!query.trim() || !marketKeyIsValid || isLoadingComps || isLoadingHistory}
              >
                {(isLoadingComps || isLoadingHistory) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                実績検索
              </Button>
            </form>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-[400px] grid-cols-2 mb-6">
            <TabsTrigger value="sold-comps">販売実績 (Sold Comps)</TabsTrigger>
            <TabsTrigger value="price-history">価格推移 (Price History)</TabsTrigger>
          </TabsList>

          <TabsContent value="sold-comps" className="mt-0 space-y-6">
            {submittedQuery && compsData && (
              <>
                {compsData.persistence_status === "unavailable" && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      保存済みの販売実績に一時的にアクセスできません。表示中の結果は今回取得できた情報源のデータです。
                    </AlertDescription>
                  </Alert>
                )}
                <Card className="border-dashed">
                  <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
                    <span className="font-medium">鮮度ポリシー</span>
                    <span data-testid="text-sold-comps-market" className="font-mono">
                      市場: {submittedMarket || "グローバル設定"}
                    </span>
                    <span className="text-muted-foreground">
                      有効期間:{" "}
                      <strong data-testid="text-sold-comps-freshness-window" className="font-medium text-foreground">
                        {compsData.freshness.recent_window_days}日
                      </strong>
                    </span>
                  </CardContent>
                </Card>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                  <CardContent className="p-6">
                    <p className="text-sm font-medium text-muted-foreground mb-1">保守的評価額</p>
                    <div className="text-2xl font-bold text-primary">
                      {compsData.conservative_value 
                        ? formatCurrency(compsData.conservative_value, "JPY") 
                        : "算出不可"}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-6">
                    <p className="text-sm font-medium text-muted-foreground mb-1">流動性 (Liquidity)</p>
                    <div className="text-2xl font-bold capitalize">
                      {compsData.liquidity}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-6">
                    <p className="text-sm font-medium text-muted-foreground mb-1">信頼度</p>
                    <div className="text-2xl font-bold tabular-nums">
                      {Math.round(compsData.confidence * 100)}%
                    </div>
                  </CardContent>
                </Card>
                </div>
              </>
            )}

            <Card>
              <CardHeader>
                <CardTitle>実績リスト</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>販売日時</TableHead>
                      <TableHead>商品名</TableHead>
                      <TableHead>状態</TableHead>
                      <TableHead className="text-right">販売価格</TableHead>
                      <TableHead>ソース</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoadingComps ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8">検索中...</TableCell></TableRow>
                    ) : !compsData?.comps?.length ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                        {compsData?.persistence_status === "unavailable"
                          ? "保存済みデータを一時的に利用できません"
                          : "実績が見つかりません"}
                      </TableCell></TableRow>
                    ) : (
                      compsData.comps.map((comp, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatDate(comp.sold_at)}
                          </TableCell>
                          <TableCell className="font-medium max-w-[300px] truncate" title={comp.title}>
                            <a href={comp.url} target="_blank" rel="noreferrer" className="hover:underline">{comp.title}</a>
                          </TableCell>
                          <TableCell>{comp.condition}</TableCell>
                          <TableCell className="text-right font-mono font-bold">
                            {formatCurrency(comp.sold_price, comp.currency)}
                          </TableCell>
                          <TableCell className="uppercase text-xs text-muted-foreground">
                            {comp.source}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="price-history" className="mt-0">
            <Card>
              <CardHeader>
                <CardTitle>価格観測履歴</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {historyData?.persistence_status === "unavailable" && (
                  <Alert variant="destructive" className="m-4">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      保存済みの価格履歴に一時的にアクセスできません。時間をおいて再試行してください。
                    </AlertDescription>
                  </Alert>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>観測日時</TableHead>
                      <TableHead>商品</TableHead>
                      <TableHead className="text-right">価格</TableHead>
                      <TableHead>ソース</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoadingHistory ? (
                      <TableRow><TableCell colSpan={4} className="text-center py-8">検索中...</TableCell></TableRow>
                    ) : !historyData?.observations?.length ? (
                      <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        {historyData?.persistence_status === "unavailable"
                          ? "保存済みデータを一時的に利用できません"
                          : "履歴が見つかりません"}
                      </TableCell></TableRow>
                    ) : (
                      historyData.observations.map((obs) => (
                        <TableRow key={obs.id}>
                          <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatDate(obs.fetched_at)}
                          </TableCell>
                          <TableCell className="font-medium max-w-[300px] truncate" title={obs.title}>
                            {obs.title}
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold">
                            {formatCurrency(obs.value, obs.currency)}
                          </TableCell>
                          <TableCell className="uppercase text-xs text-muted-foreground">
                            {obs.source}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

      </PageContent>
    </>
  )
}
