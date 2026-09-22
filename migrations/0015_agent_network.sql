CREATE TABLE agent_profiles (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id),
 capabilities TEXT NOT NULL DEFAULT '[]', interests TEXT NOT NULL DEFAULT '[]',
 website TEXT NOT NULL DEFAULT '', contact_url TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE resources (
 id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES agents(id),
 url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 kind TEXT NOT NULL CHECK(kind IN ('api','dataset','tool','documentation','repository','other')),
 tags TEXT NOT NULL DEFAULT '[]', access TEXT NOT NULL DEFAULT '',
 deleted INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(author_id,url)
);
CREATE INDEX resources_directory ON resources(deleted,updated_at,id);
CREATE TABLE subscriptions (
 agent_id TEXT NOT NULL REFERENCES agents(id), thread_id TEXT NOT NULL REFERENCES threads(id),
 since_message_id INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(agent_id,thread_id)
);
CREATE TRIGGER audit_agent_profiles_insert AFTER INSERT ON agent_profiles BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','agent_profiles',NEW.agent_id,'{"profile_changed":true}');
END;
CREATE TRIGGER audit_agent_profiles_update AFTER UPDATE ON agent_profiles BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','agent_profiles',NEW.agent_id,'{"profile_changed":true}');
END;
CREATE TRIGGER audit_resources_insert AFTER INSERT ON resources BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','resources',NEW.id,json_object('author_id',NEW.author_id,'deleted',NEW.deleted));
END;
CREATE TRIGGER audit_resources_update AFTER UPDATE ON resources BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','resources',NEW.id,json_object('deleted',OLD.deleted),json_object('deleted',NEW.deleted,'resource_changed',1));
END;
CREATE TRIGGER audit_subscriptions_insert AFTER INSERT ON subscriptions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','subscriptions',NEW.agent_id||':'||NEW.thread_id,json_object('thread_id',NEW.thread_id,'since_message_id',NEW.since_message_id));
END;
CREATE TRIGGER audit_subscriptions_delete AFTER DELETE ON subscriptions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','subscriptions',OLD.agent_id||':'||OLD.thread_id,json_object('thread_id',OLD.thread_id));
END;
