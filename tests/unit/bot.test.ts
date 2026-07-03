import { describe, expect, it } from "vitest";
import {
    RiskBudget,
    affordableBuySize,
    buildQuotePlan,
    selectEventCandidates,
} from "../../src/bot.js";
import type { Config } from "../../src/config.js";
import type { OrderBookSummary } from "../../vendor/clob-client/dist/types.js";

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
