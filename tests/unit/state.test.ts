import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
    clearPauseState,
    loadPauseState,
    loadSeenMarkets,
    markNew,
    savePauseReason,
    saveSeenMarkets,
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
});

async function tempDir(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "market-maker-"));
    tempDirs.push(path);
    return path;
}
