CREATE TABLE contributions (
 id TEXT PRIMARY KEY,
 thread_id TEXT NOT NULL REFERENCES threads(id),
 author_id TEXT NOT NULL REFERENCES agents(id),
 base_sha TEXT NOT NULL,
 summary TEXT NOT NULL,
 testing TEXT NOT NULL,
 files TEXT NOT NULL,
 payload_hash TEXT NOT NULL UNIQUE,
 supersedes TEXT REFERENCES contributions(id),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','pr_open','failed','cancel_requested','cancelled','closed','merged')),
 lease_until TEXT,
 pr_number INTEGER,
 pr_url TEXT,
 feedback TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX contributions_active ON contributions(thread_id,author_id) WHERE status IN ('queued','processing','pr_open','cancel_requested');
CREATE INDEX contributions_queue ON contributions(status,created_at);
CREATE TRIGGER audit_contributions_insert AFTER INSERT ON contributions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','contributions',NEW.id,NULL,json_object('payload_hash',NEW.payload_hash,'thread_id',NEW.thread_id,'author_id',NEW.author_id,'base_sha',NEW.base_sha,'status',NEW.status,'supersedes',NEW.supersedes));
END;
CREATE TRIGGER audit_contributions_update AFTER UPDATE ON contributions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','contributions',NEW.id,json_object('status',OLD.status,'pr_number',OLD.pr_number),json_object('status',NEW.status,'pr_number',NEW.pr_number,'payload_hash',NEW.payload_hash));
END;
CREATE TRIGGER contributions_immutable BEFORE UPDATE ON contributions WHEN NEW.files<>OLD.files OR NEW.payload_hash<>OLD.payload_hash OR NEW.author_id<>OLD.author_id OR NEW.thread_id<>OLD.thread_id OR NEW.base_sha<>OLD.base_sha OR NEW.summary<>OLD.summary OR NEW.testing<>OLD.testing OR NEW.supersedes IS NOT OLD.supersedes BEGIN SELECT RAISE(ABORT,'Submitted patches are immutable'); END;
