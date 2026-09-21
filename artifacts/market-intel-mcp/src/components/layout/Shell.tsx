import React, { ReactNode } from "react"
import { Sidebar } from "./Sidebar"
import { cn } from "@/lib/utils"


interface ShellProps {
  children: ReactNode
}

export function Shell({ children }: ShellProps) {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden selection:bg-primary/20">
      <Sidebar />
      <main className="flex-1 overflow-auto flex flex-col">
        {children}
      </main>
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: string, description?: string, actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between px-8 py-6 border-b bg-card">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {actions && (
        <div className="flex items-center gap-3">
          {actions}
        </div>
      )}
    </div>
  )
}

export function PageContent({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <div className={cn("flex-1 p-8", className)}>
      {children}
    </div>
  )
}

