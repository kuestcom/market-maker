import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
    clearPauseState,
    fillRecordsForToken,
    latestMatchedAtUnixSecs,
    loadFillLedger,
    loadPauseState,
    loadSeenMarkets,
    markNew,
    pruneFillLedgerToMaxRecords,
    saveFillLedger,
    savePauseReason,
    saveSeenMarkets,
    upsertFillRecord,
    type FillRecord,
} from "../../src/state.js";

let tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.map(path => rm(path, { recursive: true, force: true })));
    tempDirs = [];
});

describe("state", () => {
    it("loads missing state as empty", async () => {
        const dir = await tempDir();
        const seen = await loadSeenMarkets(join(dir, "state", "seen-markets.json"));

        expect(seen.markets.size).toBe(0);
    });

    it("saves and loads seen markets", async () => {
        const dir = await tempDir();
        const path = join(dir, "state", "seen-markets.json");
        const seen = { markets: new Set(["condition-b", "condition-a"]) };

        await saveSeenMarkets(path, seen);

        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            markets: ["condition-a", "condition-b"],
        });
        await expect(loadSeenMarkets(path)).resolves.toEqual({
            markets: new Set(["condition-a", "condition-b"]),
        });
    });

    it("marks a market new once", () => {
        const seen = { markets: new Set<string>() };

        expect(markNew(seen, "condition-a")).toBe(true);
        expect(markNew(seen, "condition-a")).toBe(false);
    });

    it("saves, loads, and clears pause state", async () => {
        const dir = await tempDir();
        const path = join(dir, "state", "paused.json");

        const saved = await savePauseReason(path, "risk breach market Yes");

        expect(saved.reason).toBe("risk breach market Yes");
        expect(saved.createdAtUnixSecs).toBeGreaterThan(0);
        await expect(loadPauseState(path)).resolves.toEqual(saved);
        await expect(clearPauseState(path)).resolves.toBe(true);
        await expect(loadPauseState(path)).resolves.toBeUndefined();
        await expect(clearPauseState(path)).resolves.toBe(false);
    });

    it("rejects malformed pause state", async () => {
        const dir = await tempDir();
        const path = join(dir, "state", "paused.json");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ reason: "bad", created_at_unix_secs: true }), "utf8");

        await expect(loadPauseState(path)).rejects.toThrow("created_at_unix_secs");
    });

    it("saves and loads fill ledger records by token order", async () => {
        const dir = await tempDir();
        const path = join(dir, "state", "fills.json");
        const ledger = { trades: new Map<string, FillRecord>() };

        expect(upsertFillRecord(ledger, fillRecord("trade-b", "yes", "BUY", 2, 0.4, 2))).toBe(true);
        expect(upsertFillRecord(ledger, fillRecord("trade-a", "yes", "SELL", 1, 0.6, 1))).toBe(true);
        expect(upsertFillRecord(ledger, fillRecord("trade-c", "no", "BUY", 3, 0.5, 3))).toBe(true);
        await saveFillLedger(path, ledger);

        const loaded = await loadFillLedger(path);

        expect(fillRecordsForToken(loaded, "yes").map(record => record.id)).toEqual([
            "trade-a",
            "trade-b",
        ]);
        expect(latestMatchedAtUnixSecs(loaded, "yes")).toBe(2);
        expect(latestMatchedAtUnixSecs(loaded, "missing")).toBeUndefined();
    });

    it("prunes oldest fill records", () => {
        const ledger = { trades: new Map<string, FillRecord>() };
        upsertFillRecord(ledger, fillRecord("trade-a", "yes", "BUY", 1, 0.4, 1));
        upsertFillRecord(ledger, fillRecord("trade-b", "yes", "BUY", 1, 0.4, 2));
        upsertFillRecord(ledger, fillRecord("trade-c", "yes", "BUY", 1, 0.4, 3));

        expect(pruneFillLedgerToMaxRecords(ledger, 2)).toBe(true);
        expect([...ledger.trades.keys()].sort()).toEqual(["trade-b", "trade-c"]);
        expect(pruneFillLedgerToMaxRecords(ledger, 2)).toBe(false);
    });

    it("rejects fill records whose key differs from id", async () => {
        const dir = await tempDir();
        const path = join(dir, "state", "fills.json");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
            path,
            JSON.stringify({ trades: { "trade-key": fillRecordJson("trade-id", "yes", "BUY", 1, 0.4, 1) } }),
            "utf8",
        );

        await expect(loadFillLedger(path)).rejects.toThrow("fill record key must match id");
    });
});

async function tempDir(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "market-maker-"));
    tempDirs.push(path);
    return path;
}

function fillRecord(
    id: string,
    tokenId: string,
    side: string,
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

function fillRecordJson(
    id: string,
    tokenId: string,
    side: string,
    size: number,
    price: number,
    matchedAtUnixSecs: number,
): Record<string, unknown> {
    return {
        id,
        token_id: tokenId,
        market: "market-a",
        side,
        size,
        price,
        status: "Matched",
        matched_at_unix_secs: matchedAtUnixSecs,
    };
}
