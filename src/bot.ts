import { setTimeout as sleep } from "node:timers/promises";
import { ethers } from "ethers";
import { ClobClient } from "../vendor/clob-client/dist/client.js";
import { END_CURSOR, INITIAL_CURSOR } from "../vendor/clob-client/dist/constants.js";
import { SignatureType } from "../vendor/clob-client/dist/order-utils/model/signature-types.model.js";
import {
  type ApiKeyCreds,
  Chain,
  type OrderBookSummary,
  type OrderResponse,
  type OrderSummary,
  OrderType,
  type PaginationPayload,
  Side,
} from "../vendor/clob-client/dist/types.js";
import {
  type Config,
  type DiscoveryMode,
  includesBuy,
  includesSell,
} from "./config.js";
import { fairPrice, quotePrices } from "./pricing.js";
import {
  loadSeenMarkets,
  markNew,
  saveSeenMarkets,
  type SeenMarkets,
} from "./state.js";

type Market = Record<string, unknown>;
type Token = Record<string, unknown>;

interface MarketCandidate {
  market: Market;
  isNew: boolean;
}

interface QuotePlan {
  marketKey: string;
  marketSlug: string;
  question: string;
  tokenId: string;
  outcome: string;
  fairPrice: number;
  bestBid?: number;
  bestAsk?: number;
  buyPrice?: number;
  sellPrice?: number;
  size: number;
}

export async function run(config: Config): Promise<void> {
  const publicClient = new ClobClient(
    config.clobHost,
    (config.chainId ?? Chain.AMOY) as Chain,
  );
  const liveClient = config.live ? await authenticate(config) : undefined;
  const seen = await loadSeenMarkets(config.statePath);

  for (let cycle = 1; cycle <= config.cycles; cycle += 1) {
    console.log(`cycle ${cycle}/${config.cycles}: discovering markets`);

    const markets = await discoverMarkets(
      publicClient,
      config.discovery,
      config.maxPages,
    );
    const candidates = selectCandidates(markets, seen, config.maxMarkets);
    await saveSeenMarkets(config.statePath, seen);

    const newCount = candidates.filter((candidate) => candidate.isNew).length;
    console.log(
      `found ${candidates.length} tradable fork-scoped markets (${newCount} new)`,
    );

    for (const candidate of candidates) {
      const marker = candidate.isNew ? "new" : "seen";
      console.log(
        `- [${marker}] ${marketKey(candidate.market)} :: ${marketQuestion(candidate.market)}`,
      );
    }

    if (config.discoverOnly) {
      continue;
    }

    for (const candidate of candidates) {
      await quoteMarket(publicClient, liveClient, candidate.market, config);
    }

    if (cycle < config.cycles) {
      await sleep(config.refreshSecs * 1000);
    }
  }
}

async function authenticate(config: Config): Promise<ClobClient> {
  const wallet = new ethers.Wallet(config.privateKey ?? "");
  const chainId = config.chainId as Chain;
  const l1Client = new ClobClient(
    config.clobHost,
    chainId,
    wallet,
    undefined,
    SignatureType.DEPOSIT_WALLET,
    config.depositWallet,
    undefined,
    true,
  );
  const creds: ApiKeyCreds = await l1Client.createOrDeriveApiKey();
  return new ClobClient(
    config.clobHost,
    chainId,
    wallet,
    creds,
    SignatureType.DEPOSIT_WALLET,
    config.depositWallet,
    undefined,
    true,
  );
}

export async function discoverMarkets(
  client: ClobClient,
  mode: DiscoveryMode,
  maxPages: number,
): Promise<Market[]> {
  if (mode === "auto") {
    const sampling = await fetchMarketPages(client, "sampling", maxPages);
    return sampling.length > 0
      ? sampling
      : fetchMarketPages(client, "site", maxPages);
  }

  return fetchMarketPages(client, mode, maxPages);
}

export async function fetchMarketPages(
  client: ClobClient,
  mode: Exclude<DiscoveryMode, "auto">,
  maxPages: number,
): Promise<Market[]> {
  let cursor = INITIAL_CURSOR;
  const markets: Market[] = [];

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const previousCursor = cursor;
    const page: PaginationPayload =
      mode === "sampling"
        ? await client.getSamplingMarkets(cursor)
        : await client.getMarkets(cursor);

    if (Array.isArray(page.data)) {
      markets.push(...page.data.filter(isMarket));
    }

    cursor = String(page.next_cursor || END_CURSOR);
    if (cursor === END_CURSOR || cursor === previousCursor) {
      break;
    }
  }

  return markets;
}

export function selectCandidates(
  markets: Market[],
  seen: SeenMarkets,
  maxMarkets: number,
): MarketCandidate[] {
  const candidates = markets.filter(isTradableMarket).map((market) => ({
    market,
    isNew: markNew(seen, marketKey(market)),
  }));

  candidates.sort((left, right) => {
    if (left.isNew !== right.isNew) {
      return left.isNew ? -1 : 1;
    }
    if (hasRewards(left.market) !== hasRewards(right.market)) {
      return hasRewards(left.market) ? -1 : 1;
    }
    const rightTimestamp = timestampSortValue(
      field(right.market, "accepting_order_timestamp"),
    );
    const leftTimestamp = timestampSortValue(
      field(left.market, "accepting_order_timestamp"),
    );
    if (rightTimestamp !== leftTimestamp) {
      return rightTimestamp - leftTimestamp;
    }
    return marketSlug(left.market).localeCompare(marketSlug(right.market));
  });

  return candidates.slice(0, maxMarkets);
}

export function isTradableMarket(market: Market): boolean {
  return (
    boolField(market, "enable_order_book") &&
    boolField(market, "active") &&
    !boolField(market, "closed") &&
    !boolField(market, "archived") &&
    boolField(market, "accepting_orders") &&
    marketTokens(market).length > 0
  );
}

export function hasRewards(market: Market): boolean {
  const rewards = dictField(market, "rewards");
  const rates = rewards.rates;
  const minSize = numberOrDefault(rewards.min_size, 0);
  return (Array.isArray(rates) && rates.length > 0) || minSize > 0;
}

export function marketKey(market: Market): string {
  return (
    stringOrUndefined(
      field(market, "condition_id", "conditionId", "conditionID", "c"),
    ) ?? marketSlug(market)
  );
}

async function quoteMarket(
  publicClient: ClobClient,
  liveClient: ClobClient | undefined,
  market: Market,
  config: Config,
): Promise<void> {
  for (const token of marketTokens(market)) {
    const tokenId = tokenIdFromToken(token);
    if (!tokenId) {
      continue;
    }

    const book = await publicClient.getOrderBook(tokenId);
    const plan = buildQuotePlan(market, token, book, config);
    if (!plan) {
      console.log(
        `skip ${marketSlug(market)} ${tokenOutcome(token)}: no safe quote at configured edge/sides`,
      );
      continue;
    }

    printPlan(plan, config.live);
    if (liveClient) {
      await postQuotePlan(liveClient, plan, config);
    }
  }
}

export function buildQuotePlan(
  market: Market,
  token: Token,
  book: OrderBookSummary,
  config: Config,
): QuotePlan | undefined {
  const bestBidPrice = bestBid(book.bids ?? []);
  const bestAskPrice = bestAsk(book.asks ?? []);
  const fair = fairPrice(
    bestBidPrice,
    bestAskPrice,
    numberOrDefault(field(token, "price", "p"), 0),
    numberOrUndefined(book.last_trade_price),
  );
  const tick = numberOrDefault(book.tick_size, 0.01);
  let [buyPrice, sellPrice] = quotePrices(
    fair,
    bestBidPrice,
    bestAskPrice,
    tick,
    config.edgeTicks,
    config.minSpreadTicks,
  );

  if (!includesBuy(config.quoteSides)) {
    buyPrice = undefined;
  }
  if (!includesSell(config.quoteSides)) {
    sellPrice = undefined;
  }
  if (
    !config.allowSingleSided &&
    (buyPrice === undefined || sellPrice === undefined)
  ) {
    return undefined;
  }
  if (
    buyPrice !== undefined &&
    sellPrice !== undefined &&
    buyPrice >= sellPrice
  ) {
    buyPrice = undefined;
    sellPrice = undefined;
  }
  if (buyPrice === undefined && sellPrice === undefined) {
    return undefined;
  }

  return {
    marketKey: marketKey(market),
    marketSlug: marketSlug(market),
    question: marketQuestion(market),
    tokenId: tokenIdFromToken(token),
    outcome: tokenOutcome(token),
    fairPrice: fair,
    bestBid: bestBidPrice,
    bestAsk: bestAskPrice,
    buyPrice,
    sellPrice,
    size: orderSize(market, config),
  };
}

export function orderSize(market: Market, config: Config): number {
  let size = Math.max(
    config.orderSize,
    numberOrDefault(field(market, "minimum_order_size"), 0),
  );
  if (config.respectRewardMinSize) {
    size = Math.max(
      size,
      numberOrDefault(dictField(market, "rewards").min_size, 0),
    );
  }
  return size;
}

function printPlan(plan: QuotePlan, live: boolean): void {
  const mode = live ? "live" : "dry-run";
  console.log(
    `${mode}: ${plan.marketKey} :: ${plan.marketSlug} :: ${plan.question} :: ${plan.outcome} ` +
      `(${plan.tokenId}) fair=${plan.fairPrice} bid=${plan.bestBid} ask=${plan.bestAsk} ` +
      `buy=${plan.buyPrice} sell=${plan.sellPrice} size=${plan.size}`,
  );
}

async function postQuotePlan(
  client: ClobClient,
  plan: QuotePlan,
  config: Config,
): Promise<void> {
  if (config.cancelBeforeQuote) {
    const response = await client.cancelMarketOrders({
      asset_id: plan.tokenId,
    });
    const canceled = responseList(response, "canceled");
    const notCanceled = responseList(response, "not_canceled");
    if (canceled.length > 0 || notCanceled.length > 0) {
      console.log(
        `canceled stale orders for ${plan.tokenId}: canceled=${canceled.length} not_canceled=${notCanceled.length}`,
      );
    }
  }

  const responses: Array<[Side, OrderResponse]> = [];
  if (plan.buyPrice !== undefined) {
    const order = await client.createOrder({
      tokenID: plan.tokenId,
      price: plan.buyPrice,
      size: plan.size,
      side: Side.BUY,
    });
    responses.push([
      Side.BUY,
      await client.postOrder(order, OrderType.GTC, false, config.postOnly),
    ]);
  }
  if (plan.sellPrice !== undefined) {
    const order = await client.createOrder({
      tokenID: plan.tokenId,
      price: plan.sellPrice,
      size: plan.size,
      side: Side.SELL,
    });
    responses.push([
      Side.SELL,
      await client.postOrder(order, OrderType.GTC, false, config.postOnly),
    ]);
  }

  printPostResponses(plan, responses);
}

function printPostResponses(
  plan: QuotePlan,
  responses: Array<[Side, OrderResponse]>,
): void {
  for (const [side, response] of responses) {
    console.log(
      `posted ${plan.marketSlug} ${plan.outcome} side=${side} order_id=${response.orderID} ` +
        `success=${response.success} status=${response.status} error=${response.errorMsg}`,
    );
  }
}

export function bestBid(levels: OrderSummary[]): number | undefined {
  const prices = levels
    .map((level) => numberOrUndefined(level.price))
    .filter(isNumber);
  return prices.length > 0 ? Math.max(...prices) : undefined;
}

export function bestAsk(levels: OrderSummary[]): number | undefined {
  const prices = levels
    .map((level) => numberOrUndefined(level.price))
    .filter(isNumber);
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

function isMarket(value: unknown): value is Market {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function marketSlug(market: Market): string {
  return stringOrUndefined(field(market, "market_slug", "slug")) ?? "unknown";
}

function marketQuestion(market: Market): string {
  return stringOrUndefined(field(market, "question", "title")) ?? "";
}

function marketTokens(market: Market): Token[] {
  const tokens = field(market, "tokens", "outcomes");
  return Array.isArray(tokens) ? tokens.filter(isMarket) : [];
}

function tokenIdFromToken(token: Token): string {
  return (
    stringOrUndefined(
      field(token, "token_id", "tokenId", "asset_id", "assetId", "t"),
    ) ?? ""
  );
}

function tokenOutcome(token: Token): string {
  return stringOrUndefined(field(token, "outcome", "name", "label", "o")) ?? "";
}

function field(source: Market, ...names: string[]): unknown {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function dictField(source: Market, name: string): Market {
  const value = source[name];
  return isMarket(value) ? value : {};
}

function boolField(source: Market, name: string): boolean {
  const value = source[name];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function numberOrDefault(value: unknown, fallback: number): number {
  return numberOrUndefined(value) ?? fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function responseList(response: unknown, key: string): unknown[] {
  if (!isMarket(response)) {
    return [];
  }
  const value = response[key];
  return Array.isArray(value) ? value : [];
}

function timestampSortValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  const text = stringOrUndefined(value)?.trim();
  if (!text) {
    return 0;
  }
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}
