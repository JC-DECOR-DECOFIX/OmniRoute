import type { ProviderConnectionView } from "@/lib/db/providers/lazyConnectionView";

export function isTerminalConnectionStatus(
  connection: Partial<Pick<ProviderConnectionView, "testStatus">>
): boolean {
  const status = (connection.testStatus || "").trim().toLowerCase();
  return status === "credits_exhausted" || status === "banned" || status === "expired";
}
