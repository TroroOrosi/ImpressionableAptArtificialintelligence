import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number, currency: string = "JPY"): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: currency,
    maximumFractionDigits: currency === "JPY" ? 0 : 2,
  }).format(value)
}

export function formatDate(dateString: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(dateString))
}

export function formatPercentage(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value)
}

export function formatRelativeTime(dateString: string): string {
  const rtf = new Intl.RelativeTimeFormat("ja-JP", { numeric: "auto" });
  const diffInMs = new Date(dateString).getTime() - Date.now();
  const diffInMinutes = Math.round(diffInMs / (1000 * 60));
  
  if (Math.abs(diffInMinutes) < 60) {
    return rtf.format(diffInMinutes, "minute");
  }
  
  const diffInHours = Math.round(diffInMinutes / 60);
  if (Math.abs(diffInHours) < 24) {
    return rtf.format(diffInHours, "hour");
  }
  
  const diffInDays = Math.round(diffInHours / 24);
  return rtf.format(diffInDays, "day");
}
