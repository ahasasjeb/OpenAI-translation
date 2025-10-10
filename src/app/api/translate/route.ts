import { NextResponse } from "next/server";
import OpenAI, { APIError } from "openai";

import { DEFAULT_MODEL, SUPPORTED_MODELS, type SupportedModel } from "@/config/models";
import { TRANSLATION_SYSTEM_PROMPT, buildTranslationPrompt } from "@/config/prompt";
import {
	DAILY_TOKEN_LIMIT,
	DailyQuotaExceededError,
	QuotaDisabledError,
	ensureQuotaAvailable,
	getQuotaDisabledReason,
	getQuotaStatus,
	incrementQuota,
	nextBeijingReset,
} from "@/lib/quotaStore";
import type { QuotaStatus } from "@/lib/quotaStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TranslatePayload {
	text: string;
	sourceLang?: string;
	targetLang?: string;
	model?: string;
	reasoningEffort?: string;
}

const BASE_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const GPT5_EXTRA_REASONING = ["minimal"] as const;
type ReasoningEffort = typeof BASE_REASONING_EFFORTS[number] | typeof GPT5_EXTRA_REASONING[number];

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
		if (error instanceof QuotaDisabledError) {
			console.error("Quota disabled when checking quota", error);
			return quotaDisabledResponse(error.message);
		}

		if (error instanceof DailyQuotaExceededError) {
			return await quotaExceededJson(now);
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

	const isGPT5Model = requestedModel.startsWith("gpt-5");
	const isGPT41Model = requestedModel.startsWith("gpt-4.1");
	const isO3Model = requestedModel.startsWith("o3-");
	const isO4Model = requestedModel.startsWith("o4-");
	const supportsReasoning = isGPT5Model || isGPT41Model || isO3Model || isO4Model;
	const allowedEfforts: ReasoningEffort[] = supportsReasoning
		? (isGPT5Model ? [...BASE_REASONING_EFFORTS, ...GPT5_EXTRA_REASONING] : [...BASE_REASONING_EFFORTS])
		: [];

	let reasoningEffort: ReasoningEffort | null = null;
	if (supportsReasoning) {
		const requestedEffort = (payload.reasoningEffort ?? "low") as ReasoningEffort;
		if (!allowedEfforts.includes(requestedEffort)) {
			return NextResponse.json({
				error: "invalid_reasoning_effort",
				message: `当前模型仅支持以下推理强度: ${allowedEfforts.join(", ")}`,
				supportedEfforts: allowedEfforts,
			}, { status: 400 });
		}
		reasoningEffort = requestedEffort;
	}

	const sourceLang = payload.sourceLang || "auto";
	const targetLang = payload.targetLang || "zh";
	const prompt = buildTranslationPrompt(text, sourceLang, targetLang);

	let responseStream: Awaited<ReturnType<ReturnType<typeof getOpenAIClient>["responses"]["stream"]>>;
	try {
		const openai = getOpenAIClient();
		const requestConfig: Parameters<typeof openai.responses.stream>[0] = {
			model: requestedModel,
			input: [
				{
					role: "system",
					content: TRANSLATION_SYSTEM_PROMPT,
				},
				{
					role: "user",
					content: prompt,
				},
			],
		};

		if (reasoningEffort) {
			requestConfig.reasoning = { effort: reasoningEffort, summary: null };
		}

		responseStream = await openai.responses.stream(requestConfig);
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

	const encoder = new TextEncoder();

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			const sendEvent = (type: string, data: unknown) => {
				const payload = `event: ${type}\n` + `data: ${JSON.stringify(data)}\n\n`;
				controller.enqueue(encoder.encode(payload));
			};

			let aggregated = "";
			const abortStream = (reason?: string) => {
				try {
					responseStream.controller.abort(reason);
				} catch {
					// ignore
				}
			};

			try {
				for await (const event of responseStream) {
					switch (event.type) {
						case "response.output_text.delta": {
							const delta = event.delta ?? "";
							if (delta) {
								aggregated += delta;
								sendEvent("delta", { delta });
							}
							break;
						}
						case "response.output_text.done": {
							break;
						}
						case "error": {
							const errorEvent = event as { error?: { message?: string }; message?: string };
							const message = errorEvent.error?.message ?? errorEvent.message ?? "调用 OpenAI API 失败";
							sendEvent("error", { code: "openai_error", message });
							abortStream(message);
							controller.close();
							return;
						}
						default: {
							break;
						}
					}
				}

				const finalResponse = await responseStream.finalResponse();
				const output = (aggregated || finalResponse.output_text || "").trim();
				if (!output) {
					sendEvent("error", {
						code: "empty_translation",
						message: "未能获取翻译结果，请稍后重试",
					});
					controller.close();
					return;
				}

				const tokensUsed = normaliseUsage(finalResponse.usage, text, output);
				try {
					const quota = await incrementQuota({
						tokens: tokensUsed,
						model: requestedModel,
						timestamp: new Date(),
					});

					sendEvent("final", {
						translation: output,
						quota: augmentQuota(quota),
						usage: {
							tokens: tokensUsed,
							limit: DAILY_TOKEN_LIMIT,
						},
						model: requestedModel,
						sourceLang,
						targetLang,
						quotaExceeded: quota.remaining <= 0,
					});
					controller.close();
					return;
				} catch (error) {
					if (error instanceof QuotaDisabledError) {
						console.error("Quota disabled when recording quota", error);
						sendEvent("error", {
							code: "quota_disabled",
							message: error.message,
						});
						controller.close();
						return;
					}

					if (error instanceof DailyQuotaExceededError) {
						const quota = await getQuotaStatus();
						sendEvent("error", {
							code: "quota_exceeded",
							message: "请等待下一次北京时间8点再来",
							quota: quota ? augmentQuota(quota) : null,
						});
						controller.close();
						return;
					}

					console.error("Failed to record quota", error);
					sendEvent("error", {
						code: "quota_persist_failed",
						message: "额度统计失败，请稍后再试",
					});
					controller.close();
				}
			} catch (error) {
				console.error("Unexpected streaming error", error);
				const message = error instanceof Error ? error.message : "翻译失败，请稍后再试";
				sendEvent("error", {
					code: "translation_failed",
					message,
				});
				controller.close();
			}
		},
	});

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
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

function augmentQuota(quota: QuotaStatus) {
	const resetAtBeijing = nextBeijingReset(new Date(quota.serverTime)).toISOString();
	return {
		...quota,
		resetAtBeijing,
	};
}

function quotaExceededResponse(quota: QuotaStatus) {
	const payload = {
		error: "quota_exceeded",
		message: "请等待下一次北京时间8点再来",
		quota: augmentQuota(quota),
	};

	return NextResponse.json(payload, { status: 429 });
}

async function quotaExceededJson(referenceDate?: Date) {
	const quota = await getQuotaStatus(referenceDate ?? new Date());
	if (!quota) {
		return quotaDisabledResponse(getQuotaDisabledReason() ?? "Redis 未配置");
	}
	return quotaExceededResponse(quota);
}

function quotaDisabledResponse(reason: string) {
	return NextResponse.json({
		error: "quota_disabled",
		message: reason,
	}, { status: 503 });
}
