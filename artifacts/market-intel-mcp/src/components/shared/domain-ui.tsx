import React from "react"
import type { VerificationResultStatus } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"

export function StatusBadge({ status }: { status: VerificationResultStatus }) {
  switch (status) {
    case "VERIFIED_STRONG":
      return <Badge variant="success">強力な検証済</Badge> // VERIFIED_STRONG
    case "VERIFIED_SINGLE":
      return <Badge variant="default">単一検証済</Badge> // VERIFIED_SINGLE
    case "CONFLICT":
      return <Badge variant="destructive">競合</Badge> // CONFLICT
    case "STALE":
      return <Badge variant="warning">データ古</Badge> // STALE
    case "UNVERIFIED":
    default:
      return <Badge variant="secondary">未検証</Badge> // UNVERIFIED
  }
}

export function ActionableBadge({ actionable }: { actionable?: boolean }) {
  if (actionable) {
    return <Badge variant="outline" className="border-success text-success">取引可能</Badge> // Actionable
  }
  return <Badge variant="outline" className="border-muted-foreground text-muted-foreground">監視のみ</Badge> // Monitor only
}

export function ConfidenceBar({ confidence }: { confidence: number }) {
  const percentage = Math.round(confidence * 100);
  const color = 
    percentage >= 80 ? "bg-success" : 
    percentage >= 50 ? "bg-warning" : 
    "bg-destructive";

  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8">{percentage}%</span>
    </div>
  )
}
