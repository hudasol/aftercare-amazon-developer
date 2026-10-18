/**
 * SQLite access through Node's built-in driver (node:sqlite).
 *
 * The driver is synchronous, which makes transactions simple: a transaction
 * body is a synchronous function, so no other request can interleave with it.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Database {
  readonly sql: DatabaseSync;
  private depth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA foreign_keys = ON;');
    this.sql.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.sql.exec('PRAGMA journal_mode = WAL;');
  }

  /** Apply pending migrations in file-name order. Each migration runs in its own transaction. */
  migrate(directory: string): string[] {
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
    );
    const applied = new Set(
      (
        this.sql.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]
      ).map((r) => r.version),
    );
    const files = readdirSync(directory)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(join(directory, file), 'utf8');
      this.transaction(() => {
        this.sql.exec(body);
        this.sql
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(file, new Date().toISOString());
      });
      newlyApplied.push(file);
    }
    return newlyApplied;
  }

  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return this.run(fn);
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = this.run(fn);
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  private run<T>(fn: () => T): T {
    this.depth += 1;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error('Transaction bodies must be synchronous.');
      }
      return result;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    this.sql.close();
  }
}
