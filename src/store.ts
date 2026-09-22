/**
 * Persistent userId ↔ forum threadId mapping (SQLite via better-sqlite3).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface UserMapping {
  userId: number;
  threadId: number;
  displayName: string;
  createdAt: string;
}

export class MappingStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mappings (
        user_id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mappings_thread ON mappings(thread_id);
    `);
  }

  getByUserId(userId: number): UserMapping | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id AS userId, thread_id AS threadId,
                display_name AS displayName, created_at AS createdAt
         FROM mappings WHERE user_id = ?`,
      )
      .get(userId) as UserMapping | undefined;
    return row;
  }

  getByThreadId(threadId: number): UserMapping | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id AS userId, thread_id AS threadId,
                display_name AS displayName, created_at AS createdAt
         FROM mappings WHERE thread_id = ?`,
      )
      .get(threadId) as UserMapping | undefined;
    return row;
  }

  upsert(userId: number, threadId: number, displayName: string): void {
    this.db
      .prepare(
        `INSERT INTO mappings (user_id, thread_id, display_name)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           thread_id = excluded.thread_id,
           display_name = excluded.display_name`,
      )
      .run(userId, threadId, displayName);
  }

  deleteByUserId(userId: number): void {
    this.db.prepare(`DELETE FROM mappings WHERE user_id = ?`).run(userId);
  }

  close(): void {
    this.db.close();
  }
}
