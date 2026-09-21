import React from "react"
import { Link, useLocation } from "wouter"
import { cn } from "@/lib/utils"
import {
  Activity,
  Search,
  CheckCircle2,
  Database,
  History,
  Settings,
  ShieldAlert
} from "lucide-react"

const NAV_ITEMS = [
  { href: "/", label: "概要 (Overview)", icon: Activity },
  { href: "/search", label: "検索 (Search)", icon: Search },
  { href: "/verify", label: "検証 (Verify)", icon: CheckCircle2 },
  { href: "/sources", label: "情報源 (Sources)", icon: Database },
  { href: "/history", label: "履歴 (History)", icon: History },
  { href: "/setup", label: "設定 (Setup)", icon: Settings },
]

export function Sidebar() {
  const [location] = useLocation()

  return (
    <div className="w-64 border-r bg-sidebar text-sidebar-foreground flex flex-col h-full">
      <div className="h-16 flex items-center px-6 border-b">
        <div className="flex items-center gap-2 text-primary">
          <ShieldAlert className="w-6 h-6" />
          <span className="font-bold text-lg tracking-tight">Market Intel</span>
        </div>
      </div>
      
      <div className="flex-1 py-6 px-3 space-y-1">
        <div className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Operations
        </div>
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.href
          const Icon = item.icon
          return (
            <Link 
              key={item.href} 
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors font-medium",
                isActive 
                  ? "bg-sidebar-accent text-sidebar-accent-foreground" 
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
              )}
            >
              <Icon className="w-4 h-4" />
              {item.label}
            </Link>
          )
        })}
      </div>
      
      <div className="p-4 border-t text-xs text-muted-foreground">
        <div className="font-mono">SYS.VER: 1.0.0-MCP</div>
        <div className="font-mono">STATUS: ACTIVE</div>
      </div>
    </div>
  )
}
