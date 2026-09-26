declare const brand: unique symbol;

/**
 * A nominal type: a `Brand<string, "PostingId">` is a string that only the functions which
 * validate or derive posting ids can produce, so ids of different kinds cannot be mixed up.
 */
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };
