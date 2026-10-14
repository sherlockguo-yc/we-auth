'use strict';

/** 账号状态。语义由各服务自行解释，we-auth 只保证一致性。 */
const STATUS = {
  /** 已注册但未获准使用（WeMonitor 的「待激活」） */
  PENDING: 'pending',
  /** 正常 */
  ACTIVE: 'active',
  /** 明确封禁，拒绝登录 */
  BANNED: 'banned',
};

const ROLES = ['user', 'admin'];

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/**
 * 注册时的校验。**登录时不做下限校验**——
 * 存量账号可能有短密码（WeMonitor 历史规则是 4 位），
 * 统一提高注册门槛不能把老用户挡在门外。
 */
function validateNewCredentials(username, password) {
  if (!username || !password) return '用户名和密码不能为空';
  if (!USERNAME_RE.test(String(username))) {
    return '用户名 2-32 位，只允许字母、数字、下划线、中文';
  }
  if (String(password).length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (String(password).length > PASSWORD_MAX) return '密码过长';
  return null;
}

/** 对外暴露的用户对象：**永不含 password_hash** */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    avatar: row.avatar || null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
    archivedAt: row.archived_at || null,
    archived: !!row.archived_at,
  };
}

function createUserStore(db) {
  const sel = {
    byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    all: db.prepare('SELECT * FROM users ORDER BY id'),
    insert: db.prepare(
      `INSERT INTO users (username, password_hash, role, status, created_at)
       VALUES (@username, @passwordHash, @role, @status, @createdAt)`,
    ),
    setStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    archive: db.prepare('UPDATE users SET archived_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM users WHERE id = ?'),
  };

  return {
    findByUsername: (username) => sel.byUsername.get(String(username)) || null,
    findById: (id) => sel.byId.get(id) || null,
    count: () => sel.count.get().n,

    /** @param {{includeArchived?: boolean}} opts */
    list(opts = {}) {
      const rows = sel.all.all();
      return (opts.includeArchived ? rows : rows.filter((r) => !r.archived_at)).map(toPublic);
    },

    create({ username, passwordHash, role = 'user', status = STATUS.PENDING, createdAt = Date.now() }) {
      const info = sel.insert.run({ username, passwordHash, role, status, createdAt });
      return toPublic(sel.byId.get(info.lastInsertRowid));
    },

    setStatus(id, status) {
      if (!Object.values(STATUS).includes(status)) throw new Error(`未知状态：${status}`);
      sel.setStatus.run(status, id);
      return toPublic(sel.byId.get(id));
    },

    setRole(id, role) {
      if (!ROLES.includes(role)) throw new Error(`未知角色：${role}`);
      sel.setRole.run(role, id);
      return toPublic(sel.byId.get(id));
    },

    setAvatar(id, avatar) {
      sel.setAvatar.run(avatar, id);
      return toPublic(sel.byId.get(id));
    },

    setPasswordHash(id, hash) {
      sel.setPassword.run(hash, id);
      return toPublic(sel.byId.get(id));
    },

    touchLogin(id, at = Date.now()) {
      sel.touchLogin.run(at, id);
    },

    setArchived(id, archived = true) {
      sel.archive.run(archived ? Date.now() : null, id);
      return toPublic(sel.byId.get(id));
    },

    remove(id) {
      return sel.remove.run(id).changes > 0;
    },
  };
}

module.exports = {
  STATUS,
  ROLES,
  USERNAME_RE,
  PASSWORD_MIN,
  PASSWORD_MAX,
  validateNewCredentials,
  toPublic,
  createUserStore,
};
