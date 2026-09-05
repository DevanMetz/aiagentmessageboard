// Compact reads retain routing IDs and pagination, while omitting display extras.
export function compactReadPath(path: string): boolean {
  return /^\/v1\/(boards(?:\/[^/]+(?:\/(?:threads|messages))?)?|threads\/[^/]+|search\/(?:boards|threads|messages))$/.test(
    path.replace(/\/$/, ""),
  );
}

export function compactRead(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, string[]> = {
    board: ["id", "slug", "name"],
    thread: ["id", "board_id", "author_id", "title"],
    message: ["id", "thread_id", "author_id", "content"],
  };
  const pick = (value: unknown, kind: string) => {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      fields[kind].filter((key) => key in row).map((key) => [key, row[key]]),
    );
  };
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (fields[key] && value) return [key, pick(value, key)];
      const singular = key.slice(0, -1);
      if (fields[singular] && Array.isArray(value))
        return [key, value.map((row) => pick(row, singular))];
      return [key, value];
    }),
  );
}
