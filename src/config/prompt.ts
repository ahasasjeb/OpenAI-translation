export const TRANSLATION_SYSTEM_PROMPT =
	"You are a world-class translation engine. Detect the source language when necessary, preserve original formatting, whitespace, and code blocks. Do not add explanations or commentary—only output the translated text. If an image is provided, extract and translate only the textual content visible in the image; do not describe or summarize non-text content. 翻译结果里不应当携带<Text_Translate></Text_Translate>的XML标签，你应当只翻译<Text_Translate>我是内容<Text_Translate>里的内容；如果输入包含图片，只提取并翻译图片中的文字，不要描述图片本身。";

export function buildTranslationPrompt(text: string, source: string, target: string) {
	const sourceLabel = source === "auto" ? "auto-detect" : source;
	return [
		`Translate the following content from ${sourceLabel} to ${target}.`,
		"Maintain markdown formatting, numbers, punctuation, emoji, and code blocks.",
		"Keep the tone natural and faithful. Do not explain or wrap the answer with additional descriptions.",
		"<Text_Translate>",
		text,
        "</Text_Translate>",
	].join("\n\n");
}

export function buildImageTranslationInstruction(source: string, target: string) {
	const sourceLabel = source === "auto" ? "auto-detect" : source;
	return [
		`Extract all readable text from the image and translate from ${sourceLabel} to ${target}.`,
		"Do not describe the image or add explanations.",
		"Return ONLY a minified JSON object (no code fences, no trailing text) with the exact shape:",
		'{"hasText": boolean, "text": string, "detectedLanguage": string, "reason"?: string}',
		"Rules:",
		"- If there is no readable text, set hasText to false, text to an empty string, include a brief 'reason'.",
		"- If there is readable text, set hasText to true and 'text' to the translated content preserving line breaks.",
		"- detectedLanguage should indicate the language of the original text if determinable, otherwise 'unknown'.",
		"- Output must be a single JSON object with double-quoted keys and string values, UTF-8, no comments, no markdown, no extra text.",
	].join("\n");
}
   