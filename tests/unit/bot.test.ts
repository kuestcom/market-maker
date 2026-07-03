import { describe, expect, it } from "vitest";
import {
    RiskBudget,
    affordableBuySize,
    buildQuotePlan,
    cancellableOrders,
    isOpenOrder,
    type QuotePlan,
    selectEventCandidates,
} from "../../src/bot.js";
import type { Config } from "../../src/config.js";
import { Side, type OpenOrder, type OrderBookSummary } from "../../vendor/clob-client/dist/types.js";

describe("bot feature #1", () => {
    it("marks event candidates as already scoped instead of new", () => {
        const candidates = selectEventCandidates([market("b"), market("a")], 3);

        expect(candidates.map(candidate => candidate.isNew)).toEqual([false, false]);
        expect(candidates.map(candidate => candidate.market.slug)).toEqual(["a", "b"]);
    });

    it("requires two-sided live books when configured", () => {
        const plan = buildQuotePlan(
            market("market"),
            { token_id: "yes", outcome: "Yes", price: "0.50" },
            book({ bids: [], asks: [] }),
            { ...config(), live: true, requireTwoSidedLive: true },
        );

        expect(plan).toBeUndefined();
    });

    it("filters quote prices outside configured range", () => {
        const plan = buildQuotePlan(
            market("market"),
            { token_id: "yes", outcome: "Yes", price: "0.50" },
            book({ bids: [{ price: "0.49", size: "5" }], asks: [{ price: "0.51", size: "5" }] }),
            { ...config(), minPrice: 0.55 },
        );

        expect(plan).toBeUndefined();
    });

    it("caps buy top-up size by available collateral budgets", () => {
        const globalBudget = new RiskBudget(10);
        const marketBudget = new RiskBudget(10);

        expect(affordableBuySize(5, 0.5, 1, globalBudget, marketBudget)).toBe(2);
        expect(globalBudget.remainingCollateral()).toBe(10);
        expect(marketBudget.remainingCollateral()).toBe(10);
    });

    it("trims only enough same-price size above the target", () => {
        const orders = [
            openOrder("oldest", Side.BUY, "0.49", "3", 1),
            openOrder("middle", Side.BUY, "0.49", "3", 2),
            openOrder("newest", Side.BUY, "0.49", "3", 3),
        ];

        const canceled = cancellableOrders(orders, plan(), config());

        expect(canceled.map(order => order.id)).toEqual(["newest", "middle"]);
    });

    it("keeps documented OPEN status in reconciliation", () => {
        expect(isOpenOrder(openOrder("open", Side.BUY, "0.49", "1", 1, "OPEN"))).toBe(true);
    });
});

function market(slug: string): Record<string, unknown> {
    return {
        slug,
        question: "Question?",
        enable_order_book: true,
        active: true,
        closed: false,
        archived: false,
        accepting_orders: true,
        accepting_order_timestamp: slug === "a" ? 2 : 1,
        tokens: [{ token_id: "yes", outcome: "Yes", price: "0.50" }],
    };
}

function book(partial: Partial<OrderBookSummary>): OrderBookSummary {
    return {
        market: "market",
        asset_id: "yes",
        timestamp: "0",
        bids: [],
        asks: [],
        min_order_size: "1",
        tick_size: "0.01",
        neg_risk: false,
        last_trade_price: "",
        hash: "hash",
        ...partial,
    };
}

function config(): Config {
    return {
        clobHost: "https://clob.kuest.com",
        live: false,
        discovery: "auto",
        maxMarkets: 3,
        maxPages: 5,
        orderSize: 5,
        edgeTicks: 1,
        minSpreadTicks: 2,
        quoteSides: "buy",
        allowSingleSided: true,
        respectRewardMinSize: false,
        cancelBeforeQuote: true,
        postOnly: true,
        requireTwoSidedLive: true,
        minPrice: 0.05,
        maxPrice: 0.95,
        maxCollateralPerMarket: 25,
        maxTotalCollateral: 50,
        minFreeCollateral: 1,
        maxOpenOrdersPerToken: 2,
        discoverOnly: false,
        cycles: 1,
        refreshSecs: 30,
        statePath: "state/seen-markets.json",
    };
}

function plan(): QuotePlan {
    return {
        marketKey: "market",
        marketSlug: "market",
        question: "Question?",
        tokenId: "yes",
        outcome: "Yes",
        fairPrice: 0.5,
        bestBid: 0.49,
        bestAsk: 0.51,
        buyPrice: 0.49,
        size: 5,
    };
}

function openOrder(
    id: string,
    side: Side,
    price: string,
    size: string,
    createdAt: number,
    status = "OPEN",
): OpenOrder {
    return {
        id,
        status,
        owner: "owner",
        maker_address: "maker",
        market: "market",
        asset_id: "yes",
        side,
        original_size: size,
        size_matched: "0",
        price,
        associate_trades: [],
        outcome: "Yes",
        created_at: createdAt,
        expiration: "0",
        order_type: "GTC",
    };
}
