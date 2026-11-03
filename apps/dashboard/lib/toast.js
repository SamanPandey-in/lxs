import { toast as sonner } from "sonner";

// toast(msg, kind) over sonner. kind: 'success' | 'error' | 'info' | 'warning'
export function toast(msg, kind = "success", description) {
  const fn = typeof sonner[kind] === "function" ? sonner[kind] : sonner;
  return fn(msg, description ? { description } : undefined);
}
