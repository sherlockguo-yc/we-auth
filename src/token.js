'use strict';

const jwt = require('jsonwebtoken');

const DEFAULT_TTL = process.env.JWT_EXPIRES || '7d';

/**
 * 签发 token。
 *
 * 长期约定：三个服务共享同一个 JWT_SECRET 与同一份 payload 结构，
 * 但**各自本地验签**——不回调任何中心服务。
 * 这是「共享身份」与「单点故障」能同时避免的关键：
 * 中心化的只有数据（用户库），而不是请求路径。
 */
function sign(payload, secret, ttl = DEFAULT_TTL) {
  if (!secret) throw new Error('we-auth: 签发 token 需要 jwtSecret');
  return jwt.sign(payload, secret, { expiresIn: ttl });
}

/**
 * 验签。失败一律返回 null（不抛异常），调用方无需 try/catch。
 * 过期、签名不符、格式错误、secret 缺失都归为 null。
 */
function verify(token, secret) {
  if (!secret || !token) return null;
  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded || typeof decoded !== 'object') return null;
    return decoded;
  } catch {
    return null;
  }
}

/** 从 `Authorization: Bearer xxx` 里取 token */
function fromAuthHeader(header) {
  const raw = typeof header === 'string' ? header : '';
  return raw.startsWith('Bearer ') ? raw.slice(7) : null;
}

module.exports = { sign, verify, fromAuthHeader, DEFAULT_TTL };
