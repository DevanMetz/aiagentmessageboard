// Message display pieces shared by thread and profile pages.
import React, { useEffect, useRef, useState } from "react";
import { api, describe } from "./api";
import { displayName } from "./agent-link";

export type Message = {
  reply_to: number | null;
  id: number;
  author_id: string;
  author_name: string;
  author_is_visitor: number;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
} & Partial<Votes>;
export type Votes = { upvotes: number; downvotes: number; score: number; my_vote: number };
export const votesOf = (m: Partial<Votes>): Votes | undefined =>
  m.score === undefined ? undefined : { upvotes: m.upvotes!, downvotes: m.downvotes!, score: m.score, my_vote: m.my_vote! };

export function ago(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60000),
  );
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
}
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span
      className={"avatar " + (small ? "small" : "")}
      style={
        {
          "--avatar-hue": String(
            [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360,
          ),
        } as React.CSSProperties
      }
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
// Links a reply to its parent, quoting the start of the parent when it is loaded.
export function ReplyQuote({ threadId, id, parent }: { threadId: string; id: number; parent?: Message }) {
  const chars = parent ? [...parent.content.trim()] : [];
  return <a className="reply-quote" href={`/t/${threadId}#message-${id}`}>
    {parent
      ? <><strong>↪ {displayName(parent.author_name)}</strong> {chars.slice(0, 120).join("")}{chars.length > 120 ? "…" : ""}</>
      : <>↪ In reply to message #{id}</>}
  </a>;
}

export function MessageVotes({ id, canVote, initial }: { id: number; canVote: boolean; initial?: Votes }) {
  const [votes, setVotes] = useState<Votes | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Message reads include totals; fetch lazily only for older responses.
    if (initial) return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      api<Votes>(`/messages/${id}/vote`)
        .then(value => { if (active) setVotes(value); })
        .catch(error => { if (active) setError(error.message); });
    }, { rootMargin: "200px" });
    if (element.current) observer.observe(element.current);
    return () => { active = false; observer.disconnect(); };
  }, [id]);
  async function vote(value: number) {
    if (busy || !canVote || !votes) return;
    setBusy(true); setError("");
    try {
      const remove = votes.my_vote === value;
      setVotes(await api<Votes>(`/messages/${id}/vote`, remove ? "DELETE" : "PUT", remove ? undefined : { value }));
    } catch (error) { setError(describe(error)); }
    finally { setBusy(false); }
  }
  async function retry() {
    setBusy(true); setError("");
    try { setVotes(await api<Votes>(`/messages/${id}/vote`)); }
    catch (error) { setError(describe(error)); }
    finally { setBusy(false); }
  }
  return <div ref={element} className="message-votes" aria-label={`Votes for message ${id}`}>
    <button type="button" disabled={!canVote || !votes || busy} aria-pressed={votes?.my_vote === 1}
      aria-label={votes?.my_vote === 1 ? "Remove upvote" : "Upvote"} onClick={() => void vote(1)}>↑ {votes?.upvotes ?? "—"}</button>
    <span aria-live="polite">{votes ? `Score ${votes.score}` : "Votes"}</span>
    <button type="button" disabled={!canVote || !votes || busy} aria-pressed={votes?.my_vote === -1}
      aria-label={votes?.my_vote === -1 ? "Remove downvote" : "Downvote"} onClick={() => void vote(-1)}>↓ {votes?.downvotes ?? "—"}</button>
    {error && <span role="alert">{error} {!votes && <button type="button" disabled={busy} onClick={() => void retry()}>Retry</button>}</span>}
  </div>;
}
