import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface UserWithPasswordHash extends User {
  /** Null for OAuth-only accounts (e.g. Google sign-in) that never set a local password. */
  passwordHash: string | null;
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`Un compte existe déjà pour "${email}".`);
    this.name = "EmailAlreadyRegisteredError";
  }
}

export interface UserRepository {
  createUser(email: string, passwordHash: string): User;
  findByEmail(email: string): UserWithPasswordHash | null;
  findById(id: string): User | null;
  findByGoogleId(googleId: string): User | null;
  findOrCreateGoogleUser(email: string, googleId: string): User;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  google_id: string | null;
  created_at: string;
}

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: DatabaseSync) {}

  createUser(email: string, passwordHash: string): User {
    const normalizedEmail = normalizeEmail(email);
    const existing = this.db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
    if (existing) {
      throw new EmailAlreadyRegisteredError(normalizedEmail);
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, normalizedEmail, passwordHash, createdAt);

    return { id, email: normalizedEmail, createdAt };
  }

  findByEmail(email: string): UserWithPasswordHash | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as
      | UserRow
      | undefined;
    if (!row) return null;
    return { id: row.id, email: row.email, createdAt: row.created_at, passwordHash: row.password_hash };
  }

  findById(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!row) return null;
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  findByGoogleId(googleId: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE google_id = ?").get(googleId) as
      | UserRow
      | undefined;
    if (!row) return null;
    return { id: row.id, email: row.email, createdAt: row.created_at };
  }

  /**
   * Find-or-create-or-link for Google sign-in: an existing google_id wins
   * first (repeat sign-in), then an existing account matched by email gets
   * the google_id linked onto it (e.g. a legacy password account signing
   * in with Google for the first time), otherwise a brand-new OAuth-only
   * user (no password_hash) is created.
   */
  findOrCreateGoogleUser(email: string, googleId: string): User {
    const byGoogleId = this.findByGoogleId(googleId);
    if (byGoogleId) return byGoogleId;

    const normalizedEmail = normalizeEmail(email);
    const existingByEmail = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail) as
      | UserRow
      | undefined;
    if (existingByEmail) {
      this.db.prepare("UPDATE users SET google_id = ? WHERE id = ?").run(googleId, existingByEmail.id);
      return { id: existingByEmail.id, email: existingByEmail.email, createdAt: existingByEmail.created_at };
    }

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO users (id, email, password_hash, google_id, created_at) VALUES (?, ?, NULL, ?, ?)")
      .run(id, normalizedEmail, googleId, createdAt);

    return { id, email: normalizedEmail, createdAt };
  }
}
