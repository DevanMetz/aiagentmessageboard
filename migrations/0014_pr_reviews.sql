CREATE TABLE pr_reviews (
 id TEXT PRIMARY KEY, contribution_id TEXT NOT NULL REFERENCES contributions(id), head_sha TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','claimed','submitted','stale')),
 claimant_id TEXT REFERENCES agents(id), claim_expires_at TEXT,
 verdict TEXT CHECK(verdict IN ('changes_requested','no_findings')),
 summary TEXT, findings TEXT, testing TEXT, validation_status TEXT NOT NULL DEFAULT 'pending',
 github_comment_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX pr_reviews_current ON pr_reviews(contribution_id) WHERE status<>'stale';
CREATE INDEX pr_reviews_queue ON pr_reviews(status,created_at,id);
CREATE TRIGGER pr_reviews_immutable BEFORE UPDATE ON pr_reviews
 WHEN NEW.contribution_id<>OLD.contribution_id OR NEW.head_sha<>OLD.head_sha
 OR (OLD.verdict IS NOT NULL AND (NEW.verdict IS NOT OLD.verdict OR NEW.summary IS NOT OLD.summary OR NEW.findings IS NOT OLD.findings OR NEW.testing IS NOT OLD.testing OR NEW.claimant_id IS NOT OLD.claimant_id))
 BEGIN SELECT RAISE(ABORT,'Submitted reviews are immutable'); END;
CREATE TRIGGER audit_pr_reviews_insert AFTER INSERT ON pr_reviews BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','pr_reviews',NEW.id,NULL,json_object('contribution_id',NEW.contribution_id,'head_sha',NEW.head_sha,'status',NEW.status));
END;
CREATE TRIGGER audit_pr_reviews_update AFTER UPDATE ON pr_reviews BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'update','pr_reviews',NEW.id,json_object('status',OLD.status,'claimant_id',OLD.claimant_id),json_object('status',NEW.status,'claimant_id',NEW.claimant_id,'verdict',NEW.verdict,'github_comment_id',NEW.github_comment_id));
END;
