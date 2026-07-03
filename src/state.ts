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

export interface FillRecord {
  id: string;
  tokenId: string;
  market: string;
  side: string;
  size: number;
  price: number;
  status: string;
  matchedAtUnixSecs: number;
}

export interface FillLedger {
  trades: Map<string, FillRecord>;
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

export async function loadFillLedger(path: string): Promise<FillLedger> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isFillLedgerJson(parsed)) {
      throw new Error("trades must be an object");
    }
    return {
      trades: new Map(
        Object.entries(parsed.trades).map(([key, value]) => {
          const record = fillRecordFromJson(value);
          if (key !== record.id) {
            throw new Error("fill record key must match id");
          }
          return [key, record];
        }),
      ),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { trades: new Map() };
    }
    throw new Error(`failed to parse ${path}: ${errorMessage(error)}`);
  }
}

export async function saveFillLedger(
  path: string,
  ledger: FillLedger,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const trades = [...ledger.trades.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce<Record<string, unknown>>((items, [id, record]) => {
      items[id] = fillRecordToJson(record);
      return items;
    }, {});
  await writeFile(path, `${JSON.stringify({ trades }, null, 2)}\n`, "utf8");
}

export function upsertFillRecord(ledger: FillLedger, record: FillRecord): boolean {
  const existing = ledger.trades.get(record.id);
  if (existing && fillRecordsEqual(existing, record)) {
    return false;
  }
  ledger.trades.set(record.id, record);
  return true;
}

export function fillRecordsForToken(
  ledger: FillLedger,
  tokenId: string,
): FillRecord[] {
  return [...ledger.trades.values()]
    .filter((record) => record.tokenId === tokenId)
    .sort(
      (left, right) =>
        left.matchedAtUnixSecs - right.matchedAtUnixSecs ||
        left.id.localeCompare(right.id),
    );
}

export function latestMatchedAtUnixSecs(
  ledger: FillLedger,
  tokenId: string,
): number | undefined {
  const matches = [...ledger.trades.values()]
    .filter((record) => record.tokenId === tokenId)
    .map((record) => record.matchedAtUnixSecs);
  return matches.length === 0 ? undefined : Math.max(...matches);
}

export function pruneFillLedgerToMaxRecords(
  ledger: FillLedger,
  maxRecords: number,
): boolean {
  if (ledger.trades.size <= maxRecords) {
    return false;
  }
  const records = [...ledger.trades.values()].sort(
    (left, right) =>
      left.matchedAtUnixSecs - right.matchedAtUnixSecs ||
      left.id.localeCompare(right.id),
  );
  for (const record of records.slice(0, ledger.trades.size - maxRecords)) {
    ledger.trades.delete(record.id);
  }
  return true;
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

function isFillLedgerJson(
  value: unknown,
): value is { trades: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { trades?: unknown }).trades === "object" &&
    (value as { trades?: unknown }).trades !== null &&
    !Array.isArray((value as { trades?: unknown }).trades)
  );
}

function fillRecordFromJson(value: unknown): FillRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fill record must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    id: requiredString(record, "id"),
    tokenId: requiredString(record, "token_id"),
    market: requiredString(record, "market"),
    side: requiredString(record, "side"),
    size: finiteNumber(record, "size"),
    price: finiteNumber(record, "price"),
    status: requiredString(record, "status"),
    matchedAtUnixSecs: integerNumber(record, "matched_at_unix_secs"),
  };
}

function fillRecordToJson(record: FillRecord): Record<string, unknown> {
  return {
    id: record.id,
    token_id: record.tokenId,
    market: record.market,
    side: record.side,
    size: record.size,
    price: record.price,
    status: record.status,
    matched_at_unix_secs: record.matchedAtUnixSecs,
  };
}

function fillRecordsEqual(left: FillRecord, right: FillRecord): boolean {
  return (
    left.id === right.id &&
    left.tokenId === right.tokenId &&
    left.market === right.market &&
    left.side === right.side &&
    left.size === right.size &&
    left.price === right.price &&
    left.status === right.status &&
    left.matchedAtUnixSecs === right.matchedAtUnixSecs
  );
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function finiteNumber(record: Record<string, unknown>, key: string): number {
  const value = Number(record[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function integerNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
