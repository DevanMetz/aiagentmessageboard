CREATE TABLE dao_wallet_challenges (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id), nonce TEXT NOT NULL, address TEXT NOT NULL,
 chain_id INTEGER NOT NULL, origin TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE dao_wallets (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id), address TEXT NOT NULL, chain_id INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(chain_id,address)
);
CREATE TABLE dao_proposals (
 thread_id TEXT PRIMARY KEY REFERENCES tasks(thread_id), task_id TEXT NOT NULL UNIQUE,
 proposal_id TEXT NOT NULL UNIQUE, proposer_id TEXT NOT NULL REFERENCES agents(id), proposer_wallet TEXT NOT NULL,
 chain_id INTEGER NOT NULL, governor TEXT NOT NULL, escrow TEXT NOT NULL,
 reward TEXT NOT NULL, reviewer TEXT NOT NULL, deadline INTEGER NOT NULL, specification_hash TEXT NOT NULL,
 description TEXT NOT NULL, actions TEXT NOT NULL, synced_block INTEGER NOT NULL DEFAULT 0,
 synced_block_hash TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE dao_evidence (
 task_id TEXT NOT NULL REFERENCES dao_proposals(task_id), evidence_hash TEXT NOT NULL,
 message_id INTEGER NOT NULL REFERENCES messages(id), author_id TEXT NOT NULL REFERENCES agents(id),
 wallet TEXT NOT NULL, PRIMARY KEY(task_id,evidence_hash)
);
CREATE TRIGGER audit_dao_wallet_insert AFTER INSERT ON dao_wallets BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','dao_wallets',NEW.agent_id,NULL,json_object('address',NEW.address,'chain_id',NEW.chain_id));
END;
CREATE TRIGGER audit_dao_proposal_insert AFTER INSERT ON dao_proposals BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','dao_proposals',NEW.thread_id,NULL,json_object('proposal_id',NEW.proposal_id,'task_id',NEW.task_id,'chain_id',NEW.chain_id,'specification_hash',NEW.specification_hash));
END;
CREATE TRIGGER audit_dao_evidence_insert AFTER INSERT ON dao_evidence BEGIN
 INSERT INTO audit_events(request_id,actor,action,target_type,target_id,before_state,after_state)
 VALUES(COALESCE((SELECT request_id FROM audit_context WHERE id=1),'database-direct'),COALESCE((SELECT actor FROM audit_context WHERE id=1),'database-direct'),'insert','dao_evidence',NEW.task_id,NULL,json_object('evidence_hash',NEW.evidence_hash,'message_id',NEW.message_id,'author_id',NEW.author_id));
END;
CREATE TRIGGER dao_wallet_immutable_update BEFORE UPDATE ON dao_wallets BEGIN SELECT RAISE(ABORT,'DAO wallet links are immutable in this prototype'); END;
CREATE TRIGGER dao_wallet_immutable_delete BEFORE DELETE ON dao_wallets BEGIN SELECT RAISE(ABORT,'DAO wallet links are immutable in this prototype'); END;
CREATE TRIGGER dao_proposal_immutable BEFORE UPDATE OF thread_id,task_id,proposal_id,proposer_id,proposer_wallet,chain_id,governor,escrow,reward,reviewer,deadline,specification_hash,description,actions ON dao_proposals BEGIN SELECT RAISE(ABORT,'Proposal terms are immutable'); END;
CREATE TRIGGER dao_proposal_no_delete BEFORE DELETE ON dao_proposals BEGIN SELECT RAISE(ABORT,'Proposal history is retained'); END;
CREATE TRIGGER dao_evidence_no_update BEFORE UPDATE ON dao_evidence BEGIN SELECT RAISE(ABORT,'Evidence digests are immutable'); END;
CREATE TRIGGER dao_evidence_no_delete BEFORE DELETE ON dao_evidence BEGIN SELECT RAISE(ABORT,'Evidence digests are retained'); END;
