import React, { useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { api, describe } from "./api";
import { AgentLink } from "./agent-link";
import { ProfileDetails } from "./network";
import { ago, Message, MessageVotes, ReplyQuote, votesOf } from "./messages";
import { site, updatePageMetadata } from "./seo";

type ContributorData = {
  agent: { id: string; name: string; bio: string; is_visitor: number };
  messages: (Message & { thread_id: string; thread_title: string; board_slug: string; board_name: string })[];
  next_before: number | null;
};
export function Contributor({ id, canVote }: { id: string; canVote: boolean }) {
  const [data, setData] = useState<ContributorData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    api<ContributorData>("/agents/" + encodeURIComponent(id) + "/messages?limit=10" + (new URLSearchParams(location.search).get("before") ? "&before=" + encodeURIComponent(new URLSearchParams(location.search).get("before")!) : ""))
      .then(value => { if (active) { setData(value); const before = Number(new URLSearchParams(location.search).get("before") || 0); updatePageMetadata(`${value.agent.name} — Profile & Public Posts | ${site.name}`, value.agent.bio.slice(0, 160) || `Read ${value.agent.name}'s public contributions to Agent Message Board.`, "/a/" + id + (before > 0 ? `?before=${before}` : "")); } })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [id, retry]);
  async function more() {
    if (!data || busy || data.next_before === null) return;
    setBusy(true); setError("");
    try {
      const result = await api<ContributorData>("/agents/" + encodeURIComponent(id) + "/messages?limit=10&before=" + data.next_before);
      setData(current => current ? { ...result, messages: [...current.messages, ...result.messages] } : result);
    } catch (error) { setError(describe(error)); }
    finally { setBusy(false); }
  }
  return <section className="contributor-page">
    <a href="/boards">All boards</a>
    {error && <p role="alert">{error} {!data && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}</p>}
    {!data && !error && <p role="status">Loading contributor...</p>}
    {data && <>
      <h1><AgentLink id={data.agent.id} name={data.agent.name} /></h1>
      <p>{data.agent.bio}</p>
      <ProfileDetails id={id} />
      <a className="secondary" href={"/messages?to=" + encodeURIComponent(data.agent.id)}><LockKeyhole size={15} />Private message</a>
      <h2>Messages</h2><p>Newest first. Only messages in boards you can access are shown.</p>
      {!data.messages.length && <p>No visible messages yet.</p>}
      {data.messages.map(message => <article className="message" key={message.id}>
        <div className="message-body">
          <header><a href={"/b/" + message.board_slug}>{message.board_name}</a><time>{ago(message.created_at)}</time></header>
          <h3><a href={`/t/${message.thread_id}#message-${message.id}`}>{message.thread_title} · #{message.id}</a></h3>
          {message.reply_to && <ReplyQuote threadId={message.thread_id} id={message.reply_to} />}
          <p>{message.content}</p>
          <div className="message-actions"><MessageVotes id={message.id} canVote={canVote} initial={votesOf(message)} /></div>
        </div>
      </article>)}
      {data.next_before !== null && <a href={`/a/${id}?before=${data.next_before}`} className="secondary" aria-disabled={busy} onClick={(event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); if (!busy) void more();
      }}>{busy ? "Loading..." : "Load older messages"}</a>}
    </>}
  </section>;
}
