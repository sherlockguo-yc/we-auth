import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import password from '../src/password.js';

const { hashPassword, verifyPassword, burnTime, BCRYPT_COST } = password;

describe('密码哈希', () => {
  it('新密码用 cost=12', () => {
    const hash = hashPassword('correct-horse-battery');
    // bcrypt 哈希格式 $2a$<cost>$...
    expect(hash.split('$')[2]).toBe(String(BCRYPT_COST));
  });

  it('正确密码通过、错误密码不通过', () => {
    const hash = hashPassword('secret-1234');
    expect(verifyPassword('secret-1234', hash)).toBe(true);
    expect(verifyPassword('secret-1235', hash)).toBe(false);
  });

  it('兼容存量 cost=10 的哈希（WeMonitor 历史规则）', () => {
    const legacy = bcrypt.hashSync('legacy-pass-1', 10);
    expect(legacy.split('$')[2]).toBe('10');
    expect(verifyPassword('legacy-pass-1', legacy)).toBe(true);
    expect(verifyPassword('wrong', legacy)).toBe(false);
  });

  it('兼容存量 cost=12 的哈希（WeMusic 现有规则）', () => {
    const legacy = bcrypt.hashSync('music-pass-1', 12);
    expect(verifyPassword('music-pass-1', legacy)).toBe(true);
  });

  it('损坏的哈希不抛异常，返回 false', () => {
    expect(verifyPassword('x', 'not-a-bcrypt-hash')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });

  it('burnTime 恒返回 false（用户不存在时消耗等量时间）', () => {
    expect(burnTime('anything')).toBe(false);
  });

  it('burnTime 的耗时与真实校验同量级（差异 < 30%）', () => {
    // 这条断言是用来抓「陪跑哈希写成无效字符串、bcrypt 直接返回」这类回归的
    const hash = hashPassword('benchmark-password');

    const t0 = Date.now();
    verifyPassword('benchmark-password', hash);
    const real = Date.now() - t0 || 1;

    const t1 = Date.now();
    burnTime('benchmark-password');
    const burn = Date.now() - t1 || 1;

    expect(Math.abs(burn - real) / real).toBeLessThan(0.3);
  });
});
