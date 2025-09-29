'use client';

import type { SupportedModel } from '@/config/models';
import { buildTranslationPrompt, TRANSLATION_SYSTEM_PROMPT } from '@/config/prompt';
import modelToEncoding from 'tiktoken/model_to_encoding.json';
import registryJson from 'tiktoken/registry.json';
import { init, Tiktoken } from 'tiktoken/lite/init';
import { load } from 'tiktoken/lite/load';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/tiktoken@1.0.22/lite/tiktoken_bg.wasm';
const MIN_RESPONSE_TOKENS = 64;
const RESPONSE_RATIO = 1.2;
const CHAT_MESSAGE_OVERHEAD = 12; // 粗略估算每条消息的ChatML固定token
const RESPONSE_OVERHEAD = 3;

type EncodingName = keyof typeof registryJson;
type RegistryEntry = Parameters<typeof load>[0];

const encoderCache = new Map<EncodingName, Tiktoken>();
let wasmInitPromise: Promise<void> | null = null;

async function ensureWasmReady() {
	if (!wasmInitPromise) {
		wasmInitPromise = init(async (imports) => {
			const response = await fetch(WASM_URL);
			if (!response.ok) {
				throw new Error(`加载 tiktoken WASM 失败: ${response.status}`);
			}
			const buffer = await response.arrayBuffer();
			return WebAssembly.instantiate(buffer, imports);
		}).then(() => undefined);
	}

	return wasmInitPromise;
}

async function getEncoder(model: SupportedModel) {
	await ensureWasmReady();
	const encodingName = ((modelToEncoding as Record<string, EncodingName>)[model] ?? 'o200k_base') as EncodingName;

	if (encoderCache.has(encodingName)) {
		return encoderCache.get(encodingName)!;
	}

	const registry = registryJson as Record<string, RegistryEntry>;
	const registryEntry = registry[encodingName];
	if (!registryEntry) {
		throw new Error(`暂不支持 ${encodingName} 编码`);
	}

	const { bpe_ranks, special_tokens, pat_str } = await load(registryEntry);
	const encoder = new Tiktoken(bpe_ranks, special_tokens, pat_str);
	encoderCache.set(encodingName, encoder);
	return encoder;
}

export type TokenEstimate = {
	systemTokens: number;
	promptTokens: number;
	sourceTokens: number;
	estimatedResponseTokens: number;
	totalTokens: number;
};

export async function estimateTranslationTokenUsage(params: {
	text: string;
	model: SupportedModel;
	sourceLang: string;
	targetLang: string;
}): Promise<TokenEstimate> {
	const trimmed = params.text.trim();
	if (!trimmed) {
		return {
			systemTokens: 0,
			promptTokens: 0,
			sourceTokens: 0,
			estimatedResponseTokens: 0,
			totalTokens: 0,
		};
	}

	const encoder = await getEncoder(params.model);
	const systemTokens = encoder.encode(TRANSLATION_SYSTEM_PROMPT).length + CHAT_MESSAGE_OVERHEAD;
	const promptBody = buildTranslationPrompt(trimmed, params.sourceLang, params.targetLang);
	const promptTokens = encoder.encode(promptBody).length + CHAT_MESSAGE_OVERHEAD;
	const sourceTokens = encoder.encode(trimmed).length;
	const estimatedResponseTokens = Math.max(
		MIN_RESPONSE_TOKENS,
		Math.round(sourceTokens * RESPONSE_RATIO),
		sourceTokens,
	) + RESPONSE_OVERHEAD;

	const totalTokens = systemTokens + promptTokens + estimatedResponseTokens;

	return {
		systemTokens,
		promptTokens,
		sourceTokens,
		estimatedResponseTokens,
		totalTokens,
	};
}

export function fallbackCharacterEstimate(text: string) {
	return Math.max(0, Math.ceil(text.trim().length / 3));
}
