import React from "react"
import { 
  useGetAdminSummary, 
  useListConflicts, 
  useListObservations 
} from "@workspace/api-client-react"
import { PageHeader, PageContent } from "@/components/layout/Shell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCurrency, formatPercentage, formatRelativeTime } from "@/lib/utils"
import { StatusBadge, ConfidenceBar, ActionableBadge } from "@/components/shared/domain-ui"
import { ShieldAlert, Database, Clock, Activity, AlertTriangle } from "lucide-react"

export default function Home() {
  const { data: summary, isLoading: isLoadingSummary } = useGetAdminSummary()
  const { data: conflicts, isLoading: isLoadingConflicts } = useListConflicts()
  const { data: observations, isLoading: isLoadingObservations } = useListObservations()

  return (
    <>
      <PageHeader 
        title="概要 (Dashboard)" 
        description="システム全体の健全性と最近のデータ推移" 
      />
      <PageContent className="space-y-6">
        
        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-muted-foreground">情報源稼働率</p>
                <Database className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-2xl font-bold">
                {isLoadingSummary ? "-" : `${summary?.providers_available} / ${summary?.providers_total}`}
              </div>
              <p className="text-xs text-muted-foreground mt-1">アクティブなプロバイダー</p>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-muted-foreground">レジストリカバレッジ</p>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-2xl font-bold">
                {isLoadingSummary ? "-" : formatPercentage((summary?.registry_coverage_percent || 0) / 100)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">信頼できるデータ源網羅率</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-destructive">24時間 データ競合</p>
                <ShieldAlert className="h-4 w-4 text-destructive" />
              </div>
              <div className="text-2xl font-bold text-destructive">
                {isLoadingSummary ? "-" : summary?.conflicts_24h}
              </div>
              <p className="text-xs text-muted-foreground mt-1">要確認のアラート</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-warning">24時間 データ鮮度警告</p>
                <Clock className="h-4 w-4 text-warning" />
              </div>
              <div className="text-2xl font-bold text-warning">
                {isLoadingSummary ? "-" : summary?.stale_24h}
              </div>
              <p className="text-xs text-muted-foreground mt-1">再取得が推奨されます</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Conflicts Table */}
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-destructive" />
                最新のデータ競合
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>状態</TableHead>
                    <TableHead>理由</TableHead>
                    <TableHead>確認時刻</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoadingConflicts ? (
                    <TableRow><TableCell colSpan={3} className="text-center">Loading...</TableCell></TableRow>
                  ) : conflicts?.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">競合はありません</TableCell></TableRow>
                  ) : (
                    conflicts?.slice(0, 5).map((conflict, i) => (
                      <TableRow key={i}>
                        <TableCell><StatusBadge status={conflict.status} /></TableCell>
                        <TableCell className="max-w-[200px] truncate" title={conflict.reason}>{conflict.reason}</TableCell>
                        <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatRelativeTime(conflict.checked_at)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Observations Table */}
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                最新の観測データ
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>商品</TableHead>
                    <TableHead>価格</TableHead>
                    <TableHead>信頼度</TableHead>
                    <TableHead>ソース</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoadingObservations ? (
                    <TableRow><TableCell colSpan={4} className="text-center">Loading...</TableCell></TableRow>
                  ) : observations?.length === 0 ? (
                    <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">データがありません</TableCell></TableRow>
                  ) : (
                    observations?.slice(0, 5).map((obs) => (
                      <TableRow key={obs.id}>
                        <TableCell className="font-medium max-w-[200px] truncate" title={obs.title}>{obs.title}</TableCell>
                        <TableCell className="font-mono">{formatCurrency(obs.value, obs.currency)}</TableCell>
                        <TableCell><ConfidenceBar confidence={obs.confidence} /></TableCell>
                        <TableCell className="text-muted-foreground text-xs uppercase">{obs.source}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

      </PageContent>
    </>
  )
}
