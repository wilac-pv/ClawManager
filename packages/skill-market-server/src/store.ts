/**
 * 数据访问接口 — 抽象 SQLite 与 Postgres 共有的查询语义。
 *
 * 15 个领域模块(publisher、submissions 等)依赖这个接口而非具体的
 * bun:sqlite Database 类型,使运行时可以在 SQLite 和 PG 间切换。
 *
 * 占位符约定: SQL 用 `?` 作位置参数。SQLite 驱动直接支持,
 * PG 驱动在执行前把 `?` 重写为 `$1,$2,...`。模块代码无需感知。
 */
export interface Connection {
  /**
   * 执行写操作(INSERT/UPDATE/DELETE)或无返回值的语句。
   * 返回受影响行数。
   */
  run(sql: string, params?: readonly unknown[]): Promise<number>

  /**
   * 执行查询,返回所有匹配行。无匹配返回空数组。
   */
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>

  /**
   * 执行查询,返回首行。无匹配返回 undefined。
   */
  get<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined>
}

/**
 * 数据库句柄,提供事务边界与连接管理。
 * 事务回调内拿到的是同一个 Connection(同一事务/连接),保证原子性。
 */
export interface MarketDatabase {
  /** 只读事务(实现可优化为快照读)。 */
  read<T>(callback: (connection: Connection) => Promise<T> | T): Promise<T>

  /** 读写事务。 */
  transaction<T>(callback: (connection: Connection) => Promise<T> | T): Promise<T>

  close(): Promise<void>
}
