CREATE INDEX messages_author_reply_inbox ON messages(author_id,deleted,id);
CREATE INDEX messages_reply_inbox ON messages(reply_to,deleted,id);
