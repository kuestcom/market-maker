import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

const SITE_CONFIG_PATH = ".sdk/site-config.json";
const SITE_EVENTS_LIMIT = 100;
const CONDITION_ID_KEYS = ["condition_id", "conditionId", "conditionID", "c"];
const CLOB_TOKEN_LIST_KEYS = [
  "clob_token_ids",
  "clobTokenIds",
  "outcome_assets",
  "outcomeAssets",
];
const NESTED_MARKET_KEYS = ["markets", "outcomes", "tokens"];

export async function conditionIdsFromSiteConfig(
  eventSlug: string,
  maxPages: number,
): Promise<Set<string>> {
  const siteUrl = await siteUrlFromConfig(SITE_CONFIG_PATH);
  const events = await fetchSiteEvents(siteUrl, maxPages);
  const conditionIds = new Set<string>();

  for (const event of events) {
    if (event.slug !== eventSlug || !Array.isArray(event.markets)) {
      continue;
    }
    for (const market of event.markets) {
      if (!isRecord(market) || !isClobMarketEntry(market)) {
        continue;
      }
      const conditionId = conditionIdFromMarket(market);
      if (conditionId) {
        conditionIds.add(conditionId);
      }
    }
  }

  return conditionIds;
}

export function conditionIdFromMarket(market: JsonRecord): string | undefined {
  for (const key of CONDITION_ID_KEYS) {
    const value = market[key];
    if (value !== undefined && value !== null) {
      return String(value);
    }
  }
  return undefined;
}

async function siteUrlFromConfig(path: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to parse ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed) || typeof parsed.site_url !== "string") {
    throw new Error(`${path}.site_url must be a string`);
  }

  const siteUrl = parsed.site_url.trim();
  if (!siteUrl) {
    throw new Error(`${path}.site_url must not be empty`);
  }
  return siteUrl.startsWith("http://") || siteUrl.startsWith("https://")
    ? siteUrl
    : `https://${siteUrl}`;
}

async function fetchSiteEvents(
  siteUrl: string,
  maxPages: number,
): Promise<JsonRecord[]> {
  const events: JsonRecord[] = [];
  for (let page = 0; page < Math.max(maxPages, 1); page += 1) {
    const url = siteEventsUrl(siteUrl, page);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`site events request failed for ${url}: HTTP ${response.status}`);
    }
    const pageEvents: unknown = await response.json();
    if (!Array.isArray(pageEvents)) {
      throw new Error("site-scoped market discovery expected /api/events to return an array");
    }
    events.push(...pageEvents.filter(isRecord));
    if (pageEvents.length < SITE_EVENTS_LIMIT) {
      break;
    }
  }
  return events;
}

function siteEventsUrl(siteUrl: string, page: number): string {
  const url = new URL("api/events", withTrailingSlash(siteUrl));
  url.searchParams.set("status", "active");
  url.searchParams.set("includeBookmarkState", "false");
  url.searchParams.set("limit", String(SITE_EVENTS_LIMIT));
  url.searchParams.set("offset", String(page * SITE_EVENTS_LIMIT));
  return url.toString();
}

function isClobMarketEntry(market: JsonRecord): boolean {
  if (!conditionIdFromMarket(market)) {
    return false;
  }
  if (boolField(market, "enable_order_book")) {
    return true;
  }
  return hasTokenEvidence(market);
}

function hasTokenEvidence(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasTokenEvidence);
  }
  if (!isRecord(value)) {
    return false;
  }

  for (const key of CLOB_TOKEN_LIST_KEYS) {
    const tokens = value[key];
    if (Array.isArray(tokens) && tokens.length > 0) {
      return true;
    }
  }
  for (const key of NESTED_MARKET_KEYS) {
    if (hasTokenEvidence(value[key])) {
      return true;
    }
  }
  return false;
}

function boolField(source: JsonRecord, name: string): boolean {
  const value = source[name];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
