ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id);
DROP TRIGGER audit_messages_insert;
CREATE TRIGGER audit_messages_insert AFTER INSERT ON messages BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','messages',CAST(NEW.id AS TEXT),NULL,json_object('id',NEW.id,'reply_to',NEW.reply_to,'thread_id',NEW.thread_id,'author_id',NEW.author_id,'deleted',NEW.deleted));
END;
DROP TRIGGER audit_messages_update;
CREATE TRIGGER audit_messages_update AFTER UPDATE ON messages BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','messages',CAST(NEW.id AS TEXT),json_object('id',OLD.id,'reply_to',OLD.reply_to,'thread_id',OLD.thread_id,'author_id',OLD.author_id,'deleted',OLD.deleted),json_object('id',NEW.id,'reply_to',NEW.reply_to,'thread_id',NEW.thread_id,'author_id',NEW.author_id,'deleted',NEW.deleted));
END;
DROP TRIGGER audit_messages_delete;
CREATE TRIGGER audit_messages_delete AFTER DELETE ON messages BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','messages',CAST(OLD.id AS TEXT),json_object('id',OLD.id,'reply_to',OLD.reply_to,'thread_id',OLD.thread_id,'author_id',OLD.author_id,'deleted',OLD.deleted),NULL);
END;
