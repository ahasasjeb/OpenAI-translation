type RedisClient = ReturnType<(typeof import("redis"))["createClient"]>;

export const DAILY_TOKEN_LIMIT = 2_500_000;
const BASE_KEY = "token-usage";

type QuotaKeyType = "total" | "requests" | "models";

interface UsageMetadata {
	model?: string;
	tokens: number;
	timestamp?: Date;
}

export interface QuotaStatus {
	used: number;
	limit: number;
	remaining: number;
	resetAt: string; // ISO 时间（UTC）
	serverTime: string; // ISO 时间（UTC）
}

const globalForQuota = globalThis as unknown as {
	__redisClient?: RedisClient;
};

export class RedisUnavailableError extends Error {
	constructor(message = "Redis 未配置或连接失败") {
		super(message);
		this.name = "RedisUnavailableError";
	}
}

class RedisQuotaStore {
	constructor(private readonly client: RedisClient) {}

	async getUsage(dateKey: string) {
		const totalKey = composeKey(dateKey, "total");
		const totalRaw = await this.client.get(totalKey);
		return totalRaw ? Number(totalRaw) : 0;
	}

	async incrementUsage(dateKey: string, meta: UsageMetadata) {
		const tokens = normaliseTokens(meta.tokens);
		const totalKey = composeKey(dateKey, "total");
		const requestsKey = composeKey(dateKey, "requests");
		const modelsKey = composeKey(dateKey, "models");
		const expireSeconds = secondsUntilNextUtcMidnight(meta.timestamp ?? new Date());

		const multi = this.client.multi();

		if (tokens > 0) {
			multi.incrBy(totalKey, tokens);
		}

		multi.incr(requestsKey);
		multi.expire(totalKey, expireSeconds, "NX");
		multi.expire(requestsKey, expireSeconds, "NX");

		if (meta.model && tokens > 0) {
			multi.hIncrBy(modelsKey, meta.model, tokens);
			multi.expire(modelsKey, expireSeconds, "NX");
		}

		const execResult = await multi.exec();
		if (!execResult) {
			throw new Error("Failed to execute Redis transaction for quota");
		}

		const total = await this.client.get(totalKey);
		return total ? Number(total) : 0;
	}
}

function normaliseTokens(tokens: number) {
	if (!Number.isFinite(tokens) || tokens <= 0) return 0;
	return Math.max(0, Math.round(tokens));
}

async function getRedisClient(): Promise<RedisClient> {
	if (!process.env.REDIS_URL) {
		throw new RedisUnavailableError("REDIS_URL 未配置，无法统计额度");
	}

	if (globalForQuota.__redisClient) {
		return globalForQuota.__redisClient;
	}

	const { createClient } = await import("redis");
	const client = createClient({ url: process.env.REDIS_URL });

	client.on("error", (err: unknown) => {
		console.error("Redis client error", err);
	});

	try {
		if (!client.isOpen) {
			await client.connect();
		}
	} catch (error) {
		throw new RedisUnavailableError(`Redis 连接失败: ${error instanceof Error ? error.message : "未知错误"}`);
	}

	globalForQuota.__redisClient = client;
	return client;
}

async function getQuotaStore() {
	const client = await getRedisClient();
	return new RedisQuotaStore(client);
}

function composeKey(dateKey: string, type: QuotaKeyType) {
	return `${BASE_KEY}:${dateKey}:${type}`;
}

function currentDateKey(now = new Date()) {
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	const day = String(now.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function secondsUntilNextUtcMidnight(now = new Date()) {
	const nextMidnight = new Date(Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + 1,
		0,
		0,
		0,
		0,
	));

	return Math.max(1, Math.floor((nextMidnight.getTime() - now.getTime()) / 1000));
}

export function nextUtcMidnight(now = new Date()) {
	return new Date(Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + 1,
		0,
		0,
		0,
		0,
	));
}

export function nextBeijingReset(now = new Date()) {
	return nextUtcMidnight(now);
}

export async function getQuotaStatus(now = new Date()): Promise<QuotaStatus> {
	const store = await getQuotaStore();
	const dateKey = currentDateKey(now);
	const used = await store.getUsage(dateKey);

	return toQuotaStatus(used, now);
}

export async function incrementQuota(meta: UsageMetadata): Promise<QuotaStatus> {
	const timestamp = meta.timestamp ?? new Date();
	const store = await getQuotaStore();
	const dateKey = currentDateKey(timestamp);
	const total = await store.incrementUsage(dateKey, {
		model: meta.model,
		tokens: meta.tokens,
		timestamp,
	});

	return toQuotaStatus(total, timestamp);
}

export class DailyQuotaExceededError extends Error {
	constructor(message = "Daily token quota exceeded") {
		super(message);
		this.name = "DailyQuotaExceededError";
	}
}

export async function ensureQuotaAvailable(now = new Date()): Promise<QuotaStatus> {
	const status = await getQuotaStatus(now);
	if (status.remaining <= 0) {
		throw new DailyQuotaExceededError();
	}
	return status;
}

function toQuotaStatus(used: number, now: Date): QuotaStatus {
	const limit = DAILY_TOKEN_LIMIT;
	const remaining = Math.max(0, limit - used);
	const resetAtUtc = nextUtcMidnight(now);

	return {
		used,
		limit,
		remaining,
		resetAt: resetAtUtc.toISOString(),
		serverTime: now.toISOString(),
	};
}

