import React, { useState } from "react"
import { useVerifyCurrentPrice, getVerifyCurrentPriceQueryKey } from "@workspace/api-client-react"
import { PageHeader, PageContent } from "@/components/layout/Shell"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { LinkIcon, Loader2, ShieldAlert } from "lucide-react"
import { formatCurrency, formatRelativeTime } from "@/lib/utils"
import { StatusBadge, ActionableBadge, ConfidenceBar } from "@/components/shared/domain-ui"

export default function VerifyPage() {
  const [url, setUrl] = useState("")
  const [submittedUrl, setSubmittedUrl] = useState("")

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault()
    if (url.trim()) {
      setSubmittedUrl(url.trim())
    }
  }

  const { data: result, isLoading, isError, error } = useVerifyCurrentPrice(
    { url: submittedUrl },
    { query: { enabled: !!submittedUrl, retry: false, queryKey: getVerifyCurrentPriceQueryKey({ url: submittedUrl }) } }
  )

  return (
    <>
      <PageHeader 
        title="URL検証 (URL Verification)" 
        description="対象URLの価格と状態を検証し、証拠を取得します" 
      />
      <PageContent className="space-y-6 max-w-4xl mx-auto">
        <Card>
          <CardContent className="p-6">
            <form onSubmit={handleVerify} className="flex gap-4">
              <div className="flex-1 relative">
                <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="https://example.com/product/123" 
                  className="pl-9 font-mono"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={!url || isLoading}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                検証開始
              </Button>
            </form>
          </CardContent>
        </Card>

        {isError && (
          <div className="p-4 border border-destructive/50 bg-destructive/10 text-destructive rounded-lg flex items-center gap-3">
            <ShieldAlert className="h-5 w-5" />
            <div>
              <p className="font-semibold">検証に失敗しました</p>
              <p className="text-sm opacity-80">URLが有効でないか、サポートされていないプロバイダーです。</p>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <StatusBadge status={result.status} />
                <ActionableBadge actionable={result.actionable} />
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                確認時刻: {formatRelativeTime(result.checked_at)}
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>検証結果サマリー</CardTitle>
                <CardDescription>システムの判定理由とメタデータ</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-medium">{result.reason}</p>
              </CardContent>
            </Card>

            <h3 className="text-lg font-bold mt-8 mb-4 border-b pb-2">証拠データ ({result.observations.length}件)</h3>
            <div className="space-y-4">
              {result.observations.map((obs) => (
                <Card key={obs.id} className="overflow-hidden">
                  <div className="border-l-4 border-primary p-6 bg-card">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="secondary" className="uppercase font-mono text-[10px]">{obs.source}</Badge>
                          <span className="text-xs text-muted-foreground">Tier {obs.source_tier}</span>
                        </div>
                        <h4 className="font-semibold text-base mb-2">{obs.title}</h4>
                        <div className="flex items-center gap-6 mt-4">
                          <div>
                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">価格</p>
                            <p className="font-mono font-bold text-xl">{formatCurrency(obs.value, obs.currency)}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">信頼度</p>
                            <ConfidenceBar confidence={obs.confidence} />
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">鮮度</p>
                            <p className="font-mono text-sm">{obs.freshness_seconds}秒前</p>
                          </div>
                        </div>
                      </div>
                      
                      <div className="text-right flex flex-col items-end gap-2">
                        <Button variant="outline" size="sm" asChild>
                          <a href={obs.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                            <LinkIcon className="h-3 w-3" /> 元ソース
                          </a>
                        </Button>
                        <div className="text-xs text-muted-foreground font-mono bg-muted px-2 py-1 rounded">
                          HASH: {obs.evidence_hash.substring(0, 8)}...
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}
      </PageContent>
    </>
  )
}
