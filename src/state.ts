import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SeenMarkets {
  markets: Set<string>;
}

export async function loadSeenMarkets(path: string): Promise<SeenMarkets> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isSeenMarketsJson(parsed)) {
      throw new Error("markets must be a list of strings");
    }
    return { markets: new Set(parsed.markets) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { markets: new Set() };
    }
    throw new Error(`failed to parse ${path}: ${errorMessage(error)}`);
  }
}

export async function saveSeenMarkets(
  path: string,
  seen: SeenMarkets,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const raw = JSON.stringify({ markets: [...seen.markets].sort() }, null, 2);
  await writeFile(path, `${raw}\n`, "utf8");
}

export function markNew(seen: SeenMarkets, marketKey: string): boolean {
  const before = seen.markets.size;
  seen.markets.add(marketKey);
  return seen.markets.size !== before;
}

function isSeenMarketsJson(value: unknown): value is { markets: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { markets?: unknown }).markets) &&
    (value as { markets: unknown[] }).markets.every(
      (item) => typeof item === "string",
    )
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
