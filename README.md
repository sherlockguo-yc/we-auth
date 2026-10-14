# we-auth

We 系列项目的共享身份库：**用户库唯一权威 + bcrypt 密码校验 + JWT 签发验签**。

---

## 它是什么，不是什么

| | |
|---|---|
| ✅ **是一个库** | 被 `require('we-auth')` 加载进各服务自己的进程 |
| ❌ **不是一个服务** | 没有常驻进程、没有端口、不发网络请求、没有 systemd 单元 |

**直接后果：它不会「挂」，也不会引发连锁故障。**

- WeMusic 重启 / 部署 / 崩溃 → 不影响 WeAuto 与 WeMonitor 的登录
- 不存在「auth 服务不可用导致所有站点无法登录」——因为不存在 auth 服务
- 三个服务之间**没有任何运行时依赖**：各自读同一个**本地** sqlite 文件

共享的只有两样东西：**登录代码**（本库）与**用户账号数据**（一个 sqlite 文件）。

---

## 为什么共享文件而不是「中心 auth 服务」

集中式的只有**数据**，不是**请求路径**。登录时各服务直接读本地文件，不回调任何中心节点。

| 方案 | 单点故障 | 跨机部署 |
|---|---|---|
| 中心 auth 服务 | 服务挂 → 新登录全部失败，暴露面 +1 | 天然支持 |
| **共享本地库（本方案）** | 只有「用户数据文件」受损才影响全部，且**已登录用户在 token 有效期内不受影响**（验签只需密钥，不读用户库） | ❌ 三服务必须同机 |

第三个服务若将来迁到别的机器，**只需替换本库内部的存储实现**（文件 → 远程），三个业务服务一行不用改。这是本库存在的全部理由。

---

## 安装

三个项目的消费方式（公开仓库，CI 不需要 token）：

```bash
npm install git+https://github.com/sherlockguo-yc/we-auth.git#v0.1.0
```

注意 `better-sqlite3` 是 **peerDependency**，宿主项目自己安装。原因：它是原生模块，对 Node ABI 敏感，一个进程里出现两份不同 ABI 的副本会直接崩。宿主项目本来就有它。

## 用法

```js
// CommonJS（WeMonitor）
const { createAuth, STATUS } = require('we-auth');

// ESM（WeMusic / WeAuto）
import auth from 'we-auth';           // 默认导出整个模块对象
const { createAuth, STATUS } = auth;

const auth = createAuth({
  jwtSecret: process.env.JWT_SECRET,  // 必填，三个服务须共用同一个值
  // dbPath: '~/shared/data/auth.sqlite',  // 默认值
  tokenTtl: '7d',
});

const res = auth.login(username, password);
// 成功 → { ok: true, token, user }
// 失败 → { ok: false, error, code }   code: invalid | archived | banned

auth.verify(token);        // → payload | null（失败不抛异常）
auth.verifyHeader(req.headers.authorization);

auth.register({ username, password, role: 'user', status: STATUS.PENDING });
auth.listUsers();          // 永不含 password_hash
auth.setStatus(id, STATUS.ACTIVE);
auth.setRole(id, 'admin');
auth.setArchived(id, true);
auth.setPassword(id, 'new-password');
auth.close();
```

**登录语义**（两个项目规则的并集）：

| 状态 | 能否登录 |
|---|---|
| `pending` | ✅ 能登录，是否放行由各服务决定（WeMonitor 会跳转到待激活页） |
| `active` | ✅ |
| `banned` | ❌ `code: banned` |
| `archived_at` 非空 | ❌ `code: archived` |

注册门槛：用户名 2–32 位（字母/数字/下划线/中文），密码 ≥ 8 位。
**登录不做密码下限校验**——存量账号可能是 4–7 位（WeMonitor 历史规则），提高注册门槛不能把老用户挡在门外。

---

## 从既有项目迁移用户

**先 dry-run**，看清将要写入什么，再 `--apply`：

```bash
node scripts/migrate.js \
  --wemusic   ~/wemusic/data/wemusic.sqlite \
  --wemonitor ~/wemonitor/data/wemonitor.db \
  --out       ~/shared/data/auth.sqlite
```

输出会列出每个账号的 `role / status / 来源 / 密码哈希前缀`，并**显式打印同名冲突**（同一个用户名在两个库里都存在的情况，默认以 WeMusic 的密码为准，可用 `--prefer wemonitor` 切换）。

确认无误后追加 `--apply`：

```bash
node scripts/migrate.js ... --apply
```

- **保留原 bcrypt 哈希，不重置任何人的密码**：bcrypt 哈希自带 cost，`cost=10` 的老账号照样能登录
- **幂等**：重复执行会跳过已存在的用户名（`--overwrite` 可强制覆盖）

---

## 长期约束（改代码前必读）

1. **三个服务永不直接打开用户库文件**，只通过本库的 API 访问。
   将来把「本地文件」换成「中心服务 / 多机复制」时，只改本库内部。
2. **不导出底层 db 句柄** —— 一旦导出，第 1 条就会被绕过。
3. **只允许追加迁移**，不改已发布的迁移（`src/schema.js`）。
4. **对外返回的用户对象永不含 `password_hash`**。
5. **`JWT_SECRET` 变更 = 三个站点全体登出**（token 验签失败）。轮换密钥要挑时间。

---

## 故障域与恢复

| 故障 | 影响 | 恢复 |
|---|---|---|
| 某个业务服务挂了 | 只影响它自己 | 各自重启 |
| 用户库文件被误删/损坏 | 三个站点**重新登录**时全部失败；已登录用户在 token 有效期内仍可用 | 从备份恢复 `~/shared/data/auth.sqlite` |
| `~/shared/data` 所在磁盘损坏 | 全部账号丢失 | **依赖备份** —— 该目录不在任何服务的目录下，必须单独纳入备份范围，否则不会被任何现有备份策略覆盖 |
| 本库代码有 bug | 升级它的服务受影响 | 回滚到上一个 tag（三个项目各自锁版本） |

## 版本与升级

- 语义化版本；`schema` 变更走新增迁移；破坏性 API 变更走 major
- 三个项目 **tag 锁定**引入（`#v0.1.0`），不会因为本仓库改动而被动升级
- 升级顺序：先升级一个服务验证，再升级其余

## 测试

```bash
npm install
npm test
```

## 已知坑（2026-10-14 实测）

**1. Node 24 必须用 better-sqlite3 v12，v11 会原生崩溃**

在 Node v24.19.0 上，better-sqlite3 v11 会在 GC 触发 `Statement` 析构时断言失败并杀掉进程：

```
Assertion failed: (env) != nullptr
  node::RemoveEnvironmentCleanupHook(...)
  Statement::~Statement()  [better_sqlite3.node]
```

v12（实测 12.11.1）正常。因此本仓库 `devDependencies` 用 `^12`，peer 范围放宽为 `^11 || ^12`（Node 20 上的既有项目不必升级）。
**部署 WeAuto 时同样要确认运行机器的 Node 版本与 better-sqlite3 版本匹配。**

**2. npm 11 默认拦截 install script**

`better-sqlite3` 的原生模块靠安装脚本构建，npm 11 默认不执行，表现为「装上了但 `require` 报找不到绑定」。
本仓库已在 `package.json` 里用 `allowScripts` 放行。其他项目遇到同样现象时执行：

```bash
npm approve-scripts better-sqlite3
npm rebuild better-sqlite3
```

**3. vitest 4 不支持在 CJS 里 `require('vitest')`**

测试文件必须是 ESM。本仓库测试文件用 `.mjs` 后缀（源码核心仍是 CJS）。
