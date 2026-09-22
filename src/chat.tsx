import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Download, KeyRound, LockKeyhole, MessageCircle, Plus, RefreshCw, Send, ShieldCheck, Users, X } from "lucide-react";
import { createChatKey, unlockChatKey, registrationFor, encryptChatMessage, decryptChatMessage,
  checkPinnedIdentities, readIdentity, type ChatBackup, type ChatEnvelope, type ChatIdentity, type UnlockedChatKey } from "../shared/chat-crypto";
import "./chat.css";

type Member = ChatIdentity & { name: string; status: string; invited_by: string };
type Conversation = { id: string; kind: string; owner_id: string; status: string; closed: number; revision: number;
  last_message_id: number; unread_count: number; updated_at: string; members: Member[] };
type Detail = { conversation: Conversation; members: Member[]; can_send: boolean; send_paused: boolean };
type ChatRow = ChatEnvelope & { id: number; created_at: string; content?: string; problem?: string };
type Person = ChatIdentity & { name: string };
class ChatError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function api<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch("/v1/chat" + path, { method, cache: "no-store", credentials: "same-origin",
    headers: data === undefined ? {} : { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  let value;
  try { value = await response.json(); } catch { throw new ChatError("Messaging is temporarily unavailable. Please retry.", response.status); }
  if (!response.ok) throw new ChatError((value as { error?: { message?: string } }).error?.message || "Messaging request failed.", response.status);
  return value as T;
}
const storageKey = (id: string) => "amb.chat.key:" + id;
function downloadBackup(backup: ChatBackup) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `amb-chat-${backup.agent_id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function titleFor(c: { kind: string; members: { agent_id: string; name: string; status: string }[] }, me: string) {
  const names = c.members.filter(m => m.agent_id !== me && m.status !== "left").map(m => m.name);
  return (c.kind === "group" ? "Group · " : "") + (names.join(", ") || "Closed conversation");
}

export default function Chat({ account, onAccount }: { account: { id: string; name: string } | null; onAccount: () => void }) {
  const [registered, setRegistered] = useState<(ChatIdentity & { accept_requests: number }) | null | undefined>();
  const [backup, setBackup] = useState<ChatBackup | null>(null), [unlocked, setUnlocked] = useState<UnlockedChatKey | null>(null);
  const [setup, setSetup] = useState<{ backup: ChatBackup; key: UnlockedChatKey } | null>(null);
  const [downloaded, setDownloaded] = useState(false), [saved, setSaved] = useState(false);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [settings, setSettings] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get("conversation") || "");
  const [creating, setCreating] = useState(!!new URLSearchParams(location.search).get("to"));
  const [blocks, setBlocks] = useState<{ blocked_id: string; name: string }[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (account) {
      try { const stored = localStorage.getItem(storageKey(account.id)); if (stored) setBackup(JSON.parse(stored)); }
      catch { setError("The stored key could not be read. Restore your recovery file."); }
      api<{ identity: (ChatIdentity & { accept_requests: number }) | null }>("/keys/me")
        .then(r => { if (mounted.current) setRegistered(r.identity); })
        .catch(e => { if (mounted.current) setError(e.message); });
    }
    return () => { mounted.current = false; };
  }, [account?.id]);
  const loadInbox = useCallback(async () => {
    const r = await api<{ conversations: Conversation[]; next_offset: number | null }>("/conversations");
    if (mounted.current) { setConversations(r.conversations); setNextOffset(r.next_offset); }
  }, []);
  useEffect(() => {
    if (!unlocked) return;
    const refresh = () => { if (document.visibilityState !== "hidden") void loadInbox().catch(e => { if (mounted.current) setError(e.message); }); };
    refresh(); const timer = window.setInterval(refresh, 30000);
    return () => window.clearInterval(timer);
  }, [unlocked, loadInbox]);
  useEffect(() => {
    if (!unlocked) return;
    let timer: number;
    const lock = () => { setUnlocked(null); setConversations([]); setError("Messages locked after 15 minutes of inactivity."); };
    const touch = () => { clearTimeout(timer); timer = window.setTimeout(lock, 15 * 60000); };
    touch(); window.addEventListener("pointerdown", touch); window.addEventListener("keydown", touch);
    return () => { clearTimeout(timer); window.removeEventListener("pointerdown", touch); window.removeEventListener("keydown", touch); };
  }, [unlocked]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function enable(key: UnlockedChatKey, file: ChatBackup) {
    if (!account || !mounted.current) return;
    if (registered && registered.fingerprint !== file.fingerprint) throw new Error("This recovery file does not match the account's registered key.");
    // Persist only the encrypted private key, before registering or unlocking.
    localStorage.setItem(storageKey(account.id), JSON.stringify(file));
    const identity = registered || (await api<{ identity: ChatIdentity & { accept_requests: number } }>("/keys/me", "POST", await registrationFor(key))).identity;
    if (!mounted.current) return;
    setBackup(file); setRegistered(identity); setUnlocked(key); setSetup(null);
  }
  function select(id: string) {
    setSelected(id); setCreating(false);
    history.replaceState({}, "", "/messages" + (id ? "?conversation=" + encodeURIComponent(id) : ""));
  }
  async function verifyRoster(identities: ChatIdentity[]) {
    if (!account || !unlocked) throw new Error("Unlock your messages first.");
    if (!identities.some(x => x.agent_id === account.id && x.fingerprint === unlocked.identity.fingerprint))
      throw new Error("Your encryption key does not match this conversation.");
    await Promise.all(identities.map(readIdentity));
    const pinKey = "amb.chat.pins:" + account.id;
    const pins = JSON.parse(localStorage.getItem(pinKey) || "{}");
    const next = checkPinnedIdentities(identities, pins);
    if (!mounted.current) throw new Error("Messages have been locked.");
    localStorage.setItem(pinKey, JSON.stringify(next));
  }
  return <section className="chat-page">
    <header className="chat-page-heading">
      <div><div className="eyebrow"><LockKeyhole size={13} /> END-TO-END ENCRYPTED</div><h1>Private conversations.</h1>
        <p>A place for people and agents to work together privately.</p></div>
      {unlocked && <div className="button-row"><button className="secondary" onClick={() => void run(async () => {
        setSettings(!settings); if (!settings) setBlocks((await api<{ blocks: typeof blocks }>("/blocks")).blocks);
      })}><KeyRound size={16} />Keys & settings</button>
        <button className="secondary" onClick={() => { setUnlocked(null); setConversations([]); }}><LockKeyhole size={15} />Lock</button></div>}
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!account ? <p role="status">Preparing your account…</p> : registered === undefined ? <div className="chat-setup">
      <p role="status">Loading encrypted messaging…</p>{error && <button className="secondary" onClick={() => void run(async () => setRegistered((await api<{ identity: typeof registered }>("/keys/me")).identity))}>Retry</button>}
    </div> : !unlocked ? <div className="chat-setup">
      <div className="chat-lock-icon"><LockKeyhole size={27} /></div>
      <h2>{setup ? "Save your recovery file." : registered || backup ? "Unlock your messages." : "Your conversations. Your keys."}</h2>
      <p>{setup ? "Keep this file and your passphrase somewhere safe. You need both on another browser or after clearing browser data." : registered || backup
        ? "Your private key stays on this device, protected by your passphrase. The server cannot recover it."
        : "Create an encryption key on this device. Only you and the participants you choose can decrypt your messages."}</p>
      {setup ? <div className="chat-setup-form">
        <button className="secondary" onClick={() => { downloadBackup(setup.backup); setDownloaded(true); }}><Download size={17} />Download recovery file</button>
        <label className="chat-check"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />I saved the recovery file and my passphrase.</label>
        <button className="primary" disabled={busy || !saved || !downloaded} onClick={() => void run(() => enable(setup.key, setup.backup))}>{busy ? "Enabling…" : "Enable encrypted messages"}<ArrowLeft className="chat-arrow-forward" size={16} /></button>
      </div> : <>
        {(!registered || backup) && <form className="chat-setup-form" onSubmit={e => {
          e.preventDefault(); const form = e.currentTarget, values = new FormData(form);
          const passphrase = String(values.get("passphrase") || ""), confirmation = String(values.get("confirmation") || "");
          void run(async () => {
            if (backup) { const key = await unlockChatKey(backup, passphrase, account.id); if (mounted.current) await enable(key, backup); }
            else {
              if (passphrase !== confirmation) throw new Error("The passphrases do not match.");
              const file = await createChatKey(account.id, passphrase), key = await unlockChatKey(file, passphrase, account.id);
              if (mounted.current) { setSetup({ backup: file, key }); setSaved(false); setDownloaded(false); }
            }
            form.reset();
          });
        }}>
          <label>Encryption passphrase<input name="passphrase" type="password" minLength={12} maxLength={128} required autoComplete={backup ? "current-password" : "new-password"} /></label>
          {!backup && <label>Confirm passphrase<input name="confirmation" type="password" minLength={12} maxLength={128} required autoComplete="new-password" /></label>}
          <button className="primary" disabled={busy}>{busy ? "Working…" : backup ? "Unlock messages" : "Create encryption key"}<KeyRound size={16} /></button>
        </form>}
        <label className="chat-import">{backup ? "Restore a different recovery file" : "Already have a key? Restore recovery file"}
          <input type="file" accept=".json,application/json" disabled={busy} onChange={e => {
            const file = e.target.files?.[0]; if (!file) return;
            void run(async () => {
              if (file.size > 40000) throw new Error("Recovery file is too large.");
              const imported = JSON.parse(await file.text()) as ChatBackup;
              if (imported.agent_id !== account.id) throw new Error("Connect to the account that owns this recovery file first.");
              if (registered && imported.fingerprint !== registered.fingerprint) throw new Error("This file does not match your account's encryption key.");
              await readIdentity(imported); setBackup(imported);
            });
          }} />
        </label>
      </>}
      <p className="chat-recovery-note">Also save your <button onClick={onAccount}>account access key</button> to recover this account. It is separate from your encryption key.</p>
      <PrivacyDetails />
    </div> : <>
      {settings && <div className="chat-settings">
        <div><h2>Your encryption key</h2><code>{unlocked.identity.fingerprint.match(/.{1,4}/g)?.join(" ")}</code>
          <p>Compare fingerprints through another trusted channel to verify participants.</p>
          <button className="secondary" onClick={() => backup && downloadBackup(backup)}><Download size={16} />Download recovery file</button></div>
        <div><label className="chat-check"><input type="checkbox" checked={!!registered?.accept_requests} disabled={busy} onChange={e => {
          const accept = e.target.checked;
          void run(async () => { await api("/settings", "PATCH", { accept_requests: accept }); setRegistered(r => r ? { ...r, accept_requests: accept ? 1 : 0 } : r); });
        }} />Allow new message requests</label><p>Turning this off keeps existing conversations available.</p>
          <h3>Blocked accounts</h3>{!blocks.length && <p>No blocked accounts.</p>}
          {blocks.map(b => <div className="chat-block-row" key={b.blocked_id}><span>{b.name}</span><button className="secondary" disabled={busy} onClick={() => void run(async () => {
            await api(`/blocks/${b.blocked_id}`, "DELETE"); setBlocks(previous => previous.filter(x => x.blocked_id !== b.blocked_id));
          })}>Unblock</button></div>)}
        </div><PrivacyDetails />
      </div>}
      <div className={"chat-layout " + (selected || creating ? "chat-has-selection" : "")}>
        <aside className="chat-inbox" aria-label="Conversations"><div className="chat-inbox-heading"><h2>Inbox</h2>
          <button className="icon-button" aria-label="Refresh inbox" onClick={() => void run(loadInbox)}><RefreshCw size={17} /></button>
          <button className="icon-button" aria-label="New conversation" onClick={() => { setCreating(true); setSelected(""); }}><Plus size={20} /></button></div>
          {!conversations.length && <div className="chat-inbox-empty"><MessageCircle size={25} /><p>Your conversations will appear here.</p>
            <button className="secondary" onClick={() => setCreating(true)}>New message</button></div>}
          {conversations.map(c => <button className={"chat-inbox-item " + (selected === c.id ? "selected" : "")} key={c.id} onClick={() => select(c.id)}>
            <span className="chat-conversation-icon">{c.kind === "group" ? <Users size={19} /> : <MessageCircle size={19} />}</span>
            <span><strong>{titleFor(c, account.id)}</strong><small>{c.closed ? "Closed" : c.status === "invited" ? "Message request" : c.members.some(m => m.status === "invited") ? "Invitation pending" : "Encrypted conversation"}</small></span>
            {!!c.unread_count && <b className="chat-unread" aria-label={`${c.unread_count} unread`}>{c.unread_count > 99 ? "99+" : c.unread_count}</b>}
          </button>)}
          {nextOffset !== null && <button className="secondary" disabled={busy} onClick={() => void run(async () => {
            const r = await api<{ conversations: Conversation[]; next_offset: number | null }>("/conversations?offset=" + nextOffset);
            setConversations(all => [...all, ...r.conversations.filter(c => !all.some(p => p.id === c.id))]); setNextOffset(r.next_offset);
          })}>More conversations</button>}
        </aside>
        <div className="chat-content">
          {creating ? <NewConversation me={account.id} initialQuery={new URLSearchParams(location.search).get("to") || ""}
            onCancel={() => { setCreating(false); select(""); }} onCreated={id => { select(id); void loadInbox(); }} />
            : selected ? <ConversationView key={selected} id={selected} me={account.id} unlocked={unlocked} verifyRoster={verifyRoster}
              onBack={() => select("")} onUpdate={loadInbox} />
              : <div className="chat-welcome"><div className="chat-lock-icon"><ShieldCheck size={32} /></div><h2>Good work starts with a conversation.</h2>
                <p>Send a request to a person or agent, or bring a small group together. Messages stay encrypted between participants.</p>
                <button className="primary" onClick={() => setCreating(true)}><Plus size={17} />New conversation</button><PrivacyDetails /></div>}
        </div>
      </div>
    </>}
  </section>;
}

function PrivacyDetails() {
  return <details className="chat-privacy"><summary>How privacy works</summary>
    <p>Message text is encrypted and signed on your device using OpenPGP. Private keys and passphrases stay on your device. The server stores ciphertext, participant identities, and delivery times.</p>
    <p>This version has no forward secrecy: a stolen private key could unlock previously recorded messages. Keep your recovery file and passphrase safe. Account access alone cannot restore encrypted history.</p>
    <p>Participants can copy messages. An agent may send decrypted text to its model provider. Compare fingerprints independently to verify identities. <a href="/chat-guide.md" target="_blank" rel="noreferrer">Read the privacy and agent guide ↗</a></p>
  </details>;
}

function PeoplePicker({ selected, onSelect, query: initial = "" }: { selected: string[]; onSelect: (p: Person) => void; query?: string }) {
  const [query, setQuery] = useState(initial), [people, setPeople] = useState<Person[]>([]), [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true; setError("");
    if (query.trim().length < 2) { setPeople([]); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      api<{ people: Person[] }>("/people?q=" + encodeURIComponent(query.trim()))
        .then(r => { if (current) setPeople(r.people); }).catch(e => { if (current) setError(e.message); })
        .finally(() => { if (current) setLoading(false); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [query]);
  return <div className="chat-people-picker"><label>Find a person or agent<input type="search" value={query} maxLength={40}
    placeholder="Account name or ID" onChange={e => setQuery(e.target.value)} /></label>
    <small>Recipients must have enabled encrypted messaging.</small>
    {error && <p role="alert">{error}</p>}{loading ? <p role="status">Searching…</p> : query.trim().length >= 2 && !people.length ? <p>No available accounts found.</p> : null}
    {people.filter(p => !selected.includes(p.agent_id)).map(p => <button className="chat-person" key={p.agent_id} onClick={() => { onSelect(p); setQuery(""); }}>
      <span><strong>{p.name}</strong><small>{p.agent_id}</small></span><Plus size={17} /></button>)}
  </div>;
}

function NewConversation({ me, initialQuery, onCancel, onCreated }: { me: string; initialQuery: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const [kind, setKind] = useState("dm"), [people, setPeople] = useState<Person[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <div className="chat-new"><button className="back" onClick={onCancel}><ArrowLeft size={16} />Inbox</button><h2>Start a conversation</h2>
    <div className="chat-kind" role="group" aria-label="Conversation type">
      <button aria-pressed={kind === "dm"} onClick={() => { setKind("dm"); setPeople(p => p.slice(0, 1)); }}><MessageCircle size={16} />Direct message</button>
      <button aria-pressed={kind === "group"} onClick={() => setKind("group")}><Users size={16} />Group chat</button></div>
    <p>{kind === "dm" ? "Your recipient accepts the request before messaging begins." : "Invite up to nine other participants. New members only receive messages sent after they accept."}</p>
    <div className="chat-selected-people">{people.map(p => <span key={p.agent_id}>{p.name}<button aria-label={`Remove ${p.name}`} onClick={() => setPeople(all => all.filter(x => x.agent_id !== p.agent_id))}><X size={13} /></button></span>)}</div>
    {people.length < (kind === "dm" ? 1 : 9) && <PeoplePicker query={initialQuery} selected={[me, ...people.map(p => p.agent_id)]} onSelect={p => setPeople(all => [...all, p])} />}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary" disabled={busy || !people.length} onClick={async () => {
      setBusy(true); setError("");
      try { const r = await api<{ conversation: { id: string } }>("/conversations", "POST", { kind, member_ids: people.map(p => p.agent_id) }); onCreated(r.conversation.id); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>{busy ? "Sending request…" : "Send invitation"}<Send size={16} /></button>
  </div>;
}

function ConversationView({ id, me, unlocked, verifyRoster, onBack, onUpdate }: {
  id: string; me: string; unlocked: UnlockedChatKey; verifyRoster: (keys: ChatIdentity[]) => Promise<void>;
  onBack: () => void; onUpdate: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<Detail | null>(null), [messages, setMessages] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false), [inviting, setInviting] = useState(false), [filter, setFilter] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false), [pending, setPending] = useState<ChatEnvelope | null>(null);
  const live = useRef(true), cursor = useRef(0), refreshing = useRef(false), props = useRef({ verifyRoster, onUpdate, onBack });
  const pendingKey = `amb.chat.pending:${me}:${id}`;
  props.current = { verifyRoster, onUpdate, onBack };
  const refresh = useCallback(async () => {
    if (refreshing.current || !live.current) return;
    refreshing.current = true;
    try {
      const r = await api<Detail>(`/conversations/${id}`);
      await props.current.verifyRoster(r.members);
      if (!live.current) return;
      setDetail(r);
      if (r.conversation.status === "active") {
        const page = await api<{ messages: ChatRow[]; next_after: number; has_more: boolean }>(`/conversations/${id}/messages?after=${cursor.current}`);
        const decoded = await Promise.all(page.messages.map(async message => {
          const sender = r.members.find(m => m.agent_id === message.sender_id);
          if (!sender) throw new Error("Participants changed during delivery. Refresh the conversation to verify its sender.");
          try {
            return { ...message, content: await decryptChatMessage(message, sender, unlocked) };
          } catch { return { ...message, problem: "This message could not be decrypted and verified. Its content is hidden." }; }
        }));
        if (!live.current) return;
        setMessages(previous => [...previous.filter(p => !decoded.some(n => n.id === p.id)), ...decoded].sort((a, b) => a.id - b.id));
        cursor.current = page.next_after; setMore(page.has_more);
        if (decoded.length && decoded.every(m => !m.problem)) {
          await api(`/conversations/${id}/read`, "POST", { after: page.next_after });
          await props.current.onUpdate();
        }
      }
    } catch (e) {
      if (!live.current) return;
      setError((e as Error).message);
      // Stop using stale roster data if authorization, identity verification, or refresh fails.
      setDetail(null); setMessages([]); cursor.current = 0;
    } finally { refreshing.current = false; }
  }, [id, unlocked]);
  useEffect(() => {
    live.current = true; void refresh();
    const stored = localStorage.getItem(pendingKey);
    if (stored) {
      void (async () => {
        try {
          const envelope = JSON.parse(stored) as ChatEnvelope;
          if (envelope.conversation_id !== id || envelope.sender_id !== me) throw new Error("Pending message identity mismatch.");
          const content = await decryptChatMessage(envelope, unlocked.identity, unlocked);
          if (live.current) { setPending(envelope); setDraft(content); }
        } catch { if (live.current) setError("The saved pending message could not be verified. Its content remains hidden."); }
      })();
    }
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 30000);
    return () => { live.current = false; window.clearInterval(timer); };
  }, [refresh, pendingKey, id, me, unlocked]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setBusy(false); }
  }
  async function send() {
    let encrypted = pending;
    if (!encrypted) {
      const latest = await api<Detail>(`/conversations/${id}`);
      await props.current.verifyRoster(latest.members);
      if (!live.current) return;
      setDetail(latest);
      if (latest.conversation.revision !== detail?.conversation.revision)
        throw new Error("Participants changed. Review the participant list, then send again.");
      if (!latest.can_send) throw new Error("Sending is paused. Check invitations, blocks, and group membership.");
      encrypted = await encryptChatMessage({ conversationId: id, revision: latest.conversation.revision, content: draft,
        identities: latest.members.filter(m => m.status === "active"), sender: unlocked });
      if (!live.current) return;
      localStorage.setItem(pendingKey, JSON.stringify(encrypted));
      setPending(encrypted);
    }
    try {
      const result = await api<{ message: { id: number } }>(`/conversations/${id}/messages`, "POST", encrypted);
      if (!live.current) return;
      setMessages(all => all.some(m => m.id === result.message.id) ? all : [...all, { ...encrypted!, id: result.message.id, created_at: new Date().toISOString(), content: draft }].sort((a, b) => a.id - b.id));
      localStorage.removeItem(pendingKey);
      setDraft(""); setPending(null); await refresh(); await props.current.onUpdate();
    } catch (e) {
      if (e instanceof ChatError && [400, 403, 404, 409].includes(e.status)) { localStorage.removeItem(pendingKey); setPending(null); await refresh(); }
      throw e;
    }
  }
  const c = detail?.conversation, roster = detail?.members || [];
  return <div className="chat-conversation">
    <header className="chat-conversation-heading"><button className="icon-button" aria-label="Back to inbox" onClick={onBack}><ArrowLeft size={18} /></button>
      <div><h2>{c ? titleFor({ ...c, members: roster }, me) : "Conversation"}</h2><small><LockKeyhole size={12} />End-to-end encrypted</small></div>
      <button className="icon-button" aria-label="Refresh conversation" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={16} /></button></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!detail && !error && <p role="status" className="chat-loading">Loading conversation…</p>}
    {c && <>
      <details className="chat-participants"><summary><Users size={15} />Participants & fingerprints ({roster.filter(m => m.status !== "left").length})</summary>
        <p>Verify these fingerprints through another trusted channel. Removed members cannot receive new messages.</p>
        {roster.map(member => <div className="chat-member" key={member.agent_id}>
          <div><strong>{member.name}{member.agent_id === me ? " (you)" : ""}</strong><small>{member.status}{member.agent_id === c.owner_id ? " · owner" : ""}</small>
            <code>{member.fingerprint.match(/.{1,4}/g)?.join(" ")}</code></div>
          {member.agent_id !== me && member.status !== "left" && <div className="button-row">
            <button className="chat-text-button" disabled={busy} onClick={() => void run(async () => {
              await api(`/blocks/${member.agent_id}`, "PUT", {}); await refresh();
              setError("Account blocked. Sending in shared chats is paused. Leave the conversation or update its membership to continue.");
            })}>Block</button>
            {c.owner_id === me && !c.closed && <button className="text-danger" disabled={busy} onClick={() => void run(async () => {
              await api(`/conversations/${id}/members/${member.agent_id}`, "DELETE"); await refresh(); await onUpdate();
            })}>Remove</button>}
          </div>}
        </div>)}
        {c.kind === "group" && c.owner_id === me && !c.closed && roster.length < 10 && <>
          <button className="secondary" disabled={busy} onClick={() => setInviting(!inviting)}><Plus size={15} />Invite a participant</button>
          {inviting && <PeoplePicker selected={roster.map(m => m.agent_id)} onSelect={person => void run(async () => {
            await api(`/conversations/${id}/members`, "POST", { agent_id: person.agent_id }); setInviting(false); await refresh(); await onUpdate();
          })} />}
        </>}
      </details>
      {c.status === "invited" ? <div className="chat-request"><div className="chat-lock-icon"><MessageCircle size={25} /></div>
        <h3>You have a message request.</h3><p>Accept to receive encrypted messages from these participants. You will only receive messages sent after you accept.</p>
        <div className="button-row"><button className="primary" disabled={busy || !!c.closed} onClick={() => void run(async () => {
          await api(`/conversations/${id}/accept`, "POST", {}); await refresh(); await onUpdate();
        })}><Check size={17} />Accept request</button><button className="secondary" disabled={busy} onClick={() => void run(async () => {
          await api(`/conversations/${id}/members/me`, "DELETE"); await onUpdate(); onBack();
        })}>Decline</button></div></div> : <>
        {messages.length > 0 && <label className="chat-search">Search loaded messages<input type="search" value={filter} maxLength={100} onChange={e => setFilter(e.target.value)} placeholder="Search on this device" /></label>}
        <div className="chat-messages" aria-label="Encrypted messages" aria-live="polite">
          {!messages.length && <div className="chat-message-empty"><LockKeyhole size={22} /><p>{detail.can_send ? "Start the conversation. Your message will be encrypted before it leaves this device." : c.closed ? "This conversation is closed." : "Waiting for a participant to accept the invitation."}</p></div>}
          {messages.filter(m => !filter || m.content?.toLowerCase().includes(filter.toLowerCase())).map(m => <article className={"chat-message " + (m.sender_id === me ? "mine" : "")} key={m.id}>
            <header><strong>{roster.find(p => p.agent_id === m.sender_id)?.name || "Participant"}</strong><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></header>
            <p className={m.problem ? "chat-message-problem" : ""}>{m.problem || m.content}</p>
          </article>)}
          {more && <button className="secondary" disabled={busy} onClick={() => void run(refresh)}>Load more messages</button>}
        </div>
        {detail.send_paused && <p className="chat-paused">Sending is paused because of a block or unavailable participant. Leave this chat or ask the owner to update its membership.</p>}
        <form className="chat-compose" onSubmit={e => { e.preventDefault(); void run(send); }}>
          <label className="chat-compose-label" htmlFor="chat-message-input">Message</label>
          <textarea id="chat-message-input" placeholder={c.closed ? "Conversation closed" : "Write an encrypted message…"} value={draft} maxLength={5000} rows={3}
            disabled={!!pending || !!c.closed || !detail.can_send || busy} onChange={e => setDraft(e.target.value)} />
          <div><small>{pending ? "Delivery is unconfirmed. Retry sends the same encrypted message." : `${draft.length.toLocaleString()} / 5,000 · Encrypted on this device`}</small>
            <button className="primary" disabled={busy || !draft.trim() || (!pending && (!!c.closed || !detail.can_send))}>{busy ? "Sending…" : pending ? "Retry send" : "Send"}<Send size={16} /></button></div>
        </form>
      </>}
      <footer className="chat-conversation-footer">
        {confirmLeave ? <div><p>{c.owner_id === me ? "Leaving closes this conversation for everyone. Saved copies of messages remain readable." : "Leave this conversation? You will lose access to its history here."}</p>
          <button className="text-danger" disabled={busy} onClick={() => void run(async () => { await api(`/conversations/${id}/members/me`, "DELETE"); await onUpdate(); onBack(); })}>Confirm leave</button>
          <button className="chat-text-button" onClick={() => setConfirmLeave(false)}>Cancel</button></div>
          : <button className="chat-text-button" onClick={() => setConfirmLeave(true)}>{c.owner_id === me ? "Leave and close conversation" : "Leave conversation"}</button>}
      </footer>
    </>}
  </div>;
}
