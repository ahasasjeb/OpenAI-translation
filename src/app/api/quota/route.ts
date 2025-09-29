import { NextResponse } from "next/server";

import { DEFAULT_MODEL, SUPPORTED_MODELS } from "@/config/models";
import { getQuotaDisabledReason, getQuotaStatus, nextBeijingReset } from "@/lib/quotaStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
	const quota = await getQuotaStatus();
	if (!quota) {
		return NextResponse.json({
			enabled: false,
			message: getQuotaDisabledReason() ?? "Redis 未配置",
			supportedModels: SUPPORTED_MODELS,
			defaultModel: DEFAULT_MODEL,
		});
	}

	const resetAtBeijing = nextBeijingReset(new Date(quota.serverTime)).toISOString();

	return NextResponse.json({
		enabled: true,
		quota: {
			...quota,
			resetAtBeijing,
		},
		supportedModels: SUPPORTED_MODELS,
		defaultModel: DEFAULT_MODEL,
	});
}
