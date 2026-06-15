const EPSILON = 1e-12;

export function fairPrice(
  bestBid: number | undefined,
  bestAsk: number | undefined,
  tokenPrice: number,
  lastTradePrice?: number,
): number {
  if (
    bestBid !== undefined &&
    bestAsk !== undefined &&
    bestBid > 0 &&
    bestAsk > bestBid
  ) {
    return normalizePrice((bestBid + bestAsk) / 2);
  }

  if (isValidProbability(tokenPrice)) {
    return tokenPrice;
  }

  if (lastTradePrice !== undefined && isValidProbability(lastTradePrice)) {
    return lastTradePrice;
  }

  return 0.5;
}

export function quotePrices(
  fair: number,
  bestBid: number | undefined,
  bestAsk: number | undefined,
  tick: number,
  edgeTicks: number,
  minSpreadTicks: number,
): [number | undefined, number | undefined] {
  const clampedFair = clampProbability(fair, tick);
  const edge = tick * edgeTicks;
  const minSpread = tick * minSpreadTicks;

  const buyCap = clampedFair - edge;
  const sellFloor = clampedFair + edge;
  const passiveBuy =
    bestBid === undefined ? clampedFair - minSpread : bestBid + tick;
  const passiveSell =
    bestAsk === undefined ? clampedFair + minSpread : bestAsk - tick;

  const buy = floorToTick(Math.min(passiveBuy, buyCap), tick);
  const sell = ceilToTick(Math.max(passiveSell, sellFloor), tick);

  const buyPrice = validBuy(buy, bestAsk, tick) ? buy : undefined;
  const sellPrice = validSell(sell, bestBid, tick) ? sell : undefined;

  if (
    buyPrice !== undefined &&
    sellPrice !== undefined &&
    sellPrice - buyPrice < minSpread - EPSILON
  ) {
    return [undefined, undefined];
  }

  return [buyPrice, sellPrice];
}

export function validBuy(
  price: number,
  bestAsk: number | undefined,
  tick: number,
): boolean {
  return (
    isTradeablePrice(price, tick) && (bestAsk === undefined || price < bestAsk)
  );
}

export function validSell(
  price: number,
  bestBid: number | undefined,
  tick: number,
): boolean {
  return (
    isTradeablePrice(price, tick) && (bestBid === undefined || price > bestBid)
  );
}

export function isTradeablePrice(price: number, tick: number): boolean {
  return price >= tick && price <= 1 - tick;
}

export function isValidProbability(price: number): boolean {
  return price > 0 && price < 1;
}

export function clampProbability(price: number, tick: number): number {
  return Math.max(tick, Math.min(1 - tick, price));
}

export function floorToTick(price: number, tick: number): number {
  return normalizePrice(Math.floor((price + EPSILON) / tick) * tick);
}

export function ceilToTick(price: number, tick: number): number {
  return normalizePrice(Math.ceil((price - EPSILON) / tick) * tick);
}

function normalizePrice(price: number): number {
  return Number(price.toFixed(10));
}
