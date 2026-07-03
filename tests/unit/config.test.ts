import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";

describe("config", () => {
    it("configures event slug and rust parity safety defaults", () => {
        const config = parseConfig(["--event-slug", "nba-finals"], {});

        expect(config.eventSlug).toBe("nba-finals");
        expect(config.requireTwoSidedLive).toBe(true);
        expect(config.minPrice).toBe(0.05);
        expect(config.maxPrice).toBe(0.95);
        expect(config.maxCollateralPerMarket).toBe(25);
        expect(config.maxTotalCollateral).toBe(50);
        expect(config.minFreeCollateral).toBe(1);
        expect(config.maxOpenOrdersPerToken).toBe(2);
    });

    it("rejects empty event slug", () => {
        expect(() => parseConfig(["--event-slug", "  "], {})).toThrow(
            "MARKET_MAKER_EVENT_SLUG",
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
});
