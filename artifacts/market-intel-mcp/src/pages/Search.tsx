import React, { useState, useRef, useCallback } from "react"
import { useSearchProducts, useSearchAuctions, useCompareOffers, getSearchProductsQueryKey, getSearchAuctionsQueryKey, getCompareOffersQueryKey } from "@workspace/api-client-react"
import { PageHeader, PageContent } from "@/components/layout/Shell"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Search, Loader2 } from "lucide-react"
import { formatCurrency, formatRelativeTime } from "@/lib/utils"
import { StatusBadge, ActionableBadge } from "@/components/shared/domain-ui"

export default function SearchPage() {
  const [query, setQuery] = useState("")
  const [activeTab, setActiveTab] = useState("products")
  
  // Only search when explicit submit
  const [submittedQuery, setSubmittedQuery] = useState("")
  
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim().length >= 2) {
      setSubmittedQuery(query.trim())
    }
  }

  const { data: productsData, isLoading: isLoadingProducts } = useSearchProducts(
    { q: submittedQuery },
    { query: { enabled: !!submittedQuery && activeTab === "products", queryKey: getSearchProductsQueryKey({ q: submittedQuery }) } }
  )

  const { data: auctionsData, isLoading: isLoadingAuctions } = useSearchAuctions(
    { q: submittedQuery },
    { query: { enabled: !!submittedQuery && activeTab === "auctions", queryKey: getSearchAuctionsQueryKey({ q: submittedQuery }) } }
  )

  const { data: compareData, isLoading: isLoadingCompare } = useCompareOffers(
    { q: submittedQuery },
    { query: { enabled: !!submittedQuery && activeTab === "compare", queryKey: getCompareOffersQueryKey({ q: submittedQuery }) } }
  )

  const currentData = activeTab === "products" ? productsData : activeTab === "auctions" ? auctionsData : compareData
  const isLoading = activeTab === "products" ? isLoadingProducts : activeTab === "auctions" ? isLoadingAuctions : isLoadingCompare

  return (
    <>
      <PageHeader 
        title="市場検索 (Market Search)" 
        description="製品カタログ、オークション、およびオファーの横断検索" 
      />
      <PageContent className="space-y-6">
        <Card className="bg-card">
          <CardContent className="p-6">
            <form onSubmit={handleSearch} className="flex gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="JANコード、型番、または製品名を入力..." 
                  className="pl-9 bg-background"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={query.length < 2 || isLoading}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                検索実行
              </Button>
            </form>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full justify-start rounded-none border-b bg-transparent p-0 mb-6">
            <TabsTrigger value="products" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent shadow-none px-6 py-2">
              製品 (Products)
            </TabsTrigger>
            <TabsTrigger value="auctions" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent shadow-none px-6 py-2">
              オークション (Auctions)
            </TabsTrigger>
            <TabsTrigger value="compare" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent shadow-none px-6 py-2">
              比較 (Compare)
            </TabsTrigger>
          </TabsList>

          <TabsContent value={activeTab} className="mt-0">
            {submittedQuery ? (
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[100px]">ステータス</TableHead>
                        <TableHead>アクション</TableHead>
                        <TableHead>詳細</TableHead>
                        <TableHead>観測数</TableHead>
                        <TableHead>確認時刻</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {isLoading ? (
                        <TableRow><TableCell colSpan={5} className="text-center py-12 text-muted-foreground">検索中...</TableCell></TableRow>
                      ) : !currentData?.results?.length ? (
                        <TableRow><TableCell colSpan={5} className="text-center py-12 text-muted-foreground">「{submittedQuery}」に一致する結果は見つかりませんでした。</TableCell></TableRow>
                      ) : (
                        currentData.results.map((result, idx) => (
                          <TableRow key={idx}>
                            <TableCell><StatusBadge status={result.status} /></TableCell>
                            <TableCell><ActionableBadge actionable={result.actionable} /></TableCell>
                            <TableCell className="max-w-[300px]">
                              <div className="truncate font-medium" title={result.reason}>{result.reason}</div>
                              {result.observations.length > 0 && (
                                <div className="text-xs text-muted-foreground mt-1 truncate">
                                  Top: {result.observations[0]?.title} - {formatCurrency(result.observations[0]?.value, result.observations[0]?.currency)}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="font-mono">{result.observations.length}</TableCell>
                            <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">
                              {formatRelativeTime(result.checked_at)}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 text-muted-foreground border border-dashed rounded-lg bg-card/50">
                <Search className="h-12 w-12 mb-4 text-muted-foreground/50" />
                <p>上部の検索バーから検索を開始してください</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PageContent>
    </>
  )
}
