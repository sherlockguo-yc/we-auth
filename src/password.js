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
 *
 * **必须是一个格式合法、cost 相同的真实哈希。** 手搓一个形似 bcrypt 的假字符串
 * 看似无害，实际 bcrypt 解析失败会立刻返回 false —— 耗时接近 0，于是
 * 「用户不存在」比「密码错误」快上百倍，反而把这个函数本该修补的漏洞做得更明显。
 *
 * 这个坑最初来自「沿用 WeMusic 已验证的写法」，而那段写法本身就是无效的
 * （同一个假字符串）。2026-10-14 被耗时断言抓到并修正。
 */
const DUMMY_HASH = bcrypt.hashSync('we-auth-dummy-password-for-timing', BCRYPT_COST);

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
