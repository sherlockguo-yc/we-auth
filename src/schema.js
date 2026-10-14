'use strict';

/**
 * 用户库 schema 与迁移。
 *
 * 长期约定：**只允许追加迁移，不允许修改已发布的迁移**。
 * 每个迁移有唯一的、递增的 version；已升级过的库不会再执行旧迁移。
 * 破坏性变更（删列、改语义）必须走新的迁移 + 在 README 记录。
 */

const LATEST_VERSION = 1;

const MIGRATIONS = [
  {
    version: 1,
    description: '初始 users 表（WeMusic ∪ WeMonitor 的字段并集）',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT    NOT NULL UNIQUE,
          password_hash TEXT    NOT NULL,
          role          TEXT    NOT NULL DEFAULT 'user',
          status        TEXT    NOT NULL DEFAULT 'pending',
          avatar        TEXT,
          created_at    INTEGER NOT NULL,
          last_login_at INTEGER,
          archived_at   INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      `);
    },
  },
];

function ensureMeta(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

function currentVersion(db) {
  ensureMeta(db);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) : 0;
}

/**
 * 幂等地把库升级到最新 schema。
 * @returns {{ version: number, applied: number[] }}
 */
function migrate(db) {
  let version = currentVersion(db);
  const applied = [];

  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;

    db.transaction(() => {
      m.up(db);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(m.version));
    })();

    applied.push(m.version);
    version = m.version;
  }

  return { version, applied };
}

module.exports = { LATEST_VERSION, MIGRATIONS, migrate, currentVersion };
