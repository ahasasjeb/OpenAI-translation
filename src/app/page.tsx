"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextImage from "next/image";

import { DEFAULT_MODEL, MODEL_LABELS, SUPPORTED_MODELS, type SupportedModel } from "@/config/models";
import { estimateTranslationTokenUsage, fallbackCharacterEstimate } from "@/lib/tokenEstimator";

const QUOTA_POLL_INTERVAL = 15_000;

type QuotaInfo = {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  serverTime: string;
  resetAtBeijing?: string;
};

type ApiError = {
  error?: string;
  message?: string;
  quota?: QuotaInfo;
};

type StreamFinalEvent = {
  type: "final";
  data?: {
    translation?: string;
    quota?: QuotaInfo;
    usage?: {
      tokens?: number;
      limit?: number;
    };
    quotaExceeded?: boolean;
  };
};

type StreamErrorEvent = {
  type: "error";
  message?: string;
  code?: string;
  quota?: QuotaInfo;
};

type QuotaResponse = {
  enabled?: boolean;
  quota?: QuotaInfo;
  error?: string;
  message?: string;
};

const SOURCE_LANGUAGE_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
];

const TARGET_LANGUAGE_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日文" },
  { value: "ko", label: "韩文" },
];

const BASE_REASONING_OPTIONS = ["low", "medium", "high"] as const;
type ReasoningEffort = (typeof BASE_REASONING_OPTIONS)[number] | "minimal";

const REASONING_LABELS: Record<ReasoningEffort, string> = {
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
};

export default function Home() {
  const [sourceText, setSourceText] = useState("");
  const [targetText, setTargetText] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageInfo, setImageInfo] = useState<{ width: number; height: number; type: string } | null>(null);
  const [model, setModel] = useState<SupportedModel>(DEFAULT_MODEL);
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("zh");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("low");
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [redisReady, setRedisReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUsageTokens, setLastUsageTokens] = useState<number | null>(null);
  const [estimatedTokens, setEstimatedTokens] = useState<number | null>(null);
  const [isEstimatingTokens, setIsEstimatingTokens] = useState(false);
  const [tokenEstimateError, setTokenEstimateError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const copyResetTimerRef = useRef<number | null>(null);
  const translationOutputRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmedSourceText = useMemo(() => sourceText.trim(), [sourceText]);
  const [debouncedSourceText, setDebouncedSourceText] = useState(trimmedSourceText);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isImageMode = !!imageDataUrl && !!imageInfo;

  const availableReasoningEfforts = useMemo<ReasoningEffort[]>(() => {
    if (model.startsWith("gpt-4.1")) {
      return [];
    }
    if (model.startsWith("gpt-5")) {
      return ["minimal", ...BASE_REASONING_OPTIONS] as ReasoningEffort[];
    }
    return [...BASE_REASONING_OPTIONS];
  }, [model]);

  const effectiveReasoningEffort = useMemo(
    () => (availableReasoningEfforts.length > 0 ? reasoningEffort : undefined),
    [availableReasoningEfforts, reasoningEffort],
  );

  const fetchQuota = useCallback(async () => {
    try {
      const response = await fetch("/api/quota", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as QuotaResponse | null;

      if (!response.ok) {
        const message = data?.message ?? `额度接口返回 ${response.status}`;
        setQuotaError(message);
        setRedisReady(!(data?.error === "quota_disabled"));
        return;
      }

      if (data?.enabled === false) {
        setRedisReady(false);
        setQuota(null);
        setQuotaError(data?.message ?? "Redis 未就绪，额度功能已关闭");
        return;
      }

      if (data?.quota) {
        setQuota(data.quota);
        setQuotaError(null);
        setRedisReady(true);
      }
    } catch (err) {
      console.error("Failed to fetch quota", err);
      setQuotaError("额度状态同步失败，请稍后重试");
      setRedisReady(false);
    }
  }, []);

  useEffect(() => {
    fetchQuota();
    const id = setInterval(fetchQuota, QUOTA_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchQuota]);

  useEffect(() => {
    if (!trimmedSourceText) {
      setDebouncedSourceText("");
      return;
    }

    const handler = window.setTimeout(() => {
      setDebouncedSourceText(trimmedSourceText);
    }, 300);

    return () => {
      window.clearTimeout(handler);
    };
  }, [trimmedSourceText]);

  useEffect(() => {
    if (availableReasoningEfforts.length === 0) {
      if (reasoningEffort !== "low") {
        setReasoningEffort("low");
      }
      return;
    }

    if (!availableReasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort(availableReasoningEfforts[0]);
    }
  }, [availableReasoningEfforts, reasoningEffort]);

  useEffect(() => {
    // 估算 tokens：文本或图片二选一
    if (!isImageMode && !debouncedSourceText) {
      setEstimatedTokens(0);
      setTokenEstimateError(null);
      setIsEstimatingTokens(false);
      return;
    }

    if (isImageMode && imageInfo) {
      let active = true;
      setIsEstimatingTokens(true);
      setTokenEstimateError(null);

      estimateTranslationTokenUsage({
        image: { width: imageInfo.width, height: imageInfo.height, detail: "high" },
        model,
        sourceLang,
        targetLang,
      })
        .then((result) => {
          if (!active) return;
          setEstimatedTokens(result.totalTokens);
          setTokenEstimateError(null);
        })
        .catch((err) => {
          if (!active) return;
          console.error("Token estimation failed", err);
          setTokenEstimateError("Token 预估失败");
          setEstimatedTokens(0);
        })
        .finally(() => {
          if (!active) return;
          setIsEstimatingTokens(false);
        });

      return () => {
        active = false;
      };
    }

    // 文本模式
    let active = true;
    setIsEstimatingTokens(true);
    setTokenEstimateError(null);

    estimateTranslationTokenUsage({
      text: debouncedSourceText,
      model,
      sourceLang,
      targetLang,
    })
      .then((result) => {
        if (!active) return;
        setEstimatedTokens(result.totalTokens);
        setTokenEstimateError(null);
      })
      .catch((err) => {
        if (!active) return;
        console.error("Token estimation failed", err);
        setTokenEstimateError("Token 预估失败，已使用字符数近似估算");
        setEstimatedTokens(fallbackCharacterEstimate(debouncedSourceText));
      })
      .finally(() => {
        if (!active) return;
        setIsEstimatingTokens(false);
      });

    return () => {
      active = false;
    };
  }, [debouncedSourceText, isImageMode, imageInfo, model, sourceLang, targetLang]);

  useEffect(() => {
    const ref = copyResetTimerRef;
    return () => {
      const timeoutId = ref.current;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [copyResetTimerRef]);

  const quotaPercent = useMemo(() => {
    if (!quota || quota.limit === 0) return 0;
    return Math.min(100, (quota.used / quota.limit) * 100);
  }, [quota]);

  const quotaRemainingLabel = quota?.remaining?.toLocaleString("en-US") ?? "--";
  const quotaUsedLabel = quota?.used?.toLocaleString("en-US") ?? "--";
  const quotaLimitLabel = quota?.limit?.toLocaleString("en-US") ?? "2,500,000";
  const resetLabel = quota ? formatBeijingTime(quota.resetAt) : "--";
  const quotaExceeded = quota ? quota.remaining <= 0 : false;

  const estimatedOverLimit = useMemo(() => {
    if (!quota || estimatedTokens == null) {
      return false;
    }
    return estimatedTokens > quota.remaining;
  }, [quota, estimatedTokens]);

  const estimatedRemaining = useMemo(() => {
    if (!quota || estimatedTokens == null) {
      return null;
    }
    return quota.remaining - estimatedTokens;
  }, [quota, estimatedTokens]);

  const hasInput = isImageMode || !!trimmedSourceText;
  const translateDisabled = isLoading
    || !hasInput
    || quotaExceeded
    || !redisReady
    || estimatedOverLimit
    || isEstimatingTokens;

  const translateButtonLabel = !redisReady
    ? "Redis 未就绪"
    : isLoading
      ? "翻译中..."
      : isEstimatingTokens
        ? "计算 Token..."
        : "翻译";

  const estimatedTokensDisplay = estimatedTokens != null ? estimatedTokens.toLocaleString("en-US") : "--";
  const estimatedRemainingDisplay = estimatedRemaining != null ? Math.max(0, estimatedRemaining).toLocaleString("en-US") : null;
  const estimateBannerClass = estimatedOverLimit
    ? "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
    : "border-blue-100 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300";
  const estimateMessage = isEstimatingTokens
    ? "正在估算本次请求的 Token 消耗…"
    : `预计本次请求将消耗 ${estimatedTokensDisplay} tokens${estimatedRemainingDisplay != null ? `，剩余 ${estimatedRemainingDisplay}` : ""}`;

  const handleTranslate = useCallback(async () => {
    if (!isImageMode && !trimmedSourceText) {
      setError("请输入需要翻译的文本或选择图片");
      return;
    }

    if (isEstimatingTokens) {
      setError("Token 预估尚未完成，请稍后重试");
      return;
    }

    if (estimatedOverLimit) {
      setError("预计本次请求会超出剩余额度，请缩短文本或等待额度重置");
      return;
    }

    setIsLoading(true);
    setError(null);
    setLastUsageTokens(null);
    setTargetText("");
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    setCopyStatus("idle");

    if (typeof window !== "undefined") {
      const isMobileViewport = window.matchMedia("(max-width: 640px)").matches;
      if (isMobileViewport && translationOutputRef.current) {
        translationOutputRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    try {
      const requestPayload: Record<string, unknown> = {
        sourceLang,
        targetLang,
        model,
      };

      if (isImageMode && imageDataUrl) {
        requestPayload.imageDataUrl = imageDataUrl;
        requestPayload.imageDetail = "high";
      } else {
        requestPayload.text = sourceText;
      }

      if (effectiveReasoningEffort) {
        requestPayload.reasoningEffort = effectiveReasoningEffort;
      }

      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        let errorPayload: ApiError | null = null;
        try {
          errorPayload = (await response.json()) as ApiError;
        } catch (err) {
          console.error("Failed to parse error response", err);
        }
        const message = errorPayload?.message ?? `翻译失败 (${response.status})`;
        setError(message);
        if (errorPayload?.error === "quota_disabled") {
          setRedisReady(false);
        }
        if (errorPayload?.quota) {
          setQuota(errorPayload.quota);
        }
        return;
      }

      if (!response.body) {
        setError("服务响应为空");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let aggregated = "";
      let streamError: string | null = null;
      let shouldStop = false;

      const processEvent = (rawEvent: string) => {
        const lines = rawEvent.split(/\r?\n/);
        let eventType = "message";
        const dataLines: string[] = [];

        for (const line of lines) {
          if (!line) {
            continue;
          }
          if (line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (dataLines.length === 0) {
          return;
        }

        const dataString = dataLines.join("\n");
        let payload: unknown;
        try {
          payload = JSON.parse(dataString) as unknown;
        } catch (err) {
          console.error("Failed to parse SSE data", err, dataString);
          return;
        }
        if (!payload || typeof payload !== "object") {
          return;
        }

        switch (eventType) {
          case "delta": {
            const delta = (payload as { delta?: unknown }).delta;
            const deltaText = typeof delta === "string" ? delta : "";
            if (!deltaText) {
              return;
            }
            aggregated += deltaText;
            setTargetText(aggregated);
            break;
          }
          case "final": {
            const data = payload as StreamFinalEvent["data"];
            const finalTranslation = typeof data?.translation === "string"
              ? data.translation
              : aggregated;
            aggregated = finalTranslation;
            setTargetText(finalTranslation);
            if (data?.quota) {
              setQuota(data.quota as QuotaInfo);
            }
            setRedisReady(true);
            const tokenCost = data?.usage?.tokens;
            setLastUsageTokens(typeof tokenCost === "number" ? tokenCost : null);
            if (data?.quotaExceeded) {
              streamError = "今日额度已用完，请等待下一次北京时间 8 点再来。";
            }
            shouldStop = true;
            break;
          }
          case "error": {
            const errorPayload = payload as StreamErrorEvent;
            const message = typeof errorPayload.message === "string"
              ? errorPayload.message
              : "翻译失败，请稍后再试";
            streamError = message;
            if (errorPayload.code === "quota_disabled") {
              setRedisReady(false);
            }
            if (errorPayload.quota) {
              setQuota(errorPayload.quota as QuotaInfo);
            }
            shouldStop = true;
            break;
          }
          default:
            break;
        }
      };

      const flushEvents = () => {
        while (!shouldStop) {
          const doubleNewlineIndex = (() => {
            const idxRR = buffer.indexOf("\r\n\r\n");
            const idxNN = buffer.indexOf("\n\n");
            if (idxRR === -1) {
              return idxNN;
            }
            if (idxNN === -1) {
              return idxRR;
            }
            return Math.min(idxRR, idxNN);
          })();

          if (doubleNewlineIndex === -1) {
            break;
          }

          const separator = buffer.startsWith("\r\n", doubleNewlineIndex) ? "\r\n\r\n" : "\n\n";
          const rawEvent = buffer.slice(0, doubleNewlineIndex);
          buffer = buffer.slice(doubleNewlineIndex + separator.length);
          if (rawEvent.trim()) {
            processEvent(rawEvent);
          }
          if (shouldStop) {
            break;
          }
        }
      };

      while (!shouldStop) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        flushEvents();
      }

      if (!shouldStop) {
        buffer += decoder.decode();
        flushEvents();
        if (!shouldStop && buffer.trim()) {
          processEvent(buffer.trim());
        }
      }

      if (shouldStop) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
      }

      if (!aggregated && !streamError) {
        streamError = "未能获取翻译结果，请稍后重试";
      }

      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
      setCopyStatus("idle");
      if (streamError) {
        setError(streamError);
      }
    } catch (err) {
      console.error("Translate request failed", err);
      setError(err instanceof Error ? err.message : "网络错误，请稍后再试");
    } finally {
      setIsLoading(false);
    }
  }, [effectiveReasoningEffort, estimatedOverLimit, imageDataUrl, isEstimatingTokens, isImageMode, model, sourceLang, sourceText, targetLang, trimmedSourceText]);

  const handleClear = useCallback(() => {
    setSourceText("");
    setTargetText("");
    setImageDataUrl(null);
    setImageInfo(null);
    setError(null);
    setLastUsageTokens(null);
    setEstimatedTokens(0);
    setTokenEstimateError(null);
    setCopyStatus("idle");
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  }, []);

  const handleCopy = useCallback(async () => {
    if (!targetText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(targetText);
      setCopyStatus("success");
    } catch (err) {
      console.error("Failed to copy translation", err);
      setCopyStatus("error");
    } finally {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopyStatus("idle");
        copyResetTimerRef.current = null;
      }, 2000);
    }
  }, [targetText]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">OpenAI 翻译调试面板</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            仅支持每日 2.5M token 免费额度的模型，额度在每日 UTC 0 点（北京时间 8 点）自动重置。
          </p>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">今日已用 Tokens</p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{quotaUsedLabel}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">剩余额度</p>
                <p className="text-lg text-gray-900 dark:text-gray-100">{quotaRemainingLabel} / {quotaLimitLabel}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">下次重置（北京时间）</p>
                <p className="text-lg text-gray-900 dark:text-gray-100">{resetLabel}</p>
              </div>
            </div>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full rounded-full ${quotaExceeded ? "bg-red-500 dark:bg-red-400" : "bg-blue-500 dark:bg-blue-400"}`}
                style={{ width: `${quotaPercent}%` }}
              />
            </div>
          </div>
          {quotaError && <p className="text-sm text-red-600 dark:text-red-400">{quotaError}</p>}
          {!redisReady && !quotaError && (
            <p className="text-sm text-red-600 dark:text-red-400">Redis 未就绪，无法记录额度。</p>
          )}
          {error && (
            <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300" role="alert">
              {error}
            </div>
          )}
          {quotaExceeded && !error && (
            <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-700 dark:text-amber-300" role="status">
              请等待下一次北京时间 8 点再来。
            </div>
          )}
        </header>

        <section className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">模型</label>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value as SupportedModel)}
              disabled={isLoading}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1 text-sm shadow-sm focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-gray-900 dark:text-gray-100"
            >
              {SUPPORTED_MODELS.map((option) => (
                <option key={option} value={option}>
                  {MODEL_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sourceLang}
              onChange={(event) => setSourceLang(event.target.value)}
              disabled={isLoading}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1 text-sm shadow-sm focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-gray-900 dark:text-gray-100"
            >
              {SOURCE_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-gray-500 dark:text-gray-400">→</span>
            <select
              value={targetLang}
              onChange={(event) => setTargetLang(event.target.value)}
              disabled={isLoading}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1 text-sm shadow-sm focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-gray-900 dark:text-gray-100"
            >
              {TARGET_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">推理强度</label>
              <select
                value={effectiveReasoningEffort ?? "low"}
                onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
                disabled={isLoading || !effectiveReasoningEffort}
                className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1 text-sm shadow-sm focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-gray-900 dark:text-gray-100 disabled:bg-gray-100 disabled:text-gray-500 dark:disabled:bg-gray-800/60 dark:disabled:text-gray-500"
              >
                {availableReasoningEfforts.length > 0
                  ? availableReasoningEfforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {REASONING_LABELS[effort]}
                    </option>
                  ))
                  : ["low" as ReasoningEffort].map((effort) => (
                    <option key={effort} value={effort}>
                      {REASONING_LABELS[effort]}
                    </option>
                  ))}
              </select>
            </div>
            {availableReasoningEfforts.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">GPT-4.1 系列不支持推理强度设置</p>
            )}
          </div>
          {typeof lastUsageTokens === "number" && (
            <p className="text-sm text-gray-600 dark:text-gray-400">上次翻译消耗 {lastUsageTokens.toLocaleString("en-US")} tokens</p>
          )}
        </section>

        {(trimmedSourceText || isImageMode) && (
          <section className={`rounded-lg border p-3 text-sm ${estimateBannerClass}`}>
            <p>{estimateMessage}</p>
            {tokenEstimateError && (
              <p className="mt-1 text-xs text-current">{tokenEstimateError}</p>
            )}
            {estimatedOverLimit && (
              <p className="mt-1 text-xs">预计将超出剩余额度，请缩短文本或等待额度重置。</p>
            )}
          </section>
        )}

        <section className="flex flex-col gap-4 sm:h-[600px] sm:flex-row">
          <div className="flex flex-col sm:flex-1">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">原文（文本或图片二选一）</span>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (!file.type.startsWith("image/")) {
                      setError("仅支持图片文件");
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                      const dataUrl = String(reader.result);
                      const img = new Image();
                      img.onload = () => {
                        setImageDataUrl(dataUrl);
                        setImageInfo({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, type: file.type });
                        setSourceText("");
                      };
                      img.onerror = () => {
                        setError("图片加载失败，请重试");
                      };
                      img.src = dataUrl;
                    };
                    reader.onerror = () => setError("读取图片失败");
                    reader.readAsDataURL(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading}
                  className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60"
                >
                  选择图片
                </button>
                {isImageMode && (
                  <button
                    type="button"
                    onClick={() => { setImageDataUrl(null); setImageInfo(null); }}
                    disabled={isLoading}
                    className="rounded-md border border-red-300 dark:border-red-600 px-3 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    移除图片
                  </button>
                )}
              </div>
            </div>
            <div className="relative flex-1">
              {!isImageMode ? (
                <textarea
                  value={sourceText}
                  onChange={(event) => setSourceText(event.target.value)}
                  placeholder="输入要翻译的文本... 或点击右上方选择图片"
                  className="min-h-[45vh] w-full flex-1 resize-none rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-4 pr-32 text-sm shadow-sm transition focus:border-blue-500 dark:focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-800 text-gray-900 dark:text-gray-100 sm:h-full sm:min-h-0"
                />
              ) : (
                <div className="min-h-[45vh] sm:h-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-3 pr-32">
                  {imageDataUrl && imageInfo && (
                    <NextImage src={imageDataUrl} alt="待翻译图片" width={imageInfo.width} height={imageInfo.height} unoptimized className="max-h-[70vh] max-w-full h-auto w-auto rounded" />
                  )}
                  {imageInfo && (
                    <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">尺寸：{imageInfo.width}×{imageInfo.height}，类型：{imageInfo.type}</p>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={handleTranslate}
                disabled={translateDisabled}
                className={`absolute right-4 top-4 rounded-md px-3 py-1.5 text-sm font-medium text-white shadow transition ${translateDisabled ? "cursor-not-allowed bg-blue-300 dark:bg-blue-600" : "bg-blue-500 dark:bg-blue-600 hover:bg-blue-600 dark:hover:bg-blue-700"}`}
              >
                {translateButtonLabel}
              </button>
            </div>
          </div>
          <div className="hidden w-px bg-gray-200 dark:bg-gray-700 sm:block" />
          <div className="flex flex-col sm:flex-1">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">翻译结果</span>
              <button
                type="button"
                onClick={handleCopy}
                disabled={!targetText}
                className={`rounded-md border px-3 py-1 text-xs font-medium transition ${targetText ? "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700" : "cursor-not-allowed border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600"}`}
              >
                {copyStatus === "success" ? "已复制" : "复制"}
              </button>
            </div>
            <textarea
              value={targetText}
              readOnly
              placeholder="翻译结果将显示在这里..."
              ref={translationOutputRef}
              className="min-h-[40vh] w-full flex-1 resize-none rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-700 p-4 text-sm shadow-sm focus:outline-none text-gray-900 dark:text-gray-100 sm:h-full sm:min-h-0"
            />
            {copyStatus === "success" && (
              <p className="mt-1 text-xs text-green-600 dark:text-green-400">翻译结果已复制到剪贴板</p>
            )}
            {copyStatus === "error" && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">复制失败，请手动复制</p>
            )}
          </div>
        </section>

        <section className="flex items-center justify-end gap-4">
          <button
            onClick={handleClear}
            disabled={isLoading}
            className="rounded-lg bg-gray-500 dark:bg-gray-600 px-6 py-2 font-medium text-white transition hover:bg-gray-600 dark:hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-gray-700"
          >
            清空
          </button>
        </section>
      </div>
    </div>
  );
}

function formatBeijingTime(iso: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: undefined,
      hour12: false,
      timeZone: "Asia/Shanghai",
    }).format(new Date(iso));
  } catch (error) {
    console.error("Failed to format Beijing time", error);
    return iso;
  }
}
