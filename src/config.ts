export const POLYGON = 137;
export const AMOY = 80002;

export type DiscoveryMode = "auto" | "sampling" | "site";
export type QuoteSides = "buy" | "sell" | "both";

export interface Config {
  clobHost: string;
  live: boolean;
  privateKey?: string;
  depositWallet?: string;
  chainId?: number;
  discovery: DiscoveryMode;
  eventSlug?: string;
  maxMarkets: number;
  maxPages: number;
  orderSize: number;
  edgeTicks: number;
  minSpreadTicks: number;
  bandMinMarginTicks?: number;
  bandAvgMarginTicks?: number;
  bandMaxMarginTicks?: number;
  bandMinSize?: number;
  bandAvgSize?: number;
  bandMaxSize?: number;
  maxBookSpreadTicks: number;
  minTopDepth: number;
  quoteSides: QuoteSides;
  allowSingleSided: boolean;
  respectRewardMinSize: boolean;
  cancelBeforeQuote: boolean;
  postOnly: boolean;
  requireTwoSidedLive: boolean;
  minPrice: number;
  maxPrice: number;
  maxCollateralPerMarket: number;
  maxLossPerMarket: number;
  maxTotalCollateral: number;
  minFreeCollateral: number;
  maxOpenOrdersPerToken: number;
  discoverOnly: boolean;
  cycles: number;
  refreshSecs: number;
  statePath: string;
}

export const HELP_TEXT = `Usage: market-maker [options]

Options:
  --clob-host <url>                 KUEST_CLOB_HOST, default https://clob.kuest.com
  --live / --no-live                MARKET_MAKER_LIVE, default false
  --private-key <key>               KUEST_PRIVATE_KEY, required with --live
  --deposit-wallet <address>        KUEST_DEPOSIT_WALLET, required with --live
  --chain-id <id>                   KUEST_CHAIN_ID, 137 Polygon or 80002 Amoy
  --discovery <mode>                MARKET_MAKER_DISCOVERY, auto | sampling | site
  --event-slug <slug>               MARKET_MAKER_EVENT_SLUG
  --max-markets <n>                 MARKET_MAKER_MAX_MARKETS, default 3
  --max-pages <n>                   MARKET_MAKER_MAX_PAGES, default 5
  --order-size <n>                  MARKET_MAKER_ORDER_SIZE, default 5
  --edge-ticks <n>                  MARKET_MAKER_EDGE_TICKS, default 1
  --min-spread-ticks <n>            MARKET_MAKER_MIN_SPREAD_TICKS, default 2
  --band-min-margin-ticks <n>       MARKET_MAKER_BAND_MIN_MARGIN_TICKS, optional
  --band-avg-margin-ticks <n>       MARKET_MAKER_BAND_AVG_MARGIN_TICKS, optional
  --band-max-margin-ticks <n>       MARKET_MAKER_BAND_MAX_MARGIN_TICKS, optional
  --band-min-size <n>               MARKET_MAKER_BAND_MIN_SIZE, optional
  --band-avg-size <n>               MARKET_MAKER_BAND_AVG_SIZE, optional
  --band-max-size <n>               MARKET_MAKER_BAND_MAX_SIZE, optional
  --max-book-spread-ticks <n>       MARKET_MAKER_MAX_BOOK_SPREAD_TICKS, default 20
  --min-top-depth <n>               MARKET_MAKER_MIN_TOP_DEPTH, default 5
  --quote-sides <side>              MARKET_MAKER_QUOTE_SIDES, buy | sell | both
  --allow-single-sided              MARKET_MAKER_ALLOW_SINGLE_SIDED, default true
  --respect-reward-min-size         MARKET_MAKER_RESPECT_REWARD_MIN_SIZE, default false
  --cancel-before-quote             MARKET_MAKER_CANCEL_BEFORE_QUOTE, default true
  --post-only                       MARKET_MAKER_POST_ONLY, default true
  --require-two-sided-live          MARKET_MAKER_REQUIRE_TWO_SIDED_LIVE, default true
  --min-price <n>                   MARKET_MAKER_MIN_PRICE, default 0.05
  --max-price <n>                   MARKET_MAKER_MAX_PRICE, default 0.95
  --max-collateral-per-market <n>   MARKET_MAKER_MAX_COLLATERAL_PER_MARKET, default 25
  --max-loss-per-market <n>         MARKET_MAKER_MAX_LOSS_PER_MARKET, default 25
  --max-total-collateral <n>        MARKET_MAKER_MAX_TOTAL_COLLATERAL, default 50
  --min-free-collateral <n>         MARKET_MAKER_MIN_FREE_COLLATERAL, default 1
  --max-open-orders-per-token <n>   MARKET_MAKER_MAX_OPEN_ORDERS_PER_TOKEN, default 2
  --discover-only                   MARKET_MAKER_DISCOVER_ONLY, default false
  --cycles <n>                      MARKET_MAKER_CYCLES, default 1
  --refresh-secs <n>                MARKET_MAKER_REFRESH_SECS, default 30
  --state-path <path>               MARKET_MAKER_STATE_PATH, default state/seen-markets.json
  --help                            Show this help message`;

type CliValue = string | boolean;

const knownOptions = new Set([
  "clob-host",
  "live",
  "private-key",
  "deposit-wallet",
  "chain-id",
  "discovery",
  "event-slug",
  "max-markets",
  "max-pages",
  "order-size",
  "edge-ticks",
  "min-spread-ticks",
  "band-min-margin-ticks",
  "band-avg-margin-ticks",
  "band-max-margin-ticks",
  "band-min-size",
  "band-avg-size",
  "band-max-size",
  "max-book-spread-ticks",
  "min-top-depth",
  "quote-sides",
  "allow-single-sided",
  "respect-reward-min-size",
  "cancel-before-quote",
  "post-only",
  "require-two-sided-live",
  "min-price",
  "max-price",
  "max-collateral-per-market",
  "max-loss-per-market",
  "max-total-collateral",
  "min-free-collateral",
  "max-open-orders-per-token",
  "discover-only",
  "cycles",
  "refresh-secs",
  "state-path",
  "help",
]);

export function parseConfig(
  argv = process.argv.slice(2),
  env = process.env,
): Config {
  const args = parseCliArgs(argv);
  const config: Config = {
    clobHost: stringArg(
      args,
      env,
      "clob-host",
      "KUEST_CLOB_HOST",
      "https://clob.kuest.com",
    ),
    live: booleanArg(args, env, "live", "MARKET_MAKER_LIVE", false),
    privateKey: optionalStringArg(
      args,
      env,
      "private-key",
      "KUEST_PRIVATE_KEY",
    ),
    depositWallet: optionalStringArg(
      args,
      env,
      "deposit-wallet",
      "KUEST_DEPOSIT_WALLET",
    ),
    chainId: optionalNumberArg(args, env, "chain-id", "KUEST_CHAIN_ID"),
    discovery: choiceArg(
      args,
      env,
      "discovery",
      "MARKET_MAKER_DISCOVERY",
      "auto",
      ["auto", "sampling", "site"],
    ),
    eventSlug: optionalRawStringArg(
      args,
      env,
      "event-slug",
      "MARKET_MAKER_EVENT_SLUG",
    ),
    maxMarkets: numberArg(
      args,
      env,
      "max-markets",
      "MARKET_MAKER_MAX_MARKETS",
      3,
    ),
    maxPages: numberArg(args, env, "max-pages", "MARKET_MAKER_MAX_PAGES", 5),
    orderSize: numberArg(args, env, "order-size", "MARKET_MAKER_ORDER_SIZE", 5),
    edgeTicks: numberArg(args, env, "edge-ticks", "MARKET_MAKER_EDGE_TICKS", 1),
    minSpreadTicks: numberArg(
      args,
      env,
      "min-spread-ticks",
      "MARKET_MAKER_MIN_SPREAD_TICKS",
      2,
    ),
    bandMinMarginTicks: optionalNumberArg(
      args,
      env,
      "band-min-margin-ticks",
      "MARKET_MAKER_BAND_MIN_MARGIN_TICKS",
    ),
    bandAvgMarginTicks: optionalNumberArg(
      args,
      env,
      "band-avg-margin-ticks",
      "MARKET_MAKER_BAND_AVG_MARGIN_TICKS",
    ),
    bandMaxMarginTicks: optionalNumberArg(
      args,
      env,
      "band-max-margin-ticks",
      "MARKET_MAKER_BAND_MAX_MARGIN_TICKS",
    ),
    bandMinSize: optionalNumberArg(
      args,
      env,
      "band-min-size",
      "MARKET_MAKER_BAND_MIN_SIZE",
    ),
    bandAvgSize: optionalNumberArg(
      args,
      env,
      "band-avg-size",
      "MARKET_MAKER_BAND_AVG_SIZE",
    ),
    bandMaxSize: optionalNumberArg(
      args,
      env,
      "band-max-size",
      "MARKET_MAKER_BAND_MAX_SIZE",
    ),
    maxBookSpreadTicks: numberArg(
      args,
      env,
      "max-book-spread-ticks",
      "MARKET_MAKER_MAX_BOOK_SPREAD_TICKS",
      20,
    ),
    minTopDepth: numberArg(
      args,
      env,
      "min-top-depth",
      "MARKET_MAKER_MIN_TOP_DEPTH",
      5,
    ),
    quoteSides: choiceArg(
      args,
      env,
      "quote-sides",
      "MARKET_MAKER_QUOTE_SIDES",
      "buy",
      ["buy", "sell", "both"],
    ),
    allowSingleSided: booleanArg(
      args,
      env,
      "allow-single-sided",
      "MARKET_MAKER_ALLOW_SINGLE_SIDED",
      true,
    ),
    respectRewardMinSize: booleanArg(
      args,
      env,
      "respect-reward-min-size",
      "MARKET_MAKER_RESPECT_REWARD_MIN_SIZE",
      false,
    ),
    cancelBeforeQuote: booleanArg(
      args,
      env,
      "cancel-before-quote",
      "MARKET_MAKER_CANCEL_BEFORE_QUOTE",
      true,
    ),
    postOnly: booleanArg(
      args,
      env,
      "post-only",
      "MARKET_MAKER_POST_ONLY",
      true,
    ),
    requireTwoSidedLive: booleanArg(
      args,
      env,
      "require-two-sided-live",
      "MARKET_MAKER_REQUIRE_TWO_SIDED_LIVE",
      true,
    ),
    minPrice: numberArg(args, env, "min-price", "MARKET_MAKER_MIN_PRICE", 0.05),
    maxPrice: numberArg(args, env, "max-price", "MARKET_MAKER_MAX_PRICE", 0.95),
    maxCollateralPerMarket: numberArg(
      args,
      env,
      "max-collateral-per-market",
      "MARKET_MAKER_MAX_COLLATERAL_PER_MARKET",
      25,
    ),
    maxLossPerMarket: numberArg(
      args,
      env,
      "max-loss-per-market",
      "MARKET_MAKER_MAX_LOSS_PER_MARKET",
      25,
    ),
    maxTotalCollateral: numberArg(
      args,
      env,
      "max-total-collateral",
      "MARKET_MAKER_MAX_TOTAL_COLLATERAL",
      50,
    ),
    minFreeCollateral: numberArg(
      args,
      env,
      "min-free-collateral",
      "MARKET_MAKER_MIN_FREE_COLLATERAL",
      1,
    ),
    maxOpenOrdersPerToken: numberArg(
      args,
      env,
      "max-open-orders-per-token",
      "MARKET_MAKER_MAX_OPEN_ORDERS_PER_TOKEN",
      2,
    ),
    discoverOnly: booleanArg(
      args,
      env,
      "discover-only",
      "MARKET_MAKER_DISCOVER_ONLY",
      false,
    ),
    cycles: numberArg(args, env, "cycles", "MARKET_MAKER_CYCLES", 1),
    refreshSecs: numberArg(
      args,
      env,
      "refresh-secs",
      "MARKET_MAKER_REFRESH_SECS",
      30,
    ),
    statePath: stringArg(
      args,
      env,
      "state-path",
      "MARKET_MAKER_STATE_PATH",
      "state/seen-markets.json",
    ),
  };

  validateConfig(config);
  return config;
}

export function includesBuy(quoteSides: QuoteSides): boolean {
  return quoteSides === "buy" || quoteSides === "both";
}

export function includesSell(quoteSides: QuoteSides): boolean {
  return quoteSides === "sell" || quoteSides === "both";
}

function parseCliArgs(argv: string[]): Map<string, CliValue> {
  const parsed = new Map<string, CliValue>();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--") {
      continue;
    }
    if (!raw.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${raw}`);
    }

    if (raw.startsWith("--no-")) {
      const key = raw.slice(5);
      assertKnownOption(key);
      parsed.set(key, false);
      continue;
    }

    const [flag, inlineValue] = raw.slice(2).split("=", 2);
    assertKnownOption(flag);
    if (inlineValue !== undefined) {
      parsed.set(flag, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed.set(flag, next);
      index += 1;
    } else {
      parsed.set(flag, true);
    }
  }

  return parsed;
}

function assertKnownOption(key: string): void {
  if (!knownOptions.has(key)) {
    throw new Error(`unknown option --${key}`);
  }
}

function optionalStringArg(
  args: Map<string, CliValue>,
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
): string | undefined {
  const value = args.get(key) ?? env[envKey];
  if (value === undefined || value === false) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function optionalRawStringArg(
  args: Map<string, CliValue>,
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
): string | undefined {
  const value = args.get(key) ?? env[envKey];
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value === true) {
    throw new Error(`${envKey} requires a value`);
  }
  return String(value);
}

function stringArg(
  args: Map<string, CliValue>,
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
  fallback: string,
): string {
  return optionalStringArg(args, env, key, envKey) ?? fallback;
}

function optionalNumberArg(
  args: Map<string, CliValue>,
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
): number | undefined {
  const value = optionalStringArg(args, env, key, envKey);
  return value === undefined ? undefined : parseNumber(value, key);
}

function numberArg(
  args: Map<string, CliValue>,
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
  fallback: number,
): number {
  return optionalNumberArg(args, env, key, envKey) ?? fallback;
}

function booleanArg(
  args: Map<string, CliValue>,
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
  fallback: boolean,
): boolean {
  const raw = args.get(key);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    return parseBoolean(raw, key);
  }
  const envValue = env[envKey];
  return envValue === undefined ? fallback : parseBoolean(envValue, envKey);
}

function choiceArg<T extends string>(
  args: Map<string, CliValue>,
  env: NodeJS.ProcessEnv,
  key: string,
  envKey: string,
  fallback: T,
  choices: T[],
): T {
  const value = stringArg(args, env, key, envKey, fallback).toLowerCase();
  if (choices.includes(value as T)) {
    return value as T;
  }
  throw new Error(`${envKey} must be one of: ${choices.join(", ")}`);
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function validateConfig(config: Config): void {
  if (config.maxMarkets <= 0) {
    throw new Error("MARKET_MAKER_MAX_MARKETS must be greater than zero");
  }
  if (config.maxPages <= 0) {
    throw new Error("MARKET_MAKER_MAX_PAGES must be greater than zero");
  }
  if (config.orderSize <= 0) {
    throw new Error("MARKET_MAKER_ORDER_SIZE must be greater than zero");
  }
  if (config.edgeTicks <= 0) {
    throw new Error("MARKET_MAKER_EDGE_TICKS must be greater than zero");
  }
  if (config.minSpreadTicks <= 0) {
    throw new Error("MARKET_MAKER_MIN_SPREAD_TICKS must be greater than zero");
  }
  const [bandMinMargin, bandAvgMargin, bandMaxMargin] = bandMarginTicks(config);
  if (bandMinMargin <= 0 || bandAvgMargin <= 0 || bandMaxMargin <= 0) {
    throw new Error("MARKET_MAKER_BAND_*_MARGIN_TICKS must be greater than zero");
  }
  if (bandMinMargin > bandAvgMargin || bandAvgMargin > bandMaxMargin) {
    throw new Error("MARKET_MAKER_BAND_*_MARGIN_TICKS must satisfy min <= avg <= max");
  }
  if (bandMinMargin >= bandMaxMargin) {
    throw new Error(
      "MARKET_MAKER_BAND_MAX_MARGIN_TICKS must be greater than MARKET_MAKER_BAND_MIN_MARGIN_TICKS",
    );
  }
  const [bandMinSize, bandAvgSize, bandMaxSize] = bandSizes(config);
  if (bandMinSize < 0 || bandAvgSize <= 0 || bandMaxSize <= 0) {
    throw new Error(
      "MARKET_MAKER_BAND_*_SIZE must be non-negative with avg and max greater than zero",
    );
  }
  if (bandMinSize > bandAvgSize || bandAvgSize > bandMaxSize) {
    throw new Error("MARKET_MAKER_BAND_*_SIZE must satisfy min <= avg <= max");
  }
  if (config.maxBookSpreadTicks <= 0) {
    throw new Error("MARKET_MAKER_MAX_BOOK_SPREAD_TICKS must be greater than zero");
  }
  if (config.minTopDepth < 0) {
    throw new Error("MARKET_MAKER_MIN_TOP_DEPTH cannot be negative");
  }
  if (config.eventSlug !== undefined && config.eventSlug.trim() === "") {
    throw new Error("MARKET_MAKER_EVENT_SLUG cannot be empty");
  }
  if (config.minPrice <= 0 || config.minPrice >= 1) {
    throw new Error("MARKET_MAKER_MIN_PRICE must be between 0 and 1");
  }
  if (config.maxPrice <= 0 || config.maxPrice >= 1) {
    throw new Error("MARKET_MAKER_MAX_PRICE must be between 0 and 1");
  }
  if (config.minPrice >= config.maxPrice) {
    throw new Error(
      "MARKET_MAKER_MIN_PRICE must be less than MARKET_MAKER_MAX_PRICE",
    );
  }
  if (config.maxCollateralPerMarket <= 0) {
    throw new Error(
      "MARKET_MAKER_MAX_COLLATERAL_PER_MARKET must be greater than zero",
    );
  }
  if (config.maxLossPerMarket <= 0) {
    throw new Error("MARKET_MAKER_MAX_LOSS_PER_MARKET must be greater than zero");
  }
  if (config.maxTotalCollateral <= 0) {
    throw new Error("MARKET_MAKER_MAX_TOTAL_COLLATERAL must be greater than zero");
  }
  if (config.minFreeCollateral < 0) {
    throw new Error("MARKET_MAKER_MIN_FREE_COLLATERAL cannot be negative");
  }
  if (
    !Number.isInteger(config.maxOpenOrdersPerToken) ||
    config.maxOpenOrdersPerToken <= 0
  ) {
    throw new Error(
      "MARKET_MAKER_MAX_OPEN_ORDERS_PER_TOKEN must be a positive integer",
    );
  }
  if (config.cycles <= 0) {
    throw new Error("MARKET_MAKER_CYCLES must be greater than zero");
  }
  if (!config.live) {
    return;
  }
  if (!config.privateKey) {
    throw new Error("--live requires KUEST_PRIVATE_KEY or --private-key");
  }
  if (!config.depositWallet) {
    throw new Error("--live requires KUEST_DEPOSIT_WALLET or --deposit-wallet");
  }
  if (config.chainId === undefined) {
    throw new Error(
      "--live requires KUEST_CHAIN_ID or --chain-id; use 137 for Polygon or 80002 for Amoy",
    );
  }
  if (config.chainId !== POLYGON && config.chainId !== AMOY) {
    throw new Error(
      `unsupported chain id ${config.chainId}; SDK supports ${POLYGON} and ${AMOY}`,
    );
  }
}

export function bandMarginTicks(config: Config): [number, number, number] {
  const minMargin = config.bandMinMarginTicks ?? config.edgeTicks;
  const avgMargin = config.bandAvgMarginTicks ?? minMargin;
  const maxMargin = config.bandMaxMarginTicks ?? minMargin + config.minSpreadTicks;
  return [minMargin, avgMargin, maxMargin];
}

export function bandSizes(config: Config): [number, number, number] {
  const minSize = config.bandMinSize ?? config.orderSize;
  const avgSize = config.bandAvgSize ?? Math.max(config.orderSize, minSize);
  const maxSize = config.bandMaxSize ?? Math.max(avgSize, minSize);
  return [minSize, avgSize, maxSize];
}
