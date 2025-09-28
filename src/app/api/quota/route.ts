import { NextResponse } from "next/server";

import { DEFAULT_MODEL, SUPPORTED_MODELS } from "@/config/models";
import { getQuotaStatus, nextBeijingReset } from "@/lib/quotaStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
	const quota = await getQuotaStatus();
	const resetAtBeijing = nextBeijingReset(new Date(quota.serverTime)).toISOString();

	return NextResponse.json({
		quota: {
			...quota,
			resetAtBeijing,
		},
		supportedModels: SUPPORTED_MODELS,
		defaultModel: DEFAULT_MODEL,
	});
}
