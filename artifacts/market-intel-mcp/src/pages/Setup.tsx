import React, { useState } from "react"
import { useGetSetupBundle } from "@workspace/api-client-react"
import { PageHeader, PageContent } from "@/components/layout/Shell"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, Copy, Check, Terminal, Calendar } from "lucide-react"

export default function SetupPage() {
  const { data: bundle, isLoading } = useGetSetupBundle()
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  if (isLoading) {
    return (
      <>
        <PageHeader title="MCP設定 (Setup)" />
        <PageContent className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </PageContent>
      </>
    )
  }

  return (
    <>
      <PageHeader 
        title="MCP設定 (Setup)" 
        description="ChatGPTへMarket Intel MCPを接続し、自動化を構成します" 
      />
      <PageContent className="space-y-8 max-w-4xl mx-auto">
        
        <Card className="border-primary/50 shadow-md">
          <CardHeader className="bg-primary/5 border-b border-primary/10 pb-4">
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-primary" />
              1. MCP接続手順
            </CardTitle>
            <CardDescription>ChatGPTデスクトップアプリの設定ファイルに以下を追加してください</CardDescription>
          </CardHeader>
          <CardContent className="pt-6 relative group">
            <div className="absolute right-8 top-8">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => bundle && copyToClipboard(bundle.mcp_instructions, 'mcp')}
                className="bg-background"
              >
                {copiedKey === 'mcp' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <pre className="bg-muted p-4 rounded-lg overflow-x-auto font-mono text-sm border">
              <code>{bundle?.mcp_instructions}</code>
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. ChatGPT接続・スケジュール作成プロンプト</CardTitle>
            <CardDescription>Remote MCPを接続し、14件またはCore 6件を重複なく作成・更新します</CardDescription>
          </CardHeader>
          <CardContent className="relative group">
            <div className="absolute right-6 top-6">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => bundle && copyToClipboard(bundle.chatgpt_setup_prompt, 'automation')}
                className="bg-background"
              >
                {copiedKey === 'automation' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <pre className="bg-muted p-4 rounded-lg overflow-x-auto font-mono text-sm border whitespace-pre-wrap">
              <code>{bundle?.chatgpt_setup_prompt}</code>
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Replitアプリ一括再現プロンプト</CardTitle>
            <CardDescription>他のユーザーが安全規則とスケジュールを含む環境全体を再作成できます</CardDescription>
          </CardHeader>
          <CardContent className="relative group">
            <div className="absolute right-6 top-6">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => bundle && copyToClipboard(bundle.app_reproduction_prompt, 'reproduction')}
                className="bg-background"
              >
                {copiedKey === 'reproduction' ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <pre className="bg-muted p-4 rounded-lg overflow-x-auto font-mono text-sm border whitespace-pre-wrap">
              <code>{bundle?.app_reproduction_prompt}</code>
            </pre>
          </CardContent>
        </Card>

        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
             Full Schedule Pack — 14タスク
          </h2>
          <div className="grid gap-4">
            {bundle?.full_schedule_pack.map((schedule, idx) => (
              <Card key={idx}>
                <CardHeader className="py-4">
                  <CardTitle className="text-base">{schedule.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-semibold uppercase text-muted-foreground">プロンプト</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(schedule.prompt, `prompt-${idx}`)}>
                        {copiedKey === `prompt-${idx}` ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                    <div className="bg-muted p-3 rounded text-sm font-mono">{schedule.prompt}</div>
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-semibold uppercase text-muted-foreground">iCal定義</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyToClipboard(schedule.ical, `ical-${idx}`)}>
                        {copiedKey === `ical-${idx}` ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                    <div className="bg-muted p-3 rounded text-sm font-mono whitespace-pre-wrap">{schedule.ical}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Core 6 Pack
          </h2>
          <p className="text-sm text-muted-foreground mb-4">タスク枠が少ないユーザー向けの必須6監視です。</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {bundle?.core_6_pack.map((schedule, idx) => (
              <Card key={schedule.name}>
                <CardHeader className="py-4">
                  <CardTitle className="text-base">{schedule.name}</CardTitle>
                  <CardDescription className="line-clamp-3">{schedule.prompt}</CardDescription>
                </CardHeader>
                <CardContent className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => copyToClipboard(schedule.prompt, `core-prompt-${idx}`)}>
                    {copiedKey === `core-prompt-${idx}` ? <Check className="h-4 w-4 mr-2 text-success" /> : <Copy className="h-4 w-4 mr-2" />}
                    プロンプト
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => copyToClipboard(schedule.ical, `core-ical-${idx}`)}>
                    {copiedKey === `core-ical-${idx}` ? <Check className="h-4 w-4 mr-2 text-success" /> : <Copy className="h-4 w-4 mr-2" />}
                    iCal
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

      </PageContent>
    </>
  )
}
