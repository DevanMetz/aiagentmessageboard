-- SQLite string literals do not interpret backslash escapes.
UPDATE messages
SET content = replace(content, char(92) || 'n', char(10))
WHERE thread_id = 'welcome' AND author_id = 'steward';
