import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import weauth from '../src/index.js';
import helpers from './helpers.js';

const { createAuth } = weauth;
const { tmpDbPath, cleanup } = helpers;
const SECRET = 'unit-test-secret';

let dbPath;
let auth;

beforeEach(() => {
  dbPath = tmpDbPath();
  auth = createAuth({ jwtSecret: SECRET, dbPath });
});

afterEach(() => {
  try {
    auth.close();
  } catch {
    /* 已在用例内关闭 */
  }
  cleanup(dbPath);
});

describe('注册与登录', () => {
  it('注册后可登录，token 可验签且带正确身份', () => {
    const reg = auth.register({
      username: 'sherlockguo',
      password: 'pass-word-1',
      role: 'admin',
      status: 'active',
    });
    expect(reg.ok).toBe(true);

    const res = auth.login('sherlockguo', 'pass-word-1');
    expect(res.ok).toBe(true);
    expect(res.user).toMatchObject({ username: 'sherlockguo', role: 'admin', status: 'active' });
    expect(auth.verify(res.token)).toMatchObject({ username: 'sherlockguo', role: 'admin' });
  });

  it('注册默认 status=pending，但 pending 用户仍能登录（放行范围由各服务决定）', () => {
    auth.register({ username: 'newbie', password: 'pass-word-1' });
    const res = auth.login('newbie', 'pass-word-1');
    expect(res.ok).toBe(true);
    expect(res.user.status).toBe('pending');
  });

  it('密码错误 / 用户不存在 返回同一种错误（防枚举）', () => {
    auth.register({ username: 'someone', password: 'pass-word-1', status: 'active' });
    const wrongPass = auth.login('someone', 'wrong-pass');
    const noUser = auth.login('nobody', 'whatever-1');
    expect(wrongPass.ok).toBe(false);
    expect(noUser.ok).toBe(false);
    expect(wrongPass.error).toBe(noUser.error);
    expect(wrongPass.code).toBe('invalid');
  });

  it('空用户名或空密码直接拒绝', () => {
    expect(auth.login('', 'x')).toMatchObject({ ok: false, code: 'invalid' });
    expect(auth.login('a', '')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('封禁账号拒绝登录且给出专属 code', () => {
    auth.register({ username: 'badguy', password: 'pass-word-1', status: 'active' });
    const u = auth.listUsers()[0];
    auth.setStatus(u.id, 'banned');
    expect(auth.login('badguy', 'pass-word-1')).toMatchObject({ ok: false, code: 'banned' });

    auth.setStatus(u.id, 'active');
    expect(auth.login('badguy', 'pass-word-1').ok).toBe(true);
  });

  it('归档账号拒绝登录且给出专属 code', () => {
    auth.register({ username: 'olduser', password: 'pass-word-1', status: 'active' });
    const u = auth.listUsers()[0];
    auth.setArchived(u.id, true);
    expect(auth.login('olduser', 'pass-word-1')).toMatchObject({ ok: false, code: 'archived' });

    auth.setArchived(u.id, false);
    expect(auth.login('olduser', 'pass-word-1').ok).toBe(true);
  });
});

describe('注册校验', () => {
  it('重复用户名被拒绝', () => {
    auth.register({ username: 'dup', password: 'pass-word-1' });
    expect(auth.register({ username: 'dup', password: 'pass-word-1' })).toMatchObject({
      ok: false,
      code: 'exists',
    });
  });

  it('短密码与非法用户名被拒绝', () => {
    expect(auth.register({ username: 'okname', password: '123' })).toMatchObject({ ok: false });
    expect(auth.register({ username: 'a', password: 'pass-word-1' })).toMatchObject({ ok: false });
    expect(auth.register({ username: 'has space', password: 'pass-word-1' })).toMatchObject({
      ok: false,
    });
  });

  it('中文用户名可用', () => {
    expect(auth.register({ username: '郭某', password: 'pass-word-1' }).ok).toBe(true);
  });
});

describe('用户管理', () => {
  it('listUsers 不含 password_hash，且默认不含已归档账号', () => {
    auth.register({ username: 'u1', password: 'pass-word-1', status: 'active' });
    auth.register({ username: 'u2', password: 'pass-word-1', status: 'active' });
    const u2 = auth.listUsers().find((u) => u.username === 'u2');
    auth.setArchived(u2.id, true);

    const visible = auth.listUsers();
    expect(visible.map((u) => u.username)).toEqual(['u1']);
    expect(visible[0]).not.toHaveProperty('password_hash');

    const all = auth.listUsers({ includeArchived: true });
    expect(all.map((u) => u.username).sort()).toEqual(['u1', 'u2']);
  });

  it('改密码后旧密码失效、新密码生效', () => {
    auth.register({ username: 'pwd', password: 'old-pass-11', status: 'active' });
    const u = auth.listUsers()[0];

    expect(auth.setPassword(u.id, '123').ok).toBe(false); // 太短
    expect(auth.setPassword(u.id, 'new-pass-22').ok).toBe(true);

    expect(auth.login('pwd', 'old-pass-11').ok).toBe(false);
    expect(auth.login('pwd', 'new-pass-22').ok).toBe(true);
  });

  it('数据持久化：关掉再打开同一个库仍在', () => {
    auth.register({ username: 'persist', password: 'pass-word-1', status: 'active' });
    auth.close();

    auth = createAuth({ jwtSecret: SECRET, dbPath });
    expect(auth.login('persist', 'pass-word-1').ok).toBe(true);
  });
});

describe('存量账号兼容（迁移的核心前提）', () => {
  it('cost=10 的旧哈希可直接登录，无需重置密码', () => {
    const legacyHash = bcrypt.hashSync('legacy-pass-1', 10);
    // 直接写库，模拟从 WeMonitor 迁移过来的老用户
    auth.close();
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO users (username, password_hash, role, status, created_at)
         VALUES (?, ?, 'user', 'active', ?)`,
      )
      .run('legacy', legacyHash, Date.now());
    raw.close();

    auth = createAuth({ jwtSecret: SECRET, dbPath });
    expect(auth.login('legacy', 'legacy-pass-1').ok).toBe(true);
    expect(auth.login('legacy', 'wrong').ok).toBe(false);
  });
});

describe('token 边界', () => {
  it('token 不能跨 secret 使用', () => {
    auth.register({ username: 'cross', password: 'pass-word-1', status: 'active' });
    const t = auth.login('cross', 'pass-word-1').token;

    const other = createAuth({ jwtSecret: 'a-different-secret', dbPath });
    expect(other.verify(t)).toBeNull();
    other.close();
  });

  it('createAuth 缺少 jwtSecret 直接报错', () => {
    expect(() => createAuth({ dbPath })).toThrow(/jwtSecret/);
  });

  it('verifyHeader 支持 Bearer 头', () => {
    auth.register({ username: 'hdr', password: 'pass-word-1', status: 'active' });
    const t = auth.login('hdr', 'pass-word-1').token;
    expect(auth.verifyHeader(`Bearer ${t}`)).toMatchObject({ username: 'hdr' });
    expect(auth.verifyHeader(t)).toBeNull();
  });
});
