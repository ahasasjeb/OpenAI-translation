import { NextResponse } from "next/server";
import OpenAI, { APIError } from "openai";

import { DEFAULT_MODEL, SUPPORTED_MODELS, type SupportedModel } from "@/config/models";
import {
	DAILY_TOKEN_LIMIT,
	DailyQuotaExceededError,
	ensureQuotaAvailable,
	getQuotaStatus,
	getQuotaStorageKind,
	incrementQuota,
	nextBeijingReset,
} from "@/lib/quotaStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TranslatePayload {
	text: string;
	sourceLang?: string;
	targetLang?: string;
	model?: string;
}

const SYSTEM_PROMPT =
	"You are a world-class translation engine. Detect the source language when necessary, preserve original formatting, whitespace, and code blocks. Do not add explanations or commentary—only output the translated text.";

const globalForOpenAI = globalThis as unknown as {
	__openAI?: OpenAI;
};

function getOpenAIClient() {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is not configured");
	}

	if (!globalForOpenAI.__openAI) {
		globalForOpenAI.__openAI = new OpenAI({ apiKey });
	}

	return globalForOpenAI.__openAI;
}

export async function POST(request: Request) {
	const now = new Date();

	try {
		await ensureQuotaAvailable(now);
	} catch (error) {
		if (error instanceof DailyQuotaExceededError) {
			const quota = await getQuotaStatus(now);
			return quotaExceededResponse(quota);
		}
		console.error("Failed to read quota", error);
		return NextResponse.json({
			error: "quota_check_failed",
			message: "无法校验额度，请稍后再试",
		}, { status: 500 });
	}

	let payload: TranslatePayload;
	try {
		payload = await request.json();
	} catch {
		return NextResponse.json({
			error: "invalid_json",
			message: "请求体必须是JSON",
		}, { status: 400 });
	}

	const text = (payload.text ?? "").trim();
	if (!text) {
		return NextResponse.json({
			error: "empty_text",
			message: "请输入需要翻译的文本",
		}, { status: 400 });
	}

	const requestedModel = (payload.model ?? DEFAULT_MODEL) as SupportedModel;
	if (!SUPPORTED_MODELS.includes(requestedModel)) {
		return NextResponse.json({
			error: "unsupported_model",
			message: "当前仅支持 2.5M token 免费额度的模型",
			supportedModels: SUPPORTED_MODELS,
		}, { status: 400 });
	}

	const sourceLang = payload.sourceLang || "auto";
	const targetLang = payload.targetLang || "zh";

	let translation = "";
	let tokensUsed = 0;

	try {
		const openai = getOpenAIClient();
		const response = await openai.responses.create({
			model: requestedModel,
			input: [
				{
					role: "system",
					content: SYSTEM_PROMPT,
				},
				{
					role: "user",
					content: buildPrompt(text, sourceLang, targetLang),
				},
			],
		});

		translation = (response.output_text ?? "").trim();
		tokensUsed = normaliseUsage(response.usage, text, translation);
	} catch (error) {
		if (error instanceof APIError) {
			console.error("OpenAI API error", error.status, error.error);
			return NextResponse.json({
				error: "openai_error",
				message: error.error?.message ?? "调用 OpenAI API 失败",
			}, { status: error.status ?? 502 });
		}

		if (error instanceof Error && error.message.includes("OPENAI_API_KEY")) {
			console.error("Missing OPENAI_API_KEY", error);
			return NextResponse.json({
				error: "missing_api_key",
				message: "服务器未配置 OPENAI_API_KEY",
			}, { status: 500 });
		}

		console.error("Unexpected translation error", error);
		return NextResponse.json({
			error: "translation_failed",
			message: "翻译失败，请稍后再试",
		}, { status: 502 });
	}

	if (!translation) {
		return NextResponse.json({
			error: "empty_translation",
			message: "未能获取翻译结果，请稍后重试",
		}, { status: 502 });
	}

	try {
		const quota = await incrementQuota({
			tokens: tokensUsed,
			model: requestedModel,
			timestamp: new Date(),
		});

		if (quota.remaining <= 0) {
			return quotaExceededResponse(quota);
		}

		return NextResponse.json({
			data: {
				translation,
				quota: augmentQuota(quota),
				usage: {
					tokens: tokensUsed,
					limit: DAILY_TOKEN_LIMIT,
				},
				model: requestedModel,
				sourceLang,
				targetLang,
			},
			storage: getQuotaStorageKind(),
		});
	} catch (error) {
		if (error instanceof DailyQuotaExceededError) {
			const quota = await getQuotaStatus();
			return quotaExceededResponse(quota);
		}

		console.error("Failed to record quota", error);
		return NextResponse.json({
			error: "quota_persist_failed",
			message: "额度统计失败，请稍后再试",
		}, { status: 500 });
	}
}

function buildPrompt(text: string, source: string, target: string) {
	const sourceLabel = source === "auto" ? "auto-detect" : source;
	return [
		`Translate the following content from ${sourceLabel} to ${target}.`,
		"Maintain markdown formatting, numbers, punctuation, emoji, and code blocks.",
		"Keep the tone natural and faithful. Do not explain or wrap the answer with additional descriptions.",
		"<Text_Translate>",
		text,
        "/<Text_Translate>",
	].join("\n\n");
}

function normaliseUsage(
	usage: { total_tokens?: number | null; input_tokens?: number | null; output_tokens?: number | null } | null | undefined,
	sourceText: string,
	translatedText: string,
) {
	if (usage?.total_tokens && usage.total_tokens > 0) {
		return Math.round(usage.total_tokens);
	}

	const input = usage?.input_tokens ?? 0;
	const output = usage?.output_tokens ?? 0;
	if (input + output > 0) {
		return Math.round(input + output);
	}

	const estimated = Math.ceil(sourceText.length / 3) + Math.ceil(translatedText.length / 3);
	return Math.max(1, estimated);
}

function augmentQuota(quota: Awaited<ReturnType<typeof getQuotaStatus>>) {
	const resetAtBeijing = nextBeijingReset(new Date(quota.serverTime)).toISOString();
	return {
		...quota,
		resetAtBeijing,
	};
}

function quotaExceededResponse(quota: Awaited<ReturnType<typeof getQuotaStatus>>) {
	const payload = {
		error: "quota_exceeded",
		message: "请等待下一次北京时间8点再来",
		quota: augmentQuota(quota),
		storage: getQuotaStorageKind(),
	};

	return NextResponse.json(payload, { status: 429 });
}
