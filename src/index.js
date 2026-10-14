'use strict';

/**
 * we-auth —— We 系列项目共享身份库。
 *
 * 【这是什么】
 *   一个被 `require` 进来的库。**没有进程、没有端口、不发网络请求。**
 *
 * 【为什么这样设计】
 *   三个服务各自把本库加载进自己的进程，各自读同一个本地 sqlite 文件。
 *   因此：
 *     · WeMusic 挂了/重启/部署，不影响另外两家的登录；
 *     · 不存在「auth 服务不可用导致全站不可登录」的问题，因为不存在 auth 服务。
 *   共享的是两样东西：登录代码（本库）与用户数据（一个 sqlite 文件）。
 *
 * 【长期约束（改动前必读）】
 *   1. 三个服务**永不直接打开**用户库文件，只通过本库的 API 访问。
 *      将来若要把「本地文件」换成「中心服务 / 多机复制」，只改本库内部，
 *      三个服务一行不动。这是本库存在的全部理由。
 *   2. 不导出底层 db 句柄——一旦导出，第 1 条就会被绕过。
 *   3. 只允许追加迁移（见 schema.js），不改已发布的迁移。
 *   4. 对外返回的用户对象永不含 password_hash。
 */

const { openDb, DEFAULT_DB_PATH } = require('./db');
const { hashPassword, verifyPassword, burnTime } = require('./password');
const { sign, verify, fromAuthHeader, DEFAULT_TTL } = require('./token');
const {
  STATUS,
  ROLES,
  USERNAME_RE,
  PASSWORD_MIN,
  PASSWORD_MAX,
  validateNewCredentials,
  createUserStore,
  toPublic,
} = require('./users');

const MAX_FIELD_LEN = { username: 64, password: 256 };

/**
 * @param {object} opts
 * @param {string} opts.jwtSecret  必填。三个服务须共用同一个值
 * @param {string} [opts.dbPath]   默认 ~/shared/data/auth.sqlite
 * @param {string} [opts.tokenTtl] 默认 '7d'
 */
function createAuth({ jwtSecret, dbPath = DEFAULT_DB_PATH, tokenTtl = DEFAULT_TTL } = {}) {
  if (!jwtSecret) throw new Error('we-auth: createAuth 需要 jwtSecret');

  const db = openDb(dbPath);
  const store = createUserStore(db);

  function issueToken(row) {
    return sign({ id: row.id, username: row.username, role: row.role, status: row.status }, jwtSecret, tokenTtl);
  }

  return {
    STATUS,
    ROLES,
    dbPath,

    /**
     * 登录。
     * 返回 { ok: true, token, user } 或 { ok: false, error, code }。
     * code: invalid | archived | banned —— 供各服务自行决定如何呈现。
     *
     * 注意：status === 'pending' **允许登录成功**（WeMonitor 的待激活用户需要能登录后跳转
     * 到待激活页），由各服务根据 user.status 决定放行范围。
     */
    login(username, password) {
      if (!username || !password) {
        return { ok: false, error: '用户名和密码不能为空', code: 'invalid' };
      }
      // 超长输入直接拒绝，避免拖慢查询
      if (
        String(username).length > MAX_FIELD_LEN.username ||
        String(password).length > MAX_FIELD_LEN.password
      ) {
        return { ok: false, error: '用户名或密码错误', code: 'invalid' };
      }

      const row = store.findByUsername(username);
      // 用户不存在时也要消耗与真实校验相当的时间，防用户名枚举
      const valid = row ? verifyPassword(password, row.password_hash) : burnTime(password);
      if (!valid) {
        return { ok: false, error: '用户名或密码错误', code: 'invalid' };
      }

      if (row.archived_at) return { ok: false, error: '该账号已被归档，无法登录', code: 'archived' };
      if (row.status === STATUS.BANNED) return { ok: false, error: '该账号已被封禁，无法登录', code: 'banned' };

      store.touchLogin(row.id);
      const user = { id: row.id, username: row.username, role: row.role, status: row.status };
      return { ok: true, token: issueToken(row), user };
    },

    /** 注册。status 默认 pending，由管理员或各服务自行激活 */
    register({ username, password, role = 'user', status = STATUS.PENDING } = {}) {
      const invalid = validateNewCredentials(username, password);
      if (invalid) return { ok: false, error: invalid, code: 'invalid' };
      if (store.findByUsername(username)) {
        return { ok: false, error: '用户名已存在', code: 'exists' };
      }
      if (!ROLES.includes(role)) return { ok: false, error: `未知角色：${role}`, code: 'invalid' };
      if (!Object.values(STATUS).includes(status)) {
        return { ok: false, error: `未知状态：${status}`, code: 'invalid' };
      }

      const user = store.create({ username, passwordHash: hashPassword(password), role, status });
      return { ok: true, user };
    },

    /** 验签。失败返回 null（不抛异常） */
    verify: (token) => verify(token, jwtSecret),
    verifyHeader: (header) => verify(fromAuthHeader(header), jwtSecret),
    sign: (payload) => sign(payload, jwtSecret, tokenTtl),

    /** 用户管理 */
    listUsers: (opts) => store.list(opts),
    getUser: (id) => toPublic(store.findById(id)),
    countUsers: () => store.count(),
    setStatus: (id, status) => store.setStatus(id, status),
    setRole: (id, role) => store.setRole(id, role),
    setArchived: (id, archived = true) => store.setArchived(id, archived),
    /** 改密码：只做长度校验，不做复杂度要求 */
    setPassword(id, newPassword) {
      if (!newPassword || String(newPassword).length < PASSWORD_MIN) {
        return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` };
      }
      if (String(newPassword).length > PASSWORD_MAX) return { ok: false, error: '密码过长' };
      store.setPasswordHash(id, hashPassword(newPassword));
      return { ok: true };
    },

    close: () => db.close(),
  };
}

module.exports = {
  createAuth,
  DEFAULT_DB_PATH,
  STATUS,
  ROLES,
  USERNAME_RE,
  PASSWORD_MIN,
  PASSWORD_MAX,
};
