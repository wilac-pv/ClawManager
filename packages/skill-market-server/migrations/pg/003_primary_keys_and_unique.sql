-- PG 补全: 主键 + 唯一索引
-- 根因: SQLite→PG 数据同步时,表结构只建了列+普通索引,
-- 遗漏了所有 PRIMARY KEY 和 UNIQUE INDEX,
-- 导致 ON CONFLICT(...) 语句全部失败:
--   - SSO 登录 complete() 写 departments/users 表 → dependency-unavailable
--   - expert_packages 同步 ON CONFLICT(slug) → sync_error
--   - 其他 INSERT ... ON CONFLICT 路径同样受影响
-- 已验证: 26 张表的主键列均无重复数据(2026-08-06 检查)

BEGIN;

-- ============================================================
-- 单列主键(19 张表)
-- ============================================================
ALTER TABLE skill_market_stage.users ADD CONSTRAINT pk_users PRIMARY KEY (employee_id);
ALTER TABLE skill_market_stage.departments ADD CONSTRAINT pk_departments PRIMARY KEY (department_id);
ALTER TABLE skill_market_stage.login_attempts ADD CONSTRAINT pk_login_attempts PRIMARY KEY (attempt_hash);
ALTER TABLE skill_market_stage.sessions ADD CONSTRAINT pk_sessions PRIMARY KEY (session_hash);
ALTER TABLE skill_market_stage.community_skills ADD CONSTRAINT pk_community_skills PRIMARY KEY (skill_id);
ALTER TABLE skill_market_stage.submissions ADD CONSTRAINT pk_submissions PRIMARY KEY (id);
ALTER TABLE skill_market_stage.reviews ADD CONSTRAINT pk_reviews PRIMARY KEY (id);
ALTER TABLE skill_market_stage.publish_jobs ADD CONSTRAINT pk_publish_jobs PRIMARY KEY (id);
ALTER TABLE skill_market_stage.audit_events ADD CONSTRAINT pk_audit_events PRIMARY KEY (id);
ALTER TABLE skill_market_stage.skillhub_generations ADD CONSTRAINT pk_skillhub_generations PRIMARY KEY (id);
ALTER TABLE skill_market_stage.skillhub_import_items ADD CONSTRAINT pk_skillhub_import_items PRIMARY KEY (slug);
ALTER TABLE skill_market_stage.skillhub_deferred_import_items ADD CONSTRAINT pk_skillhub_deferred_import_items PRIMARY KEY (slug);
ALTER TABLE skill_market_stage.expert_packages ADD CONSTRAINT pk_expert_packages PRIMARY KEY (slug);
ALTER TABLE skill_market_stage.announcements ADD CONSTRAINT pk_announcements PRIMARY KEY (id);
ALTER TABLE skill_market_stage.market_groups ADD CONSTRAINT pk_market_groups PRIMARY KEY (id);
ALTER TABLE skill_market_stage.restricted_publications ADD CONSTRAINT pk_restricted_publications PRIMARY KEY (id);
ALTER TABLE skill_market_stage.private_install_grants ADD CONSTRAINT pk_private_install_grants PRIMARY KEY (token_hash);
ALTER TABLE skill_market_stage.delist_requests ADD CONSTRAINT pk_delist_requests PRIMARY KEY (id);
ALTER TABLE skill_market_stage.artifact_cleanup_jobs ADD CONSTRAINT pk_artifact_cleanup_jobs PRIMARY KEY (id);

-- ============================================================
-- 复合主键(7 张表)
-- ============================================================
ALTER TABLE skill_market_stage.role_assignments ADD CONSTRAINT pk_role_assignments PRIMARY KEY (employee_id, role);
ALTER TABLE skill_market_stage.submission_revisions ADD CONSTRAINT pk_submission_revisions PRIMARY KEY (submission_id, revision_number);
ALTER TABLE skill_market_stage.idempotency_keys ADD CONSTRAINT pk_idempotency_keys PRIMARY KEY (employee_id, route, idempotency_key);
ALTER TABLE skill_market_stage.skill_favorites ADD CONSTRAINT pk_skill_favorites PRIMARY KEY (employee_id, source, skill_id);
ALTER TABLE skill_market_stage.market_group_members ADD CONSTRAINT pk_market_group_members PRIMARY KEY (group_id, employee_id);
ALTER TABLE skill_market_stage.submission_group_targets ADD CONSTRAINT pk_submission_group_targets PRIMARY KEY (submission_id, group_id);
ALTER TABLE skill_market_stage.restricted_publication_groups ADD CONSTRAINT pk_restricted_publication_groups PRIMARY KEY (publication_id, group_id);

-- ============================================================
-- 唯一索引(部分索引,对应 SQLite 的 CREATE UNIQUE INDEX ... WHERE ...)
-- ============================================================

-- submissions: 同一 skill+version 只能有一个活跃投稿(company/personal/restricted 三类)
CREATE UNIQUE INDEX IF NOT EXISTS submissions_active_company_skill_version
  ON skill_market_stage.submissions (skill_id, target_version)
  WHERE target_scope = 'company'
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE UNIQUE INDEX IF NOT EXISTS submissions_active_personal_skill_version
  ON skill_market_stage.submissions (owner_employee_id, skill_id, target_version)
  WHERE target_scope = 'personal'
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE UNIQUE INDEX IF NOT EXISTS submissions_active_restricted_skill_version
  ON skill_market_stage.submissions (owner_employee_id, skill_id, target_version)
  WHERE target_scope IN ('groups', 'department')
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

CREATE UNIQUE INDEX IF NOT EXISTS submissions_active_audience_change_source
  ON skill_market_stage.submissions (source_publication_id)
  WHERE source_publication_id IS NOT NULL
    AND status IN ('validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed');

-- skillhub_generations: 同一时间只能有一个 running/paused generation
CREATE UNIQUE INDEX IF NOT EXISTS skillhub_single_unsettled_generation
  ON skill_market_stage.skillhub_generations ((1))
  WHERE state IN ('running', 'paused');

-- delist_requests: 同一 submission 只能有一个 pending delist
CREATE UNIQUE INDEX IF NOT EXISTS delist_requests_pending_submission
  ON skill_market_stage.delist_requests (submission_id)
  WHERE status = 'pending';

-- publish_jobs: 同一 submission 只能有一个活跃 publish job
CREATE UNIQUE INDEX IF NOT EXISTS publish_jobs_active_submission
  ON skill_market_stage.publish_jobs (submission_id)
  WHERE submission_id IS NOT NULL AND status IN ('pending', 'running');

-- restricted_publications: 每个 owner+skill+version 只能有一个 published
CREATE UNIQUE INDEX IF NOT EXISTS restricted_publications_live_owner_skill_version
  ON skill_market_stage.restricted_publications (owner_employee_id, skill_id, version)
  WHERE status = 'published';

-- restricted_publications.submission_id 的内联 UNIQUE(对应 SQLite schema)
-- 主键已覆盖 id;submission_id 上的 UNIQUE 约束
ALTER TABLE skill_market_stage.restricted_publications ADD CONSTRAINT uq_restricted_publications_submission_id UNIQUE (submission_id);

-- artifact_cleanup_jobs.delist_request_id 的内联 UNIQUE
ALTER TABLE skill_market_stage.artifact_cleanup_jobs ADD CONSTRAINT uq_artifact_cleanup_jobs_delist_request_id UNIQUE (delist_request_id);

COMMIT;
