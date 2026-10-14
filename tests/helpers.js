'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 每个测试用独立的临时库，互不干扰（用户库是全局唯一文件，测试必须隔离） */
function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-auth-test-'));
  return path.join(dir, 'auth.sqlite');
}

function cleanup(dbPath) {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

module.exports = { tmpDbPath, cleanup };
