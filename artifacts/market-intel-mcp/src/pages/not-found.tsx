import { useLocation } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="flex flex-col items-center justify-center min-h-full bg-background p-4 text-center">
      <AlertCircle className="h-12 w-12 text-destructive mb-4" />
      <h1 className="text-4xl font-bold text-foreground tracking-tight mb-2">404</h1>
      <p className="text-lg text-muted-foreground mb-6">お探しのページは見つかりませんでした。</p>
      <Button onClick={() => setLocation("/")}>ダッシュボードへ戻る</Button>
    </div>
  );
}
