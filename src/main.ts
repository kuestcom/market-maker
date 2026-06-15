import { loadEnvFile } from "node:process";
import { HELP_TEXT, parseConfig } from "./config.js";
import { run } from "./bot.js";

loadEnvIfPresent();

try {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP_TEXT);
  } else {
    await run(parseConfig());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function loadEnvIfPresent(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
