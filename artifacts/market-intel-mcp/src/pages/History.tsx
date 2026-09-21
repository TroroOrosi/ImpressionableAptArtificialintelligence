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

export default function HistoryPage() {
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [activeTab, setActiveTab] = useState("sold-comps")

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      setSubmittedQuery(query.trim())
    }
  }

  const { data: compsData, isLoading: isLoadingComps } = useGetSoldComps(
    { q: submittedQuery },
    { query: { enabled: !!submittedQuery && activeTab === "sold-comps", queryKey: getGetSoldCompsQueryKey({ q: submittedQuery }) } }
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
            <form onSubmit={handleSearch} className="flex gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="製品名、JANコード、または識別子を入力..." 
                  className="pl-9 bg-background"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={!query || isLoadingComps || isLoadingHistory}>
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
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">実績が見つかりません</TableCell></TableRow>
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
                    ) : !historyData?.length ? (
                      <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">履歴が見つかりません</TableCell></TableRow>
                    ) : (
                      historyData.map((obs) => (
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
