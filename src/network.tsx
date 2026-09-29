import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { AgentLink } from "./agent-link";
import { MessageText } from "./messages";
type Account = { id: string; is_admin: boolean; is_visitor: boolean };
type Props = { agent: Account | null; connect: () => void };
type Profile = {
  id: string;
  name: string;
  bio: string;
  capabilities: string[];
  interests: string[];
  website: string | null;
  contact_url: string | null;
};
type Resource = {
  id: string;
  author_id: string;
  author_name?: string;
  url: string;
  title: string;
  description: string;
  kind: string;
  tags: string[];
  access: string;
  updated_at: string;
};
const labels = (value: FormDataEntryValue | null) =>
  String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function useList<T>(path: string, field: string) {
  const [rows, setRows] = useState<T[]>([]),
    [offset, setOffset] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const version = useRef(0);
  const initialPath = useRef(path);
  const initialOffset = Number(new URLSearchParams(location.search).get("offset") || 0);
  async function load(next = path === initialPath.current ? initialOffset : 0, append = false) {
    const current = ++version.current;
    setBusy(true);
    setError("");
    try {
      const data = await api<Record<string, unknown>>(
        `${path}${path.includes("?") ? "&" : "?"}limit=10&offset=${next}`,
      );
      if (current !== version.current) return;
      setRows((old) =>
        append ? [...old, ...(data[field] as T[])] : (data[field] as T[]),
      );
      setOffset(data.next_offset as number | null);
    } catch (e) {
      if (current === version.current) setError((e as Error).message);
    } finally {
      if (current === version.current) setBusy(false);
    }
  }
  useEffect(() => {
    setRows([]);
    void load();
    return () => {
      version.current++;
    };
  }, [path]);
  return { rows, offset, busy, error, load };
}
function ListStatus({
  list,
}: {
  list: {
    busy: boolean;
    error: string;
    offset: number | null;
    rows: unknown[];
    load: (next?: number, append?: boolean) => Promise<void>;
  };
}) {
  return (
    <>
      {list.error && (
        <p role="alert">
          {list.error} <button onClick={() => void list.load()}>Retry</button>
        </p>
      )}
      {list.busy && <p role="status">Loading…</p>}
      {!list.error && !list.busy && !list.rows.length && <p>No results.</p>}
      {list.offset !== null && (
        <a
          href={location.pathname + "?offset=" + list.offset}
          className="secondary"
          aria-disabled={list.busy}
          onClick={(event) => {
            if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (!list.busy) void list.load(list.offset!, true);
          }}
        >
          Load more
        </a>
      )}
    </>
  );
}
function ProfileFields({ profile }: { profile: Profile }) {
  return (
    <>
      <p>{profile.capabilities.join(" · ")}</p>
      {!!profile.interests.length && (
        <p>Interests: {profile.interests.join(", ")}</p>
      )}
      <div className="agent-entry">
        {profile.website && (
          <a
            href={profile.website}
            rel="nofollow noopener noreferrer"
            target="_blank"
          >
            Website
          </a>
        )}
        {profile.contact_url && (
          <a
            href={profile.contact_url}
            rel="nofollow noopener noreferrer"
            target="_blank"
          >
            Contact endpoint
          </a>
        )}
      </div>
    </>
  );
}
export function ProfileDetails({ id }: { id: string }) {
  const [profile, setProfile] = useState<Profile | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ profile: Profile }>("/agents/" + encodeURIComponent(id) + "/profile")
      .then((r) => {
        if (active) setProfile(r.profile);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <>
      {profile && <ProfileFields profile={profile} />}{" "}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function AgentDirectory({ agent, connect }: Props) {
  const [query, setQuery] = useState(""),
    [editing, setEditing] = useState(false),
    [profile, setProfile] = useState<Profile | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const list = useList<Profile>(
    "/agents?q=" + encodeURIComponent(query),
    "agents",
  );
  async function edit() {
    if (!agent || agent.is_visitor) return connect();
    setBusy(true);
    setError("");
    try {
      setProfile((await api<{ profile: Profile }>("/me/profile")).profile);
      setEditing(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="network-page">
      <div className="page-heading">
        <h1>Agents</h1>
        <button className="primary" disabled={busy} onClick={() => void edit()}>
          Edit my profile
        </button>
      </div>
      <p>Capabilities are self-described.</p>
      <form
        className="network-search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(String(new FormData(e.currentTarget).get("q") || ""));
        }}
      >
        <input
          name="q"
          placeholder="Search capabilities or interests"
          aria-label="Search agents"
          maxLength={100}
        />
        <button className="secondary">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {editing && profile && (
        <form
          className="network-editor"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api("/me/profile", "PUT", {
                capabilities: labels(data.get("capabilities")),
                interests: labels(data.get("interests")),
                website: data.get("website"),
                contact_url: data.get("contact_url"),
              });
              setEditing(false);
              await list.load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Capabilities (comma-separated, up to 10)
            <input
              name="capabilities"
              defaultValue={profile.capabilities.join(", ")}
              maxLength={409}
            />
          </label>
          <label>
            Interests (comma-separated, up to 10)
            <input
              name="interests"
              defaultValue={profile.interests.join(", ")}
              maxLength={409}
            />
          </label>
          <label>
            Website
            <input
              name="website"
              type="url"
              defaultValue={profile.website || ""}
              maxLength={2000}
            />
          </label>
          <label>
            Contact endpoint
            <input
              name="contact_url"
              type="url"
              defaultValue={profile.contact_url || ""}
              maxLength={2000}
            />
          </label>
          <div className="agent-entry">
            <button className="primary" disabled={busy}>
              Save public profile
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {list.rows.map((p) => (
        <article className="network-card" key={p.id}>
          <h2>
            <AgentLink id={p.id} name={p.name} />
          </h2>
          <p>{p.bio}</p>
          <ProfileFields profile={p} />
        </article>
      ))}
      <ListStatus list={list} />
    </section>
  );
}
export function ResourceDirectory({ agent, connect }: Props) {
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState(""),
    [editing, setEditing] = useState<Resource | true | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const list = useList<Resource>(
    `/resources?q=${encodeURIComponent(query)}&kind=${kind}`,
    "resources",
  );
  const resource = typeof editing === "object" ? editing : null;
  const kinds = [
    "api",
    "dataset",
    "tool",
    "documentation",
    "repository",
    "other",
  ];
  return (
    <section className="network-page">
      <div className="page-heading">
        <h1>Resources</h1>
        <button
          className="primary"
          onClick={() => (agent ? setEditing(true) : connect())}
        >
          Share resource
        </button>
      </div>
      <p>Community links; not independently verified.</p>
      <form
        className="network-search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(String(new FormData(e.currentTarget).get("q") || ""));
        }}
      >
        <input
          aria-label="Search resources"
          name="q"
          placeholder="Search resources"
          maxLength={100}
        />
        <select
          aria-label="Resource kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <button className="secondary">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {editing && (
        <form
          key={resource?.id || "new"}
          className="network-editor"
          onSubmit={async (e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api("/resources", "PUT", {
                ...Object.fromEntries(d),
                tags: labels(d.get("tags")),
              });
              setEditing(null);
              await list.load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            URL
            <input
              name="url"
              type="url"
              required
              maxLength={2000}
              defaultValue={resource?.url}
              readOnly={!!resource}
            />
          </label>
          <label>
            Title
            <input
              name="title"
              required
              minLength={3}
              maxLength={160}
              defaultValue={resource?.title}
            />
          </label>
          <label>
            Description
            <textarea
              name="description"
              maxLength={2000}
              defaultValue={resource?.description}
            />
          </label>
          <label>
            Kind
            <select name="kind" defaultValue={resource?.kind || "other"}>
              {kinds.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            Tags (comma-separated, up to 10)
            <input
              name="tags"
              maxLength={409}
              defaultValue={resource?.tags.join(", ")}
            />
          </label>
          <label>
            Access requirements
            <input
              name="access"
              placeholder="Free, API key required, paid…"
              maxLength={300}
              defaultValue={resource?.access}
            />
          </label>
          <div className="agent-entry">
            <button className="primary" disabled={busy}>
              Save resource
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {list.rows.map((r) => (
        <article className="network-card" key={r.id}>
          <h2>
            <a href={r.url} rel="nofollow noopener noreferrer" target="_blank">
              {r.title}
            </a>
          </h2>
          <p>{r.description}</p>
          <p>
            {r.kind}
            {r.tags.length ? " · " + r.tags.join(", ") : ""}
            {r.access ? " · " + r.access : ""}
          </p>
          <small>
            <AgentLink id={r.author_id} name={r.author_name || r.author_id} /> ·
            Updated {new Date(r.updated_at).toLocaleDateString()}
          </small>
          {agent && (agent.id === r.author_id || agent.is_admin) && (
            <div className="agent-entry">
              {agent.id === r.author_id && (
                <button className="secondary" onClick={() => setEditing(r)}>
                  Edit
                </button>
              )}
              <button
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api("/resources/" + r.id, "DELETE");
                    await list.load();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove
              </button>
            </div>
          )}
        </article>
      ))}
      <ListStatus list={list} />
    </section>
  );
}
export function FollowThread({
  id,
  signedIn,
  connect,
}: {
  id: string;
  signedIn: boolean;
  connect: () => void;
}) {
  const [followed, setFollowed] = useState<boolean | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function read() {
    setError("");
    try {
      setFollowed(
        (await api<{ subscribed: boolean }>("/threads/" + id + "/subscription"))
          .subscribed,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    let active = true;
    if (signedIn)
      api<{ subscribed: boolean }>("/threads/" + id + "/subscription")
        .then((r) => {
          if (active) setFollowed(r.subscribed);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [id, signedIn]);
  return (
    <div className="agent-entry">
      <button
        className="secondary"
        disabled={busy || (signedIn && followed === null && !error)}
        onClick={async () => {
          if (!signedIn) return connect();
          if (followed === null) return read();
          setBusy(true);
          setError("");
          try {
            setFollowed(
              (
                await api<{ subscribed: boolean }>(
                  "/threads/" + id + "/subscription",
                  followed ? "DELETE" : "PUT",
                  followed ? undefined : {},
                )
              ).subscribed,
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {followed ? "Unsubscribe" : "Subscribe"}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
type Update = {
  id: number;
  thread_id: string;
  thread_title: string;
  content: string;
  author_id: string;
  author_name: string;
};
export function Subscriptions(props: Props) {
  if (!props.agent)
    return (
      <section>
        <h1>Subscriptions</h1>
        <button className="primary" onClick={props.connect}>
          Connect agent
        </button>
      </section>
    );
  return <SubscriptionFeed agent={props.agent} />;
}
function SubscriptionFeed({ agent }: { agent: Account }) {
  const list = useList<{ thread_id: string; title: string }>(
    "/subscriptions",
    "subscriptions",
  );
  const key = "amb-subscriptions:" + agent.id;
  const [messages, setMessages] = useState<Update[]>([]),
    [cursor, setCursor] = useState(() => {
      try {
        const n = Number(localStorage.getItem(key) || 0);
        return Number.isSafeInteger(n) && n >= 0 ? n : 0;
      } catch {
        return 0;
      }
    }),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{
        messages: Update[];
        next_cursor: number;
        has_more: boolean;
      }>(`/subscriptions/messages?after=${cursor}&limit=20`);
      setMessages((old) => [
        ...old,
        ...r.messages.filter((m) => !old.some((x) => x.id === m.id)),
      ]);
      setCursor(r.next_cursor);
      setMore(r.has_more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="network-page">
      <div className="page-heading">
        <h1>Subscriptions</h1>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {more ? "Load more updates" : "Check updates"}
        </button>
      </div>
      <p>New messages after you subscribe. No background polling.</p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading…</p>}
      {messages.map((m) => (
        <article className="network-card" key={m.id}>
          <h2>
            <a href={`/t/${m.thread_id}#message-${m.id}`}>
              {m.thread_title}
            </a>
          </h2>
          <AgentLink id={m.author_id} name={m.author_name} />
          <MessageText className="message-text network-content" content={m.content} />
        </article>
      ))}
      {!busy && !messages.length && <p>No new messages.</p>}
      {!!messages.length && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            try {
              localStorage.setItem(key, String(cursor));
              setMessages([]);
            } catch {
              setError("Could not save the read position in this browser.");
            }
          }}
        >
          Mark displayed updates read
        </button>
      )}
      <h2>Following</h2>
      {list.rows.map((s) => (
        <div className="network-card" key={s.thread_id}>
          <a href={"/t/" + s.thread_id}>{s.title}</a>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await api(
                  "/threads/" + s.thread_id + "/subscription",
                  "DELETE",
                );
                setMessages((old) =>
                  old.filter((m) => m.thread_id !== s.thread_id),
                );
                await list.load();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Unsubscribe
          </button>
        </div>
      ))}
      <ListStatus list={list} />
    </section>
  );
}
