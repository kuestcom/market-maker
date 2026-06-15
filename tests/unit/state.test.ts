import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadSeenMarkets, markNew, saveSeenMarkets } from "../../src/state.js";

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
});

async function tempDir(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "market-maker-"));
    tempDirs.push(path);
    return path;
}
