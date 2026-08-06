import postgres, { type Sql } from "postgres"
import type { Connection, MarketDatabase } from "./store"

/**
 * 把 SQLite 风格的 `?` 占位符重写为 Postgres 的 `$n` 编号占位符。
 * 模块代码统一用 `?` 写 SQL,PG 驱动在执行前转换,实现 SQL 可移植。
 *
 * 注意: 只重写不在字符串字面量内的 `?`。现有 SQL 里没有字符串包含
 * 问号的场景(校验过 migration 和领域查询),所以简单按字符扫描即可。
 */
function rewrite(sql: string, params: readonly unknown[]): { text: string; values: unknown[] } {
  if (params.length === 0) return { text: translateSqliteToPg(sql), values: [] }
  let text = ""
  let n = 0
  let inQuote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inQuote) {
      text += ch
      if (ch === inQuote && sql[i - 1] !== "\\") inQuote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch
      text += ch
      continue
    }
    if (ch === "?") {
      n++
      text += `$${n}`
    } else {
      text += ch
    }
  }
  return { text: translateSqliteToPg(text), values: [...params] }
}

/**
 * 把 SQLite 专属 SQL 函数/语法翻译成 Postgres 等价物。
 * 模块代码用 SQLite 风格写 SQL,PG 驱动运行时转换,
 * 这样 SQLite 路径不受影响,SQL 保持单一来源。
 *
 * 处理的方言:
 * - json_extract(col, '$.path')     → col->>'path'(文本提取)
 * - json_extract(col, '$.a.b')      → col#>>'{a,b}'
 * - json_group_array(x)             → json_agg(x)
 * - json_set(col, '$.path', val)    → jsonb_set(col::jsonb, '{path}', val::jsonb)
 * - rowid                           → ctid(近似;PG 无直接等价,用 ctid 做排序近似)
 * - ($n IS NULL OR col OP $n)       → 加显式类型 cast(详见下方注释)
 *
 * 注意: 这是尽力而为的转换。复杂 JSON 操作可能需要模块层调整,
 * 但覆盖了现有代码库的全部用法。
 */
/**
 * 把 SQL 文本中所有 `oldName(...)` 调用替换为 `newName(...)::text`,
 * 用平衡括号扫描定位闭合,正确处理嵌套子查询。
 * 用于 json_group_array → json_agg(...)::text 这种需要包裹整体结果的场景。
 */
function wrapFunctionCall(sql: string, oldName: string, newName: string): string {
  const needle = oldName + "("
  let out = ""
  let i = 0
  while (i < sql.length) {
    const idx = findFunctionCall(sql, needle, i)
    if (idx < 0) {
      out += sql.slice(i)
      break
    }
    out += sql.slice(i, idx) + newName + "("
    const close = findMatchingParen(sql, idx + needle.length - 1)
    if (close < 0) {
      out += sql.slice(idx + needle.length)
      break
    }
    out += sql.slice(idx + needle.length, close) + ")::text"
    i = close + 1
  }
  return out
}

/** 从 from 位置开始查找下一个完整函数调用 `needle`(前面非标识符字符),返回 needle 起始位置。 */
function findFunctionCall(sql: string, needle: string, from: number): number {
  let start = from
  while (true) {
    const idx = sql.indexOf(needle, start)
    if (idx < 0) return -1
    if (idx === 0 || !/[a-zA-Z0-9_]/.test(sql[idx - 1])) return idx
    start = idx + 1
  }
}

/** 给定 sql 中某个 `(` 的位置(openIdx),返回对应 `)` 的位置;不匹配返回 -1。 */
function findMatchingParen(sql: string, openIdx: number): number {
  let depth = 0
  let inQuote: string | null = null
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i]
    if (inQuote) {
      if (ch === inQuote && sql[i - 1] !== "\\") inQuote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch
      continue
    }
    if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function translateSqliteToPg(sql: string): string {
  let out = sql
  // COALESCE(json_extract(col, '$.path'), <number>) — json_extract 返回的值用于数值比较,
  // 翻译后加 ::bigint 转型让 COALESCE 类型匹配(PG 不允许 text 和 int 混用)。
  out = out.replace(
    /COALESCE\(json_extract\(([^,()]+(?:\([^)]*\))?[^,]*),\s*'\$\.([^']+)'\),\s*(-?\d+)\)/g,
    (_, col, path, fallback) =>
      `COALESCE(((${col})::jsonb->>'${path}')::bigint, ${fallback})`,
  )
  // json_extract(col, '$.path') → (col)::jsonb->>'path';嵌套路径 $.a.b → (col)::jsonb#>>'{a,b}'
  // 加 ::jsonb 转型因为 PG 迁移把 JSON 列建成了 text(未用 jsonb 类型)
  out = out.replace(/json_extract\(([^,()]+(?:\([^)]*\))?[^,]*),\s*'\$(?:\.([^']+))'\)/g, (_, col, path) => {
    const parts = path.split(".")
    if (parts.length === 1) return `(${col})::jsonb->>'${parts[0]}'`
    return `(${col})::jsonb#>>'{${parts.join(",")}}'`
  })
  // json_group_array(x) → json_agg(x)::text
  // 加 ::text 是因为代码层用 UnknownFromJsonString 把结果当 JSON 字符串解析。
  // SQLite 的 json_group_array 返回文本 '["a","b"]',PG 的 json_agg 返回原生 json 类型,
  // postgres.js 会把 json 自动解析成 JS 数组/对象,导致 UnknownFromJsonString(期望字符串)报错。
  // ::text 让 PG 返回 JSON 字符串文本,保持与 SQLite 一致的字符串契约。
  // 用平衡括号扫描定位闭合,正确处理嵌套子查询(如 json_group_array(SELECT ...))。
  out = wrapFunctionCall(out, "json_group_array", "json_agg")
  // json_set(col, '$.path', val) → jsonb_set(col::jsonb, '{path}', val::jsonb)::text
  // 第一个参数可能是含括号/逗号的表达式(如 COALESCE),用非贪婪匹配到 ',$.path'
  out = out.replace(
    /json_set\((.+?),\s*'\$\.([^']+)',\s*(.+?)\)/g,
    (_, col, path, val) => `jsonb_set((${col})::jsonb, '{${path}}', (${val})::jsonb)::text`,
  )
  // rowid(作为 ORDER BY 的次级排序键)→ ctid
  // 注意: ctid 在 PG 里是物理位置,语义不完全等同 rowid,但作为排序 tiebreaker 够用
  out = out.replace(/\browid\b/g, "ctid")

  // PG 参数类型推断修复: 代码里大量使用 `(? IS NULL OR col = ?)` 模式做可选过滤,
  // SQLite 不在意,但 PG 在参数传 null 且仅出现在 IS NULL 语境时无法推断类型,
  // 报 "could not determine data type of parameter $n"。
  //
  // 修复策略:
  // 1. `($n IS NULL` → `($n::text IS NULL`  — 给 IS NULL 的参数明确 text 类型
  // 2. 范围比较语境的参数加 ::bigint:
  //    `OP $n`(OP ∈ >=, <=, >, <)→ `OP $n::bigint`
  //    因为步骤 1 把参数约束成 text,数值/时间戳列(text 不行)需要显式转 bigint。
  //    `=` / `!=` / `<>` 比较不加 cast — 列本身的类型让 PG 推断参数类型,
  //    且这些操作符既用于文本又用于数值,强制 bigint 会破坏文本列的比较。
  //    lookbehind/lookahead 断言排除 `<>`、`!=` 以及已被分支消费的 `>=`/`<=` 残留。
  //
  // PG 允许同一参数在不同 cast 下出现(`$1::text IS NULL OR col >= $1::bigint`),
  // 这是 prepared statement 的合法用法。
  out = out.replace(/\((\$\d+) IS NULL/g, "($1::text IS NULL")
  out = out.replace(/(?<![<>!=>=<])(>=|<=|>|<)(?![<>=])\s*(\$\d+)\b/g, "$1 $2::bigint")
  return out
}

/** 单个 PG 连接(事务内)或共享连接池句柄(事务外)的 Connection 适配。 */
class PgConnection implements Connection {
  constructor(private readonly sql: Sql) {}

  async run(sqlText: string, params: readonly unknown[] = []): Promise<number> {
    const { text, values } = rewrite(sqlText, params)
    const result = await this.sql.unsafe(text, values as never)
    return result.count ?? 0
  }

  async all<T>(sqlText: string, params: readonly unknown[] = []): Promise<T[]> {
    const { text, values } = rewrite(sqlText, params)
    return (await this.sql.unsafe(text, values as never)) as T[]
  }

  async get<T>(sqlText: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sqlText, params)
    return rows[0]
  }
}

/** Postgres MarketDatabase 实现,用 postgres.js 的事务原语。 */
export class PgDatabase implements MarketDatabase {
  constructor(private readonly sql: Sql) {}

  async read<T>(callback: (connection: Connection) => Promise<T> | T): Promise<T> {
    // postgres.js 的 transaction 默认是读写事务;只读语义由 SQL 决定,
    // 这里仍用 begin 保证回调在一个事务里执行。
    return this.transaction(callback)
  }

  transaction<T>(callback: (connection: Connection) => Promise<T> | T): Promise<T> {
    // sql.begin 的类型签名用 UnwrapPromiseArray<T> 展开,对我们的纯对象
    // 返回值没有实质影响,这里用 unknown 中转断言回 Promise<T>。
    return this.sql.begin(async (tx) => {
      const connection: Connection = new PgConnection(tx as unknown as Sql)
      return (await callback(connection)) as unknown
    }) as Promise<T>
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}

export interface OpenPostgresOptions {
  /** 完整连接串,如 postgres://user:pass@host:port/db */
  readonly url: string
  /** schema 名(对应 skill_market_stage 等),设为 search_path */
  readonly schema?: string
  /** 单次语句超时(毫秒),默认 30s */
  readonly statementTimeoutMs?: number
  /** 连接池上限,默认 8 */
  readonly maxConnections?: number
}

export async function openPostgres(options: OpenPostgresOptions): Promise<PgDatabase> {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 8,
    connection: {
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    },
    onnotice: () => {
      // 忽略 NOTICE(IF NOT EXISTS 跳过等),避免噪音
    },
  })

  // bigint 列(epoch 毫秒时间戳、行号等)默认返回 string,会导致 new Date("123")
  // 报 Invalid Date。注册 OID 20(int8)解析器返回 number。
  // 我们的值都在 Number.MAX_SAFE_INTEGER 内,精度安全。
  sql.options.parsers[20] = (value: string) => Number(value)

  if (options.schema) {
    await sql.unsafe(`SET search_path TO ${options.schema}, public`)
  }

  // 验证连接
  await sql`SELECT 1`

  return new PgDatabase(sql)
}
