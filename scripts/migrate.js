#!/usr/bin/env node
'use strict';

/**
 * 把 WeMusic 与 WeMonitor 各自的 users 表合并进共享用户库。
 *
 * 设计要点：
 *   · **默认 dry-run**，必须显式 --apply 才写库（迁移是不可逆动作，先看清单）。
 *   · **保留原 bcrypt 哈希**，不重置任何人的密码
 *     （bcrypt 哈希自带 cost，cost=10 的老账号照样能登录）。
 *   · **幂等**：重复执行时已存在的用户名会被跳过（--overwrite 可强制覆盖）。
 *   · 同名冲突默认以 WeMusic 为准（--prefer wemonitor 可切换），并且**一定会打印冲突清单**。
 *
 * 用法：
 *   node scripts/migrate.js --wemusic ~/wemusic/data/wemusic.sqlite \
 *                           --wemonitor ~/wemonitor/data/wemonitor.db \
 *                           --out ~/shared/data/auth.sqlite
 *   # 确认输出无误后加 --apply
 */

const fs = require('node:fs');
const { openDb } = require('../src/db');

function parseArgs(argv) {
  const args = { prefer: 'wemusic', apply: false, overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--prefer') args.prefer = argv[++i];
    else if (a === '--wemusic') args.wemusic = argv[++i];
    else if (a === '--wemonitor') args.wemonitor = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

const HELP = `
把 WeMusic / WeMonitor 的 users 合并进共享用户库（默认 dry-run）

  --wemusic   <path>   WeMusic 的 sqlite（通常 data/wemusic.sqlite）
  --wemonitor <path>   WeMonitor 的 sqlite（通常 data/wemonitor.db）
  --out       <path>   共享用户库路径（通常 ~/shared/data/auth.sqlite）
  --prefer    <who>    同名冲突时以谁为准：wemusic（默认）| wemonitor
  --apply              真正写入（不加则只打印将要做的变更）
  --overwrite          已存在的用户名也覆盖（默认跳过）
  -h, --help           显示本帮助
`;

function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

/** 读一个来源库的 users，缺失的列按 null 处理（两个库的 schema 不完全一致） */
function readUsers(file, label) {
  if (!file) return [];
  if (!fs.existsSync(file)) {
    console.warn(`[warn] ${label} 数据库不存在，跳过：${file}`);
    return [];
  }
  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true });
  try {
    const cols = columnsOf(db, 'users');
    if (!cols.has('username')) {
      console.warn(`[warn] ${label} 中找不到 users 表，跳过：${file}`);
      return [];
    }
    const rows = db.prepare('SELECT * FROM users').all();
    return rows.map((r) => normalize(r, cols, label)).filter(Boolean);
  } finally {
    db.close();
  }
}

function normalize(row, cols, source) {
  const get = (k) => (cols.has(k) ? row[k] : undefined);
  const username = get('username');
  const passwordHash = get('password_hash');
  if (!username || !passwordHash) return null;

  // status 归一：WeMusic 可能为 null（视为正常），WeMonitor 有 pending/active
  let status = get('status');
  if (!status) status = 'active';

  return {
    username: String(username),
    passwordHash: String(passwordHash),
    role: get('role') || 'user',
    status,
    avatar: get('avatar') || null,
    createdAt: get('created_at') || Date.now(),
    lastLoginAt: get('last_login_at') || null,
    archivedAt: get('archived_at') || null,
    source,
  };
}

function shortHash(h) {
  return `${String(h).slice(0, 10)}…`;
}

function merge(wemusic, wemonitor, prefer) {
  const map = new Map();
  const conflicts = [];

  const order = prefer === 'wemonitor' ? [wemonitor, wemusic] : [wemusic, wemonitor];
  for (const rows of order) {
    for (const u of rows) {
      const existing = map.get(u.username);
      if (!existing) {
        map.set(u.username, u);
        continue;
      }
      // 同名：以 prefer 指定的先到者为准，但把对方缺失的字段补上
      conflicts.push({ username: u.username, keep: existing.source, drop: u.source });
      for (const k of ['avatar', 'lastLoginAt', 'archivedAt']) {
        if (existing[k] == null && u[k] != null) existing[k] = u[k];
      }
    }
  }
  return { users: [...map.values()], conflicts };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (!args.out) {
    console.error('缺少 --out\n' + HELP);
    process.exit(2);
  }
  if (!['wemusic', 'wemonitor'].includes(args.prefer)) {
    console.error('--prefer 只能是 wemusic 或 wemonitor');
    process.exit(2);
  }

  const wemusic = readUsers(args.wemusic, 'WeMusic');
  const wemonitor = readUsers(args.wemonitor, 'WeMonitor');
  const { users, conflicts } = merge(wemusic, wemonitor, args.prefer);

  console.log(`\n来源统计：WeMusic ${wemusic.length} 个用户，WeMonitor ${wemonitor.length} 个用户`);
  console.log(`合并结果：${users.length} 个用户，冲突 ${conflicts.length} 个\n`);

  for (const u of users) {
    console.log(
      `  ${u.username.padEnd(20)} role=${u.role.padEnd(6)} status=${u.status.padEnd(8)} ` +
        `source=${u.source.padEnd(9)} hash=${shortHash(u.passwordHash)}`,
    );
  }

  if (conflicts.length) {
    console.log('\n⚠ 同名冲突（下列账号两处都存在，只保留一行）：');
    for (const c of conflicts) {
      console.log(`  ${c.username}：保留 ${c.keep} 的密码，丢弃 ${c.drop} 的密码`);
    }
    console.log('  如果保留的那个密码不是你想用的，请用 --prefer 切换后重跑。');
  }

  if (!args.apply) {
    console.log(`\n[dry-run] 未写入任何文件。确认无误后加 --apply 写入：${args.out}`);
    return;
  }

  const db = openDb(args.out);
  const find = db.prepare('SELECT id FROM users WHERE username = ?');
  const insert = db.prepare(
    `INSERT INTO users (username, password_hash, role, status, avatar, created_at, last_login_at, archived_at)
     VALUES (@username, @passwordHash, @role, @status, @avatar, @createdAt, @lastLoginAt, @archivedAt)`,
  );
  const update = db.prepare(
    `UPDATE users SET password_hash = @passwordHash, role = @role, status = @status,
     avatar = @avatar, last_login_at = @lastLoginAt, archived_at = @archivedAt
     WHERE username = @username`,
  );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const u of users) {
      const existing = find.get(u.username);
      if (existing && !args.overwrite) {
        skipped++;
        continue;
      }
      if (existing) {
        update.run(u);
        updated++;
      } else {
        insert.run(u);
        inserted++;
      }
    }
  })();

  console.log(`\n[apply] 写入完成 → ${args.out}`);
  console.log(`  新增 ${inserted}，覆盖 ${updated}，跳过 ${skipped}`);
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`  共享库现有用户总数：${total}`);
  db.close();
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`迁移失败：${err.message}`);
    process.exit(1);
  }
}

// 纯函数导出给测试用（merge / normalize 是迁移正确性的核心，必须可单测）
module.exports = { normalize, merge, readUsers, columnsOf, parseArgs, main, HELP };

