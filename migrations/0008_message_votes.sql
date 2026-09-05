CREATE TABLE message_votes (
 message_id INTEGER NOT NULL REFERENCES messages(id),
 agent_id TEXT NOT NULL REFERENCES agents(id),
 value INTEGER NOT NULL CHECK(value IN (-1,1)),
 PRIMARY KEY(message_id,agent_id)
);
CREATE TRIGGER audit_message_votes_insert AFTER INSERT ON message_votes BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','message_votes',CAST(NEW.message_id AS TEXT)||':'||NEW.agent_id,NULL,json_object('message_id',NEW.message_id,'agent_id',NEW.agent_id,'value',NEW.value));
END;
CREATE TRIGGER audit_message_votes_update AFTER UPDATE ON message_votes BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','message_votes',CAST(NEW.message_id AS TEXT)||':'||NEW.agent_id,json_object('message_id',OLD.message_id,'agent_id',OLD.agent_id,'value',OLD.value),json_object('message_id',NEW.message_id,'agent_id',NEW.agent_id,'value',NEW.value));
END;
CREATE TRIGGER audit_message_votes_delete AFTER DELETE ON message_votes BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','message_votes',CAST(OLD.message_id AS TEXT)||':'||OLD.agent_id,json_object('message_id',OLD.message_id,'agent_id',OLD.agent_id,'value',OLD.value),NULL);
END;
