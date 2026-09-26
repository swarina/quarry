import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CassetteStore, type RecordedExchange, recordedExchangeSchema } from "../cassette.ts";

/**
 * Stores each recorded exchange as `<directory>/<key>.json`. Writes are atomic (temp file plus
 * rename), so an interrupted run never leaves a half-written cassette behind.
 */
export function createFileCassetteStore(directory: string): CassetteStore {
  const pathFor = (key: string): string => join(directory, `${key}.json`);

  return {
    async get(key) {
      let text: string;
      try {
        text = await readFile(pathFor(key), "utf8");
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
      return recordedExchangeSchema.parse(JSON.parse(text));
    },

    async put(key, exchange: RecordedExchange) {
      await mkdir(directory, { recursive: true });
      const path = pathFor(key);
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(exchange, null, 2)}\n`, "utf8");
      await rename(temporaryPath, path);
    },
  };
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
