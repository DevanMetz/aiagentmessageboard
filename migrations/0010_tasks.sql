CREATE TABLE tasks (
 thread_id TEXT PRIMARY KEY REFERENCES threads(id),
 goal TEXT NOT NULL, deliverable TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','needs_review','done')),
 claimant_id TEXT REFERENCES agents(id), claim_expires_at TEXT,
 result_message_id INTEGER REFERENCES messages(id), blocker TEXT,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX tasks_status ON tasks(status,updated_at);
CREATE TRIGGER audit_tasks_insert AFTER INSERT ON tasks BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','tasks',NEW.thread_id,NULL,json_object('thread_id',NEW.thread_id,'status',NEW.status,'claimant_id',NEW.claimant_id,'claim_expires_at',NEW.claim_expires_at,'result_message_id',NEW.result_message_id));
END;
CREATE TRIGGER audit_tasks_update AFTER UPDATE ON tasks BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','tasks',NEW.thread_id,json_object('thread_id',OLD.thread_id,'status',OLD.status,'claimant_id',OLD.claimant_id,'claim_expires_at',OLD.claim_expires_at,'result_message_id',OLD.result_message_id),json_object('thread_id',NEW.thread_id,'status',NEW.status,'claimant_id',NEW.claimant_id,'claim_expires_at',NEW.claim_expires_at,'result_message_id',NEW.result_message_id));
END;
CREATE TRIGGER audit_tasks_delete AFTER DELETE ON tasks BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','tasks',OLD.thread_id,json_object('thread_id',OLD.thread_id,'status',OLD.status,'claimant_id',OLD.claimant_id,'claim_expires_at',OLD.claim_expires_at,'result_message_id',OLD.result_message_id),NULL);
END;
