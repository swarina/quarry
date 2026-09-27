export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Fields a log line may carry. The set is closed on purpose: there is no field for request
 * bodies or posting text, so they can't end up in logs.
 */
export interface LogFields {
  readonly run_id?: string;
  readonly board_id?: string;
  readonly host?: string;
  readonly outcome?: string;
  readonly http_status?: number | null;
  readonly error_code?: string | null;
  readonly error_message?: string | null;
  readonly duration_ms?: number;
  readonly listed?: number;
  readonly new_postings?: number;
  readonly changed_postings?: number;
  readonly invalid?: number;
  readonly bytes?: number;
  readonly boards?: number;
  readonly boards_added?: number;
  readonly boards_reactivated?: number;
  readonly boards_retired?: number;
  readonly boards_denied?: number;
  readonly postings_purged?: number;
  readonly snapshot_seq?: number;
  readonly postings?: number;
  readonly shards?: number;
}

export type Logger = Record<LogLevel, (message: string, fields?: LogFields) => void>;

/** One JSON object per line, written through `write` (stdout in the CLI). */
export function createLogger(
  component: string,
  write: (line: string) => void,
  now: () => number = Date.now,
): Logger {
  const log =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}) => {
      write(
        `${JSON.stringify({ ts: new Date(now()).toISOString(), level, component, msg: message, ...fields })}\n`,
      );
    };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}
