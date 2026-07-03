import { describe, expect, it } from "vitest";
import { bandMarginTicks, bandSizes, parseConfig } from "../../src/config.js";

describe("config", () => {
    it("configures event slug and rust parity safety defaults", () => {
        const config = parseConfig(["--event-slug", "nba-finals"], {});

        expect(config.eventSlug).toBe("nba-finals");
        expect(config.requireTwoSidedLive).toBe(true);
        expect(config.minPrice).toBe(0.05);
        expect(config.maxPrice).toBe(0.95);
        expect(bandMarginTicks(config)).toEqual([1, 1, 3]);
        expect(bandSizes(config)).toEqual([5, 5, 5]);
        expect(config.maxBookSpreadTicks).toBe(20);
        expect(config.minTopDepth).toBe(5);
        expect(config.maxCollateralPerMarket).toBe(25);
        expect(config.maxLossPerMarket).toBe(25);
        expect(config.maxTotalCollateral).toBe(50);
        expect(config.minFreeCollateral).toBe(1);
        expect(config.maxOpenOrdersPerToken).toBe(2);
        expect(config.cancelAll).toBe(false);
        expect(config.cancelAllOnExit).toBe(false);
    });

    it("rejects empty event slug", () => {
        expect(() => parseConfig(["--event-slug", "  "], {})).toThrow(
            "MARKET_MAKER_EVENT_SLUG",
        );
    });

    it("rejects event slug without a value", () => {
        expect(() => parseConfig(["--event-slug"], {})).toThrow(
            "MARKET_MAKER_EVENT_SLUG requires a value",
        );
    });

    it("rejects invalid price range", () => {
        expect(() =>
            parseConfig(["--min-price", "0.60", "--max-price", "0.40"], {}),
        ).toThrow("MARKET_MAKER_MIN_PRICE");
    });

    it("rejects zero open order limit", () => {
        expect(() => parseConfig(["--max-open-orders-per-token", "0"], {})).toThrow(
            "MARKET_MAKER_MAX_OPEN_ORDERS_PER_TOKEN",
        );
    });

    it("rejects zero market loss limit", () => {
        expect(() => parseConfig(["--max-loss-per-market", "0"], {})).toThrow(
            "MARKET_MAKER_MAX_LOSS_PER_MARKET",
        );
    });

    it("rejects zero max book spread", () => {
        expect(() => parseConfig(["--max-book-spread-ticks", "0"], {})).toThrow(
            "MARKET_MAKER_MAX_BOOK_SPREAD_TICKS",
        );
    });

    it("rejects negative top depth", () => {
        expect(() => parseConfig(["--min-top-depth", "-1"], {})).toThrow(
            "MARKET_MAKER_MIN_TOP_DEPTH",
        );
    });

    it("rejects invalid band margins", () => {
        expect(() =>
            parseConfig([
                "--band-min-margin-ticks", "4",
                "--band-avg-margin-ticks", "3",
                "--band-max-margin-ticks", "5",
            ], {}),
        ).toThrow("MARKET_MAKER_BAND_*_MARGIN_TICKS");
    });

    it("allows average margin override without explicit max margin", () => {
        const config = parseConfig(["--band-avg-margin-ticks", "5"], {});

        expect(bandMarginTicks(config)).toEqual([1, 5, 5]);
    });

    it("rejects invalid band sizes", () => {
        expect(() =>
            parseConfig([
                "--band-min-size", "10",
                "--band-avg-size", "5",
                "--band-max-size", "10",
            ], {}),
        ).toThrow("MARKET_MAKER_BAND_*_SIZE");
    });

    it("rejects fractional open order limit", () => {
        expect(() => parseConfig(["--max-open-orders-per-token", "1.5"], {})).toThrow(
            "MARKET_MAKER_MAX_OPEN_ORDERS_PER_TOKEN must be a positive integer",
        );
    });

    it("rejects cancel-all without live mode", () => {
        expect(() => parseConfig(["--cancel-all"], {})).toThrow(
            "MARKET_MAKER_CANCEL_ALL and MARKET_MAKER_CANCEL_ALL_ON_EXIT require --live",
        );
    });

    it("rejects mutually exclusive cancel modes", () => {
        expect(() =>
            parseConfig(["--cancel-all", "--cancel-all-on-exit"], {}),
        ).toThrow(
            "MARKET_MAKER_CANCEL_ALL and MARKET_MAKER_CANCEL_ALL_ON_EXIT are mutually exclusive",
        );
    });
});
