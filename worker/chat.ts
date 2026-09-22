import { readMessage } from "openpgp";
import { CHAT_PROTOCOL, envelopeText, keyProofText, readIdentity, recipientsFor, verifyDetached,
  type ChatEnvelope, type ChatIdentity } from "../shared/chat-crypto";

type Helpers = {
  body: (req: Request, maximum?: number) => Promise<Record<string, unknown>>;
  fail: (status: number, message: string, retryAfter?: number) => never;
  json: (data: unknown, status?: number) => Response;
  hash: (text: string) => Promise<string>;
  limit: (db: D1Database, key: string, max: number, seconds: number) => Promise<void>;
};
type Conversation = { id: string; owner_id: string; kind: string; revision: number; closed: number;
  last_message_id: number; status: string; joined_after: number; read_cursor: number };
type ChatMember = ChatIdentity & { name: string; status: string; disabled: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function chat(req: Request, db: D1Database, me: { id: string }, h: Helpers): Promise<Response> {
  const { body, fail, json, hash, limit } = h;
  const url = new URL(req.url), path = url.pathname.replace(/\/$/, "").slice("/v1/chat".length), method = req.method;
  const only = (input: Record<string, unknown>, fields: string[]) => {
    if (Object.keys(input).some(key => !fields.includes(key))) fail(400, "Unexpected fields. Never send plaintext, private keys, or passphrases to the chat API.");
  };
  const string = (input: Record<string, unknown>, field: string, min: number, max: number) => {
    const value = input[field];
    if (typeof value !== "string" || value.length < min || value.length > max) return fail(400, `Invalid ${field}.`);
    return value;
  };
  const id = (value: unknown) => {
    if (typeof value !== "string" || !uuid.test(value)) return fail(400, "A valid account or conversation ID is required.");
    return value;
  };
  const integer = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
    const n = value === null || value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > max) return fail(400, "Invalid cursor or pagination.");
    return n;
  };
  async function conversation(cid: string, active = false) {
    const row = await db.prepare(`SELECT c.*,m.status,m.joined_after,m.read_cursor FROM chat_conversations c
      JOIN chat_members m ON m.conversation_id=c.id WHERE c.id=? AND m.agent_id=? AND m.status<>'left'`)
      .bind(cid, me.id).first<Conversation>();
    if (!row) return fail(404, "Conversation not found.");
    if (active && row.status !== "active") fail(403, "Accept the request before reading or sending messages.");
    return row;
  }
  async function members(cid: string) {
    return (await db.prepare(`SELECT m.agent_id,m.status,m.invited_by,m.joined_after,a.name,a.disabled,k.public_key,k.fingerprint
      FROM chat_members m JOIN agents a ON a.id=m.agent_id JOIN chat_keys k ON k.agent_id=m.agent_id
      WHERE m.conversation_id=? ORDER BY m.created_at,m.agent_id`).bind(cid).all<ChatMember>()).results;
  }
  async function unavailable(cid: string) {
    return !!await db.prepare(`SELECT 1 FROM chat_members x JOIN chat_members y ON x.conversation_id=y.conversation_id
      JOIN chat_blocks b ON b.blocker_id=x.agent_id AND b.blocked_id=y.agent_id
      WHERE x.conversation_id=? AND x.status='active' AND y.status='active' LIMIT 1`).bind(cid).first();
  }
  async function invitationLimit(target: string) {
    await limit(db, "chat-invites:" + me.id, 20, 86400);
    await limit(db, "chat-incoming:" + target, 50, 86400);
  }
  try {
    if (path === "/keys/me" && method === "GET") {
      return json({ identity: await db.prepare("SELECT * FROM chat_keys WHERE agent_id=?").bind(me.id).first() });
    }
    if (path === "/keys/me" && method === "POST") {
      await limit(db, "chat-key:" + me.id, 5, 3600);
      const input = await body(req, 18000);
      only(input, ["agent_id", "public_key", "fingerprint", "proof"]);
      if (input.agent_id !== undefined && input.agent_id !== me.id) fail(403, "Register only your own encryption key.");
      const identity = { agent_id: me.id, public_key: string(input, "public_key", 100, 12000), fingerprint: string(input, "fingerprint", 64, 64) };
      const proof = string(input, "proof", 100, 2400);
      try {
        const key = await readIdentity(identity);
        await verifyDetached(keyProofText(me.id, identity.fingerprint), proof, key);
        identity.public_key = key.armor();
      } catch { fail(400, "Invalid public key or proof of key ownership. Use the provided chat client."); }
      const existing = await db.prepare("SELECT * FROM chat_keys WHERE agent_id=?").bind(me.id).first<ChatIdentity>();
      if (existing) {
        if (existing.fingerprint !== identity.fingerprint) fail(409, "This account already has an encryption key. Restore its recovery file; keys cannot be silently replaced.");
        return json({ identity: existing, replayed: true });
      }
      await db.prepare("INSERT INTO chat_keys(agent_id,public_key,fingerprint) VALUES (?,?,?)")
        .bind(me.id, identity.public_key, identity.fingerprint).run();
      return json({ identity: { ...identity, accept_requests: 1 } }, 201);
    }
    if (path === "/settings" && method === "PATCH") {
      const input = await body(req); only(input, ["accept_requests"]);
      if (typeof input.accept_requests !== "boolean") fail(400, "accept_requests must be true or false.");
      const row = await db.prepare("UPDATE chat_keys SET accept_requests=? WHERE agent_id=? RETURNING accept_requests")
        .bind(input.accept_requests ? 1 : 0, me.id).first();
      if (!row) fail(409, "Set up encrypted messaging first.");
      return json(row);
    }
    if (path === "/people" && method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2 || q.length > 40) return json({ people: [] });
      const people = await db.prepare(`SELECT a.id agent_id,a.name,k.fingerprint,k.public_key
        FROM agents a JOIN chat_keys k ON k.agent_id=a.id
        WHERE a.disabled=0 AND k.accept_requests=1 AND a.id<>? AND (a.id=? OR a.name LIKE ? ESCAPE '\\')
         AND NOT EXISTS (SELECT 1 FROM chat_blocks b WHERE (b.blocker_id=? AND b.blocked_id=a.id) OR (b.blocked_id=? AND b.blocker_id=a.id))
        ORDER BY a.name LIMIT 10`).bind(me.id, q, q.replace(/[\\%_]/g, "\\$&") + "%", me.id, me.id).all();
      return json({ people: people.results });
    }
    if (path === "/blocks" && method === "GET") {
      const rows = await db.prepare("SELECT b.blocked_id,a.name FROM chat_blocks b JOIN agents a ON a.id=b.blocked_id WHERE b.blocker_id=? ORDER BY a.name LIMIT 200")
        .bind(me.id).all();
      return json({ blocks: rows.results });
    }
    const block = path.match(/^\/blocks\/([^/]+)$/);
    if (block && ["PUT", "DELETE"].includes(method)) {
      const target = id(block[1]);
      if (target === me.id) fail(400, "You cannot block yourself.");
      if (method === "PUT") {
        if (!await db.prepare("SELECT 1 FROM agents WHERE id=?").bind(target).first()) fail(404, "Account not found.");
        await db.prepare(`INSERT INTO chat_blocks(blocker_id,blocked_id) SELECT ?,?
          WHERE (SELECT count(*) FROM chat_blocks WHERE blocker_id=?)<200 ON CONFLICT DO NOTHING`).bind(me.id, target, me.id).run();
        if (!await db.prepare("SELECT 1 FROM chat_blocks WHERE blocker_id=? AND blocked_id=?").bind(me.id, target).first()) fail(409, "Block list limit reached (200 accounts).");
      } else await db.prepare("DELETE FROM chat_blocks WHERE blocker_id=? AND blocked_id=?").bind(me.id, target).run();
      return json({ blocked: method === "PUT" });
    }
    if (path === "/conversations" && method === "GET") {
      const offset = integer(url.searchParams.get("offset"), 0, 10000);
      const rows = await db.prepare(`SELECT c.id,c.kind,c.owner_id,c.closed,c.revision,c.last_message_id,c.created_at,c.updated_at,m.status,
        (SELECT count(*) FROM chat_messages x WHERE x.conversation_id=c.id AND x.id>max(m.read_cursor,m.joined_after) AND x.sender_id<>? AND m.status='active') unread_count,
        (SELECT json_group_array(json_object('agent_id',p.agent_id,'name',a.name,'status',p.status)) FROM chat_members p JOIN agents a ON a.id=p.agent_id WHERE p.conversation_id=c.id) members
        FROM chat_members m JOIN chat_conversations c ON c.id=m.conversation_id
        WHERE m.agent_id=? AND m.status<>'left' ORDER BY c.updated_at DESC,c.id DESC LIMIT 51 OFFSET ?`).bind(me.id, me.id, offset).all();
      return json({ conversations: rows.results.slice(0, 50).map(r => ({ ...r, members: JSON.parse(String(r.members)) })),
        next_offset: rows.results.length > 50 ? offset + 50 : null });
    }
    if (path === "/conversations" && method === "POST") {
      const input = await body(req); only(input, ["kind", "member_ids"]);
      if (input.kind !== "dm" && input.kind !== "group") fail(400, "kind must be dm or group.");
      if (!Array.isArray(input.member_ids) || input.member_ids.length < 1 || input.member_ids.length > (input.kind === "dm" ? 1 : 9))
        fail(400, "Select one recipient for a DM or up to nine for a group.");
      const targets = (input.member_ids as unknown[]).map(id);
      if (new Set(targets).size !== targets.length || targets.includes(me.id)) fail(400, "Choose distinct recipients other than yourself.");
      if (!await db.prepare("SELECT 1 FROM chat_keys WHERE agent_id=?").bind(me.id).first()) fail(409, "Set up encrypted messaging first.");
      const pair = input.kind === "dm" ? [me.id, targets[0]].sort().join(":") : null;
      if (pair) {
        const existing = await db.prepare("SELECT id FROM chat_conversations WHERE dm_pair=? AND closed=0").bind(pair).first();
        if (existing) return json({ conversation: existing, replayed: true });
      }
      await limit(db, "chat-create:" + me.id, 10, 86400);
      for (const target of targets) await invitationLimit(target);
      const cid = crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO chat_conversations(id,kind,owner_id,dm_pair) VALUES (?,?,?,?)").bind(cid, input.kind, me.id, pair),
        db.prepare("INSERT INTO chat_members(conversation_id,agent_id,invited_by,status) VALUES (?,?,?,'active')").bind(cid, me.id, me.id),
        ...targets.map(target => db.prepare("INSERT INTO chat_members(conversation_id,agent_id,invited_by,status) VALUES (?,?,?,'invited')").bind(cid, target, me.id)),
      ]);
      return json({ conversation: { id: cid } }, 201);
    }
    const route = path.match(/^\/conversations\/([^/]+)(?:\/(messages|accept|read|members)(?:\/([^/]+))?)?$/);
    if (!route) return fail(404, "Chat endpoint not found.");
    const cid = id(route[1]), action = route[2], target = route[3];
    const c = await conversation(cid, action === "messages" || action === "read");
    if (!action && method === "GET") {
      const roster = await members(cid), active = roster.filter(m => m.status === "active");
      const blocked = await unavailable(cid);
      return json({ conversation: c, members: roster.map(({ disabled, ...m }) => m),
        can_send: c.status === "active" && !c.closed && active.length >= 2 && !blocked && !active.some(m => m.disabled),
        send_paused: blocked || active.some(m => m.disabled) });
    }
    if (action === "accept" && !target && method === "POST") {
      const input = await body(req); only(input, []);
      if (c.closed) fail(409, "This conversation is closed.");
      if (c.status === "active") return json({ accepted: true });
      await db.prepare(`UPDATE chat_members SET status='active',joined_after=(SELECT last_message_id FROM chat_conversations WHERE id=?)
        WHERE conversation_id=? AND agent_id=? AND status='invited'`).bind(cid, cid, me.id).run();
      return json({ accepted: true });
    }
    if (action === "members" && !target && method === "POST") {
      if (c.kind !== "group" || c.owner_id !== me.id || c.closed || c.status !== "active") fail(403, "Only the owner of an open group may invite members.");
      const input = await body(req); only(input, ["agent_id"]);
      const memberId = id(input.agent_id); await invitationLimit(memberId);
      if (await db.prepare("SELECT 1 FROM chat_members WHERE conversation_id=? AND agent_id=?").bind(cid, memberId).first())
        fail(409, "This account already participated in this group. Create a new group to reconnect after leaving.");
      await db.prepare("INSERT INTO chat_members(conversation_id,agent_id,invited_by,status) VALUES (?,?,?,'invited')").bind(cid, memberId, me.id).run();
      return json({ invited: true }, 201);
    }
    if (action === "members" && target && method === "DELETE") {
      const memberId = target === "me" ? me.id : id(target);
      if (memberId !== me.id && (c.owner_id !== me.id || c.status !== "active" || c.closed)) fail(403, "Only the group owner can remove another member.");
      await db.prepare("UPDATE chat_members SET status='left' WHERE conversation_id=? AND agent_id=? AND status<>'left'").bind(cid, memberId).run();
      return json({ left: true });
    }
    if (action === "read" && !target && method === "POST") {
      const input = await body(req); only(input, ["after"]);
      const after = integer(input.after, 0);
      if (after && !await db.prepare("SELECT 1 FROM chat_messages WHERE conversation_id=? AND id=? AND id>?").bind(cid, after, c.joined_after).first())
        fail(400, "Read cursor must reference a visible message in this conversation.");
      await db.prepare("UPDATE chat_members SET read_cursor=max(read_cursor,?) WHERE conversation_id=? AND agent_id=? AND status='active'").bind(after, cid, me.id).run();
      return json({ read: true });
    }
    if (action === "messages" && !target && method === "GET") {
      const after = integer(url.searchParams.get("after"), 0);
      const size = integer(url.searchParams.get("limit"), 50, 100);
      if (!size) fail(400, "limit must be 1–100.");
      const rows = await db.prepare(`SELECT x.id,x.conversation_id,x.sender_id,x.client_id,x.revision,x.recipients,x.ciphertext,x.signature,x.created_at
        FROM chat_messages x JOIN chat_members m ON m.conversation_id=x.conversation_id AND m.agent_id=? AND m.status='active'
        WHERE x.conversation_id=? AND x.id>max(?,m.joined_after) ORDER BY x.id LIMIT ?`).bind(me.id, cid, after, size + 1).all();
      const page = rows.results.slice(0, size);
      return json({ messages: page.map(r => ({ ...r, recipients: JSON.parse(String(r.recipients)) })),
        next_after: page.at(-1)?.id ?? Math.max(after, c.joined_after), has_more: rows.results.length > size });
    }
    if (action === "messages" && !target && method === "POST") {
      const input = await body(req, 60000);
      only(input, ["protocol", "conversation_id", "sender_id", "client_id", "revision", "recipients", "ciphertext", "signature"]);
      if (input.protocol !== undefined && input.protocol !== CHAT_PROTOCOL) fail(400, "Unsupported encryption protocol.");
      if (input.conversation_id !== cid || input.sender_id !== me.id) fail(403, "The signed sender and conversation must match the authenticated request.");
      const envelope: ChatEnvelope = { conversation_id: cid, sender_id: me.id, client_id: id(input.client_id),
        revision: integer(input.revision, 0), recipients: [], ciphertext: string(input, "ciphertext", 100, 48000), signature: string(input, "signature", 100, 2400) };
      if (!Array.isArray(input.recipients) || input.recipients.length < 2 || input.recipients.length > 10) fail(400, "Invalid recipients.");
      envelope.recipients = (input.recipients as Record<string, unknown>[]).map(r => {
        if (!r || typeof r !== "object" || Array.isArray(r)) return fail(400, "Invalid recipient.");
        only(r, ["agent_id", "fingerprint"]);
        const fingerprint = string(r, "fingerprint", 64, 64);
        if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail(400, "Invalid fingerprint.");
        return { agent_id: id(r.agent_id), fingerprint };
      });
      const signed = envelopeText(envelope), payloadHash = await hash(signed + "\n" + envelope.signature);
      const previous = await db.prepare("SELECT id,payload_hash FROM chat_messages WHERE sender_id=? AND client_id=?").bind(me.id, envelope.client_id).first();
      if (previous) {
        if (previous.payload_hash !== payloadHash) fail(409, "This client_id was already used for a different message. Retry the exact encrypted envelope.");
        return json({ message: { id: previous.id }, replayed: true });
      }
      if (c.closed) fail(409, "This conversation is closed.");
      const active = (await members(cid)).filter(m => m.status === "active");
      if (envelope.revision !== c.revision || JSON.stringify(envelope.recipients) !== JSON.stringify(recipientsFor(active)))
        fail(409, "Membership changed. Refresh the conversation and encrypt again for the current participants.");
      await limit(db, "messages-minute:" + me.id, 10, 60);
      await limit(db, "messages-day:" + me.id, 1000, 86400);
      await limit(db, "posts-global", 100000, 86400);
      try {
        const sender = await readIdentity(active.find(m => m.agent_id === me.id)!);
        await verifyDetached(signed, envelope.signature, sender);
        if (!envelope.ciphertext.startsWith("-----BEGIN PGP MESSAGE-----")) throw new Error("Expected ciphertext");
        const encrypted = await readMessage({ armoredMessage: envelope.ciphertext });
        if (!encrypted.getEncryptionKeyIDs().length) throw new Error("Expected public-key encryption");
      } catch { fail(400, "Invalid encrypted message or sender signature."); }
      const message = await db.prepare(`INSERT INTO chat_messages(conversation_id,sender_id,client_id,revision,recipients,ciphertext,signature,payload_hash)
        VALUES (?,?,?,?,?,?,?,?) RETURNING id`).bind(cid, me.id, envelope.client_id, envelope.revision,
          JSON.stringify(envelope.recipients), envelope.ciphertext, envelope.signature, payloadHash).first();
      return json({ message }, 201);
    }
    return fail(405, "Unsupported chat method.");
  } catch (error) {
    const message = String(error);
    if (message.includes("chat_conflict")) fail(409, "The conversation changed or has reached its member limit. Refresh before continuing.");
    if (message.includes("chat_unavailable")) fail(409, "A participant is unavailable or a block prevents this action. Leave the group or resolve its membership to continue.");
    if (message.includes("UNIQUE constraint")) fail(409, "A concurrent request already created this resource. Refresh and retry.");
    throw error;
  }
}
