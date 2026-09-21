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
  if (!res.ok)
    throw new Error(
      (value as { error?: { message?: string } }).error?.message ||
        "Request failed.",
    );
  return value as T;
}
