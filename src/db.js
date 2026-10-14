'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrate } = require('./schema');

/**
 * 共享用户库的默认位置。
 *
 * **刻意放在所有服务目录之外**（不是 WeMusic/data，也不是 WeMonitor/data）：
 * 一旦放进某个服务的目录，就又会变成「谁的文件谁做主」——
 * 而那正是这次重构要消灭的模式。
 *
 * 可用环境变量 WEAUTH_DB 覆盖（测试与临时库用）。
 */
const DEFAULT_DB_PATH = path.join(
  process.env.WEAUTH_HOME || path.join(os.homedir(), 'shared'),
  'data',
  'auth.sqlite',
);

/**
 * 打开（必要时创建）用户库。
 *
 * better-sqlite3 声明为 peerDependency 而非 dependency：
 * 它对 Node ABI 敏感，必须由宿主项目提供一份已编译好的副本，
 * 避免一个进程里出现两份不同 ABI 的原生模块。
 */
function openDb(dbPath = process.env.WEAUTH_DB || DEFAULT_DB_PATH) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    throw new Error(
      `we-auth 需要宿主项目安装 better-sqlite3（peerDependency）：${err.message}`,
    );
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // 三个服务进程共用同一个库文件，写锁必须等而不是立刻报 SQLITE_BUSY
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

module.exports = { openDb, DEFAULT_DB_PATH };
