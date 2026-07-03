import { setTimeout as sleep } from "node:timers/promises";
import { ethers } from "ethers";
import { ClobClient } from "../vendor/clob-client/dist/client.js";
import { END_CURSOR, INITIAL_CURSOR } from "../vendor/clob-client/dist/constants.js";
import { SignatureType } from "../vendor/clob-client/dist/order-utils/model/signature-types.model.js";
import {
  AssetType,
  type ApiKeyCreds,
  Chain,
  type OpenOrder,
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
import { conditionIdFromMarket, conditionIdsFromSiteConfig } from "./event-scope.js";
import { fairPrice, quotePrices } from "./pricing.js";
import {
  loadSeenMarkets,
  markNew,
  saveSeenMarkets,
  type SeenMarkets,
} from "./state.js";

type Market = Record<string, unknown>;
type Token = Record<string, unknown>;
const CONDITIONAL_TOKEN_BASE_UNITS = 1_000_000;

interface MarketCandidate {
  market: Market;
  isNew: boolean;
}

export interface QuotePlan {
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

interface TokenQuote {
  tokenId: string;
  fairPrice: number;
  plan?: QuotePlan;
  skipReason?: string;
}

class LiveMarketState {
  constructor(
    private readonly tokens: LiveTokenState[],
    private readonly pendingOrders: ProposedOrder[] = [],
  ) {}

  static async load(
    client: ClobClient,
    tokenQuotes: TokenQuote[],
  ): Promise<LiveMarketState> {
    const tokens: LiveTokenState[] = [];
    for (const tokenQuote of tokenQuotes) {
      tokens.push({
        tokenId: tokenQuote.tokenId,
        fairPrice: tokenQuote.fairPrice,
        balance: await conditionalBalance(client, tokenQuote.tokenId),
        openOrders: await openOrdersForToken(client, tokenQuote.tokenId),
      });
    }
    return new LiveMarketState(tokens);
  }

  openOrders(tokenId: string): OpenOrder[] {
    return [...this.tokenState(tokenId).openOrders];
  }

  tokenBalance(tokenId: string): number {
    return this.tokenState(tokenId).balance;
  }

  replaceOpenOrders(tokenId: string, openOrders: OpenOrder[]): void {
    this.tokenState(tokenId).openOrders = [...openOrders];
  }

  recordPendingOrder(order: ProposedOrder): void {
    this.pendingOrders.push(order);
  }

  projectedLoss(order: ProposedOrder): number {
    const exposure = this.exposure();
    exposure.applyOrder(order);
    return exposure.worstLoss();
  }

  private exposure(): MarketExposure {
    const exposure = new MarketExposure(
      this.tokens.map((token) => ({
        tokenId: token.tokenId,
        position: token.balance,
        cost: token.balance * token.fairPrice,
        proceeds: 0,
      })),
    );

    for (const token of this.tokens) {
      for (const order of token.openOrders) {
        const proposed = proposedOrderFromOpenOrder(order, token.tokenId);
        if (proposed) {
          exposure.applyKnownOrder(proposed);
        }
      }
    }
    for (const order of this.pendingOrders) {
      exposure.applyKnownOrder(order);
    }
    return exposure;
  }

  private tokenState(tokenId: string): LiveTokenState {
    const token = this.tokens.find((state) => state.tokenId === tokenId);
    if (!token) {
      throw new Error(`missing live market state for token ${tokenId}`);
    }
    return token;
  }
}

interface LiveTokenState {
  tokenId: string;
  fairPrice: number;
  balance: number;
  openOrders: OpenOrder[];
}

interface ProposedOrder {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
}

interface OutcomeExposure {
  tokenId: string;
  position: number;
  cost: number;
  proceeds: number;
}

export class MarketExposure {
  constructor(private readonly outcomes: OutcomeExposure[]) {}

  applyOrder(order: ProposedOrder): void {
    const outcome = this.outcomes.find((item) => item.tokenId === order.tokenId);
    if (!outcome) {
      throw new Error(`missing exposure state for token ${order.tokenId}`);
    }
    applyOrderToOutcome(outcome, order);
  }

  applyKnownOrder(order: ProposedOrder): void {
    const outcome = this.outcomes.find((item) => item.tokenId === order.tokenId);
    if (outcome) {
      applyOrderToOutcome(outcome, order);
    }
  }

  worstLoss(): number {
    const cost = this.outcomes.reduce((total, outcome) => total + outcome.cost, 0);
    const proceeds = this.outcomes.reduce(
      (total, outcome) => total + outcome.proceeds,
      0,
    );
    const worstResolutionPayout =
      this.outcomes.length > 1
        ? Math.min(...this.outcomes.map((outcome) => outcome.position))
        : 0;
    return Math.max(cost - proceeds - worstResolutionPayout, 0);
  }
}

export class RiskBudget {
  private remaining: number;
  private readonly countedOpenBuyOrders = new Set<string>();

  constructor(collateralLimit: number) {
    this.remaining = Math.max(collateralLimit, 0);
  }

  remainingCollateral(): number {
    return Math.max(this.remaining, 0);
  }

  reserveOpenBuyOrder(order: OpenOrder): void {
    if (order.side !== Side.BUY || this.countedOpenBuyOrders.has(order.id)) {
      return;
    }
    this.countedOpenBuyOrders.add(order.id);
    this.remaining = Math.max(
      this.remaining - openOrderRemainingSize(order) * numberOrDefault(order.price, 0),
      0,
    );
  }

  reserveNewCollateral(requested: number): number {
    const reserved = Math.min(Math.max(requested, 0), this.remainingCollateral());
    this.remaining = Math.max(this.remaining - reserved, 0);
    return reserved;
  }
}

interface BuyTopUpPlace {
  kind: "place";
  size: number;
  collateral: number;
}

interface BuyTopUpSkip {
  kind: "skip";
  affordableSize: number;
}

type BuyTopUpDecision = BuyTopUpPlace | BuyTopUpSkip;

type LiquidityRejectReason =
  | { kind: "missingTwoSidedBook" }
  | { kind: "invalidTick" }
  | { kind: "spreadTooWide"; spreadTicks: number; maxSpreadTicks: number }
  | { kind: "bidDepthTooLow"; depth: number; minDepth: number }
  | { kind: "askDepthTooLow"; depth: number; minDepth: number };

export async function run(config: Config): Promise<void> {
  const publicClient = new ClobClient(
    config.clobHost,
    (config.chainId ?? Chain.AMOY) as Chain,
  );
  const liveClient = config.live ? await authenticate(config) : undefined;
  const seen = await loadSeenMarkets(config.statePath);

  for (let cycle = 1; cycle <= config.cycles; cycle += 1) {
    const eventSlug = config.eventSlug?.trim();
    let candidates: MarketCandidate[];
    if (eventSlug) {
      console.log(
        `cycle ${cycle}/${config.cycles}: discovering markets for event ${eventSlug}`,
      );
      const markets = await discoverEventMarkets(publicClient, eventSlug, config.maxPages);
      candidates = selectEventCandidates(markets, config.maxMarkets);
      console.log(`event ${eventSlug}: found ${candidates.length} tradable markets`);
    } else {
      console.log(`cycle ${cycle}/${config.cycles}: discovering markets`);
      const markets = await discoverMarkets(
        publicClient,
        config.discovery,
        config.maxPages,
      );
      candidates = selectCandidates(markets, seen, config.maxMarkets);
      await saveSeenMarkets(config.statePath, seen);

      const newCount = candidates.filter((candidate) => candidate.isNew).length;
      console.log(
        `found ${candidates.length} tradable fork-scoped markets (${newCount} new)`,
      );
    }

    for (const candidate of candidates) {
      const marker = candidate.isNew ? "new" : "seen";
      console.log(
        `- [${marker}] ${marketKey(candidate.market)} :: ${marketQuestion(candidate.market)}`,
      );
    }

    if (config.discoverOnly) {
      continue;
    }

    const riskBudget = new RiskBudget(config.maxTotalCollateral);
    for (const candidate of candidates) {
      await quoteMarket(publicClient, liveClient, candidate.market, config, riskBudget);
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

export async function discoverEventMarkets(
  client: ClobClient,
  eventSlug: string,
  maxPages: number,
): Promise<Market[]> {
  const conditionIds = await conditionIdsFromSiteConfig(eventSlug, maxPages);
  const markets: Market[] = [];
  for (const conditionId of [...conditionIds].sort()) {
    const market = await client.getMarket(conditionId);
    if (isMarket(market)) {
      markets.push(market);
    }
  }
  return markets;
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

  sortCandidates(candidates);

  return candidates.slice(0, maxMarkets);
}

export function selectEventCandidates(
  markets: Market[],
  maxMarkets: number,
): MarketCandidate[] {
  const candidates = markets.filter(isTradableMarket).map((market) => ({
    market,
    isNew: false,
  }));

  sortCandidates(candidates);

  return candidates.slice(0, maxMarkets);
}

function sortCandidates(candidates: MarketCandidate[]): void {
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
  return conditionIdFromMarket(market) ?? marketSlug(market);
}

async function quoteMarket(
  publicClient: ClobClient,
  liveClient: ClobClient | undefined,
  market: Market,
  config: Config,
  globalBudget: RiskBudget,
): Promise<void> {
  const marketBudget = new RiskBudget(config.maxCollateralPerMarket);
  const tokenQuotes: TokenQuote[] = [];
  for (const token of marketTokens(market)) {
    const tokenId = tokenIdFromToken(token);
    if (!tokenId) {
      continue;
    }

    const book = await publicClient.getOrderBook(tokenId);
    const tokenQuote = buildTokenQuote(market, token, book, config);
    if (!tokenQuote.plan) {
      console.log(
        `skip ${marketSlug(market)} ${tokenOutcome(token)}: ` +
          `${tokenQuote.skipReason ?? "no safe quote at configured edge/sides"}`,
      );
    } else {
      printPlan(tokenQuote.plan, config.live);
    }

    tokenQuotes.push(tokenQuote);
  }

  if (liveClient) {
    const marketState = await LiveMarketState.load(liveClient, tokenQuotes);
    for (const tokenQuote of tokenQuotes) {
      if (tokenQuote.plan) {
        await reconcileQuotePlan(
          liveClient,
          tokenQuote.plan,
          config,
          globalBudget,
          marketBudget,
          marketState,
        );
      }
    }
  }
}

function buildTokenQuote(
  market: Market,
  token: Token,
  book: OrderBookSummary,
  config: Config,
): TokenQuote {
  const bestBidPrice = bestBid(book.bids ?? []);
  const bestAskPrice = bestAsk(book.asks ?? []);
  const fair = fairPrice(
    bestBidPrice,
    bestAskPrice,
    numberOrDefault(field(token, "price", "p"), 0),
    numberOrUndefined(book.last_trade_price),
  );
  const liquiditySkip = shouldEnforceLiquidityQuality(config)
    ? liquidityQualityRejectReason(book, config)
    : undefined;
  const plan = liquiditySkip
    ? undefined
    : buildQuotePlan(market, token, book, config);
  return {
    tokenId: tokenIdFromToken(token),
    fairPrice: fair,
    plan,
    skipReason: plan
      ? undefined
      : liquiditySkip
        ? `liquidity quality check failed: ${liquidityRejectMessage(liquiditySkip)}`
        : "no safe quote at configured edge/sides",
  };
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
  if (
    config.live &&
    config.requireTwoSidedLive &&
    !(
      bestBidPrice !== undefined &&
      bestAskPrice !== undefined &&
      bestBidPrice > 0 &&
      bestAskPrice > bestBidPrice
    )
  ) {
    return undefined;
  }
  const tick = numberOrDefault(book.tick_size, 0.01);
  let [buyPrice, sellPrice] = quotePrices(
    fair,
    bestBidPrice,
    bestAskPrice,
    tick,
    config.edgeTicks,
    config.minSpreadTicks,
  );

  if (buyPrice !== undefined && !priceInConfiguredRange(buyPrice, config)) {
    buyPrice = undefined;
  }
  if (sellPrice !== undefined && !priceInConfiguredRange(sellPrice, config)) {
    sellPrice = undefined;
  }

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

function priceInConfiguredRange(price: number, config: Config): boolean {
  return price >= config.minPrice && price <= config.maxPrice;
}

function shouldEnforceLiquidityQuality(config: Config): boolean {
  return config.live && config.requireTwoSidedLive;
}

function liquidityQualityRejectReason(
  book: OrderBookSummary,
  config: Config,
): LiquidityRejectReason | undefined {
  return liquidityRejectReason(
    book.bids ?? [],
    book.asks ?? [],
    numberOrDefault(book.tick_size, 0),
    config.maxBookSpreadTicks,
    config.minTopDepth,
  );
}

export function liquidityRejectReason(
  bids: OrderSummary[],
  asks: OrderSummary[],
  tick: number,
  maxSpreadTicks: number,
  minTopDepth: number,
): LiquidityRejectReason | undefined {
  if (tick <= 0) {
    return { kind: "invalidTick" };
  }

  const bid = bestBid(bids);
  const ask = bestAsk(asks);
  if (
    bid === undefined ||
    ask === undefined ||
    bid <= 0 ||
    ask <= bid
  ) {
    return { kind: "missingTwoSidedBook" };
  }

  const spreadTicks = (ask - bid) / tick;
  if (spreadTicks > maxSpreadTicks) {
    return { kind: "spreadTooWide", spreadTicks, maxSpreadTicks };
  }

  const bidDepth = topDepth(bids, bid);
  if (bidDepth < minTopDepth) {
    return { kind: "bidDepthTooLow", depth: bidDepth, minDepth: minTopDepth };
  }

  const askDepth = topDepth(asks, ask);
  if (askDepth < minTopDepth) {
    return { kind: "askDepthTooLow", depth: askDepth, minDepth: minTopDepth };
  }

  return undefined;
}

function topDepth(levels: OrderSummary[], price: number): number {
  return levels
    .filter((level) => numberOrDefault(level.price, 0) === price)
    .reduce((total, level) => total + numberOrDefault(level.size, 0), 0);
}

function liquidityRejectMessage(reason: LiquidityRejectReason): string {
  if (reason.kind === "missingTwoSidedBook") {
    return "missing a valid two-sided book";
  }
  if (reason.kind === "invalidTick") {
    return "book tick size is invalid";
  }
  if (reason.kind === "spreadTooWide") {
    return `spread is ${reason.spreadTicks} ticks above max ${reason.maxSpreadTicks}`;
  }
  if (reason.kind === "bidDepthTooLow") {
    return `best bid depth ${reason.depth} below minimum ${reason.minDepth}`;
  }
  return `best ask depth ${reason.depth} below minimum ${reason.minDepth}`;
}

function printPlan(plan: QuotePlan, live: boolean): void {
  const mode = live ? "live" : "dry-run";
  console.log(
    `${mode}: ${plan.marketKey} :: ${plan.marketSlug} :: ${plan.question} :: ${plan.outcome} ` +
      `(${plan.tokenId}) fair=${plan.fairPrice} bid=${plan.bestBid} ask=${plan.bestAsk} ` +
      `buy=${plan.buyPrice} sell=${plan.sellPrice} size=${plan.size}`,
  );
}

async function reconcileQuotePlan(
  client: ClobClient,
  plan: QuotePlan,
  config: Config,
  globalBudget: RiskBudget,
  marketBudget: RiskBudget,
  marketState: LiveMarketState,
): Promise<void> {
  const openOrders = marketState.openOrders(plan.tokenId);
  const ordersToCancel = cancellableOrders(openOrders, plan, config);
  if (config.cancelBeforeQuote && ordersToCancel.length > 0) {
    const response = await client.cancelOrders(ordersToCancel.map((order) => order.id));
    const canceled = responseList(response, "canceled");
    const notCanceled = responseList(response, "not_canceled");
    console.log(
      `canceled stale orders for ${plan.tokenId}: canceled=${canceled.length} not_canceled=${notCanceled.length}`,
    );
    if (notCanceled.length > 0) {
      console.log(
        `skip placing ${plan.marketSlug} ${plan.outcome}: some stale orders could not be canceled`,
      );
      return;
    }
  }

  const canceledIds = new Set(ordersToCancel.map((order) => order.id));
  const remainingOrders = openOrders.filter((order) => !canceledIds.has(order.id));
  marketState.replaceOpenOrders(plan.tokenId, remainingOrders);
  for (const order of remainingOrders) {
    globalBudget.reserveOpenBuyOrder(order);
    marketBudget.reserveOpenBuyOrder(order);
  }

  const collateral = await collateralBalance(client);
  const tokenBalance = marketState.tokenBalance(plan.tokenId);
  const lockedCollateral = remainingOrders
    .filter((order) => order.side === Side.BUY)
    .reduce(
      (total, order) =>
        total + openOrderRemainingSize(order) * numberOrDefault(order.price, 0),
      0,
    );
  const lockedTokens = remainingOrders
    .filter((order) => order.side === Side.SELL)
    .reduce((total, order) => total + openOrderRemainingSize(order), 0);
  const freeCollateral = Math.max(
    collateral - lockedCollateral - config.minFreeCollateral,
    0,
  );
  const freeTokens = Math.max(tokenBalance - lockedTokens, 0);
  let newOrderSlots = Math.max(
    config.maxOpenOrdersPerToken - remainingOrders.length,
    0,
  );

  const responses: Array<[Side, OrderResponse]> = [];
  if (plan.buyPrice !== undefined) {
    if (newOrderSlots > 0) {
      const openSize = matchingOpenSize(remainingOrders, Side.BUY, plan.buyPrice);
      if (openSize < plan.size) {
        const missingSize = plan.size - openSize;
        const decision = buyTopUpDecision(
          missingSize,
          plan.buyPrice,
          freeCollateral,
          globalBudget,
          marketBudget,
        );
        if (decision.kind === "place") {
          const proposedOrder = {
            tokenId: plan.tokenId,
            side: Side.BUY,
            price: plan.buyPrice,
            size: decision.size,
          };
          if (!marketLossExceedsCap(plan, proposedOrder, marketState, config)) {
            const order = await client.createOrder({
              tokenID: plan.tokenId,
              price: plan.buyPrice,
              size: decision.size,
              side: Side.BUY,
            });
            reserveBuyCollateral(decision.collateral, globalBudget, marketBudget);
            marketState.recordPendingOrder(proposedOrder);
            responses.push([
              Side.BUY,
              await client.postOrder(order, OrderType.GTC, false, config.postOnly),
            ]);
            newOrderSlots -= 1;
          }
        } else {
          console.log(
            `skip ${plan.marketSlug} ${plan.outcome} buy: ` +
              `risk budget/free collateral leaves size ${decision.affordableSize} below required ${missingSize}`,
          );
        }
      }
    }
  }
  if (plan.sellPrice !== undefined && newOrderSlots > 0) {
    const openSize = matchingOpenSize(remainingOrders, Side.SELL, plan.sellPrice);
    if (openSize < plan.size) {
      const missingSize = plan.size - openSize;
      const size = Math.min(missingSize, freeTokens);
      if (size >= missingSize) {
        const proposedOrder = {
          tokenId: plan.tokenId,
          side: Side.SELL,
          price: plan.sellPrice,
          size,
        };
        if (!marketLossExceedsCap(plan, proposedOrder, marketState, config)) {
          const order = await client.createOrder({
            tokenID: plan.tokenId,
            price: plan.sellPrice,
            size,
            side: Side.SELL,
          });
          marketState.recordPendingOrder(proposedOrder);
          responses.push([
            Side.SELL,
            await client.postOrder(order, OrderType.GTC, false, config.postOnly),
          ]);
        }
      } else {
        console.log(
          `skip ${plan.marketSlug} ${plan.outcome} sell: ` +
            `free token balance leaves size ${size} below required ${missingSize}`,
        );
      }
    }
  }

  if (responses.length === 0) {
    return;
  }
  printPostResponses(plan, responses);
}

async function openOrdersForToken(
  client: ClobClient,
  tokenId: string,
): Promise<OpenOrder[]> {
  const orders = await client.getOpenOrders({ asset_id: tokenId });
  return orders.filter(isOpenOrder);
}

function buyTopUpDecision(
  missingSize: number,
  price: number,
  freeCollateral: number,
  globalBudget: RiskBudget,
  marketBudget: RiskBudget,
): BuyTopUpDecision {
  const affordableSize = affordableBuySize(
    missingSize,
    price,
    freeCollateral,
    globalBudget,
    marketBudget,
  );
  if (affordableSize < missingSize) {
    return { kind: "skip", affordableSize };
  }

  const collateral = missingSize * price;
  return { kind: "place", size: missingSize, collateral };
}

function reserveBuyCollateral(
  collateral: number,
  globalBudget: RiskBudget,
  marketBudget: RiskBudget,
): void {
  const globalReserved = globalBudget.reserveNewCollateral(collateral);
  const marketReserved = marketBudget.reserveNewCollateral(globalReserved);
  if (globalReserved !== collateral || marketReserved !== collateral) {
    throw new Error("failed to reserve buy collateral after top-up decision");
  }
}

export function affordableBuySize(
  missingSize: number,
  price: number,
  freeCollateral: number,
  globalBudget: RiskBudget,
  marketBudget: RiskBudget,
): number {
  if (missingSize <= 0 || price <= 0) {
    return 0;
  }

  const requestedCollateral = missingSize * price;
  const affordableCollateral = Math.min(
    requestedCollateral,
    freeCollateral,
    globalBudget.remainingCollateral(),
    marketBudget.remainingCollateral(),
  );
  return affordableCollateral / price;
}

async function collateralBalance(client: ClobClient): Promise<number> {
  const response = await client.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
  });
  return numberOrDefault(response.balance, 0) / CONDITIONAL_TOKEN_BASE_UNITS;
}

async function conditionalBalance(client: ClobClient, tokenId: string): Promise<number> {
  const response = await client.getBalanceAllowance({
    asset_type: AssetType.CONDITIONAL,
    token_id: tokenId,
  });
  return numberOrDefault(response.balance, 0) / CONDITIONAL_TOKEN_BASE_UNITS;
}

function marketLossExceedsCap(
  plan: QuotePlan,
  proposedOrder: ProposedOrder,
  marketState: LiveMarketState,
  config: Config,
): boolean {
  const projectedLoss = marketState.projectedLoss(proposedOrder);
  if (projectedLoss <= config.maxLossPerMarket) {
    return false;
  }

  console.log(
    `skip ${plan.marketSlug} ${plan.outcome} ${proposedOrder.side}: ` +
      `projected market loss ${projectedLoss} exceeds cap ${config.maxLossPerMarket}`,
  );
  return true;
}

function applyOrderToOutcome(outcome: OutcomeExposure, order: ProposedOrder): void {
  if (order.side === Side.BUY) {
    outcome.position += order.size;
    outcome.cost += order.size * order.price;
    return;
  }
  if (order.side === Side.SELL) {
    outcome.position -= order.size;
    outcome.proceeds += order.size * order.price;
  }
}

function proposedOrderFromOpenOrder(
  order: OpenOrder,
  defaultTokenId: string,
): ProposedOrder | undefined {
  const side = sideFromOpenOrder(order.side);
  if (!side) {
    return undefined;
  }
  const size = openOrderRemainingSize(order);
  if (size <= 0) {
    return undefined;
  }
  return {
    tokenId: order.asset_id || defaultTokenId,
    side,
    price: numberOrDefault(order.price, 0),
    size,
  };
}

function sideFromOpenOrder(side: string): Side | undefined {
  if (side === Side.BUY) {
    return Side.BUY;
  }
  if (side === Side.SELL) {
    return Side.SELL;
  }
  return undefined;
}

export function cancellableOrders(
  openOrders: OpenOrder[],
  plan: QuotePlan,
  config: Config,
): OpenOrder[] {
  if (!config.cancelBeforeQuote) {
    return [];
  }

  const cancellable: OpenOrder[] = [];
  const cancellableIds = new Set<string>();
  for (const order of openOrders) {
    if (orderShouldCancel(order, plan)) {
      cancellable.push(order);
      cancellableIds.add(order.id);
    }
  }

  for (const [side, targetPrice] of [
    [Side.BUY, plan.buyPrice],
    [Side.SELL, plan.sellPrice],
  ] as const) {
    if (targetPrice === undefined) {
      continue;
    }
    const matchingOrders = openOrders.filter(
      (order) =>
        !cancellableIds.has(order.id) &&
        order.side === side &&
        numberOrDefault(order.price, 0) === targetPrice,
    );
    const matchingSize = matchingOrders.reduce(
      (total, order) => total + openOrderRemainingSize(order),
      0,
    );
    let remainingMatchingSize = matchingSize;
    if (remainingMatchingSize > plan.size) {
      const leastCompetitiveQueue = [...matchingOrders].sort(
        (left, right) => right.created_at - left.created_at,
      );
      for (const order of leastCompetitiveQueue) {
        if (remainingMatchingSize <= plan.size) {
          break;
        }
        if (!cancellableIds.has(order.id)) {
          cancellableIds.add(order.id);
          cancellable.push(order);
          remainingMatchingSize = Math.max(
            remainingMatchingSize - openOrderRemainingSize(order),
            0,
          );
        }
      }
    }
  }

  const kept = openOrders
    .filter((order) => !cancellableIds.has(order.id))
    .sort((left, right) => left.created_at - right.created_at);
  if (kept.length > config.maxOpenOrdersPerToken) {
    for (const order of kept.slice(config.maxOpenOrdersPerToken)) {
      if (!cancellableIds.has(order.id)) {
        cancellableIds.add(order.id);
        cancellable.push(order);
      }
    }
  }

  return cancellable;
}

function orderShouldCancel(order: OpenOrder, plan: QuotePlan): boolean {
  if (openOrderRemainingSize(order) <= 0) {
    return true;
  }
  if (order.side === Side.BUY) {
    return plan.buyPrice !== numberOrDefault(order.price, 0);
  }
  if (order.side === Side.SELL) {
    return plan.sellPrice !== numberOrDefault(order.price, 0);
  }
  return true;
}

function matchingOpenSize(
  orders: OpenOrder[],
  side: Side,
  price: number,
): number {
  return orders
    .filter((order) => order.side === side && numberOrDefault(order.price, 0) === price)
    .reduce((total, order) => total + openOrderRemainingSize(order), 0);
}

function openOrderRemainingSize(order: OpenOrder): number {
  return Math.max(
    numberOrDefault(order.original_size, 0) -
      numberOrDefault(order.size_matched, 0),
    0,
  );
}

export function isOpenOrder(order: OpenOrder): boolean {
  return ["live", "open", "unmatched", "delayed"].includes(
    order.status.toLowerCase(),
  );
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
