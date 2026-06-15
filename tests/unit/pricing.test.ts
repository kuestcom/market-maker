import { describe, expect, it } from "vitest";
import { fairPrice, quotePrices } from "../../src/pricing.js";

describe("pricing", () => {
    it("quotes inside a wide book without crossing fair edge", () => {
        const [buy, sell] = quotePrices(0.5, 0.4, 0.6, 0.01, 1, 2);

        expect(buy).toBe(0.41);
        expect(sell).toBe(0.59);
    });

    it("keeps configured edge on a tight book", () => {
        const [buy, sell] = quotePrices(0.5, 0.49, 0.51, 0.01, 2, 2);

        expect(buy).toBe(0.48);
        expect(sell).toBe(0.52);
    });

    it("refuses prices outside tradeable bounds", () => {
        const [buy, sell] = quotePrices(0.99, undefined, undefined, 0.01, 1, 2);

        expect(buy).toBe(0.97);
        expect(sell).toBeUndefined();
    });

    it("prefers midpoint when the book is two-sided", () => {
        const fair = fairPrice(0.44, 0.56, 0.1, 0.2);

        expect(fair).toBe(0.5);
    });
});
