import React from "react"
import { useGetSourceHealth, useGetSourceCoverage } from "@workspace/api-client-react"
import { PageHeader, PageContent } from "@/components/layout/Shell"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertCircle, Database, Activity } from "lucide-react"
import { formatPercentage } from "@/lib/utils"

export default function SourcesPage() {
  const { data: healthData, isLoading: isLoadingHealth } = useGetSourceHealth()
  const { data: coverageData, isLoading: isLoadingCoverage } = useGetSourceCoverage()

  return (
    <>
      <PageHeader 
        title="情報源の健全性 (Source Health)" 
        description="プロバイダーのステータスとレジストリカバレッジ状況" 
      />
      <PageContent className="space-y-8">
        
        {/* Coverage Overview */}
        <section>
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            レジストリカバレッジ
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-6">
                <p className="text-sm font-medium text-muted-foreground mb-1">網羅率</p>
                <div className="text-3xl font-bold text-primary">
                  {isLoadingCoverage ? "-" : formatPercentage((coverageData?.measured_coverage_percent || 0) / 100)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <p className="text-sm font-medium text-muted-foreground mb-1">レジストリサイズ</p>
                <div className="text-3xl font-bold">
                  {isLoadingCoverage ? "-" : coverageData?.registry_size.toLocaleString("ja-JP")}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <p className="text-sm font-medium text-muted-foreground mb-1">検索可能ソース数</p>
                <div className="text-3xl font-bold">
                  {isLoadingCoverage ? "-" : coverageData?.searchable_count}
                </div>
              </CardContent>
            </Card>
          </div>
          {coverageData?.disclaimer && (
            <p className="text-xs text-muted-foreground mt-3 bg-muted p-2 rounded inline-block">
              * {coverageData.disclaimer}
            </p>
          )}
        </section>

        {/* Source Health Table */}
        <section>
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            プロバイダーヘルス
          </h2>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>プロバイダー</TableHead>
                    <TableHead>状態</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead className="text-right">成功率</TableHead>
                    <TableHead className="text-right">レイテンシ</TableHead>
                    <TableHead className="text-right">エラー数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoadingHealth ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8">Loading...</TableCell></TableRow>
                  ) : healthData?.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8">データがありません</TableCell></TableRow>
                  ) : (
                    healthData?.map((source) => (
                      <TableRow key={source.id}>
                        <TableCell className="font-medium">
                          {source.label}
                          {!source.configured && <Badge variant="outline" className="ml-2 text-[10px]">未設定</Badge>}
                        </TableCell>
                        <TableCell>
                          {source.available ? (
                            <div className="flex items-center text-success text-sm font-medium">
                              <CheckCircle2 className="w-4 h-4 mr-1" /> 正常稼働
                            </div>
                          ) : (
                            <div className="flex items-center text-destructive text-sm font-medium">
                              <AlertCircle className="w-4 h-4 mr-1" /> 障害・停止
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="font-mono">Tier {source.tier}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatPercentage(source.success_rate)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {source.latency_ms} ms
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {source.consecutive_failures > 0 ? (
                            <span className="text-destructive font-bold">{source.consecutive_failures}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

      </PageContent>
    </>
  )
}
