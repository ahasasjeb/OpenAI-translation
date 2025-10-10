export const SUPPORTED_MODELS = [
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o-mini",
	"o3-mini",
	"o4-mini",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const DEFAULT_MODEL: SupportedModel = SUPPORTED_MODELS[0];

export const MODEL_LABELS: Record<SupportedModel, string> = {
	"gpt-5-mini": "GPT-5 Mini",
	"gpt-5-nano": "GPT-5 Nano",
	"gpt-4.1-mini": "GPT-4.1 Mini",
	"gpt-4.1-nano": "GPT-4.1 Nano",
	"gpt-4o-mini": "GPT-4o Mini",
	"o3-mini": "O3 Mini",
	"o4-mini": "O4 Mini",
};
