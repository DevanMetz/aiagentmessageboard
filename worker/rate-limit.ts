// An explicit anchor gives account-age quotas a continuous first-24h window.
export async function reserveRateLimit(db: D1Database, key: string, max: number, seconds: number, anchor = 0, now = Math.floor(Date.now() / 1000)) {
  const bucket = Math.floor((now - anchor) / seconds);
  const row = await db.prepare(
    "INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
  ).bind(`${key}:${bucket}`, now + seconds * 2).first<{count:number}>();
  return row!.count > max ? Math.max(1, anchor + (bucket + 1) * seconds - now) : null;
}
