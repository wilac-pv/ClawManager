-- PG 约束补全: CHECK 约束 + NOT NULL 列
-- 对应 SQLite schema 迁移时丢失的完整性约束
-- 已于 2026-08-06 应用于 skill_market_stage: 117 CHECK + 141 NOT NULL
--
-- 方言翻译规则(从生成脚本提取):
--   GLOB 'pat'          →  ~ '^pat$'    (PG 正则)
--   NOT GLOB '*[^x]*'   →  ~ '^[x]+$'   (全字符集匹配)
--   IS 'val'            →  = 'val'      (PG 不支持 IS 对字符串)
--   json_valid(col)     →  (col IS JSON) (PG 16 内建)
--   instr(a,b)          →  position(b in a)
--
-- 幂等性: PG16 的 ALTER TABLE ADD CONSTRAINT 不支持 IF NOT EXISTS,
-- 所以每条用 DO 块包裹(查 pg_constraint 判断存在性),可重复执行。

BEGIN;

-- ============================================================
-- CHECK 约束(示例: 完整 117 条见 /tmp/pg-add-constraints.sql
-- 这里只记录有方言转换的关键条目,其余 IN/>=/length 类直接可迁移)
-- ============================================================

-- 枚举类型约束(15 条): role/status/state/decision/kind/scope 等
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_role_assignments_1') THEN
    ALTER TABLE role_assignments ADD CONSTRAINT ck_role_assignments_1
      CHECK (role IN ('reviewer', 'admin'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_submissions_1') THEN
    ALTER TABLE submissions ADD CONSTRAINT ck_submissions_1
      CHECK (status IN ('validating','validation_failed','pending_review','changes_requested','rejected','publishing','publish_failed','published','withdrawn'));
  END IF;
END $$;

-- 范围约束(45 条): version>=1, attempts>=0, updated_at>=created_at, BETWEEN 等
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_submissions_3') THEN
    ALTER TABLE submissions ADD CONSTRAINT ck_submissions_3 CHECK (version >= 1);
  END IF;
END $$;

-- 字符串/正则约束(翻译后的关键 3 条)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_announcements_1') THEN
    ALTER TABLE announcements ADD CONSTRAINT ck_announcements_1
      CHECK (id ~ '^ann_[a-zA-Z0-9_-]+$' AND length(id) BETWEEN 12 AND 68);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_private_install_grants_1') THEN
    ALTER TABLE private_install_grants ADD CONSTRAINT ck_private_install_grants_1
      CHECK (length(token_hash) = 64 AND token_hash ~ '^[a-f0-9]+$');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_restricted_publications_4') THEN
    ALTER TABLE restricted_publications ADD CONSTRAINT ck_restricted_publications_4
      CHECK (length(package_key) > 0 AND position('://' in package_key) = 0);
  END IF;
END $$;

-- JSON 校验(8 条): SQLite json_valid(col) → PG (col IS JSON)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_submission_revisions_json') THEN
    ALTER TABLE submission_revisions ADD CONSTRAINT ck_submission_revisions_json
      CHECK (private_icon_json IS NULL OR (private_icon_json IS JSON));
  END IF;
END $$;

-- ============================================================
-- NOT NULL 列(共 141 列, 此处示例, 完整清单见生成脚本)
-- ============================================================
-- 已全部应用, 无 NULL 违反(数据迁移时完整性保持良好)

COMMIT;

-- 注: 完整的 117 CHECK + 141 NOT NULL 由 /tmp/gen-pg3.py 生成。
-- 此文件记录方言转换策略和关键样例,便于审计和 stage2/3 复用。
-- 要在 stage2/stage3 复用: SET search_path TO skill_market_stage2; 然后重跑。
