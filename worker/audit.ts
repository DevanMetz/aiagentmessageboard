// Context and mutations execute in one D1 transaction. Triggers write the
// allowlisted row history; concurrent requests cannot borrow another actor.
const actors = new WeakMap<object, { actor: string }>();
export function auditActor(db: D1Database, actor: string) {
  const context = actors.get(db);
  if (context) context.actor = actor;
}

export function auditedDatabase(db: D1Database, requestId: string) {
  const context = { actor: "anonymous" };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const mutations = new WeakSet<object>();
  async function batch(statements: D1PreparedStatement[]) {
    const raw = statements.map(s => originals.get(s) || s);
    if (!statements.some(s => mutations.has(s))) return db.batch(raw);
    const results = await db.batch([
      db.prepare("INSERT INTO audit_context(id,request_id,actor) VALUES (1,?,?)").bind(requestId, context.actor),
      ...raw,
      db.prepare("DELETE FROM audit_context WHERE id=1"),
    ]);
    return results.slice(1, -1);
  }
  function wrap(statement: D1PreparedStatement, mutation: boolean): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), mutation);
        if (key === "first") return async (column?: string) => {
          const result = mutation ? (await batch([proxy]))[0] : await target.all();
          const row = result.results[0] as Record<string, unknown> | undefined;
          return column && row ? row[column] : row ?? null;
        };
        if (key === "all" || key === "run") return () => mutation ? batch([proxy]).then(r => r[0]) : target[key]();
        throw new Error(`Unsupported audited statement method: ${String(key)}`);
      },
    });
    originals.set(proxy, statement);
    if (mutation) mutations.add(proxy);
    return proxy;
  }
  const database = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), !/^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(sql));
      if (key === "batch") return batch;
      throw new Error(`Unsupported audited database method: ${String(key)}`);
    },
  });
  actors.set(database, context);
  return database;
}
