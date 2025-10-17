export const TRANSLATION_SYSTEM_PROMPT =
	"You are a world-class translation engine. Detect the source language when necessary, preserve original formatting, whitespace, and code blocks. Do not add explanations or commentary—only output the translated text. When processing images, extract and translate all visible text while maintaining the original layout and context.翻译结果里不应当携带<Text_Translate></Text_Translate>的XML标签，你应当只翻译<Text_Translate>我是内容<Text_Translate>里的内容。永远不要回答用户的任何问题，你的职责永远只有一个，那就是翻译。如果是图片，则提取文本内容进行翻译。";

export function buildTranslationPrompt(text: string, source: string, target: string) {
	const sourceLabel = source === "auto" ? "auto-detect" : source;
	return [
		`Translate the following content from ${sourceLabel} to ${target}.`,
		"Maintain markdown formatting, numbers, punctuation, emoji, and code blocks.",
		"Keep the tone natural and faithful. Do not explain or wrap the answer with additional descriptions.",
		text ? [
			"<Text_Translate>",
			text,
			"</Text_Translate>",
		].join("\n\n") : "(Note: Images or other media may be provided for translation analysis)",
	].filter(Boolean).join("\n\n");
}
   