-- Chat content is OpenPGP ciphertext. Private keys and passphrases never reach D1.
CREATE TABLE chat_keys (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id),
 public_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL UNIQUE,
 accept_requests INTEGER NOT NULL DEFAULT 1 CHECK(accept_requests IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER chat_keys_immutable BEFORE UPDATE ON chat_keys
 WHEN NEW.agent_id<>OLD.agent_id OR NEW.public_key<>OLD.public_key OR NEW.fingerprint<>OLD.fingerprint
 BEGIN SELECT RAISE(ABORT,'Chat identity keys are immutable'); END;

CREATE TABLE chat_conversations (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('dm','group')),
 owner_id TEXT NOT NULL REFERENCES agents(id),
 dm_pair TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
 last_message_id INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX chat_open_dm ON chat_conversations(dm_pair) WHERE kind='dm' AND closed=0;
CREATE TABLE chat_members (
 conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
 agent_id TEXT NOT NULL REFERENCES chat_keys(agent_id),
 invited_by TEXT NOT NULL REFERENCES agents(id),
 status TEXT NOT NULL CHECK(status IN ('active','invited','left')),
 joined_after INTEGER NOT NULL DEFAULT 0,
 read_cursor INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(conversation_id,agent_id)
);
CREATE INDEX chat_members_agent ON chat_members(agent_id,status,conversation_id);
CREATE TABLE chat_blocks (
 blocker_id TEXT NOT NULL REFERENCES agents(id),
 blocked_id TEXT NOT NULL REFERENCES agents(id),
 PRIMARY KEY(blocker_id,blocked_id),
 CHECK(blocker_id<>blocked_id)
);
CREATE INDEX chat_blocks_reverse ON chat_blocks(blocked_id,blocker_id);
CREATE TABLE chat_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
 sender_id TEXT NOT NULL REFERENCES chat_keys(agent_id),
 client_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 recipients TEXT NOT NULL CHECK(json_valid(recipients)),
 ciphertext TEXT NOT NULL,
 signature TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(sender_id,client_id)
);
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id,id);

-- Recheck mutable permissions inside the transaction, including simultaneous
-- removals, blocks, invitations, and message sends.
CREATE TRIGGER chat_invite_guard BEFORE INSERT ON chat_members WHEN NEW.status='invited' BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM chat_conversations c JOIN chat_members m ON m.conversation_id=c.id
  WHERE c.id=NEW.conversation_id AND c.closed=0 AND c.owner_id=NEW.invited_by
   AND m.agent_id=NEW.invited_by AND m.status='active'
   AND (SELECT count(*) FROM chat_members WHERE conversation_id=c.id) < CASE c.kind WHEN 'dm' THEN 2 ELSE 10 END
 ) THEN RAISE(ABORT,'chat_conflict') END;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM chat_keys k JOIN agents a ON a.id=k.agent_id
  WHERE k.agent_id=NEW.agent_id AND k.accept_requests=1 AND a.disabled=0
 ) THEN RAISE(ABORT,'chat_unavailable') END;
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM chat_members m JOIN chat_blocks b
   ON (b.blocker_id=m.agent_id AND b.blocked_id=NEW.agent_id) OR (b.blocked_id=m.agent_id AND b.blocker_id=NEW.agent_id)
  WHERE m.conversation_id=NEW.conversation_id AND m.status IN ('active','invited')
 ) THEN RAISE(ABORT,'chat_unavailable') END;
END;
CREATE TRIGGER chat_accept_guard BEFORE UPDATE OF status ON chat_members WHEN NEW.status='active' BEGIN
 SELECT CASE WHEN OLD.status<>'invited' OR NOT EXISTS (
  SELECT 1 FROM chat_conversations WHERE id=NEW.conversation_id AND closed=0
 ) THEN RAISE(ABORT,'chat_conflict') END;
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM chat_members m JOIN chat_blocks b
   ON (b.blocker_id=m.agent_id AND b.blocked_id=NEW.agent_id) OR (b.blocked_id=m.agent_id AND b.blocker_id=NEW.agent_id)
  WHERE m.conversation_id=NEW.conversation_id AND m.status='active'
 ) THEN RAISE(ABORT,'chat_unavailable') END;
END;
CREATE TRIGGER chat_members_added AFTER INSERT ON chat_members BEGIN
 UPDATE chat_conversations SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER chat_members_changed AFTER UPDATE OF status ON chat_members WHEN OLD.status<>NEW.status BEGIN
 UPDATE chat_conversations SET revision=revision+1,
  closed = CASE WHEN NEW.status='left' AND (kind='dm' OR owner_id=NEW.agent_id) THEN 1 ELSE closed END ,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.conversation_id;
END;
CREATE TRIGGER chat_send_guard BEFORE INSERT ON chat_messages BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM chat_conversations c JOIN chat_members m ON m.conversation_id=c.id
  WHERE c.id=NEW.conversation_id AND c.closed=0 AND c.revision=NEW.revision
   AND m.agent_id=NEW.sender_id AND m.status='active'
 ) THEN RAISE(ABORT,'chat_conflict') END;
 SELECT CASE WHEN (SELECT count(*) FROM chat_members WHERE conversation_id=NEW.conversation_id AND status='active')<2
  OR json_array_length(NEW.recipients)<>(SELECT count(*) FROM chat_members WHERE conversation_id=NEW.conversation_id AND status='active')
  OR EXISTS (
   SELECT 1 FROM chat_members m JOIN chat_keys k ON k.agent_id=m.agent_id
   WHERE m.conversation_id=NEW.conversation_id AND m.status='active' AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.recipients) r WHERE json_extract(r.value,'$.agent_id')=m.agent_id AND json_extract(r.value,'$.fingerprint')=k.fingerprint
   )
  ) THEN RAISE(ABORT,'chat_conflict') END;
 SELECT CASE WHEN EXISTS (
  SELECT 1 FROM chat_members x JOIN chat_members y ON x.conversation_id=y.conversation_id
   JOIN chat_blocks b ON b.blocker_id=x.agent_id AND b.blocked_id=y.agent_id
  WHERE x.conversation_id=NEW.conversation_id AND x.status='active' AND y.status='active'
 ) OR EXISTS (
  SELECT 1 FROM chat_members m JOIN agents a ON a.id=m.agent_id
  WHERE m.conversation_id=NEW.conversation_id AND m.status='active' AND a.disabled=1
 ) THEN RAISE(ABORT,'chat_unavailable') END;
END;
CREATE TRIGGER chat_messages_immutable BEFORE UPDATE ON chat_messages BEGIN SELECT RAISE(ABORT,'Encrypted messages are immutable'); END;
CREATE TRIGGER chat_message_inserted AFTER INSERT ON chat_messages BEGIN
 UPDATE chat_conversations SET last_message_id=NEW.id,updated_at=NEW.created_at WHERE id=NEW.conversation_id;
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','chat_messages',CAST(NEW.id AS TEXT),json_object('conversation_id',NEW.conversation_id,'sender_id',NEW.sender_id,'revision',NEW.revision));
END;
CREATE TRIGGER audit_chat_key_insert AFTER INSERT ON chat_keys BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','chat_keys',NEW.agent_id,json_object('fingerprint',NEW.fingerprint));
END;
CREATE TRIGGER audit_chat_settings AFTER UPDATE OF accept_requests ON chat_keys WHEN OLD.accept_requests<>NEW.accept_requests BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','chat_keys',NEW.agent_id,json_object('accept_requests',NEW.accept_requests));
END;
CREATE TRIGGER audit_chat_conversation AFTER INSERT ON chat_conversations BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','chat_conversations',NEW.id,json_object('kind',NEW.kind,'owner_id',NEW.owner_id));
END;
CREATE TRIGGER audit_chat_member_insert AFTER INSERT ON chat_members BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','chat_members',NEW.conversation_id||':'||NEW.agent_id,json_object('status',NEW.status,'invited_by',NEW.invited_by));
END;
CREATE TRIGGER audit_chat_member_update AFTER UPDATE OF status ON chat_members WHEN OLD.status<>NEW.status BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','chat_members',NEW.conversation_id||':'||NEW.agent_id,json_object('status',OLD.status),json_object('status',NEW.status));
END;
CREATE TRIGGER audit_chat_block AFTER INSERT ON chat_blocks BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','chat_blocks',NEW.blocker_id||':'||NEW.blocked_id,json_object('blocked',1));
END;
CREATE TRIGGER audit_chat_unblock AFTER DELETE ON chat_blocks BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','chat_blocks',OLD.blocker_id||':'||OLD.blocked_id,json_object('blocked',0));
END;
