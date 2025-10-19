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
	sourceTokens: number; // 文本或图片tokens
	estimatedResponseTokens: number;
	totalTokens: number;
};

export async function estimateTranslationTokenUsage(params: {
	text?: string;
	image?: { width: number; height: number; detail?: 'low' | 'high' | 'auto' } | null;
	model: SupportedModel;
	sourceLang: string;
	targetLang: string;
}): Promise<TokenEstimate> {
	const isImage = !!params.image;
	const encoder = await getEncoder(params.model);
	const systemTokens = encoder.encode(TRANSLATION_SYSTEM_PROMPT).length + CHAT_MESSAGE_OVERHEAD;

	if (isImage && params.image) {
		const promptBody = `Extract and translate all readable text from the image from ${params.sourceLang === 'auto' ? 'auto-detect' : params.sourceLang} to ${params.targetLang}. Only output the translated text.`;
		const promptTokens = encoder.encode(promptBody).length + CHAT_MESSAGE_OVERHEAD;
		const sourceTokens = estimateImageTokens(params.model, params.image.width, params.image.height, params.image.detail ?? 'high');
		const estimatedResponseTokens = MIN_RESPONSE_TOKENS + RESPONSE_OVERHEAD; // 图像输出长度与图中文字相关，这里取保守常量
		const totalTokens = systemTokens + promptTokens + sourceTokens + estimatedResponseTokens;
		return { systemTokens, promptTokens, sourceTokens, estimatedResponseTokens, totalTokens };
	}

	const trimmed = (params.text ?? '').trim();
	if (!trimmed) {
		return { systemTokens: 0, promptTokens: 0, sourceTokens: 0, estimatedResponseTokens: 0, totalTokens: 0 };
	}

	const promptBody = buildTranslationPrompt(trimmed, params.sourceLang, params.targetLang);
	const promptTokens = encoder.encode(promptBody).length + CHAT_MESSAGE_OVERHEAD;
	const sourceTokens = encoder.encode(trimmed).length;
	const estimatedResponseTokens = Math.max(
		MIN_RESPONSE_TOKENS,
		Math.round(sourceTokens * RESPONSE_RATIO),
		sourceTokens,
	) + RESPONSE_OVERHEAD;

	const totalTokens = systemTokens + promptTokens + sourceTokens + estimatedResponseTokens;

	return { systemTokens, promptTokens, sourceTokens, estimatedResponseTokens, totalTokens };
}

export function fallbackCharacterEstimate(text: string) {
	return Math.max(0, Math.ceil(text.trim().length / 3));
}

// =============== 图片 Token 估算 ===============

const PATCH_BASE_MODELS: Record<SupportedModel, number | undefined> = {
	'gpt-5-mini': 1.62,
	'gpt-5-nano': 2.46,
	'gpt-4.1-mini': 1.62,
	'gpt-4.1-nano': 2.46,
	'o4-mini': 1.72,
	'gpt-4o-mini': undefined as unknown as number, // 使用瓦片规则
	'o3-mini': undefined as unknown as number, // 使用瓦片规则
};

const TILE_BASE_MODELS: Record<SupportedModel, { base: number; tile: number } | undefined> = {
	'gpt-4o-mini': { base: 2833, tile: 5667 },
	'o3-mini': { base: 75, tile: 150 },
	'gpt-5-mini': undefined,
	'gpt-5-nano': undefined,
	'gpt-4.1-mini': undefined,
	'gpt-4.1-nano': undefined,
	'o4-mini': undefined,
};

export function estimateImageTokens(model: SupportedModel, width: number, height: number, detail: 'low' | 'high' | 'auto' = 'high'): number {
	width = Math.max(1, Math.floor(width));
	height = Math.max(1, Math.floor(height));

	const patchMultiplier = PATCH_BASE_MODELS[model];
	if (typeof patchMultiplier === 'number') {
		// 32x32 分块 + 模型乘数
		// 缩放以满足最多 1536 个 patch
		const maxPatches = 1536;
		const rawPatches = Math.ceil(width / 32) * Math.ceil(height / 32);
		let w = width;
		let h = height;
		if (rawPatches > maxPatches) {
			const r = Math.sqrt((32 * 32 * maxPatches) / (width * height));
			// 再进行一次对齐，确保能被 32 的网格覆盖
			const w1 = Math.floor(width * r);
			const h1 = Math.floor(height * r);
			// 对齐后重新计算，若有需要可做轻微缩放以对齐 patch
			w = Math.floor(Math.floor(w1 / 32) * 32);
			h = Math.floor(Math.floor(h1 / 32) * 32);
			w = Math.max(32, w);
			h = Math.max(32, h);
		}
		const tokens = Math.ceil(w / 32) * Math.ceil(h / 32);
		return Math.round(tokens * patchMultiplier);
	}

	const tileSpec = TILE_BASE_MODELS[model];
	if (tileSpec) {
		if (detail === 'low') {
			return tileSpec.base;
		}
		// 高细节：
		// 1) 限制到 2048 方框内
		const maxDim = Math.max(width, height);
		let w = width;
		let h = height;
		if (maxDim > 2048) {
			const s = 2048 / maxDim;
			w = Math.round(width * s);
			h = Math.round(height * s);
		}
		// 2) 最短边缩放到 768
		const minDim = Math.min(w, h);
		const s2 = 768 / minDim;
		w = Math.round(w * s2);
		h = Math.round(h * s2);
		// 3) 计算 512 tile 数
		const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
		return tileSpec.base + tiles * tileSpec.tile;
	}

	// 兜底：按文本粗略近似（极少触发）
	return Math.ceil((width * height) / (32 * 32));
}
