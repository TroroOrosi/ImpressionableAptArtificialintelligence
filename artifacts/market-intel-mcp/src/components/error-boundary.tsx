import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children?: ReactNode;
  resetKey?: any;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] w-full p-6 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive mb-4" />
          <h2 className="text-xl font-bold mb-2">システムエラーが発生しました</h2>
          <p className="text-muted-foreground mb-6 max-w-md">
            {this.state.error?.message || "予期せぬエラーが発生しました。"}
          </p>
          <Button onClick={() => this.setState({ hasError: false, error: null })}>
            再試行
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
