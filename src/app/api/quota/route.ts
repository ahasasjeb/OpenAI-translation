import { NextResponse } from "next/server";

import { DEFAULT_MODEL, SUPPORTED_MODELS } from "@/config/models";
import { RedisUnavailableError, getQuotaStatus, nextBeijingReset } from "@/lib/quotaStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
	try {
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
	} catch (error) {
		if (error instanceof RedisUnavailableError) {
			console.error("Redis unavailable when fetching quota", error);
			return NextResponse.json({
				error: "redis_unavailable",
				message: error.message,
			}, { status: 503 });
		}

		console.error("Failed to read quota", error);
		return NextResponse.json({
			error: "quota_read_failed",
			message: "无法读取额度，请稍后再试",
		}, { status: 500 });
	}
}
