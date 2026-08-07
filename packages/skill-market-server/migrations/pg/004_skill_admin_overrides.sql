-- PG 新增: 管理员技能管理覆盖层
-- 支持:
--   1. skill_overrides: 对 skillhub/enterprise 外部来源做本地覆盖(精选/隐藏/分类)
--      community 技能直接改 submissions/community_skills,不走覆盖层
--   2. hidden_categories: 按分类整体隐藏,市场列表/facets 排除该分类下所有技能
-- 生效方式: catalog 查询/重建时读取覆盖层并过滤/覆盖

BEGIN;

CREATE TABLE IF NOT EXISTS skill_market_stage.skill_overrides (
  skill_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('skillhub', 'enterprise', 'community')),
  featured boolean NULL,
  hidden boolean NOT NULL DEFAULT false,
  hidden_reason text NULL,
  category_override jsonb NULL,
  updated_by text NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT pk_skill_overrides PRIMARY KEY (source, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_market_stage.hidden_categories (
  category text NOT NULL,
  hidden_reason text NULL,
  updated_by text NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT pk_hidden_categories PRIMARY KEY (category)
);

CREATE INDEX IF NOT EXISTS skill_overrides_hidden_idx
  ON skill_market_stage.skill_overrides (hidden)
  WHERE hidden = true;

COMMIT;
