import { TransportError } from "./errors.ts";

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransportError("operation aborted", { cause: signal.reason });
}

/** Bound even a custom transport that does not itself implement AbortSignal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new TransportError("operation aborted", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function positiveTimeout(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)) {
    throw new RangeError(`${name} must be positive and at most 2147483647 milliseconds`);
  }
  return value;
}
