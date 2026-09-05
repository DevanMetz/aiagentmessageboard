-- No credentials, credential hashes, message text, metadata, or profile text.
CREATE TABLE audit_context (id INTEGER PRIMARY KEY CHECK(id=1), request_id TEXT NOT NULL, actor TEXT NOT NULL);
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id TEXT NOT NULL,
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 target_type TEXT NOT NULL,
 target_id TEXT NOT NULL,
 outcome TEXT NOT NULL DEFAULT 'committed' CHECK(outcome='committed'),
 before_state TEXT,
 after_state TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_events_actor ON audit_events(actor,id);
CREATE INDEX audit_events_target ON audit_events(target_type,target_id,id);
CREATE INDEX audit_events_request ON audit_events(request_id,id);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit events are append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit events are append-only'); END;
CREATE TRIGGER audit_agents_insert AFTER INSERT ON agents BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','agents',CAST(NEW.id AS TEXT),NULL,json_object('id',NEW.id,'is_admin',NEW.is_admin,'disabled',NEW.disabled,'is_visitor',NEW.is_visitor));
END;
CREATE TRIGGER audit_agents_update AFTER UPDATE ON agents BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','agents',CAST(NEW.id AS TEXT),json_object('id',OLD.id,'is_admin',OLD.is_admin,'disabled',OLD.disabled,'is_visitor',OLD.is_visitor),json_object('id',NEW.id,'is_admin',NEW.is_admin,'disabled',NEW.disabled,'is_visitor',NEW.is_visitor, 'key_changed', OLD.key_hash IS NOT NEW.key_hash, 'profile_changed', OLD.name IS NOT NEW.name OR OLD.bio IS NOT NEW.bio));
END;
CREATE TRIGGER audit_agents_delete AFTER DELETE ON agents BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','agents',CAST(OLD.id AS TEXT),json_object('id',OLD.id,'is_admin',OLD.is_admin,'disabled',OLD.disabled,'is_visitor',OLD.is_visitor),NULL);
END;
CREATE TRIGGER audit_boards_insert AFTER INSERT ON boards BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','boards',CAST(NEW.id AS TEXT),NULL,json_object('id',NEW.id,'visibility',NEW.visibility,'join_mode',NEW.join_mode,'owner_id',NEW.owner_id));
END;
CREATE TRIGGER audit_boards_update AFTER UPDATE ON boards BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','boards',CAST(NEW.id AS TEXT),json_object('id',OLD.id,'visibility',OLD.visibility,'join_mode',OLD.join_mode,'owner_id',OLD.owner_id),json_object('id',NEW.id,'visibility',NEW.visibility,'join_mode',NEW.join_mode,'owner_id',NEW.owner_id, 'password_changed', OLD.password_hash IS NOT NEW.password_hash, 'details_changed', OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description));
END;
CREATE TRIGGER audit_boards_delete AFTER DELETE ON boards BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','boards',CAST(OLD.id AS TEXT),json_object('id',OLD.id,'visibility',OLD.visibility,'join_mode',OLD.join_mode,'owner_id',OLD.owner_id),NULL);
END;
CREATE TRIGGER audit_memberships_insert AFTER INSERT ON memberships BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','memberships',CAST(NEW.board_id || ':' || NEW.agent_id AS TEXT),NULL,json_object('board_id',NEW.board_id,'agent_id',NEW.agent_id,'role',NEW.role,'status',NEW.status));
END;
CREATE TRIGGER audit_memberships_update AFTER UPDATE ON memberships BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','memberships',CAST(NEW.board_id || ':' || NEW.agent_id AS TEXT),json_object('board_id',OLD.board_id,'agent_id',OLD.agent_id,'role',OLD.role,'status',OLD.status),json_object('board_id',NEW.board_id,'agent_id',NEW.agent_id,'role',NEW.role,'status',NEW.status));
END;
CREATE TRIGGER audit_memberships_delete AFTER DELETE ON memberships BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','memberships',CAST(OLD.board_id || ':' || OLD.agent_id AS TEXT),json_object('board_id',OLD.board_id,'agent_id',OLD.agent_id,'role',OLD.role,'status',OLD.status),NULL);
END;
CREATE TRIGGER audit_threads_insert AFTER INSERT ON threads BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','threads',CAST(NEW.id AS TEXT),NULL,json_object('id',NEW.id,'board_id',NEW.board_id,'author_id',NEW.author_id,'deleted',NEW.deleted));
END;
CREATE TRIGGER audit_threads_update AFTER UPDATE ON threads BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','threads',CAST(NEW.id AS TEXT),json_object('id',OLD.id,'board_id',OLD.board_id,'author_id',OLD.author_id,'deleted',OLD.deleted),json_object('id',NEW.id,'board_id',NEW.board_id,'author_id',NEW.author_id,'deleted',NEW.deleted));
END;
CREATE TRIGGER audit_threads_delete AFTER DELETE ON threads BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','threads',CAST(OLD.id AS TEXT),json_object('id',OLD.id,'board_id',OLD.board_id,'author_id',OLD.author_id,'deleted',OLD.deleted),NULL);
END;
CREATE TRIGGER audit_messages_insert AFTER INSERT ON messages BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','messages',CAST(NEW.id AS TEXT),NULL,json_object('id',NEW.id,'thread_id',NEW.thread_id,'author_id',NEW.author_id,'deleted',NEW.deleted));
END;
CREATE TRIGGER audit_messages_update AFTER UPDATE ON messages BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','messages',CAST(NEW.id AS TEXT),json_object('id',OLD.id,'thread_id',OLD.thread_id,'author_id',OLD.author_id,'deleted',OLD.deleted),json_object('id',NEW.id,'thread_id',NEW.thread_id,'author_id',NEW.author_id,'deleted',NEW.deleted));
END;
CREATE TRIGGER audit_messages_delete AFTER DELETE ON messages BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','messages',CAST(OLD.id AS TEXT),json_object('id',OLD.id,'thread_id',OLD.thread_id,'author_id',OLD.author_id,'deleted',OLD.deleted),NULL);
END;
CREATE TRIGGER audit_invites_insert AFTER INSERT ON invites BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','invites',CAST(NEW.board_id AS TEXT),NULL,json_object('board_id',NEW.board_id,'expires_at',NEW.expires_at,'uses_left',NEW.uses_left));
END;
CREATE TRIGGER audit_invites_update AFTER UPDATE ON invites BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','invites',CAST(NEW.board_id AS TEXT),json_object('board_id',OLD.board_id,'expires_at',OLD.expires_at,'uses_left',OLD.uses_left),json_object('board_id',NEW.board_id,'expires_at',NEW.expires_at,'uses_left',NEW.uses_left));
END;
CREATE TRIGGER audit_invites_delete AFTER DELETE ON invites BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','invites',CAST(OLD.board_id AS TEXT),json_object('board_id',OLD.board_id,'expires_at',OLD.expires_at,'uses_left',OLD.uses_left),NULL);
END;
CREATE TRIGGER audit_sessions_insert AFTER INSERT ON sessions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','sessions',CAST(NEW.agent_id AS TEXT),NULL,json_object('agent_id',NEW.agent_id,'expires_at',NEW.expires_at));
END;
CREATE TRIGGER audit_sessions_update AFTER UPDATE ON sessions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','sessions',CAST(NEW.agent_id AS TEXT),json_object('agent_id',OLD.agent_id,'expires_at',OLD.expires_at),json_object('agent_id',NEW.agent_id,'expires_at',NEW.expires_at));
END;
CREATE TRIGGER audit_sessions_delete AFTER DELETE ON sessions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','sessions',CAST(OLD.agent_id AS TEXT),json_object('agent_id',OLD.agent_id,'expires_at',OLD.expires_at),NULL);
END;
CREATE TRIGGER audit_moderation_actions_insert AFTER INSERT ON moderation_actions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','moderation_actions',CAST(NEW.id AS TEXT),NULL,json_object('id',NEW.id,'kind',NEW.kind,'target_id',NEW.target_id,'action',NEW.action,'actor',NEW.actor,'undo_of',NEW.undo_of));
END;
CREATE TRIGGER audit_moderation_actions_update AFTER UPDATE ON moderation_actions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','moderation_actions',CAST(NEW.id AS TEXT),json_object('id',OLD.id,'kind',OLD.kind,'target_id',OLD.target_id,'action',OLD.action,'actor',OLD.actor,'undo_of',OLD.undo_of),json_object('id',NEW.id,'kind',NEW.kind,'target_id',NEW.target_id,'action',NEW.action,'actor',NEW.actor,'undo_of',NEW.undo_of));
END;
CREATE TRIGGER audit_moderation_actions_delete AFTER DELETE ON moderation_actions BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','moderation_actions',CAST(OLD.id AS TEXT),json_object('id',OLD.id,'kind',OLD.kind,'target_id',OLD.target_id,'action',OLD.action,'actor',OLD.actor,'undo_of',OLD.undo_of),NULL);
END;
CREATE TRIGGER audit_moderation_reviews_insert AFTER INSERT ON moderation_reviews BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','moderation_reviews',CAST(NEW.agent_id AS TEXT),NULL,json_object('agent_id',NEW.agent_id,'reviewed_through',NEW.reviewed_through));
END;
CREATE TRIGGER audit_moderation_reviews_update AFTER UPDATE ON moderation_reviews BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','moderation_reviews',CAST(NEW.agent_id AS TEXT),json_object('agent_id',OLD.agent_id,'reviewed_through',OLD.reviewed_through),json_object('agent_id',NEW.agent_id,'reviewed_through',NEW.reviewed_through));
END;
CREATE TRIGGER audit_moderation_reviews_delete AFTER DELETE ON moderation_reviews BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES (COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'delete','moderation_reviews',CAST(OLD.agent_id AS TEXT),json_object('agent_id',OLD.agent_id,'reviewed_through',OLD.reviewed_through),NULL);
END;
