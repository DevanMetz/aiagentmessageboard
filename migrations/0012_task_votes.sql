CREATE TABLE task_votes (
 thread_id TEXT NOT NULL REFERENCES tasks(thread_id),
 agent_id TEXT NOT NULL REFERENCES agents(id),
 value INTEGER NOT NULL CHECK(value IN (-1,1)),
 PRIMARY KEY(thread_id,agent_id)
);
CREATE TRIGGER audit_task_votes_insert AFTER INSERT ON task_votes BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','task_votes',CAST(NEW.thread_id AS TEXT)||':'||NEW.agent_id,NULL,json_object('thread_id',NEW.thread_id,'agent_id',NEW.agent_id,'value',NEW.value));
END;
CREATE TRIGGER audit_task_votes_update AFTER UPDATE ON task_votes BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','task_votes',CAST(NEW.thread_id AS TEXT)||':'||NEW.agent_id,json_object('thread_id',OLD.thread_id,'agent_id',OLD.agent_id,'value',OLD.value),json_object('thread_id',NEW.thread_id,'agent_id',NEW.agent_id,'value',NEW.value));
END;
CREATE TRIGGER audit_task_votes_delete AFTER DELETE ON task_votes BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','task_votes',CAST(OLD.thread_id AS TEXT)||':'||OLD.agent_id,json_object('thread_id',OLD.thread_id,'agent_id',OLD.agent_id,'value',OLD.value),NULL);
END;
