import { describe, expect, it } from "vitest";
import {
    RiskBudget,
    MarketExposure,
    LiveMarketState,
    affordableBuySize,
    bandContainsPrice,
    bandMissingSize,
    buildQuotePlan,
    cancelScopeOrders,
    cancellableOrders,
    isOpenOrder,
    inventoryAdjustedBuySize,
    liquidityRejectReason,
    managedTokenIds,
    openOrderMatchesProposed,
    positionReconcileErrorFor,
    preflightSnapshotForMarket,
    priceMoveRejectReason,
    riskBreachAppliesToToken,
    staleInputReason,
    tokenCostBasis,
    tokenLedgerPosition,
    tradeMatchTimeUnixSecs,
    tokenLongInventory,
    type PreflightMarketSnapshot,
    type QuoteBand,
    type QuotePlan,
    type RiskBreach,
    selectEventCandidates,
} from "../../src/bot.js";
import type { Config } from "../../src/config.js";
import type { FillRecord } from "../../src/state.js";
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
            minimumSize: 0,
            minSize: 3,
            avgSize: 7,
            maxSize: 9,
        });
        expect(plan?.sellBand).toMatchObject({
            side: Side.SELL,
            price: 0.53,
            minPrice: 0.52,
            maxPrice: 0.54,
            minimumSize: 0,
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

    it("releases reserved open-buy collateral when an order is no longer open", () => {
        const budget = new RiskBudget(10);
        const order = openOrder("buy", Side.BUY, "0.50", "4", 1);

        budget.reserveOpenBuyOrder(order);
        expect(budget.remainingCollateral()).toBe(8);
        expect(budget.reservedCollateral()).toBe(2);

        budget.releaseOpenBuyOrder(order);
        expect(budget.remainingCollateral()).toBe(10);
        expect(budget.reservedCollateral()).toBe(0);
    });

    it("tracks over-limit open buy collateral without expanding spendable room", () => {
        const budget = new RiskBudget(3);
        const order = openOrder("buy", Side.BUY, "0.50", "10", 1);

        budget.reserveOpenBuyOrder(order);
        expect(budget.remainingCollateral()).toBe(0);
        expect(budget.reservedCollateral()).toBe(5);

        budget.releaseOpenBuyOrder(order);
        expect(budget.remainingCollateral()).toBe(3);
        expect(budget.reservedCollateral()).toBe(0);
    });

    it("does not restore buy room while remaining open buys still exceed the cap", () => {
        const budget = new RiskBudget(3);
        const first = openOrder("first", Side.BUY, "0.50", "10", 1);
        const second = openOrder("second", Side.BUY, "0.50", "10", 2);

        budget.reserveOpenBuyOrder(first);
        budget.reserveOpenBuyOrder(second);
        expect(budget.remainingCollateral()).toBe(0);
        expect(budget.reservedCollateral()).toBe(10);

        budget.releaseOpenBuyOrder(first);
        expect(budget.remainingCollateral()).toBe(0);
        expect(budget.reservedCollateral()).toBe(5);
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

    it("caps buy size by inventory room while respecting minimum order size", () => {
        expect(inventoryAdjustedBuySize(10, 1, 4)).toBe(4);
        expect(inventoryAdjustedBuySize(10, 5, 4)).toBeUndefined();
    });

    it("counts long inventory from balances, open buys, pending buys, and staged buys", () => {
        expect(
            tokenLongInventory(
                2,
                [openOrder("open-buy", Side.BUY, "0.49", "3", 1), openOrder("sell", Side.SELL, "0.51", "7", 2)],
                [{ tokenId: "yes", side: Side.BUY, price: 0.48, size: 4 }],
                [{ tokenId: "yes", side: Side.BUY, price: 0.47, size: 5 }],
                "yes",
            ),
        ).toBe(14);
    });

    it("does not count open buys with missing token id toward every token inventory", () => {
        expect(
            tokenLongInventory(
                0,
                [openOrder("missing-token", Side.BUY, "0.49", "3", 1, "OPEN", "0", "")],
                [],
                [],
                "yes",
            ),
        ).toBe(0);
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

    it("reports stale input age once it exceeds the configured limit", () => {
        expect(staleInputReason("order book", 1_000, 12_001, 10)).toBe(
            "order book age 11001ms exceeds max 10000ms",
        );
        expect(staleInputReason("order book", 1_000, 11_000, 10)).toBeUndefined();
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
        cancelOnRiskBreach: false,
        pauseOnRiskBreach: false,
        clearPause: false,
        pausePath: "state/paused.json",
        postOnly: true,
        requireTwoSidedLive: true,
        maxPrePostMoveTicks: 2,
        maxDataAgeSecs: 10,
        minPrice: 0.05,
        maxPrice: 0.95,
        maxCollateralPerMarket: 25,
        maxLossPerMarket: 25,
        maxInventoryPerToken: 25,
        maxInventoryPerMarket: 50,
        maxTotalCollateral: 50,
        minFreeCollateral: 1,
        maxOpenOrdersPerToken: 2,
        discoverOnly: false,
        cycles: 1,
        refreshSecs: 30,
        statePath: "state/seen-markets.json",
        fillStatePath: "state/fills.json",
        fillMaxRecords: 10000,
        positionReconcileTolerance: 0.000001,
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

    it("counts buy collateral from outcome costs", () => {
        const exposure = new MarketExposure([
            { tokenId: "yes", position: 2, cost: 0.8, proceeds: 0 },
            { tokenId: "no", position: 3, cost: 1.2, proceeds: 0 },
        ]);

        expect(exposure.buyCollateral()).toBe(2);
    });

    it("uses realized average cost after sells for token cost basis", () => {
        expect(
            tokenCostBasis(
                [
                    fillRecord("buy-a", "yes", Side.BUY, 10, 0.4, 1),
                    fillRecord("sell-a", "yes", Side.SELL, 4, 0.7, 2),
                ],
                6,
                0.5,
            ),
        ).toBe(2.4);
    });

    it("falls back to fair price for balance not covered by fills", () => {
        expect(
            tokenCostBasis([fillRecord("buy-a", "yes", Side.BUY, 2, 0.4, 1)], 5, 0.5),
        ).toBe(2.3);
    });

    it("normalizes numeric millisecond trade timestamps to seconds", () => {
        expect(tradeMatchTimeUnixSecs("1700000000123")).toBe(1700000000);
        expect(tradeMatchTimeUnixSecs("1700000000")).toBe(1700000000);
    });

    it("tracks ledger position from buys and sells", () => {
        expect(
            tokenLedgerPosition([
                fillRecord("buy-a", "yes", Side.BUY, 10, 0.4, 1),
                fillRecord("sell-a", "yes", Side.SELL, 4, 0.7, 2),
            ]),
        ).toBe(6);
    });

    it("reports position reconciliation mismatches beyond tolerance", () => {
        expect(positionReconcileErrorFor(6.0000005, 6, 0.000001)).toBeUndefined();
        expect(positionReconcileErrorFor(7, 6, 0.000001)).toMatchObject({
            liveBalance: 7,
            ledgerPosition: 6,
            difference: 1,
            tolerance: 0.000001,
        });
    });

    it("reports unreconciled market state positions", () => {
        const marketState = new LiveMarketState([
            {
                tokenId: "yes",
                fairPrice: 0.5,
                balance: 7,
                costBasis: 2.4,
                positionReconcileError: positionReconcileErrorFor(7, 6, 0.000001),
                balanceFetchedAt: 1_000,
                openOrders: [],
                openOrdersFetchedAt: 1_000,
            } as never,
        ]);

        expect(marketState.positionReconcileRejectReason()).toContain(
            "live balance 7 differs from fill-ledger position 6",
        );
    });

    it("applies token inventory breaches only to their token", () => {
        const breaches: RiskBreach[] = [
            { kind: "tokenInventory", tokenId: "yes", value: 26, limit: 25 },
        ];

        expect(riskBreachAppliesToToken(breaches, "yes")).toBe(true);
        expect(riskBreachAppliesToToken(breaches, "no")).toBe(false);
    });

    it("applies market-level risk breaches to every token", () => {
        const breaches: RiskBreach[] = [
            { kind: "marketLoss", value: 26, limit: 25 },
        ];

        expect(riskBreachAppliesToToken(breaches, "yes")).toBe(true);
        expect(riskBreachAppliesToToken(breaches, "no")).toBe(true);
    });

    it("rejects preflight snapshot market key mismatches", () => {
        const snapshot: PreflightMarketSnapshot = {
            marketKey: "market-a",
            tokenQuotes: [],
            marketState: {} as never,
        };

        expect(() => preflightSnapshotForMarket(snapshot, "market-b")).toThrow(
            "preflight snapshot market mismatch",
        );
    });

    it("rejects large pre-post fair value moves", () => {
        expect(priceMoveRejectReason(0.5, 0.53, 0.01, 2)).toContain(
            "fair moved",
        );
    });

    it("allows pre-post fair value moves at the configured limit", () => {
        expect(priceMoveRejectReason(0.5, 0.52, 0.01, 2)).toBeUndefined();
    });

    it("rejects invalid refreshed book tick size", () => {
        expect(priceMoveRejectReason(0.5, 0.5, 0, 2)).toBe(
            "refreshed book tick size is invalid",
        );
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
        bookFetchedAt: 1_000,
        buyBand: quoteBand(),
    };
}

function quoteBand(): QuoteBand {
    return {
        side: Side.BUY,
        price: 0.49,
        minPrice: 0.47,
        maxPrice: 0.49,
        minimumSize: 1,
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
    assetId = "yes",
): OpenOrder {
    return {
        id,
        status,
        owner: "owner",
        maker_address: "maker",
        market: "market",
        asset_id: assetId,
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

function fillRecord(
    id: string,
    tokenId: string,
    side: Side,
    size: number,
    price: number,
    matchedAtUnixSecs: number,
): FillRecord {
    return {
        id,
        tokenId,
        market: "market-a",
        side,
        size,
        price,
        status: "Matched",
        matchedAtUnixSecs,
    };
}
