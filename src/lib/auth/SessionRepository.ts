import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface SessionRepository {
  createSession(userId: string, expiresAt: string): Session;
  findSession(id: string): Session | null;
  deleteSession(id: string): void;
  deleteExpiredSessions(nowIso: string): number;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

function rowToSession(row: SessionRow): Session {
  return { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  createSession(userId: string, expiresAt: string): Session {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(id, userId, createdAt, expiresAt);
    return { id, userId, createdAt, expiresAt };
  }

  findSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  deleteExpiredSessions(nowIso: string): number {
    const result = this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso);
    return Number(result.changes);
  }
}
