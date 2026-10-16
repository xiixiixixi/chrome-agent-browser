// service/credentials.mjs — 凭据仓：macOS 钥匙串读写（可注入执行器，供测试 mock）
//
// 存储模型：一组凭据 = 钥匙串里的一个 generic password 条目
//   service = "chrome-agent-browser"（固定服务名）
//   account = <origin>（如 https://github.com，含端口则带端口）
//   value   = JSON {"username","password","totp"?}
// CLI 入口在仓库根 credential.mjs（npm run credential）；service 端 ab_login 只读。
//
// 安全约定：
//   - 凭据明文只允许存在于钥匙串、service 进程内存（get 后即用即弃）、真实网页输入框。
//   - list() 只经 dump-keychain 读条目元数据（svce/acct），不触碰任何秘密值。
//   - 非 macOS 平台 supported=false，set/get 直接报"当前仅支持 macOS 钥匙串"（诚实限制）。
//
// 注入点：createCredentials({ exec, platform })。exec 为 async (cmd, args) =>
// {code, stdout, stderr}（默认用 node:child_process execFile 调 security，非交互实测通过）。

import { execFile } from 'node:child_process';
import process from 'node:process';

export const KEYCHAIN_SERVICE = 'chrome-agent-browser';

function defaultExec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * 解析 origin → 归一化键 {raw, key}；不合法返回 null。
 * key = `${protocol}//${去 www. 的 host}${port ? ':' + port : ''}`（小写）。
 * 这是防钓鱼第一锁的比对基准：只有 www. 前缀差异算同一站点，协议/端口差异不算。
 */
export function parseOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) return null;
  let u;
  try { u = new URL(origin.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const key = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  return { raw: origin.trim(), key };
}

/** 两个 origin 是否等价（仅容忍 www. 前缀差异；任一不合法返回 false）。 */
export function originsEquivalent(a, b) {
  const ka = parseOrigin(a);
  const kb = parseOrigin(b);
  return !!ka && !!kb && ka.key === kb.key;
}

/**
 * 是否同站（防钓鱼第二锁用）：主机名相等，或一个是另一个的子域（点边界）。
 * 只看主机名（去 www.）——登录后常见 https 升级/跳子域，不算"完全不同的域"。
 */
export function sameSite(urlA, urlB) {
  const host = (x) => {
    try { return new URL(x).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  };
  const a = host(urlA);
  const b = host(urlB);
  if (!a || !b) return true; // 解析不了（about:blank 等）→ 不定罪
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * 解析 `security dump-keychain` 文本 → 本服务已存的 origin 清单（去重、排序）。
 * 只读元数据（class=genp + svce=chrome-agent-browser 条目的 acct），零秘密值。
 * 兼容命名键（"svce"<blob>=）与十六进制键（0x00000007 <blob>=）两种输出格式。
 */
export function parseOrigins(dumpText) {
  const origins = new Set();
  for (const rec of String(dumpText ?? '').split(/^keychain:/m)) {
    if (!/class:\s*"genp"/.test(rec)) continue;
    const isOurs = new RegExp(`"svce"<blob>="${KEYCHAIN_SERVICE}"`).test(rec)
      || new RegExp(`0x00000007 <blob>="${KEYCHAIN_SERVICE}"`).test(rec);
    if (!isOurs) continue;
    const m = rec.match(/"acct"<blob>="([^"]*)"/) ?? rec.match(/0x00000008 <blob>="([^"]*)"/);
    if (m && m[1]) origins.add(m[1]);
  }
  return [...origins].sort();
}

function validateOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) throw new Error('origin 不能为空（如 https://github.com）');
  if (!parseOrigin(origin)) throw new Error(`origin 需为 http(s) 站点地址，收到: ${origin}`);
  return origin.trim();
}

/**
 * 创建凭据仓句柄。
 * @param {{exec?: Function, platform?: string}} [opts] exec/platform 均可注入（测试用）
 */
export function createCredentials({ exec = defaultExec, platform = process.platform } = {}) {
  const supported = platform === 'darwin';
  const run = (args) => exec('security', args);
  const notSupported = () => { throw new Error('当前仅支持 macOS 钥匙串（本平台没有 security 命令）'); };
  const failText = (r) => `${(r.stderr || '').trim() || (r.stdout || '').trim() || `exit ${r.code}`}`;
  const notFound = (r) => /could not be found/i.test(`${r.stderr}\n${r.stdout}`);

  return {
    supported,
    service: KEYCHAIN_SERVICE,

    /** 存/更新一组凭据（-U：已存在则更新）。totp 可选。 */
    async set(origin, { username, password, totp } = {}) {
      if (!supported) notSupported();
      validateOrigin(origin);
      if (typeof username !== 'string' || !username) throw new Error('username 不能为空');
      if (typeof password !== 'string' || !password) throw new Error('password 不能为空');
      if (totp !== undefined && (typeof totp !== 'string' || !totp.trim())) throw new Error('totp 种子为非空 Base32 字符串或省略');
      const payload = JSON.stringify({
        username, password,
        ...(totp && totp.trim() ? { totp: totp.trim() } : {}),
      });
      const r = await run(['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', origin.trim(), '-w', payload]);
      if (r.code !== 0) throw new Error(`钥匙串写入失败: ${failText(r)}`);
      return { ok: true, origin: origin.trim() };
    },

    /**
     * 取一组凭据到调用方内存（即用即弃）。未存返回 null。
     * @returns {{username:string, password:string, totp?:string}|null}
     */
    async get(origin) {
      if (!supported) notSupported();
      validateOrigin(origin);
      const r = await run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', origin.trim(), '-w']);
      if (r.code !== 0) {
        if (notFound(r)) return null;
        throw new Error(`钥匙串读取失败: ${failText(r)}`);
      }
      let v;
      try { v = JSON.parse(r.stdout.trim()); } catch { throw new Error('钥匙串条目不是合法 JSON（可能被外部改动）；请重新 npm run credential -- set'); }
      if (!v || typeof v !== 'object' || typeof v.username !== 'string' || typeof v.password !== 'string') {
        throw new Error('钥匙串条目缺少 username/password 字段；请重新 npm run credential -- set');
      }
      return {
        username: v.username,
        password: v.password,
        ...(typeof v.totp === 'string' && v.totp ? { totp: v.totp } : {}),
      };
    },

    /** 删除一组凭据。未存返回 {ok:false, reason:'not-found'}。 */
    async remove(origin) {
      if (!supported) notSupported();
      validateOrigin(origin);
      const r = await run(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', origin.trim()]);
      if (r.code !== 0) {
        if (notFound(r)) return { ok: false, reason: 'not-found' };
        throw new Error(`钥匙串删除失败: ${failText(r)}`);
      }
      return { ok: true };
    },

    /** 列出已存 origin 清单（只列站点，不显任何秘密）。失败返回 []（读不了就当空）。 */
    async list() {
      if (!supported) return [];
      const r = await run(['dump-keychain']);
      if (r.code !== 0) return [];
      return parseOrigins(r.stdout);
    },
  };
}
