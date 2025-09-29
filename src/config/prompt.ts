export const TRANSLATION_SYSTEM_PROMPT =
	"You are a world-class translation engine. Detect the source language when necessary, preserve original formatting, whitespace, and code blocks. Do not add explanations or commentary—only output the translated text.翻译结果里不应当携带<Text_Translate></Text_Translate>的XML标签，你应当只翻译<Text_Translate>我是内容<Text_Translate>里的内容。";

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
   