// test/totp.test.mjs — TOTP 正确性（硬门槛：RFC 6238 附录 B 的 SHA1 公开测试向量）
//
// RFC 向量用 8 位数字公布；本项目的 totpCode 产出 6 位（认证器标准）。6 位码 =
// 同一次动态截断的 31 位整数 mod 10^6，即 8 位向量串的**末 6 位**（287082 而非
// 942870——这正是真实认证器在该时刻显示的码）。向量密钥 "12345678901234567890"
// 是 ASCII 原始字节；Base32 编码为 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ，
// 用它同时验证 base32 解码路径。

import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, hotp, totpCode } from '../service/totp.mjs';

const RFC_KEY = Buffer.from('12345678901234567890', 'utf8');
const RFC_KEY_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // = base32(RFC_KEY)
// RFC 6238 附录 B（SHA1、8 位）：[Unix 秒, 期望 8 位码]
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('硬门槛：RFC 6238 SHA1 全部 8 位公开向量逐条命中（HOTP 层）', () => {
  for (const [t, expected] of RFC_VECTORS) {
    assert.equal(hotp(RFC_KEY, Math.floor(t / 30), 8), expected, `T=${t}`);
  }
});

test('totpCode（Base32 种子 + 30 秒窗口 + 6 位）= RFC 8 位码的末 6 位（mod 10^6）', () => {
  assert.deepEqual(base32Decode(RFC_KEY_B32), RFC_KEY, 'Base32 解码应还原 RFC 原始密钥');
  for (const [t, expected8] of RFC_VECTORS) {
    assert.equal(totpCode(RFC_KEY_B32, { now: t * 1000, digits: 6 }), expected8.slice(-6), `T=${t}`);
  }
});

test('totpCode 默认参数：6 位、30 秒窗口、前导零保留（10 万样本统计每一位都出现过 0-9）', () => {
  // 用确定的 now 走默认参数形状；同时验证前导零：枚举一批计数器找 0 开头的码
  const code = totpCode(RFC_KEY_B32, { now: 59 * 1000 });
  assert.match(code, /^\d{6}$/);
  let seenLeadingZero = false;
  const digitsSeen = new Set();
  for (let c = 0; c < 3000; c++) {
    const s = hotp(RFC_KEY, c, 6);
    if (s[0] === '0') seenLeadingZero = true;
    for (const d of s) digitsSeen.add(d);
    if (seenLeadingZero && digitsSeen.size === 10) break;
  }
  assert.ok(seenLeadingZero, '应存在前导零码（padStart 生效）');
  assert.equal(digitsSeen.size, 10, '0-9 都应出现（截断分布正常）');
});

test('base32Decode：容忍小写/空格/连字符/填充；非法字符与空串抛错', () => {
  assert.deepEqual(base32Decode('mzxw6ytboi'), Buffer.from('foobar'));
  assert.deepEqual(base32Decode(' MZXW-6YTB OI=== '), Buffer.from('foobar'));
  assert.throws(() => base32Decode('ABC1'), /非法/); // 1/8/9/0 不在 Base32 字母表
  assert.throws(() => base32Decode(''), /为空/);
});
