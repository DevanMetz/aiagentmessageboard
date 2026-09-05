import { DurableObject } from "cloudflare:workers";

// USD estimates deliberately ignore free allowances shared with other projects.
// CPU ceiling (100ms), Worker/DO requests, and guard storage overhead.
export const REQUEST_COST = 0.000006;
const RESERVATION = 0.01;
export const databaseCost = (reads: number, writes: number) =>
  reads * 1e-9 + writes * 1e-6;
export function billingCycle(now = new Date()) {
  const year = now.getUTCFullYear(),
    month = now.getUTCMonth();
  const start = new Date(
    Date.UTC(year, month - (now.getUTCDate() < 5 ? 1 : 0), 5),
  );
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 5),
  );
  return { start: start.toISOString(), end: end.toISOString() };
}

interface BudgetEnv {
  BOARD_BUDGET_USD: string;
}
export class BudgetGuard extends DurableObject<BudgetEnv> {
  constructor(ctx: DurableObjectState, env: BudgetEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS budget (
      cycle TEXT PRIMARY KEY, spent REAL NOT NULL, requests INTEGER NOT NULL,
      reads INTEGER NOT NULL, writes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, cycle TEXT NOT NULL);`);
  }
  async fetch(req: Request) {
    const input = (await req.json()) as {
      action: string;
      id?: string;
      reads?: number;
      writes?: number;
    };
    const cycle = billingCycle();
    const sql = this.ctx.storage.sql;
    const limit = Number(this.env.BOARD_BUDGET_USD);
    if (!Number.isFinite(limit) || limit <= 0)
      return Response.json(
        { error: "Budget configuration unavailable" },
        { status: 503 },
      );
    if (input.action === "settle" && input.id) {
      const reads = input.reads ?? 0,
        writes = input.writes ?? 0;
      if (![reads, writes].every((n) => Number.isSafeInteger(n) && n >= 0))
        return new Response(null, { status: 400 });
      this.ctx.storage.transactionSync(() => {
        const lease = sql
          .exec<{ cycle: string }>(
            "DELETE FROM reservations WHERE id=? RETURNING cycle",
            input.id,
          )
          .toArray()[0];
        // Exactly-once settlement. Missing settlements retain the full reserve.
        if (lease)
          sql.exec(
            "UPDATE budget SET spent=spent+?,reads=reads+?,writes=writes+? WHERE cycle=?",
            REQUEST_COST + databaseCost(reads, writes) - RESERVATION,
            reads,
            writes,
            lease.cycle,
          );
      });
      return Response.json({ ok: true });
    }
    const current = () =>
      sql
        .exec<{
          spent: number;
          requests: number;
          reads: number;
          writes: number;
        }>(
          "SELECT spent,requests,reads,writes FROM budget WHERE cycle=?",
          cycle.start,
        )
        .toArray()[0] || { spent: 0, requests: 0, reads: 0, writes: 0 };
    if (input.action === "status")
      return Response.json({
        ...cycle,
        limit_usd: limit,
        estimated_usd_including_reservations: current().spent,
        ...current(),
        hard_billing_cap: false,
        accepting_requests: current().spent + RESERVATION <= limit,
      });
    if (input.action !== "reserve" || !input.id)
      return new Response(null, { status: 400 });
    const accepted = this.ctx.storage.transactionSync(() => {
      if (current().spent + RESERVATION > limit) return false;
      sql.exec(
        "INSERT INTO reservations(id,cycle) VALUES (?,?)",
        input.id!,
        cycle.start,
      );
      sql.exec(
        "INSERT INTO budget VALUES (?,?,1,0,0) ON CONFLICT(cycle) DO UPDATE SET spent=spent+excluded.spent,requests=requests+1",
        cycle.start,
        RESERVATION,
      );
      return true;
    });
    return Response.json(
      { accepted, ...cycle },
      { status: accepted ? 200 : 503 },
    );
  }
}

export function meteredDatabase(db: D1Database) {
  const usage = { reads: 0, writes: 0, unknown: false };
  const pending = new Set<Promise<unknown>>();
  const originals = new WeakMap<object, D1PreparedStatement>();
  const record = (result: D1Result) => {
    usage.reads += result.meta.rows_read || 0;
    usage.writes += result.meta.rows_written || 0;
  };
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const task = operation().catch((e) => {
      usage.unknown = true;
      throw e;
    });
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "first")
          return (column?: string) =>
            track(async () => {
              const result = await target.all();
              record(result);
              const row = result.results[0] || null;
              return column && row ? row[column] : row;
            });
        if (key === "all" || key === "run")
          return () =>
            track(async () => {
              const result = await target[key]();
              record(result);
              return result;
            });
        throw new Error(`Unmetered D1 statement method: ${String(key)}`);
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const database = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          track(async () => {
            const result = await target.batch(
              statements.map((s) => originals.get(s) || s),
            );
            result.forEach(record);
            return result;
          });
      throw new Error(`Unmetered D1 database method: ${String(key)}`);
    },
  });
  return { database, usage, drain: () => Promise.allSettled([...pending]) };
}
