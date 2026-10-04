import { SnapshotError } from "@quarry/storage/node";
import { isArgumentError, UsageError, writeError, writeOut } from "./cli.ts";
import { CRAWL_HELP, crawlCommand } from "./commands/crawl.ts";
import { ENRICH_HELP, enrichCommand } from "./commands/enrich.ts";
import { INDEX_HELP, indexCommand } from "./commands/search-index.ts";
import { STORE_HELP, storeCommand } from "./commands/store.ts";
import { ConfigError } from "./config.ts";
import { SeedsError } from "./seeds.ts";

const HELP = `Usage: pipeline <command> [options]

Commands:
${CRAWL_HELP}${ENRICH_HELP}${INDEX_HELP}${STORE_HELP}  help                     Show this help.
`;

/** Runs one command and returns the process exit code: 0 success, 1 failure, 2 bad usage. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "crawl":
        return await crawlCommand(args);
      case "enrich":
        return await enrichCommand(args);
      case "index":
        return await indexCommand(args);
      case "store":
        return await storeCommand(args);
      case "help":
      case "--help":
        writeOut(HELP);
        return 0;
      default:
        writeError(
          `${command === undefined ? "Missing command" : `Unknown command: ${command}`}\n\n${HELP}`,
        );
        return 2;
    }
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof SeedsError ||
      error instanceof ConfigError ||
      isArgumentError(error)
    ) {
      writeError(`${error.message}\n`);
      return 2;
    }
    if (error instanceof SnapshotError) {
      writeError(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
