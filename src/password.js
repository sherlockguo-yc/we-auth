'use strict';

const bcrypt = require('bcryptjs');

/**
 * 新密码统一用 cost=12。
 *
 * 向后兼容：bcrypt 哈希字符串自带 salt 与 cost，
 * compare 时自动按哈希里记录的 cost 计算——
 * 所以存量用户（WeMusic cost=12 / WeMonitor cost=10）**无需重置密码即可登录**。
 * 这是整个迁移方案能「无感」成立的基础。
 */
const BCRYPT_COST = 12;

/**
 * 用户不存在时仍要跑一次 bcrypt，且耗时与真实校验相当。
 * 否则「用户不存在」会比「密码错误」返回得更快，可被用来枚举用户名。
 * 沿用 WeMusic 已验证的写法。
 */
const DUMMY_HASH = '$2a$12$invalidhashforlengthpadding000000000000000000000000000000';

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), BCRYPT_COST);
}

function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(String(plain), hash);
  } catch {
    return false;
  }
}

/** 恒返回 false，只为消耗与真实校验相当的时间 */
function burnTime(plain) {
  try {
    bcrypt.compareSync(String(plain), DUMMY_HASH);
  } catch {
    /* 忽略 */
  }
  return false;
}

module.exports = { BCRYPT_COST, hashPassword, verifyPassword, burnTime };
