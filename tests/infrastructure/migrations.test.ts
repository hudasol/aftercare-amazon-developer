import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/container.js';
import { Database } from '../../src/infrastructure/sqlite/database.js';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('migration 003 (mismatch status)', () => {
  it('rebuilds the operations table without losing operations or attempts', () => {
    dir = mkdtempSync(join(tmpdir(), 'aftercare-mig-'));
    const early = join(dir, 'early');
    mkdirSync(early);
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '003')) {
      copyFileSync(join(MIGRATIONS_DIR, f), join(early, f));
    }
    const db = new Database(join(dir, 'm.db'));
    db.migrate(early);
    const at = '2026-10-17T10:00:00Z';
    db.sql.exec(`
      INSERT INTO cases VALUES ('c1','cus','executing','return',NULL,'2026-10-17','t',1,'${at}','${at}');
      INSERT INTO assessments VALUES ('a1','c1',1,'1.0.0','submit_approved_action','ready_to_submit','{}','${at}');
      INSERT INTO proposals VALUES ('p1','c1','a1','create_return_authorization','{}','${'a'.repeat(64)}','[]','[]','[]','approved','${at}','${at}');
      INSERT INTO operations VALUES ('o1','c1','p1','k1','accepted',1,'RMA-1',NULL,NULL,'${at}','${at}');
      INSERT INTO operation_attempts VALUES ('t1','o1','submit','accepted',NULL,'${at}','${at}');
    `);
    expect(db.migrate(MIGRATIONS_DIR)).toEqual(['003_operation_mismatch.sql']);
    expect(db.sql.prepare('SELECT id, status, idempotency_key FROM operations').all()).toEqual([
      { id: 'o1', status: 'accepted', idempotency_key: 'k1' },
    ]);
    expect(db.sql.prepare('SELECT id, operation_id FROM operation_attempts').all()).toEqual([
      { id: 't1', operation_id: 'o1' },
    ]);
    expect(db.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.sql.prepare("UPDATE operations SET status = 'mismatch' WHERE id = 'o1'").run();
    expect(() =>
      db.sql.prepare("UPDATE operations SET status = 'bogus' WHERE id = 'o1'").run(),
    ).toThrow();
    expect(() =>
      db.sql
        .prepare(
          "INSERT INTO operations VALUES ('o2','c1','p1','k1','accepted',1,NULL,NULL,NULL,'x','x')",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});
