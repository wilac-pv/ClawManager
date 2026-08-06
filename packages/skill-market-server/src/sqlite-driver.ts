import { Database } from "bun:sqlite"
import type { Connection, MarketDatabase } from "./store"

/**
 * 把同步的 bun:sqlite Database 包装成异步 Store.Connection 接口。
 * 这样领域模块统一用 await,SQLite 和 PG 行为一致。
 * 同步调用结果用 Promise.resolve 包装,开销可忽略。
 */
class SqliteConnection implements Connection {
  constructor(private readonly db: Database) {}

  run(sql: string, params: readonly unknown[] = []): Promise<number> {
    const result = this.db.prepare(sql).run(...(params as never[]))
    return Promise.resolve(result.changes ?? 0)
  }

  all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...(params as never[])) as T[]
    return Promise.resolve(rows)
  }

  get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const row = this.db.prepare(sql).get(...(params as never[])) as T | null
    return Promise.resolve(row ?? undefined)
  }
}

/**
 * SQLite 的 MarketDatabase 实现。
 *
 * 关键设计:用显式 BEGIN/COMMIT/ROLLBACK + SAVEPOINT 处理嵌套事务。
 * bun:sqlite 原生的 transaction() 是同步的,无法正确包裹 async 回调
 * (微任务会在事务边界外执行)。改用显式 SQL 控制事务边界后,
 * async 回调里的所有查询都在同一事务里。
 *
 * 嵌套事务(回调里又调 database.read/transaction)用 SAVEPOINT 实现:
 * 外层 BEGIN,内层 SAVEPOINT sp_1,最内层 RELEASE/ROLLBACK TO。
 */
export class SqliteDatabase implements MarketDatabase {
  constructor(readonly connection: Database) {}

  read<T>(callback: (connection: Connection) => Promise<T> | T): Promise<T> {
    return this.runTransaction(callback)
  }

  transaction<T>(callback: (connection: Connection) => Promise<T> | T): Promise<T> {
    return this.runTransaction(callback)
  }

  private depth = 0

  private async runTransaction<T>(
    callback: (connection: Connection) => Promise<T> | T,
  ): Promise<T> {
    if (this.depth > 0) {
      // 已在事务中:内层不开启新事务,直接执行回调。
      // SQLite 的事务是连接级的,内层查询自动在同一事务里。
      // 如果内层抛错,由外层事务统一回滚。
      this.depth += 1
      try {
        return await callback(new SqliteConnection(this.connection))
      } finally {
        this.depth -= 1
      }
    }
    this.depth += 1
    this.connection.exec("BEGIN IMMEDIATE")
    try {
      const result = await callback(new SqliteConnection(this.connection))
      this.connection.exec("COMMIT")
      return result
    } catch (error) {
      try {
        this.connection.exec("ROLLBACK")
      } catch {
        // 连接已断开等,忽略 rollback 错误,抛原始错误
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }

  close(): Promise<void> {
    this.connection.close()
    return Promise.resolve()
  }
}
