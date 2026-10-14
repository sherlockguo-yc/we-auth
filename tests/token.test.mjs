import { describe, it, expect } from 'vitest';
import token from '../src/token.js';

const { sign, verify, fromAuthHeader } = token;
const SECRET = 'test-secret-abc';

describe('JWT 签发与验签', () => {
  it('同一 secret 可验签，payload 保真', () => {
    const t = sign({ id: 7, username: 'sherlockguo', role: 'admin' }, SECRET);
    expect(verify(t, SECRET)).toMatchObject({ id: 7, username: 'sherlockguo', role: 'admin' });
  });

  it('不同 secret 验签失败并返回 null（不抛异常）', () => {
    const t = sign({ id: 1 }, SECRET);
    expect(verify(t, 'another-secret')).toBeNull();
  });

  it('篡改过的 token 返回 null', () => {
    const t = sign({ id: 1 }, SECRET);
    expect(verify(`${t}x`, SECRET)).toBeNull();
  });

  it('过期 token 返回 null', () => {
    const t = sign({ id: 1 }, SECRET, '-1s');
    expect(verify(t, SECRET)).toBeNull();
  });

  it('缺 token / 缺 secret 均返回 null', () => {
    expect(verify(null, SECRET)).toBeNull();
    expect(verify('abc', '')).toBeNull();
  });

  it('没有 secret 时签发直接报错（配置被静默忽略比报错更危险）', () => {
    expect(() => sign({ id: 1 }, '')).toThrow(/jwtSecret/);
  });

  it('能从 Authorization: Bearer 头里取值', () => {
    expect(fromAuthHeader('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(fromAuthHeader('abc.def.ghi')).toBeNull();
    expect(fromAuthHeader(undefined)).toBeNull();
  });
});
