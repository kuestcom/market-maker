import { describe, expect, it } from "vitest";
import {
    RiskBudget,
    MarketExposure,
    affordableBuySize,
    bandContainsPrice,
    bandMissingSize,
    buildQuotePlan,
    cancelScopeOrders,
    cancellableOrders,
    isOpenOrder,
    liquidityRejectReason,
    managedTokenIds,
    openOrderMatchesProposed,
    type QuoteBand,
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

    it("builds configured quote bands around fair value", () => {
        const plan = buildQuotePlan(
            market("market"),
            { token_id: "yes", outcome: "Yes", price: "0.50" },
            book({ bids: [{ price: "0.49", size: "5" }], asks: [{ price: "0.51", size: "5" }] }),
            {
                ...config(),
                quoteSides: "both",
                bandMinMarginTicks: 2,
                bandAvgMarginTicks: 3,
                bandMaxMarginTicks: 4,
                bandMinSize: 3,
                bandAvgSize: 7,
                bandMaxSize: 9,
            },
        );

        expect(plan?.buyBand).toMatchObject({
            side: Side.BUY,
            price: 0.47,
            minPrice: 0.46,
            maxPrice: 0.48,
            minSize: 3,
            avgSize: 7,
            maxSize: 9,
        });
        expect(plan?.sellBand).toMatchObject({
            side: Side.SELL,
            price: 0.53,
            minPrice: 0.52,
            maxPrice: 0.54,
            minSize: 3,
            avgSize: 7,
            maxSize: 9,
        });
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

        const canceled = cancellableOrders(
            orders,
            {
                ...plan(),
                buyBand: {
                    ...quoteBand(),
                    minPrice: 0.49,
                    maxPrice: 0.49,
                    minSize: 5,
                    avgSize: 5,
                    maxSize: 5,
                },
            },
            config(),
        );

        expect(canceled.map(order => order.id)).toEqual(["newest", "middle"]);
    });

    it("keeps orders inside a quote band and cancels orders outside it", () => {
        const orders = [
            openOrder("inside-low", Side.BUY, "0.47", "2", 1),
            openOrder("inside-high", Side.BUY, "0.49", "2", 2),
            openOrder("outside", Side.BUY, "0.46", "2", 3),
        ];

        const canceled = cancellableOrders(orders, plan(), config());

        expect(canceled.map(order => order.id)).toEqual(["outside"]);
    });

    it("trims least competitive band orders before best priced liquidity", () => {
        const orders = [
            openOrder("far", Side.BUY, "0.47", "5", 1),
            openOrder("middle", Side.BUY, "0.48", "5", 2),
            openOrder("best", Side.BUY, "0.49", "5", 3),
        ];

        const canceled = cancellableOrders(
            orders,
            {
                ...plan(),
                buyBand: {
                    ...quoteBand(),
                    minSize: 5,
                    avgSize: 10,
                    maxSize: 12,
                },
            },
            config(),
        );

        expect(canceled.map(order => order.id)).toEqual(["far"]);
    });

    it("tops up bands only below minimum size", () => {
        const band = quoteBand();

        expect(bandMissingSize(band, 4)).toBe(6);
        expect(bandMissingSize(band, 5)).toBeUndefined();
        expect(bandMissingSize(band, 9)).toBeUndefined();
    });

    it("checks prices against inclusive quote band bounds", () => {
        const band = quoteBand();

        expect(bandContainsPrice(band, 0.47)).toBe(true);
        expect(bandContainsPrice(band, 0.48)).toBe(true);
        expect(bandContainsPrice(band, 0.49)).toBe(true);
        expect(bandContainsPrice(band, 0.46)).toBe(false);
        expect(bandContainsPrice(band, 0.5)).toBe(false);
    });

    it("keeps documented OPEN status in reconciliation", () => {
        expect(isOpenOrder(openOrder("open", Side.BUY, "0.49", "1", 1, "OPEN"))).toBe(true);
    });

    it("matches accepted open orders to proposed pending orders after partial fills", () => {
        expect(
            openOrderMatchesProposed(
                openOrder("partial", Side.BUY, "0.49", "5", 1, "OPEN", "2"),
                { tokenId: "yes", side: Side.BUY, price: 0.49, size: 5 },
            ),
        ).toBe(true);
    });

    it("collects unique managed token ids in market order", () => {
        expect(
            managedTokenIds([
                { tokens: [{ token_id: "yes" }, { token_id: "no" }] },
                { tokens: [{ token_id: "yes" }, { token_id: "maybe" }] },
            ]),
        ).toEqual(["yes", "no", "maybe"]);
    });

    it("falls back to discovered scope when managed cancel scope is empty", async () => {
        const checkedTokenIds: string[] = [];
        const publicClient = {
            getSamplingMarkets: async () => ({ data: [market("market")], next_cursor: "LTE=" }),
        };
        const liveClient = {
            getOpenOrders: async (params: { asset_id: string }) => {
                checkedTokenIds.push(params.asset_id);
                return [];
            },
        };

        await cancelScopeOrders(
            publicClient as never,
            liveClient as never,
            config(),
            [],
        );

        expect(checkedTokenIds).toEqual(["yes"]);
    });

    it("rejects missing two-sided liquidity", () => {
        expect(
            liquidityRejectReason([{ price: "0.49", size: "10" }], [], 0.01, 20, 5),
        ).toEqual({ kind: "missingTwoSidedBook" });
    });

    it("rejects wide books", () => {
        const reason = liquidityRejectReason(
            [{ price: "0.40", size: "10" }],
            [{ price: "0.70", size: "10" }],
            0.01,
            20,
            5,
        );

        expect(reason).toMatchObject({ kind: "spreadTooWide", maxSpreadTicks: 20 });
        expect(reason?.kind === "spreadTooWide" ? reason.spreadTicks : undefined).toBeCloseTo(30);
    });

    it("rejects shallow top depth", () => {
        expect(
            liquidityRejectReason(
                [{ price: "0.49", size: "4.9" }, { price: "0.48", size: "100" }],
                [{ price: "0.51", size: "10" }],
                0.01,
                20,
                5,
            ),
        ).toEqual({ kind: "bidDepthTooLow", depth: 4.9, minDepth: 5 });
    });

    it("accepts tight books with enough top depth", () => {
        expect(
            liquidityRejectReason(
                [{ price: "0.49", size: "2" }, { price: "0.49", size: "3" }],
                [{ price: "0.51", size: "5" }],
                0.01,
                20,
                5,
            ),
        ).toBeUndefined();
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
        maxBookSpreadTicks: 20,
        minTopDepth: 5,
        quoteSides: "buy",
        allowSingleSided: true,
        respectRewardMinSize: false,
        cancelBeforeQuote: true,
        cancelAll: false,
        cancelAllOnExit: false,
        postOnly: true,
        requireTwoSidedLive: true,
        minPrice: 0.05,
        maxPrice: 0.95,
        maxCollateralPerMarket: 25,
        maxLossPerMarket: 25,
        maxTotalCollateral: 50,
        minFreeCollateral: 1,
        maxOpenOrdersPerToken: 2,
        discoverOnly: false,
        cycles: 1,
        refreshSecs: 30,
        statePath: "state/seen-markets.json",
    };
}

describe("market loss guard", () => {
    it("counts complete sets as hedged", () => {
        const exposure = new MarketExposure([
            { tokenId: "yes", position: 5, cost: 2.5, proceeds: 0 },
            { tokenId: "no", position: 5, cost: 2.5, proceeds: 0 },
        ]);

        expect(exposure.worstLoss()).toBe(0);
    });

    it("accounts for worst resolution payout", () => {
        const exposure = new MarketExposure([
            { tokenId: "yes", position: 0, cost: 0, proceeds: 0 },
            { tokenId: "no", position: 0, cost: 0, proceeds: 0 },
        ]);

        exposure.applyOrder({
            tokenId: "yes",
            side: Side.BUY,
            price: 0.4,
            size: 5,
        });

        expect(exposure.worstLoss()).toBe(2);
    });
});

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
        buyBand: quoteBand(),
    };
}

function quoteBand(): QuoteBand {
    return {
        side: Side.BUY,
        price: 0.49,
        minPrice: 0.47,
        maxPrice: 0.49,
        minSize: 5,
        avgSize: 10,
        maxSize: 15,
    };
}

function openOrder(
    id: string,
    side: Side,
    price: string,
    size: string,
    createdAt: number,
    status = "OPEN",
    sizeMatched = "0",
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
        size_matched: sizeMatched,
        price,
        associate_trades: [],
        outcome: "Yes",
        created_at: createdAt,
        expiration: "0",
        order_type: "GTC",
    };
}
