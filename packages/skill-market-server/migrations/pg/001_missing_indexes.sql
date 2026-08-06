-- PG 补全: 对应 SQLite 手动建但 PG 迁移时遗漏的索引
-- 上下文: skill_market_stage schema (search_path 默认指向它)
-- 来源: SQLite .schema 里的 CREATE INDEX, 迁移工具(idx_83xxx_)未覆盖的部分
-- 执行: 已在 2026-08-06 应用于 skill_market_stage, EXPLAIN 确认走 Index Scan

-- announcements: 列表按发布时间倒序分页
CREATE INDEX IF NOT EXISTS idx_announcements_published
  ON announcements (published_at DESC, id DESC);

-- audit_events: 按操作者/时间/对象审计查询(3 个)
CREATE INDEX IF NOT EXISTS idx_audit_events_actor
  ON audit_events (actor_employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created
  ON audit_events (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_audit_events_object
  ON audit_events (object_type, object_id, created_at DESC);

-- departments: 同步扫描按 last_seen_at
CREATE INDEX IF NOT EXISTS idx_departments_last_seen
  ON departments (last_seen_at DESC, department_id);

-- market_group_members: 按成员查所属组
CREATE INDEX IF NOT EXISTS idx_market_group_members_employee
  ON market_group_members (employee_id, group_id);

-- skillhub_deferred_import_items: 延迟导入队列扫描
CREATE INDEX IF NOT EXISTS idx_skillhub_deferred_imports
  ON skillhub_deferred_import_items (deferred_at, slug);

-- skillhub_import_items: 同步队列三件套(11 万行,最关键)
CREATE INDEX IF NOT EXISTS idx_skillhub_import_queue
  ON skillhub_import_items (state, next_attempt_at, lease_expires_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_skillhub_import_generation
  ON skillhub_import_items (last_seen_generation, state);
CREATE INDEX IF NOT EXISTS idx_skillhub_import_detail
  ON skillhub_import_items (detail_key);

-- submission_group_targets: 按组查投稿
CREATE INDEX IF NOT EXISTS idx_submission_group_targets_group
  ON submission_group_targets (group_id, submission_id);

-- submissions: 按状态/按拥有者查询(2 个)
CREATE INDEX IF NOT EXISTS idx_submissions_status_updated
  ON submissions (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_submissions_owner
  ON submissions (owner_employee_id, updated_at DESC);
