import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import "./moderation.css";

type Account = {
  id: string;
  name: string;
  created_at: string;
  disabled: number;
  is_admin?: number;
  moderation_action_id: string | null;
  posts: number;
  link_posts: number;
  max_repeats: number;
  latest_id: number;
};
type Post = {
  id: number;
  thread_id: string;
  content: string;
  created_at: string;
  deleted: number;
  moderation_action_id: string | null;
  thread_title: string;
  thread_author_id: string;
  thread_deleted: number;
  thread_action_id: string | null;
  board_slug: string;
};
type Queue = {
  accounts: Account[];
  next_offset: number | null;
  window: string;
};
type Detail = {
  account: Account;
  messages: Post[];
  next_before: number | null;
};
type Audit = {
  id: string;
  kind: string;
  target_id: string;
  action: string;
  reason: string;
  created_at: string;
  undo_of: string | null;
};
type Usage = {
  status: string;
  budget: {
    estimated_used_usd: number;
    limit_usd: number;
    used_percent: number;
  };
  cycle: { end: string };
};
type Decision = {
  kind: string;
  target_id: string;
  action: string;
  label: string;
  undo_of?: string;
  reviewed_through?: number;
};

export function Moderation() {
  // Keep this credential in memory only. Reload or Lock forgets it.
  const credential = useRef("");
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [key, setKey] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState("flagged");
  const [queue, setQueue] = useState<Queue | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [auditNext, setAuditNext] = useState<number | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const [updated, setUpdated] = useState("");
  const retry = useRef<{ body: string; id: string } | null>(null);
  useEffect(() => {
    if (decision && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [decision]);

  function lock() {
    generation.current++;
    credential.current = "";
    setKey("");
    setUnlocked(false);
    setQueue(null);
    setDetail(null);
    setAudit([]);
    setUsage(null);
    setDecision(null);
    setError("");
    setNotice("");
  }
  async function request<T>(path: string, data?: unknown): Promise<T> {
    const body = data === undefined ? undefined : JSON.stringify(data);
    if (body && retry.current?.body !== body)
      retry.current = { body, id: crypto.randomUUID() };
    const response = await fetch("/v1/moderation" + path, {
      method: body ? "POST" : "GET",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Authorization: "Bearer " + credential.current,
        ...(body
          ? {
              "Content-Type": "application/json",
              "Idempotency-Key": retry.current!.id,
            }
          : {}),
      },
      body,
    });
    const value = (await response.json()) as T & {
      error?: { message?: string };
    };
    if (!response.ok) {
      if (response.status === 401) lock();
      throw new Error(
        (value.error?.message || "Request failed.") +
          (response.headers.has("Retry-After")
            ? ` Retry in ${response.headers.get("Retry-After")} seconds.`
            : ""),
      );
    }
    return value;
  }
  async function work(task: (current: number) => Promise<void>) {
    setBusy(true);
    setError("");
    const current = generation.current;
    try {
      await task(current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  async function load(selected: string, current: number) {
    const result = await request<Queue>(`/queue?mode=${selected}`);
    if (current !== generation.current) return;
    setQueue(result);
    setMode(selected);
    setUnlocked(true);
    setKey("");
    setUpdated(new Date().toLocaleTimeString());
    try {
      const response = await fetch("/v1/usage", { credentials: "omit" });
      if (!response.ok) throw new Error("Usage information unavailable.");
      const value = (await response.json()) as Usage;
      if (current === generation.current) setUsage(value);
    } catch {
      if (current === generation.current) {
        setUsage(null);
        setError(
          "Queue loaded; usage information is unavailable. Try refreshing.",
        );
      }
    }
  }
  const choose = (d: Decision) => {
    retry.current = null;
    setReason("");
    setDecision(d);
    setError("");
  };
  const signals = (a: Account) =>
    [
      a.max_repeats >= 3 ? `${a.max_repeats} identical posts` : "",
      a.posts >= 40 ? `${a.posts} posts / 24h` : "",
      a.link_posts >= 5 && a.link_posts / a.posts >= 0.8
        ? `${a.link_posts} link posts`
        : "",
    ].filter(Boolean);

  return (
    <div className="mod-shell">
      <header className="mod-header">
        <a href="/">
          <ArrowLeft size={16} /> Message Board
        </a>
        <span>
          <ShieldCheck size={18} /> Moderation
        </span>
        {unlocked && (
          <button className="secondary" disabled={busy} onClick={lock}>
            <LockKeyhole size={15} /> Lock
          </button>
        )}
      </header>
      {!unlocked ? (
        <section className="mod-login">
          <div className="mod-seal">
            <ShieldCheck size={30} />
          </div>
          <div className="eyebrow">OWNER WORKSPACE</div>
          <h1>
            A clearer view.
            <br />
            Your decisions.
          </h1>
          <p>
            Review public activity, inspect flagged accounts, and manage spam.
            Nothing is removed automatically.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              credential.current = key.trim();
              void work((c) => load("flagged", c));
            }}
          >
            <label htmlFor="mod-key">Moderation key</label>
            <input
              id="mod-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
              placeholder="Paste your moderation key"
            />
            <button className="primary" disabled={busy || !key.trim()}>
              {busy ? "Unlocking…" : "Unlock moderation"}
            </button>
          </form>
          <small>
            The key stays in this tab’s memory. Reloading locks the page.
          </small>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </section>
      ) : (
        <>
          <section className="mod-heading">
            <div>
              <div className="eyebrow">PUBLIC COMMUNITY HEALTH</div>
              <h1>Review, then decide.</h1>
              <p>
                Signals help you find activity worth checking. They are not
                proof of spam.
              </p>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void work(async (c) => {
                  if (mode === "history") {
                    const r = await request<{
                      actions: Audit[];
                      next_offset: number | null;
                    }>("/history");
                    if (c === generation.current) {
                      setAudit(r.actions);
                      setAuditNext(r.next_offset);
                    }
                  } else {
                    await load(mode, c);
                    if (detail) {
                      const r = await request<Detail>(
                        `/accounts/${encodeURIComponent(detail.account.id)}?limit=3`,
                      );
                      if (c === generation.current) setDetail(r);
                    }
                  }
                })
              }
            >
              <RefreshCw size={16} /> Refresh
            </button>
          </section>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="mod-notice" role="status">
              <Check size={16} />
              {notice}
            </div>
          )}
          <section className="mod-stats" aria-label="Usage summary">
            <div>
              <small>BACKEND STATUS</small>
              <strong>
                {usage ? usage.status.replaceAll("_", " ") : "Unavailable"}
              </strong>
            </div>
            <div>
              <small>ESTIMATED USAGE</small>
              <strong>
                {usage
                  ? `$${usage.budget.estimated_used_usd.toFixed(3)} / $${usage.budget.limit_usd}`
                  : "—"}
              </strong>
              <span>
                {usage
                  ? `${usage.budget.used_percent.toFixed(1)}% used · resets ${new Date(usage.cycle.end).toLocaleDateString()}`
                  : "Refresh to retry"}
              </span>
            </div>
            <div>
              <small>REVIEW WINDOW</small>
              <strong>Last 24 hours</strong>
              <span>Newest 5,000 public messages · manual refresh</span>
            </div>
          </section>
          <div className="mod-toolbar">
            <nav aria-label="Moderation views">
              {[
                ["flagged", "Flagged"],
                ["recent", "Recent activity"],
                ["suspended", "Suspended"],
                ["history", "Action history"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  disabled={busy}
                  aria-pressed={mode === value}
                  onClick={() =>
                    void work(async (c) => {
                      setDetail(null);
                      if (value === "history") {
                        const r = await request<{
                          actions: Audit[];
                          next_offset: number | null;
                        }>("/history");
                        if (c === generation.current) {
                          setAudit(r.actions);
                          setAuditNext(r.next_offset);
                          setMode(value);
                        }
                      } else await load(value, c);
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </nav>
            <small>Updated {updated}</small>
          </div>
          {mode === "history" ? (
            <section className="mod-history">
              {!audit.length && <p>No moderation actions yet.</p>}
              {audit.map((a) => (
                <article key={a.id}>
                  <div>
                    <strong>
                      {a.action} · {a.kind}
                    </strong>
                    <small>{new Date(a.created_at).toLocaleString()}</small>
                    <p>{a.reason}</p>
                    <code>{a.target_id}</code>
                  </div>
                  {["hide", "suspend"].includes(a.action) && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        choose({
                          kind: a.kind,
                          target_id: a.target_id,
                          action: "restore",
                          undo_of: a.id,
                          label: `Restore ${a.kind} ${a.target_id}`,
                        })
                      }
                    >
                      Undo
                    </button>
                  )}
                </article>
              ))}
              {auditNext !== null && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void work(async (c) => {
                      const r = await request<{
                        actions: Audit[];
                        next_offset: number | null;
                      }>(`/history?offset=${auditNext}`);
                      if (c === generation.current) {
                        setAudit((v) => [...v, ...r.actions]);
                        setAuditNext(r.next_offset);
                      }
                    })
                  }
                >
                  Load older actions
                </button>
              )}
            </section>
          ) : (
            <div className="mod-grid">
              <section className="mod-queue" aria-label="Accounts to review">
                {!queue?.accounts.length && (
                  <div className="mod-empty">
                    <ShieldCheck size={28} />
                    <h2>
                      {mode === "flagged"
                        ? "No flags to review"
                        : "No accounts here"}
                    </h2>
                    <p>
                      {mode === "flagged"
                        ? "No unreviewed accounts match the current signals. You can still browse recent activity."
                        : "Accounts will appear here as activity changes."}
                    </p>
                  </div>
                )}
                {queue?.accounts.map((a) => (
                  <button
                    key={a.id}
                    className={`mod-account ${detail?.account.id === a.id ? "selected" : ""}`}
                    disabled={busy}
                    onClick={() =>
                      void work(async (c) => {
                        const r = await request<Detail>(
                          `/accounts/${encodeURIComponent(a.id)}?limit=3`,
                        );
                        if (c === generation.current) setDetail(r);
                      })
                    }
                  >
                    <strong>{a.name}</strong>
                    <span>
                      {a.disabled
                        ? "Suspended"
                        : `${a.posts} posts · ${a.link_posts} with links`}
                    </span>
                    <div>
                      {signals(a).map((s) => (
                        <em key={s}>{s}</em>
                      ))}
                    </div>
                  </button>
                ))}
                {queue?.next_offset !== null &&
                  queue?.next_offset !== undefined && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void work(async (c) => {
                          const r = await request<Queue>(
                            `/queue?mode=${mode}&offset=${queue.next_offset}`,
                          );
                          if (c === generation.current)
                            setQueue((v) =>
                              v
                                ? {
                                    ...r,
                                    accounts: [...v.accounts, ...r.accounts],
                                  }
                                : r,
                            );
                        })
                      }
                    >
                      Load more accounts
                    </button>
                  )}
              </section>
              <section className="mod-detail" aria-label="Selected account">
                {!detail ? (
                  <div className="mod-empty">
                    <h2>Select an account</h2>
                    <p>
                      See three recent public posts first. Load more context
                      only when you need it.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="mod-detail-heading">
                      <div>
                        <h2>{detail.account.name}</h2>
                        <small>
                          Joined{" "}
                          {new Date(
                            detail.account.created_at,
                          ).toLocaleDateString()}
                        </small>
                        <code>{detail.account.id}</code>
                      </div>
                      <button
                        aria-label="Close account"
                        onClick={() => setDetail(null)}
                      >
                        <X size={18} />
                      </button>
                    </div>
                    <div className="mod-actions">
                      {detail.account.disabled
                        ? detail.account.moderation_action_id && (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                choose({
                                  kind: "account",
                                  target_id: detail.account.id,
                                  action: "restore",
                                  undo_of: detail.account.moderation_action_id!,
                                  label: `Restore ${detail.account.name}`,
                                })
                              }
                            >
                              Restore account
                            </button>
                          )
                        : !detail.account.is_admin &&
                          detail.account.id !== "steward" && (
                            <button
                              className="mod-danger"
                              disabled={busy}
                              onClick={() =>
                                choose({
                                  kind: "account",
                                  target_id: detail.account.id,
                                  action: "suspend",
                                  label: `Suspend ${detail.account.name} site-wide`,
                                })
                              }
                            >
                              Suspend account
                            </button>
                          )}
                      {(() => {
                        const a = queue?.accounts.find(
                          (a) => a.id === detail.account.id,
                        );
                        return a && a.latest_id > 0 ? (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() =>
                              choose({
                                kind: "review",
                                target_id: a.id,
                                action: "dismiss",
                                reviewed_through: a.latest_id,
                                label: `Mark ${a.name} as reviewed`,
                              })
                            }
                          >
                            Mark reviewed
                          </button>
                        ) : null;
                      })()}
                    </div>
                    <p className="mod-help">
                      Suspension blocks the account site-wide and signs it out.
                      Existing posts stay visible until you hide them.
                    </p>
                    {detail.messages.map((m) => (
                      <article className="mod-post" key={m.id}>
                        <header>
                          <a
                            href={`/t/${encodeURIComponent(m.thread_id)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {m.thread_title}
                          </a>
                          <small>
                            {m.board_slug} ·{" "}
                            {new Date(m.created_at).toLocaleString()}
                          </small>
                        </header>
                        <p>
                          {m.content.length > 700
                            ? m.content.slice(0, 700) + "…"
                            : m.content}
                        </p>
                        {m.content.length > 700 && (
                          <details>
                            <summary>Read full message</summary>
                            <p>{m.content}</p>
                          </details>
                        )}
                        <div className="mod-actions">
                          {m.deleted ? (
                            <>
                              <span className="mod-badge">Message hidden</span>
                              {m.moderation_action_id && (
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    choose({
                                      kind: "message",
                                      target_id: String(m.id),
                                      action: "restore",
                                      undo_of: m.moderation_action_id!,
                                      label: `Restore message #${m.id}`,
                                    })
                                  }
                                >
                                  Restore message
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                choose({
                                  kind: "message",
                                  target_id: String(m.id),
                                  action: "hide",
                                  label: `Hide message #${m.id}`,
                                })
                              }
                            >
                              Hide message
                            </button>
                          )}
                          {m.thread_deleted ? (
                            <>
                              <span className="mod-badge">Thread hidden</span>
                              {m.thread_action_id && (
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    choose({
                                      kind: "thread",
                                      target_id: m.thread_id,
                                      action: "restore",
                                      undo_of: m.thread_action_id!,
                                      label: "Restore this thread",
                                    })
                                  }
                                >
                                  Restore thread
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                choose({
                                  kind: "thread",
                                  target_id: m.thread_id,
                                  action: "hide",
                                  label:
                                    "Hide this entire thread and all replies",
                                })
                              }
                            >
                              Hide thread
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                    {detail.next_before !== null && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void work(async (c) => {
                            const r = await request<Detail>(
                              `/accounts/${encodeURIComponent(detail.account.id)}?limit=10&before=${detail.next_before}`,
                            );
                            if (c === generation.current)
                              setDetail((v) =>
                                v
                                  ? {
                                      ...r,
                                      messages: [...v.messages, ...r.messages],
                                    }
                                  : r,
                              );
                          })
                        }
                      >
                        Load older posts
                      </button>
                    )}
                  </>
                )}
              </section>
            </div>
          )}
          <footer className="mod-footnote">
            Signals: 3 identical posts, 40 posts in 24h, or at least 5 link
            posts making up 80% of activity. Counts use the newest 5,000 visible
            public messages. Private boards are excluded. Budget figures are
            estimates, not a billing cap.
          </footer>
        </>
      )}
      {decision && (
          <dialog
            ref={dialog}
            className="mod-confirm"
            aria-labelledby="decision-title"
            onCancel={e => { e.preventDefault(); if (!busy) setDecision(null); }}
          >
            <h2 id="decision-title">{decision.label}?</h2>
            <p>
              {decision.action === "dismiss"
                ? "New posts can flag this account again."
                : decision.action === "restore"
                  ? "This only undoes the selected action. A newer action cannot be overwritten."
                  : "This action is recorded and can be undone from the action history."}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void work(async (c) => {
                  const { label, ...payload } = decision;
                  await request("/actions", {
                    ...payload,
                    reason: reason.trim(),
                  });
                  if (c !== generation.current) return;
                  retry.current = null;
                  setDecision(null);
                  setNotice(`${label}: done.`);
                  if (mode === "history") {
                    const r = await request<{
                      actions: Audit[];
                      next_offset: number | null;
                    }>("/history");
                    setAudit(r.actions);
                    setAuditNext(r.next_offset);
                  } else {
                    await load(mode, c);
                    if (detail) {
                      const r = await request<Detail>(
                        `/accounts/${encodeURIComponent(detail.account.id)}?limit=3`,
                      );
                      if (c === generation.current) setDetail(r);
                    }
                  }
                });
              }}
            >
              <label htmlFor="mod-reason">Reason for the record</label>
              <textarea
                id="mod-reason"
                autoFocus
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Describe the evidence or reason for this decision"
              />
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="mod-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setDecision(null)}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={busy || reason.trim().length < 3}
                >
                  {busy ? "Saving…" : "Confirm decision"}
                </button>
              </div>
            </form>
          </dialog>
      )}
    </div>
  );
}
