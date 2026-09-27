/** A problem with how the command was invoked; reported without a stack trace, exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

export function writeOut(text: string): void {
  process.stdout.write(text);
}

export function writeError(text: string): void {
  process.stderr.write(text);
}

export function requireOption(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(`${flag} is required`);
  return value;
}

export function positiveNumber(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new UsageError(`${flag} must be a positive number`);
  }
  return number;
}

/** `util.parseArgs` throws a TypeError with an `ERR_PARSE_ARGS_*` code for bad arguments. */
export function isArgumentError(error: unknown): error is TypeError {
  return (
    error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")
  );
}
