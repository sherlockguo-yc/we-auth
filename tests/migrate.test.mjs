import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import migrate from '../scripts/migrate.js';

const { normalize, merge } = migrate;
const SCRIPT = fileURLToPath(new URL('../scripts/migrate.js', import.meta.url));

/* ───────────── 纯函数 ───────────── */

describe('normalize：两个库的 schema 不完全一致', () => {
  it('缺失的列按默认值补齐（WeMusic 旧 schema 没有 avatar）', () => {
    const cols = new Set(['username', 'password_hash', 'created_at']);
    const u = normalize({ username: 'a', password_hash: 'h', created_at: 100 }, cols, 'WeMusic');
    expect(u).toEqual({
      username: 'a',
      passwordHash: 'h',
      role: 'user',
      status: 'active', // status 缺失视为正常账号
      avatar: null,
      createdAt: 100,
      lastLoginAt: null,
      archivedAt: null,
      source: 'WeMusic',
    });
  });

  it('保留 WeMonitor 的 pending 状态（不能当成 active 放行）', () => {
    const cols = new Set(['username', 'password_hash', 'status', 'role', 'created_at']);
    const u = normalize(
      { username: 'b', password_hash: 'h', status: 'pending', role: 'user', created_at: 1 },
      cols,
      'WeMonitor',
    );
    expect(u.status).toBe('pending');
  });

  it('缺 username 或 password_hash 的行被丢弃', () => {
    const cols = new Set(['username', 'password_hash']);
    expect(normalize({ username: 'x' }, cols, 'WeMusic')).toBeNull();
    expect(normalize({ password_hash: 'h' }, cols, 'WeMusic')).toBeNull();
  });
});

describe('merge：同名冲突', () => {
  const W = [{ username: 'x', passwordHash: 'HASH-W', source: 'WeMusic', avatar: null, lastLoginAt: null, archivedAt: null }];
  const M = [{ username: 'x', passwordHash: 'HASH-M', source: 'WeMonitor', avatar: null, lastLoginAt: null, archivedAt: null }];

  it('默认以 WeMusic 为准，并记录冲突', () => {
    const r = merge(W, M, 'wemusic');
    expect(r.users).toHaveLength(1);
    expect(r.users[0].passwordHash).toBe('HASH-W');
    expect(r.conflicts).toEqual([{ username: 'x', keep: 'WeMusic', drop: 'WeMonitor' }]);
  });

  it('--prefer wemonitor 时以 WeMonitor 为准', () => {
    const r = merge(W, M, 'wemonitor');
    expect(r.users[0].passwordHash).toBe('HASH-M');
  });

  it('不冲突的用户全部保留', () => {
    const r = merge(
      [...W, { username: 'only-w', passwordHash: 'HW', source: 'WeMusic', avatar: null, lastLoginAt: null, archivedAt: null }],
      [...M, { username: 'only-m', passwordHash: 'HM', source: 'WeMonitor', avatar: null, lastLoginAt: null, archivedAt: null }],
      'wemusic',
    );
    expect(r.users.map((u) => u.username).sort()).toEqual(['only-m', 'only-w', 'x']);
    expect(r.conflicts).toHaveLength(1);
  });
});

/* ───────────── 端到端 CLI ───────────── */

describe('migrate.js 端到端（真实读写 sqlite）', () => {
  let dir;
  let srcW;
  let srcM;
  let out;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-auth-migrate-'));
    srcW = path.join(dir, 'wemusic.sqlite');
    srcM = path.join(dir, 'wemonitor.db');
    out = path.join(dir, 'out', 'auth.sqlite');

    // WeMusic 风格：有 avatar / last_login_at / archived_at，users 表没有 role 的默认值差异
    const w = new Database(srcW);
    w.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, avatar TEXT, role TEXT DEFAULT 'user',
      status TEXT, created_at INTEGER, last_login_at INTEGER, archived_at INTEGER)`);
    w.prepare(`INSERT INTO users (username,password_hash,role,status,created_at) VALUES (?,?,?,?,?)`)
      .run('sherlockguo', 'HASH-MUSIC-SHERLOCK', 'admin', 'active', 1000);
    w.prepare(`INSERT INTO users (username,password_hash,role,status,created_at) VALUES (?,?,?,?,?)`)
      .run('musiconly', 'HASH-MUSIC-ONLY', 'user', 'active', 2000);
    w.close();

    // WeMonitor 风格：没有 avatar 列，status 用了 pending
    const m = new Database(srcM);
    m.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'pending', created_at INTEGER)`);
    m.prepare(`INSERT INTO users (username,password_hash,role,status,created_at) VALUES (?,?,?,?,?)`)
      .run('sherlockguo', 'HASH-MONITOR-SHERLOCK', 'admin', 'active', 900);
    m.prepare(`INSERT INTO users (username,password_hash,role,status,created_at) VALUES (?,?,?,?,?)`)
      .run('waiting', 'HASH-MONITOR-PENDING', 'user', 'pending', 1500);
    m.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runCli(extra = []) {
    return execFileSync(
      process.execPath,
      [SCRIPT, '--wemusic', srcW, '--wemonitor', srcM, '--out', out, ...extra],
      { encoding: 'utf8' },
    );
  }

  it('默认 dry-run：打印清单但不写任何文件', () => {
    const stdout = runCli();
    expect(stdout).toContain('WeMusic 2 个用户');
    expect(stdout).toContain('WeMonitor 2 个用户');
    expect(stdout).toContain('同名冲突');
    expect(stdout).toContain('[dry-run]');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('--apply 写入共享库，冲突时保留 WeMusic 的密码，pending 状态被保留', () => {
    runCli(['--apply']);

    const db = new Database(out, { readonly: true });
    const rows = db.prepare('SELECT username, password_hash, status, role FROM users ORDER BY username').all();
    db.close();

    expect(rows.map((r) => r.username)).toEqual(['musiconly', 'sherlockguo', 'waiting']);

    const sherlock = rows.find((r) => r.username === 'sherlockguo');
    expect(sherlock.password_hash).toBe('HASH-MUSIC-SHERLOCK'); // 默认 prefer=wemusic
    expect(sherlock.role).toBe('admin');

    expect(rows.find((r) => r.username === 'waiting').status).toBe('pending');
  });

  it('幂等：重复 apply 不新增也不重复覆盖', () => {
    const stdout = runCli(['--apply']);
    expect(stdout).toContain('跳过 3');

    const db = new Database(out, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    db.close();
    expect(n).toBe(3);
  });

  it('--prefer wemonitor 时冲突以 WeMonitor 为准', () => {
    runCli(['--apply', '--prefer', 'wemonitor', '--overwrite']);
    const db = new Database(out, { readonly: true });
    const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('sherlockguo');
    db.close();
    expect(row.password_hash).toBe('HASH-MONITOR-SHERLOCK');
  });

  it('来源库不存在时只警告、不中断', () => {
    // 该警告走 stderr，这里只断言主流程不中断（不抛异常、正常出统计）
    const stdout = runCli(['--wemusic', path.join(dir, 'nope.sqlite')]);
    expect(stdout).toContain('WeMusic 0 个用户');
    expect(stdout).toContain('WeMonitor 2 个用户');
  });
});
