import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { getWebSearchConfigPath, resolveProviderApiUrl, fetchWithCredentialRedirects } from "./utils.ts";

// 知乎开放平台（知乎数据开放平台）站内搜索。
// Docs: https://developer.zhihu.com/docs?key=authorization
// Auth: Authorization: Bearer <Access Secret> + X-Request-Timestamp (seconds).
const ZHIHU_SEARCH_URL = "https://developer.zhihu.com/api/v1/content/zhihu_search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
// The API caps Count at 10 for zhihu_search (20 for global_search).
const MAX_RESULTS = 10;
const SNIPPET_CHARS = 600;

interface WebSearchConfig {
	zhihuBaseUrl?: unknown;
	zhihuApiKey?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await resolveCredential({
		provider: "Zhihu",
		configuredValue: loadConfig().zhihuApiKey,
		environmentValue: process.env.ZHIHU_API_KEY,
		signal,
	});
	if (!apiKey) {
		throw new Error(
			"Zhihu access secret not found. Either:\n" +
			`  1. Add { "zhihuApiKey": "<Access Secret>" } to ${CONFIG_PATH}\n` +
			"  2. Set ZHIHU_API_KEY environment variable\n" +
			"Create one at https://developer.zhihu.com/personal",
		);
	}
	return apiKey;
}

export function isZhihuAvailable(): boolean {
	return hasCredentialSource({
		provider: "Zhihu",
		configuredValue: loadConfig().zhihuApiKey,
		environmentValue: process.env.ZHIHU_API_KEY,
	});
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return MAX_RESULTS;
	return Math.max(1, Math.min(Math.floor(value), MAX_RESULTS));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Zhihu API returned invalid response: ${message}`);
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function numeric(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

interface ZhihuItem {
	Title?: unknown;
	Url?: unknown;
	ContentText?: unknown;
	ContentType?: unknown;
	AuthorName?: unknown;
	AuthorityLevel?: unknown;
	VoteUpCount?: unknown;
	CommentCount?: unknown;
	EditTime?: unknown;
}

interface ParsedItem {
	title: string;
	url: string;
	text: string;
	contentType: string | null;
	author: string | null;
	authority: string | null;
	votes: number | null;
	comments: number | null;
	editedAt: number | null;
}

function parseSearchResponse(value: unknown): ParsedItem[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	const code = numeric(envelope.Code);
	if (code === null) throw invalidResponse("missing Code field");
	if (code !== 0) {
		const message = firstString(envelope.Message) ?? "unknown error";
		if (code === 20001) throw new Error("Zhihu access secret was rejected (Code 20001). Recreate it at https://developer.zhihu.com/personal");
		if (code === 30001 || code === 30002) throw new Error(`Zhihu quota or rate limit reached (Code ${code}): ${message}`);
		if (code === 30003) throw new Error(`Zhihu rejected the request by risk control (Code 30003): ${message}. Do not retry immediately`);
		if (code === 10001) throw new Error(`Zhihu rejected the parameters (Code 10001): ${message}`);
		throw new Error(`Zhihu API error ${code}: ${message}`);
	}
	const data = envelope.Data;
	const items = (data && typeof data === "object" && !Array.isArray(data))
		? (data as Record<string, unknown>).Items
		: undefined;
	if (items === undefined || items === null) {
		const reason = (data && typeof data === "object" && !Array.isArray(data))
			? firstString((data as Record<string, unknown>).EmptyReason)
			: null;
		if (reason) return [];
		throw invalidResponse("missing Data.Items array");
	}
	if (!Array.isArray(items)) throw invalidResponse("Data.Items is not an array");
	const parsed: ParsedItem[] = [];
	for (const raw of items) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const item = raw as ZhihuItem;
		const url = firstString(item.Url);
		if (!url) continue;
		const editedAt = numeric(item.EditTime);
		parsed.push({
			title: firstString(item.Title) ?? url,
			url,
			text: firstString(item.ContentText) ?? "",
			contentType: firstString(item.ContentType),
			author: firstString(item.AuthorName),
			authority: firstString(item.AuthorityLevel),
			votes: numeric(item.VoteUpCount),
			comments: numeric(item.CommentCount),
			editedAt,
		});
	}
	return parsed;
}

interface DomainFilters {
	include: string[];
	exclude: string[];
}

function parseDomainFilter(domainFilter: string[] | undefined): DomainFilters {
	const filters: DomainFilters = { include: [], exclude: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.exclude : filters.include;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function passesDomainFilters(url: string, filters: DomainFilters): boolean {
	if (filters.include.length === 0 && filters.exclude.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	if (filters.exclude.some(matches)) return false;
	return filters.include.length === 0 || filters.include.some(matches);
}

function recencyCutoff(recency: SearchOptions["recencyFilter"]): number | null {
	const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 30 : recency === "year" ? 365 : null;
	if (days === null) return null;
	return Math.floor(Date.now() / 1000) - days * 86_400;
}

function formatDate(unixSeconds: number | null): string | null {
	if (unixSeconds === null || unixSeconds <= 0) return null;
	const date = new Date(unixSeconds * 1000);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString().slice(0, 10);
}

function formatAnswer(items: ParsedItem[]): string {
	return items.map((item, index) => {
		const meta: string[] = [];
		if (item.contentType) meta.push(`类型：${item.contentType}`);
		if (item.author) meta.push(`作者：${item.author}`);
		if (item.authority) meta.push(`权威：${item.authority}`);
		if (item.votes !== null) meta.push(`赞同 ${item.votes}`);
		if (item.comments !== null) meta.push(`评论 ${item.comments}`);
		const date = formatDate(item.editedAt);
		if (date) meta.push(date);
		const lines = [`### ${index + 1}. ${item.title}`];
		if (meta.length > 0) lines.push(`- ${meta.join(" | ")}`);
		lines.push(`- 链接：${item.url}`);
		if (item.text) lines.push("", truncate(item.text, SNIPPET_CHARS));
		return lines.join("\n");
	}).join("\n\n");
}

export async function searchWithZhihu(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	if (!query.trim()) throw new Error("Zhihu search query must not be empty");
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeCount(options.numResults);
	// Ask for a little more than requested so local filters can still fill the page.
	const requestCount = Math.min(MAX_RESULTS, Math.max(numResults, Math.min(numResults * 2, MAX_RESULTS)));
	const url = new URL(resolveProviderApiUrl("zhihu", ZHIHU_SEARCH_URL, loadConfig().zhihuBaseUrl));
	url.searchParams.set("Query", query.trim());
	url.searchParams.set("Count", String(requestCount));

	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetchWithCredentialRedirects(url.toString(), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		}, ["Authorization"]);
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Zhihu API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Zhihu API returned invalid JSON: ${errorMessage(err)}`);
	}
	let items: ParsedItem[];
	try {
		items = parseSearchResponse(rawData);
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
	activityMonitor.logComplete(activityId, response.status);

	const filters = parseDomainFilter(options.domainFilter);
	const cutoff = recencyCutoff(options.recencyFilter);
	const kept = items
		.filter((item) => passesDomainFilters(item.url, filters))
		.filter((item) => cutoff === null || item.editedAt === null || item.editedAt === 0 || item.editedAt >= cutoff)
		.slice(0, numResults);

	if (kept.length === 0) {
		return { answer: "知乎没有匹配内容。", results: [] };
	}
	return {
		answer: formatAnswer(kept),
		results: kept.map((item) => ({
			title: item.title,
			url: item.url,
			snippet: truncate(item.text, SNIPPET_CHARS),
		})),
	};
}
