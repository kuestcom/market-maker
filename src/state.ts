import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "./errors.js";

export interface SeenMarkets {
  markets: Set<string>;
}

export interface PauseState {
  reason: string;
  createdAtUnixSecs: number;
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

export async function loadPauseState(path: string): Promise<PauseState | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPauseStateJson(parsed)) {
      throw new Error("reason must be a string and created_at_unix_secs must be an integer");
    }
    return {
      reason: parsed.reason,
      createdAtUnixSecs: parsed.created_at_unix_secs,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`failed to parse ${path}: ${errorMessage(error)}`);
  }
}

export async function savePauseReason(
  path: string,
  reason: string,
): Promise<PauseState> {
  const pause = {
    reason,
    createdAtUnixSecs: Math.floor(Date.now() / 1000),
  };
  await mkdir(dirname(path), { recursive: true });
  const raw = JSON.stringify(
    {
      reason: pause.reason,
      created_at_unix_secs: pause.createdAtUnixSecs,
    },
    null,
    2,
  );
  await writeFile(path, `${raw}\n`, "utf8");
  return pause;
}

export async function clearPauseState(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw new Error(`failed to clear ${path}: ${errorMessage(error)}`);
  }
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

function isPauseStateJson(
  value: unknown,
): value is { reason: string; created_at_unix_secs: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { reason?: unknown }).reason === "string" &&
    Number.isInteger((value as { created_at_unix_secs?: unknown }).created_at_unix_secs)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
