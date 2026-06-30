import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/**
 * Provider usage meter for Pi.
 *
 * Shows a compact footer status for the currently selected provider,
 * updating every minute so the countdown keeps ticking even when the
 * agent is idle (e.g. while you wait for a quota to reset).
 *
 * Supported providers:
 *   - Z.ai (provider ids: "zai", "zai-coding-cn")
 *   - Kimi for Coding (provider id: "kimi-coding")
 */

const STATUS_KEY = "provider-usage";
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

type UsageWindow = {
	label: string;
	percentage: number;
	resetInMs?: number;
};

type UsageData = {
	windows: UsageWindow[];
};

type ProviderSpec = {
	id: string;
	label: string;
	matches: (provider: string) => boolean;
	authProvider: string;
	fetchUsage: (ctx: ExtensionContext) => Promise<UsageData>;
};

// -------------------------------------------------------------------------
// Number / time helpers
// -------------------------------------------------------------------------

function toNum(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value.trim());
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function usagePct(limit?: number, used?: number, remaining?: number): number | undefined {
	if (limit === undefined || limit <= 0) return undefined;
	if (used !== undefined) {
		return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
	}
	if (remaining !== undefined) {
		return Math.max(0, Math.min(100, Math.round(((limit - remaining) / limit) * 100)));
	}
	return undefined;
}

function timeUntil(reset?: string | number): number | undefined {
	if (reset === undefined || reset === null || reset === "") return undefined;
	const at = typeof reset === "number" ? reset : Date.parse(reset);
	if (!Number.isFinite(at)) return undefined;
	return Math.max(0, at - Date.now());
}

function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
	if (totalMinutes <= 0) return "soon";
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes && !days) parts.push(`${minutes}m`);
	return parts.length ? parts.join("") : "soon";
}

function zaiWindowLabel(resetInMs?: number): string | undefined {
	if (resetInMs === undefined) return undefined;
	const DAY_MS = 24 * 60 * 60 * 1000;
	return resetInMs < DAY_MS ? "5h" : "wk";
}

function kimiWindowLabel(duration?: number, unit?: string): string {
	if (!duration || !unit) return "window";
	const u = unit.toUpperCase();
	if (u.includes("MINUTE")) {
		return duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
	}
	if (u.includes("HOUR")) return `${duration}h`;
	if (u.includes("DAY")) return `${duration}d`;
	return `${duration}`;
}

function colorForPercentage(theme: Theme, pct?: number): (text: string) => string {
	if (pct === undefined) return (s) => theme.fg("dim", s);
	if (pct >= 90) return (s) => theme.fg("error", s);
	if (pct >= 70) return (s) => theme.fg("warning", s);
	return (s) => theme.fg("success", s);
}

// -------------------------------------------------------------------------
// Z.ai usage fetcher
// -------------------------------------------------------------------------

type ZaiLimit = {
	type?: string;
	percentage?: number;
	nextResetTime?: number;
};

type ZaiResponse = {
	code?: number;
	msg?: string;
	success?: boolean;
	data?: {
		limits?: ZaiLimit[];
	};
};

async function fetchZaiUsage(ctx: ExtensionContext, endpoint: string, authProvider: string): Promise<UsageData> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(authProvider);
	if (!apiKey) throw new Error("no API key");

	const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(endpoint, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Accept-Encoding": "identity",
		},
		signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
	}

	const parsed = (await response.json()) as ZaiResponse;
	if (typeof parsed.success === "boolean" && !parsed.success && parsed.msg) {
		throw new Error(parsed.msg);
	}

	const allLimits = parsed.data?.limits ?? [];
	const tokenLimits = allLimits.filter((limit) => limit.type === "TOKENS_LIMIT");

	return {
		windows: tokenLimits.map((limit) => {
			const resetInMs = limit.nextResetTime ? limit.nextResetTime - Date.now() : undefined;
			return {
				label: zaiWindowLabel(resetInMs) ?? "window",
				percentage: typeof limit.percentage === "number" ? limit.percentage : 0,
				resetInMs,
			};
		}),
	};
}

// -------------------------------------------------------------------------
// Kimi for Coding usage fetcher
// -------------------------------------------------------------------------

type KimiUsage = {
	limit?: string | number;
	used?: string | number;
	remaining?: string | number;
	resetTime?: string;
	reset_at?: string;
};

type KimiLimit = {
	window?: {
		duration?: number;
		timeUnit?: string;
	};
	detail?: KimiUsage;
};

type KimiResponse = {
	usage?: KimiUsage;
	limits?: KimiLimit[];
};

function kimiUsageUrl(): string {
	const base = process.env.KIMI_CODE_BASE_URL?.trim();
	if (base) {
		return `${base.replace(/\/+$/, "")}/usages`;
	}
	return "https://api.kimi.com/coding/v1/usages";
}

async function fetchKimiUsage(ctx: ExtensionContext): Promise<UsageData> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("kimi-coding");
	if (!apiKey) throw new Error("no API key");

	const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(kimiUsageUrl(), {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Accept-Encoding": "identity",
		},
		signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
	}

	const data = (await response.json()) as KimiResponse;
	const windows: UsageWindow[] = [];

	const weeklyLimit = toNum(data.usage?.limit);
	const weeklyUsed = toNum(data.usage?.used);
	const weeklyRemaining = toNum(data.usage?.remaining);
	const weeklyPct = usagePct(weeklyLimit, weeklyUsed, weeklyRemaining);
	if (weeklyPct !== undefined) {
		windows.push({
			label: "7d",
			percentage: weeklyPct,
			resetInMs: timeUntil(data.usage?.resetTime || data.usage?.reset_at),
		});
	}

	const rate = data.limits?.[0];
	if (rate) {
		const rateLimit = toNum(rate.detail?.limit);
		const rateUsed = toNum(rate.detail?.used);
		const rateRemaining = toNum(rate.detail?.remaining);
		const ratePct = usagePct(rateLimit, rateUsed, rateRemaining);
		if (ratePct !== undefined) {
			windows.push({
				label: kimiWindowLabel(rate.window?.duration, rate.window?.timeUnit),
				percentage: ratePct,
				resetInMs: timeUntil(rate.detail?.resetTime || rate.detail?.reset_at),
			});
		}
	}

	return { windows };
}

// -------------------------------------------------------------------------
// Provider specs
// -------------------------------------------------------------------------

const providers: ProviderSpec[] = [
	{
		id: "zai",
		label: "Z.ai",
		matches: (p) => p === "zai",
		authProvider: "zai",
		fetchUsage: (ctx) => fetchZaiUsage(ctx, "https://api.z.ai/api/monitor/usage/quota/limit", "zai"),
	},
	{
		id: "zai-cn",
		label: "Z.ai CN",
		matches: (p) => p === "zai-coding-cn",
		authProvider: "zai-coding-cn",
		fetchUsage: (ctx) => fetchZaiUsage(ctx, "https://api.z.ai/api/monitor/usage/quota/limit", "zai-coding-cn"),
	},
	{
		id: "kimi-coding",
		label: "Kimi",
		matches: (p) => p === "kimi-coding",
		authProvider: "kimi-coding",
		fetchUsage: fetchKimiUsage,
	},
];

function currentSpec(ctx: ExtensionContext): ProviderSpec | undefined {
	const provider = ctx.model?.provider;
	if (!provider) return undefined;
	return providers.find((p) => p.matches(provider));
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------

function renderStatus(providerLabel: string, data: UsageData, theme: Theme): string {
	if (data.windows.length === 0) {
		return `${theme.fg("muted", `${providerLabel}:`)}${theme.fg("dim", " <no data>")}`;
	}

	const segments = data.windows.map((w) => {
		const pct = Math.round(w.percentage * 10) / 10;
		const color = colorForPercentage(theme, pct);
		let seg = color(`${w.label} ${pct}%`);
		if (w.resetInMs !== undefined && w.resetInMs > 0) {
			seg += ` ${theme.fg("dim", `(${formatDuration(w.resetInMs)})`)}`;
		}
		return seg;
	});

	const sep = ` ${theme.fg("dim", "·")} `;
	return `${theme.fg("muted", `${providerLabel}:`)} ${segments.join(sep)}`;
}

function renderError(providerLabel: string, error: unknown, theme: Theme): string {
	const code = error instanceof Error ? error.message : "error";
	return `${theme.fg("muted", `${providerLabel}:`)}${theme.fg("warning", ` <${code}>`)}`;
}

// -------------------------------------------------------------------------
// Runtime state
// -------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | undefined;
let generation = 0;
let inFlight: Promise<void> | undefined;

function clearTimer() {
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
}

function startTimer(ctx: ExtensionContext) {
	clearTimer();
	const myGeneration = ++generation;
	timer = setInterval(() => {
		if (generation !== myGeneration) return;
		void render(ctx);
	}, REFRESH_MS);
}

async function render(ctx: ExtensionContext) {
	const spec = currentSpec(ctx);
	if (!spec) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	if (inFlight) {
		// Already fetching; skip this tick. The next minute will catch up.
		return;
	}

	const promise = (async () => {
		try {
			const data = await spec.fetchUsage(ctx);
			ctx.ui.setStatus(STATUS_KEY, renderStatus(spec.label, data, ctx.ui.theme));
		} catch (error) {
			if (error instanceof Error && error.message === "no API key") {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `${spec.label}: no API key`));
			} else {
				ctx.ui.setStatus(STATUS_KEY, renderError(spec.label, error, ctx.ui.theme));
			}
		}
	})();

	inFlight = promise;
	try {
		await promise;
	} finally {
		if (inFlight === promise) {
			inFlight = undefined;
		}
	}
}

// -------------------------------------------------------------------------
// Extension entry point
// -------------------------------------------------------------------------

export default function piUsageMeterExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		startTimer(ctx);
		await render(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await render(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await render(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generation++;
		clearTimer();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("usage", {
		description: "Refresh the provider usage meter",
		handler: async (_args, ctx) => {
			await render(ctx);
			ctx.ui.notify("Usage meter refreshed", "info");
		},
	});
}
