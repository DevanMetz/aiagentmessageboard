ALTER TABLE threads ADD COLUMN accepted_message_id INTEGER REFERENCES messages(id);

CREATE TABLE thread_tags (
 thread_id TEXT NOT NULL REFERENCES threads(id), tag TEXT NOT NULL,
 PRIMARY KEY(thread_id,tag)
) WITHOUT ROWID;
CREATE INDEX thread_tags_by_tag ON thread_tags(tag,thread_id);
CREATE TABLE topic_follows (
 agent_id TEXT NOT NULL REFERENCES agents(id), tag TEXT NOT NULL,
 PRIMARY KEY(agent_id,tag)
) WITHOUT ROWID;
CREATE TABLE message_mentions (
 message_id INTEGER NOT NULL REFERENCES messages(id), agent_id TEXT NOT NULL REFERENCES agents(id),
 PRIMARY KEY(message_id,agent_id)
) WITHOUT ROWID;
CREATE INDEX mentions_by_recipient ON message_mentions(agent_id,message_id);
CREATE TABLE inbox_read_state (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id), last_read_message_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE thread_read_state (
 agent_id TEXT NOT NULL REFERENCES agents(id), thread_id TEXT NOT NULL REFERENCES threads(id),
 last_read_message_id INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(agent_id,thread_id)
) WITHOUT ROWID;
CREATE TABLE mcp_tokens (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE INDEX mcp_tokens_by_owner ON mcp_tokens(agent_id,revoked,expires_at);
CREATE TRIGGER audit_thread_tags_insert AFTER INSERT ON thread_tags BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','thread_tags',NEW.thread_id,'{"tags_changed":true}');
END;

CREATE TRIGGER audit_thread_tags_delete AFTER DELETE ON thread_tags BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','thread_tags',OLD.thread_id,'{"tags_changed":true}');
END;

CREATE TRIGGER audit_topic_follows_insert AFTER INSERT ON topic_follows BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','topic_follows',NEW.agent_id,'{"topics_changed":true}');
END;

CREATE TRIGGER audit_topic_follows_delete AFTER DELETE ON topic_follows BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','topic_follows',OLD.agent_id,'{"topics_changed":true}');
END;

CREATE TRIGGER audit_message_mentions_insert AFTER INSERT ON message_mentions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','message_mentions',CAST(NEW.message_id AS TEXT),'{"mentions_changed":true}');
END;

CREATE TRIGGER audit_message_mentions_delete AFTER DELETE ON message_mentions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','message_mentions',CAST(OLD.message_id AS TEXT),'{"mentions_changed":true}');
END;

CREATE TRIGGER audit_inbox_read_state_insert AFTER INSERT ON inbox_read_state BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','inbox_read_state',NEW.agent_id,json_object('last_read_message_id',NEW.last_read_message_id));
END;

CREATE TRIGGER audit_inbox_read_state_update AFTER UPDATE ON inbox_read_state BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','inbox_read_state',NEW.agent_id,json_object('last_read_message_id',NEW.last_read_message_id));
END;

CREATE TRIGGER audit_thread_read_state_insert AFTER INSERT ON thread_read_state BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','thread_read_state',NEW.agent_id||':'||NEW.thread_id,json_object('last_read_message_id',NEW.last_read_message_id));
END;

CREATE TRIGGER audit_thread_read_state_update AFTER UPDATE ON thread_read_state BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','thread_read_state',NEW.agent_id||':'||NEW.thread_id,json_object('last_read_message_id',NEW.last_read_message_id));
END;

CREATE TRIGGER clear_hidden_answer AFTER UPDATE OF deleted ON messages WHEN NEW.deleted=1 BEGIN
 UPDATE threads SET accepted_message_id=NULL WHERE accepted_message_id=NEW.id;
END;
CREATE TRIGGER audit_accepted_answer AFTER UPDATE OF accepted_message_id ON threads WHEN OLD.accepted_message_id IS NOT NEW.accepted_message_id BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','accepted_answer',NEW.id,json_object('message_id',OLD.accepted_message_id),json_object('message_id',NEW.accepted_message_id));
END;
CREATE TRIGGER audit_mcp_token_insert AFTER INSERT ON mcp_tokens BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','mcp_token',NEW.id,json_object('agent_id',NEW.agent_id,'scopes',json(NEW.scopes),'expires_at',NEW.expires_at));
END;
CREATE TRIGGER audit_mcp_token_update AFTER UPDATE OF revoked ON mcp_tokens WHEN OLD.revoked<>NEW.revoked BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','mcp_token',NEW.id,json_object('revoked',NEW.revoked));
END;
