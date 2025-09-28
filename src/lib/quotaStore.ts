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

interface StorageAdapter {
	getUsage(dateKey: string): Promise<number>;
	incrementUsage(dateKey: string, meta: UsageMetadata): Promise<number>;
}

const globalForQuota = globalThis as unknown as {
	__redisClient?: RedisClient;
	__memoryQuotaStore?: MemoryQuotaStore;
};

class MemoryQuotaStore implements StorageAdapter {
	private totals = new Map<string, number>();
	private models = new Map<string, Map<string, number>>();
	private requests = new Map<string, number>();

	async getUsage(dateKey: string) {
		this.prune(dateKey);
		return this.totals.get(dateKey) ?? 0;
	}

	async incrementUsage(dateKey: string, meta: UsageMetadata) {
		this.prune(dateKey);

		const tokens = normaliseTokens(meta.tokens);
		const prevTotal = this.totals.get(dateKey) ?? 0;
		const nextTotal = prevTotal + tokens;

		this.totals.set(dateKey, nextTotal);
		this.requests.set(dateKey, (this.requests.get(dateKey) ?? 0) + 1);

		if (meta.model) {
			const modelMap = this.models.get(dateKey) ?? new Map<string, number>();
			modelMap.set(meta.model, (modelMap.get(meta.model) ?? 0) + tokens);
			this.models.set(dateKey, modelMap);
		}

		return nextTotal;
	}

	private prune(currentKey: string) {
		for (const key of this.totals.keys()) {
			if (key !== currentKey) {
				this.totals.delete(key);
				this.models.delete(key);
				this.requests.delete(key);
			}
		}
	}
}

function normaliseTokens(tokens: number) {
	if (!Number.isFinite(tokens) || tokens <= 0) return 0;
	return Math.max(0, Math.round(tokens));
}

async function getRedisClient(): Promise<RedisClient | null> {
	if (!process.env.REDIS_URL) {
		return null;
	}

	if (globalForQuota.__redisClient) {
		return globalForQuota.__redisClient;
	}

	const { createClient } = await import("redis");
	const client = createClient({ url: process.env.REDIS_URL });

	client.on("error", (err: unknown) => {
		console.error("Redis client error", err);
	});

	if (!client.isOpen) {
		await client.connect();
	}

	globalForQuota.__redisClient = client;
	return client;
}

async function getStorage(): Promise<StorageAdapter> {
	const redisClient = await getRedisClient();

	if (redisClient) {
		return createRedisAdapter(redisClient);
	}

	if (!globalForQuota.__memoryQuotaStore) {
		globalForQuota.__memoryQuotaStore = new MemoryQuotaStore();
	}

	return globalForQuota.__memoryQuotaStore;
}

function createRedisAdapter(client: RedisClient): StorageAdapter {
	return {
		async getUsage(dateKey: string) {
			const totalKey = composeKey(dateKey, "total");
			const totalRaw = await client.get(totalKey);
			return totalRaw ? Number(totalRaw) : 0;
		},
		async incrementUsage(dateKey: string, meta: UsageMetadata) {
			const tokens = normaliseTokens(meta.tokens);
			if (tokens === 0) {
				const totalRaw = await client.get(composeKey(dateKey, "total"));
				return totalRaw ? Number(totalRaw) : 0;
			}

			const totalKey = composeKey(dateKey, "total");
			const requestsKey = composeKey(dateKey, "requests");
			const modelsKey = composeKey(dateKey, "models");

			const expireSeconds = secondsUntilNextUtcMidnight(meta.timestamp ?? new Date());

			const multi = client.multi();
			multi.incrBy(totalKey, tokens);
			multi.incr(requestsKey);
			multi.expire(totalKey, expireSeconds, "NX");
			multi.expire(requestsKey, expireSeconds, "NX");

			if (meta.model) {
				multi.hIncrBy(modelsKey, meta.model, tokens);
				multi.expire(modelsKey, expireSeconds, "NX");
			}

			const execResult = await multi.exec();
			if (!execResult) {
				throw new Error("Failed to execute Redis transaction for quota");
			}

			const totalRaw = await client.get(totalKey);
			return totalRaw ? Number(totalRaw) : 0;
		},
	} satisfies StorageAdapter;
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
	const storage = await getStorage();
	const dateKey = currentDateKey(now);
	const used = await storage.getUsage(dateKey);

	return toQuotaStatus(used, now);
}

export async function incrementQuota(meta: UsageMetadata): Promise<QuotaStatus> {
	const timestamp = meta.timestamp ?? new Date();
	const storage = await getStorage();
	const dateKey = currentDateKey(timestamp);
	const total = await storage.incrementUsage(dateKey, {
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

