"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { DEFAULT_MODEL, MODEL_LABELS, SUPPORTED_MODELS, type SupportedModel } from "@/config/models";

const QUOTA_POLL_INTERVAL = 5_000;

type QuotaInfo = {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
  serverTime: string;
  resetAtBeijing?: string;
};

type TranslateSuccess = {
  data: {
    translation: string;
    quota: QuotaInfo;
    usage?: {
      tokens?: number;
      limit?: number;
    };
    model: SupportedModel;
    sourceLang: string;
    targetLang: string;
  };
};

type ApiError = {
  error?: string;
  message?: string;
  quota?: QuotaInfo;
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
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUsageTokens, setLastUsageTokens] = useState<number | null>(null);

  const fetchQuota = useCallback(async () => {
    try {
      const response = await fetch("/api/quota", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Quota API responded with ${response.status}`);
      }
      const data = (await response.json()) as { quota?: QuotaInfo };
      if (data.quota) {
        setQuota(data.quota);
        setQuotaError(null);
      }
    } catch (err) {
      console.error("Failed to fetch quota", err);
      setQuotaError("额度状态同步失败，请稍后重试");
    }
  }, []);

  useEffect(() => {
    fetchQuota();
    const id = setInterval(fetchQuota, QUOTA_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchQuota]);

  const handleTranslate = useCallback(async () => {
    if (!sourceText.trim()) {
      setError("请输入需要翻译的文本");
      return;
    }

    setIsLoading(true);
    setError(null);
    setLastUsageTokens(null);

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

      const json = (await response.json()) as TranslateSuccess | ApiError;
      if (!response.ok) {
        const errorPayload = json as ApiError;
        const message = errorPayload.message ?? "翻译失败，请稍后再试";
        setError(message);
        if (errorPayload.quota) {
          setQuota(errorPayload.quota);
        }
        return;
      }

      if (!("data" in json)) {
        setError("服务响应格式异常");
        return;
      }

      setTargetText(json.data.translation);
      if (json.data.quota) {
        setQuota(json.data.quota);
      }
      const tokenCost = json.data.usage?.tokens;
      setLastUsageTokens(typeof tokenCost === "number" ? tokenCost : null);
    } catch (err) {
      console.error("Translate request failed", err);
      setError(err instanceof Error ? err.message : "网络错误，请稍后再试");
    } finally {
      setIsLoading(false);
    }
  }, [model, sourceLang, sourceText, targetLang]);

  const handleClear = useCallback(() => {
    setSourceText("");
    setTargetText("");
    setError(null);
    setLastUsageTokens(null);
  }, []);

  const quotaPercent = useMemo(() => {
    if (!quota || quota.limit === 0) return 0;
    return Math.min(100, (quota.used / quota.limit) * 100);
  }, [quota]);

  const quotaRemaining = quota?.remaining?.toLocaleString("en-US") ?? "--";
  const quotaUsed = quota?.used?.toLocaleString("en-US") ?? "--";
  const quotaLimit = quota?.limit?.toLocaleString("en-US") ?? "2,500,000";
  const resetLabel = quota ? formatBeijingTime(quota.resetAt) : "--";
  const quotaExceeded = quota ? quota.remaining <= 0 : false;
  const translateDisabled = isLoading || !sourceText.trim() || quotaExceeded;

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
                <p className="text-2xl font-semibold text-gray-900">{quotaUsed}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">剩余额度</p>
                <p className="text-lg text-gray-900">{quotaRemaining} / {quotaLimit}</p>
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

        <section className="flex flex-col gap-4 sm:h-[600px] sm:flex-row">
          <div className="sm:flex-1">
            <textarea
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="输入要翻译的文本..."
              className="h-60 w-full resize-none rounded-lg border border-gray-300 p-4 text-sm shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 sm:h-full"
            />
          </div>
          <div className="hidden w-px bg-gray-200 sm:block" />
          <div className="sm:flex-1">
            <textarea
              value={targetText}
              readOnly
              placeholder="翻译结果将显示在这里..."
              className="h-60 w-full resize-none rounded-lg border border-gray-300 bg-gray-100 p-4 text-sm shadow-sm focus:outline-none sm:h-full"
            />
          </div>
        </section>

        <section className="flex items-center justify-center gap-4">
          <button
            onClick={handleTranslate}
            disabled={translateDisabled}
            className={`rounded-lg px-6 py-2 font-medium text-white transition ${translateDisabled ? "cursor-not-allowed bg-blue-300" : "bg-blue-500 hover:bg-blue-600"}`}
          >
            {isLoading ? "翻译中..." : "翻译"}
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
