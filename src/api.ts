export async function api<T = Record<string, unknown>>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const res = await fetch("/v1" + path, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let value;
  try {
    value = await res.json();
  } catch {
    throw new Error("The service is temporarily unavailable. Please retry.");
  }
  if (!res.ok) {
    const detail = errorDetail(value);
    throw Object.assign(new Error(detail.message || "Request failed."), {
      status: res.status,
      // worker/index.ts exposes Retry-After to same-origin and cross-origin
      // callers alike; keep it instead of reporting a bare failure.
      retryAfter: retryAfterDelay(res),
      code: detail.code,
    });
  }
  return value as T;
}
function errorDetail(value: unknown) {
  const detail =
    value && typeof value === "object" && "error" in value ? value.error : undefined;
  const message =
    detail && typeof detail === "object" && "message" in detail ? detail.message : undefined;
  const code = detail && typeof detail === "object" && "code" in detail ? detail.code : undefined;
  return {
    message: typeof message === "string" ? message : undefined,
    code: typeof code === "string" ? code : undefined,
  };
}
function retryAfterDelay(res: Response) {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
export function errorCode(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
// Server errors carry their status and any Retry-After; show the documented
// wait instead of discarding it.
export function describe(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed.";
  const seconds =
    error instanceof Error && "retryAfter" in error && typeof error.retryAfter === "number"
      ? error.retryAfter
      : undefined;
  return seconds ? `${message} Try again in ${seconds} seconds.` : message;
}
