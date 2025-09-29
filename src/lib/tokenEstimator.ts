'use client';

import type { SupportedModel } from '@/config/models';
import { buildTranslationPrompt, TRANSLATION_SYSTEM_PROMPT } from '@/config/prompt';
import modelToEncoding from 'tiktoken/model_to_encoding.json';
import { init, Tiktoken } from 'tiktoken/lite/init';
import { load } from 'tiktoken/lite/load';

const WASM_URL = '/tiktoken_bg.wasm';
const MIN_RESPONSE_TOKENS = 64;
const RESPONSE_RATIO = 1.2;
const CHAT_MESSAGE_OVERHEAD = 12; // 粗略估算每条消息的ChatML固定token
const RESPONSE_OVERHEAD = 3;

type RegistryEntry = Parameters<typeof load>[0];

const ENCODING_REGISTRY: Record<string, RegistryEntry> = {
	o200k_base: {
		load_tiktoken_bpe: '/o200k_base.tiktoken',
		special_tokens: {
			'<|endoftext|>': 199999,
			'<|endofprompt|>': 200018,
		},
		pat_str: "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+",
	},
};

const encoderCache = new Map<string, Tiktoken>();
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
	const encodingName = (modelToEncoding as Record<string, string>)[model] ?? 'o200k_base';

	if (encoderCache.has(encodingName)) {
		return encoderCache.get(encodingName)!;
	}

	// 使用本地覆盖的配置，如果存在的话
	const registryEntry = ENCODING_REGISTRY[encodingName];
	if (!registryEntry) {
		throw new Error(`暂不支持 ${encodingName} 编码，请添加对应的本地 registry 定义`);
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
