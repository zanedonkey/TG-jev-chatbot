/**
 * Persistent userId ↔ forum threadId mapping (SQLite via better-sqlite3).
 * Also stores short-lived Jev suggestion payloads and learn-from-chats candidates.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface UserMapping {
  userId: number;
  threadId: number;
  displayName: string;
  createdAt: string;
  lastQuestion: string | null;
}

export interface JevSuggestionRow {
  id: string;
  userId: number;
  threadId: number;
  answer: string;
  createdAt: string;
}

export type LearnSource = "staff" | "jev";
export type LearnStatus = "pending" | "approved" | "rejected";

export interface LearnCandidateRow {
  id: string;
  userId: number;
  question: string;
  answer: string;
  source: LearnSource;
  status: LearnStatus;
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

      CREATE TABLE IF NOT EXISTS jev_suggestions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        answer TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_jev_suggestions_user ON jev_suggestions(user_id);

      CREATE TABLE IF NOT EXISTS learn_candidates (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_learn_status_created
        ON learn_candidates(status, created_at DESC);
    `);
    this.migrateMappingsLastQuestion();
  }

  /** Add last_question column if missing (existing DBs). */
  private migrateMappingsLastQuestion(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(mappings)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "last_question")) {
      this.db.exec(
        `ALTER TABLE mappings ADD COLUMN last_question TEXT DEFAULT NULL`,
      );
    }
  }

  getByUserId(userId: number): UserMapping | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id AS userId, thread_id AS threadId,
                display_name AS displayName, created_at AS createdAt,
                last_question AS lastQuestion
         FROM mappings WHERE user_id = ?`,
      )
      .get(userId) as UserMapping | undefined;
    return row;
  }

  getByThreadId(threadId: number): UserMapping | undefined {
    const row = this.db
      .prepare(
        `SELECT user_id AS userId, thread_id AS threadId,
                display_name AS displayName, created_at AS createdAt,
                last_question AS lastQuestion
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

  setLastQuestion(userId: number, question: string): void {
    this.db
      .prepare(`UPDATE mappings SET last_question = ? WHERE user_id = ?`)
      .run(question, userId);
  }

  getLastQuestion(userId: number): string | null {
    const row = this.db
      .prepare(`SELECT last_question AS lastQuestion FROM mappings WHERE user_id = ?`)
      .get(userId) as { lastQuestion: string | null } | undefined;
    return row?.lastQuestion ?? null;
  }

  deleteByUserId(userId: number): void {
    this.db.prepare(`DELETE FROM mappings WHERE user_id = ?`).run(userId);
  }

  /** Persist a suggestion; returns a short id safe for Telegram callback_data (≤64 bytes). */
  saveJevSuggestion(
    userId: number,
    threadId: number,
    answer: string,
  ): string {
    const id = randomBytes(8).toString("hex"); // 16 hex chars
    this.db
      .prepare(
        `INSERT INTO jev_suggestions (id, user_id, thread_id, answer)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, userId, threadId, answer);
    return id;
  }

  getJevSuggestion(id: string): JevSuggestionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId, thread_id AS threadId,
                answer, created_at AS createdAt
         FROM jev_suggestions WHERE id = ?`,
      )
      .get(id) as JevSuggestionRow | undefined;
    return row;
  }

  deleteJevSuggestion(id: string): void {
    this.db.prepare(`DELETE FROM jev_suggestions WHERE id = ?`).run(id);
  }

  /**
   * Insert a pending learn candidate if length/dedupe checks pass.
   * Returns id, or null if skipped (too short / duplicate recently).
   */
  tryInsertLearnCandidate(
    userId: number,
    question: string,
    answer: string,
    source: LearnSource,
  ): string | null {
    const q = question.trim();
    const a = answer.trim();
    if (q.length < 2 || a.length < 4) return null;

    // Loose dedupe: identical Q+A already pending or approved recently (7 days)
    const dup = this.db
      .prepare(
        `SELECT id FROM learn_candidates
         WHERE question = ? AND answer = ?
           AND status IN ('pending', 'approved')
           AND created_at >= datetime('now', '-7 days')
         LIMIT 1`,
      )
      .get(q, a) as { id: string } | undefined;
    if (dup) return null;

    const id = randomBytes(8).toString("hex");
    this.db
      .prepare(
        `INSERT INTO learn_candidates (id, user_id, question, answer, source, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      )
      .run(id, userId, q, a, source);
    return id;
  }

  countPendingLearn(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM learn_candidates WHERE status = 'pending'`,
      )
      .get() as { n: number };
    return row.n;
  }

  listPendingLearn(limit = 5): LearnCandidateRow[] {
    return this.db
      .prepare(
        `SELECT id, user_id AS userId, question, answer, source,
                status, created_at AS createdAt
         FROM learn_candidates
         WHERE status = 'pending'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as LearnCandidateRow[];
  }

  getLearnCandidate(id: string): LearnCandidateRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, user_id AS userId, question, answer, source,
                status, created_at AS createdAt
         FROM learn_candidates WHERE id = ?`,
      )
      .get(id) as LearnCandidateRow | undefined;
    return row;
  }

  setLearnStatus(id: string, status: LearnStatus): void {
    this.db
      .prepare(`UPDATE learn_candidates SET status = ? WHERE id = ?`)
      .run(status, id);
  }

  deleteLearnCandidate(id: string): void {
    this.db.prepare(`DELETE FROM learn_candidates WHERE id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}
