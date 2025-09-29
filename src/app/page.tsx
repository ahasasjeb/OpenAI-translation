"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_MODEL, MODEL_LABELS, SUPPORTED_MODELS, type SupportedModel } from "@/config/models";
import { estimateTranslationTokenUsage, fallbackCharacterEstimate } from "@/lib/tokenEstimator";

const QUOTA_POLL_INTERVAL = 5_000;

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

type StreamDeltaEvent = {
  type: "delta";
  delta?: string;
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

export default function Home() {
  const [sourceText, setSourceText] = useState("");
  const [targetText, setTargetText] = useState("");
  const [model, setModel] = useState<SupportedModel>(DEFAULT_MODEL);
  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("zh");
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
  const trimmedSourceText = useMemo(() => sourceText.trim(), [sourceText]);
  const [debouncedSourceText, setDebouncedSourceText] = useState(trimmedSourceText);

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
    if (!debouncedSourceText) {
      setEstimatedTokens(0);
      setTokenEstimateError(null);
      setIsEstimatingTokens(false);
      return;
    }

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
  }, [debouncedSourceText, model, sourceLang, targetLang]);

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

  const translateDisabled = isLoading
    || !trimmedSourceText
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
    ? "border-red-200 bg-red-50 text-red-700"
    : "border-blue-100 bg-blue-50 text-blue-700";
  const estimateMessage = isEstimatingTokens
    ? "正在估算本次请求的 Token 消耗…"
    : `预计本次请求将消耗 ${estimatedTokensDisplay} tokens${estimatedRemainingDisplay != null ? `，剩余 ${estimatedRemainingDisplay}` : ""}`;

  const handleTranslate = useCallback(async () => {
    if (!trimmedSourceText) {
      setError("请输入需要翻译的文本");
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

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: sourceText,
          sourceLang,
          targetLang,
          model,
        }),
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

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed) as unknown;
        } catch (err) {
          console.error("Failed to parse stream chunk", err, trimmed);
          return;
        }
        if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
          return;
        }
        const event = parsed as StreamDeltaEvent | StreamFinalEvent | StreamErrorEvent;

        switch (event.type) {
          case "delta": {
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (!delta) {
              return;
            }
            aggregated += delta;
            setTargetText(aggregated);
            break;
          }
          case "final": {
            const data = event.data ?? {};
            const finalTranslation = typeof data.translation === "string"
              ? data.translation
              : aggregated;
            aggregated = finalTranslation;
            setTargetText(finalTranslation);
            if (data.quota) {
              setQuota(data.quota as QuotaInfo);
            }
            setRedisReady(true);
            const tokenCost = data.usage?.tokens;
            setLastUsageTokens(typeof tokenCost === "number" ? tokenCost : null);
            if (data.quotaExceeded) {
              streamError = "今日额度已用完，请等待下一次北京时间 8 点再来。";
            }
            shouldStop = true;
            break;
          }
          case "error": {
            const message = typeof event.message === "string"
              ? event.message
              : "翻译失败，请稍后再试";
            streamError = message;
            if (event.code === "quota_disabled") {
              setRedisReady(false);
            }
            if (event.quota) {
              setQuota(event.quota as QuotaInfo);
            }
            shouldStop = true;
            break;
          }
          default:
            break;
        }
      };

      while (!shouldStop) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          processLine(line);
          if (shouldStop) {
            break;
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      if (!shouldStop && buffer.trim()) {
        processLine(buffer.trim());
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
  }, [estimatedOverLimit, isEstimatingTokens, model, sourceLang, sourceText, targetLang, trimmedSourceText]);

  const handleClear = useCallback(() => {
    setSourceText("");
    setTargetText("");
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
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold text-gray-900">OpenAI 翻译调试面板</h1>
          <p className="text-sm text-gray-600">
            仅支持每日 2.5M token 免费额度的模型，额度在每日 UTC 0 点（北京时间 8 点）自动重置。
          </p>
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700">今日已用 Tokens</p>
                <p className="text-2xl font-semibold text-gray-900">{quotaUsedLabel}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">剩余额度</p>
                <p className="text-lg text-gray-900">{quotaRemainingLabel} / {quotaLimitLabel}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">下次重置（北京时间）</p>
                <p className="text-lg text-gray-900">{resetLabel}</p>
              </div>
            </div>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className={`h-full rounded-full ${quotaExceeded ? "bg-red-500" : "bg-blue-500"}`}
                style={{ width: `${quotaPercent}%` }}
              />
            </div>
          </div>
          {quotaError && <p className="text-sm text-red-600">{quotaError}</p>}
          {!redisReady && !quotaError && (
            <p className="text-sm text-red-600">Redis 未就绪，无法记录额度。</p>
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              {error}
            </div>
          )}
          {quotaExceeded && !error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700" role="status">
              请等待下一次北京时间 8 点再来。
            </div>
          )}
        </header>

        <section className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">模型</label>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value as SupportedModel)}
              disabled={isLoading}
              className="rounded-md border border-gray-300 px-3 py-1 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              className="rounded-md border border-gray-300 px-3 py-1 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {SOURCE_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-gray-500">→</span>
            <select
              value={targetLang}
              onChange={(event) => setTargetLang(event.target.value)}
              disabled={isLoading}
              className="rounded-md border border-gray-300 px-3 py-1 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {TARGET_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {typeof lastUsageTokens === "number" && (
            <p className="text-sm text-gray-600">上次翻译消耗 {lastUsageTokens.toLocaleString("en-US")} tokens</p>
          )}
        </section>

        {trimmedSourceText && (
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
            <div className="mb-2">
              <span className="text-sm font-medium text-gray-700">原文</span>
            </div>
            <textarea
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="输入要翻译的文本..."
              className="h-60 w-full flex-1 resize-none rounded-lg border border-gray-300 p-4 text-sm shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 sm:h-full"
            />
          </div>
          <div className="hidden w-px bg-gray-200 sm:block" />
          <div className="flex flex-col sm:flex-1">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">翻译结果</span>
              <button
                type="button"
                onClick={handleCopy}
                disabled={!targetText}
                className={`rounded-md border px-3 py-1 text-xs font-medium transition ${targetText ? "border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50" : "cursor-not-allowed border-gray-200 text-gray-400"}`}
              >
                {copyStatus === "success" ? "已复制" : "复制"}
              </button>
            </div>
            <textarea
              value={targetText}
              readOnly
              placeholder="翻译结果将显示在这里..."
              className="h-60 w-full flex-1 resize-none rounded-lg border border-gray-300 bg-gray-100 p-4 text-sm shadow-sm focus:outline-none sm:h-full"
            />
            {copyStatus === "success" && (
              <p className="mt-1 text-xs text-green-600">翻译结果已复制到剪贴板</p>
            )}
            {copyStatus === "error" && (
              <p className="mt-1 text-xs text-red-600">复制失败，请手动复制</p>
            )}
          </div>
        </section>

        <section className="flex items-center justify-center gap-4">
          <button
            onClick={handleTranslate}
            disabled={translateDisabled}
            className={`rounded-lg px-6 py-2 font-medium text-white transition ${translateDisabled ? "cursor-not-allowed bg-blue-300" : "bg-blue-500 hover:bg-blue-600"}`}
          >
            {translateButtonLabel}
          </button>
          <button
            onClick={handleClear}
            disabled={isLoading}
            className="rounded-lg bg-gray-500 px-6 py-2 font-medium text-white transition hover:bg-gray-600 disabled:cursor-not-allowed disabled:bg-gray-300"
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
