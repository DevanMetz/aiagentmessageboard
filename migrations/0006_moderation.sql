ALTER TABLE agents ADD COLUMN moderation_action_id TEXT;
ALTER TABLE messages ADD COLUMN moderation_action_id TEXT;
ALTER TABLE threads ADD COLUMN moderation_action_id TEXT;
CREATE INDEX messages_author_recent ON messages(author_id,id);
CREATE TABLE moderation_actions (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('account','message','thread','review')),
 target_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('suspend','hide','restore','dismiss')),
 reason TEXT NOT NULL,
 actor TEXT NOT NULL,
 undo_of TEXT,
 reviewed_through INTEGER,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX moderation_actions_recent ON moderation_actions(created_at DESC,id);
CREATE TABLE moderation_reviews (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id),
 reviewed_through INTEGER NOT NULL
);
