// service/totp.mjs — TOTP（RFC 6238）手写实现：node:crypto 的 HMAC-SHA1，零新依赖。
//
// 用途：ab_login 的动态口令。TOTP 种子按行业惯例是 Base32 字符串（认证器扫码得到
// 的 secret），内部解码成原始字节再做 HOTP（RFC 4226 动态截断）。
//   - totpCode(seed, {now, step, digits})：给页面填的 6 位码（30 秒窗口，标准截断）。
//   - hotp(key, counter, digits)：底层原语，key 为原始字节；单测用 RFC 6238 的
//     公开测试向量（SHA1/8 位那组）直接验证，这是本模块的硬门槛。
// 截断说明："8 位截 6 位" 指 RFC 向量按 8 位公布、我们的 6 位码等于其对 10^6 取模
//（即 8 位串的末 6 位，与真实认证器显示一致）——两者来自同一次动态截断
//（31 位整数 mod 10^digits），见 test/totp.test.mjs 的向量比对。

import { createHmac } from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32 解码（RFC 4648，容忍小写/空格/`=` 填充；遇到字母表外字符抛错）。
 * @param {string} s
 * @returns {Buffer} 原始字节
 */
export function base32Decode(s) {
  const clean = String(s ?? '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean.length) throw new Error('TOTP 种子为空');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`TOTP 种子含非法 Base32 字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/**
 * HOTP（RFC 4226）：HMAC-SHA1 + 动态截断 → digits 位数字串。
 * @param {Buffer|Uint8Array} key 原始密钥字节
 * @param {number} counter 8 字节大端计数器值（非负整数）
 * @param {number} [digits=6]
 * @returns {string} 前导零保留的数字串
 */
export function hotp(key, counter, digits = 6) {
  if (!Number.isInteger(counter) || counter < 0) throw new TypeError('counter must be a non-negative integer');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * 生成当前 TOTP 码（默认 6 位、30 秒窗口、SHA1——与主流认证器一致）。
 * @param {string} seed Base32 种子（钥匙串里存的 totp 字段）
 * @param {{now?: number, step?: number, digits?: number}} [opts]
 * @returns {string}
 */
export function totpCode(seed, { now = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(base32Decode(seed), Math.floor(now / 1000 / step), digits);
}
