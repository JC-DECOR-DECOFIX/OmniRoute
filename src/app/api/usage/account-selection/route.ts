import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildAccountSelectionReport } from "@/sse/services/accountSelectionReport";

const QuerySchema = z.object({
  provider: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .default("claude"),
});

/** EARLIEST_QUOTA_RENEWAL_FIRST: per-account ranking, pins and failovers (credential-free). */
export async function GET(request: Request) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      provider: url.searchParams.get("provider") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    const report = await buildAccountSelectionReport(parsed.data.provider);
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(
      "[API ERROR] /api/usage/account-selection failed:",
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json(
      { error: "Failed to build account selection report" },
      { status: 500 }
    );
  }
}
