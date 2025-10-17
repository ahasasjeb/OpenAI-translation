export const TEXT_SYSTEM_PROMPT =
	"You are a world-class translation engine. Detect the source language when necessary, preserve original formatting, whitespace, and code blocks. Do not add explanations or commentary—only output the translated text.翻译结果里不应当携带<Text_Translate></Text_Translate>的XML标签，你应当只翻译<Text_Translate>我是内容<Text_Translate>里的内容。";

export const IMAGE_SYSTEM_PROMPT =
	"You are a world-class translation engine specialized in image analysis and translation. Extract all visible text from images and translate them accurately. Preserve the original layout, formatting, and context. Maintain numbers, punctuation, emoji, and code blocks. Do not add explanations or commentary—only provide the translated text based on what you see in the image.";

export const TRANSLATION_SYSTEM_PROMPT = TEXT_SYSTEM_PROMPT;

export function buildTranslationPrompt(text: string, source: string, target: string, isImageMode: boolean = false) {
	const sourceLabel = source === "auto" ? "auto-detect" : source;
	
	if (isImageMode) {
		// 图片模式：提示词针对图片内容翻译
		return [
			`Translate all text visible in the provided image from ${sourceLabel} to ${target}.`,
			"Focus on accuracy and maintaining the original layout and context.",
			"Extract and translate: text, labels, captions, and any other visible content.",
		].join("\n\n");
	}

	// 文本模式：原有的文本翻译提示词
	return [
		`Translate the following content from ${sourceLabel} to ${target}.`,
		"Maintain markdown formatting, numbers, punctuation, emoji, and code blocks.",
		"Keep the tone natural and faithful. Do not explain or wrap the answer with additional descriptions.",
		text ? [
			"<Text_Translate>",
			text,
			"</Text_Translate>",
		].join("\n\n") : "Content will be provided for translation.",
	].filter(Boolean).join("\n\n");
}
   