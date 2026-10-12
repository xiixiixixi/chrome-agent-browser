// test/sync.test.mjs — 硬拷贝同步检查：extension/background.js 里的 EV/ERR/CDP 白名单
// 是 shared/protocol.mjs 的手工拷贝（扩展单文件无 import）。任何一边改动忘了同步，
// 运行期就会静默错乱（真实事故：WEBMCP_TOOLS 漏拷 → 推送通知全部静默丢弃）。
// 本测试用正则从两边各自提取后逐项比对，把这类漂移挡在提交前。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EV, ERR, CDP_ALLOWLIST } from '../shared/protocol.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bg = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');

function extractObjectLiteral(src, anchor) {
  const i = src.indexOf(anchor);
  assert.ok(i > -1, `找不到 ${anchor}`);
  const start = src.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('对象字面量未闭合');
}

test('扩展 EV 硬拷贝与 shared/protocol.mjs 值集合完全一致（键名可异，线上值不可错）', () => {
  const lit = extractObjectLiteral(bg, 'const EV =');
  const extVals = new Set([...lit.matchAll(/:\s*['"]([a-zA-Z/]+)['"]/g)].map((m) => m[1]));
  const sharedVals = new Set(Object.values(EV));
  for (const v of sharedVals) assert.ok(extVals.has(v), `扩展缺少事件值 '${v}'（线上会变成 undefined 静默丢消息）`);
  for (const v of extVals) assert.ok(sharedVals.has(v), `扩展 EV 多出未知值 '${v}'`);
});

test('扩展 ERR 硬拷贝键与值与 shared 一致', () => {
  const lit = extractObjectLiteral(bg, 'const ERR =');
  for (const [k, v] of Object.entries(ERR)) {
    assert.ok(new RegExp(`${k}\\s*:\\s*${v}\\b`).test(lit), `扩展缺少错误码 ${k}: ${v}`);
  }
});

test('扩展 CDP 白名单硬拷贝与 shared 一致（双向值集合）', () => {
  const i = bg.indexOf('CDP_ALLOWLIST');
  assert.ok(i > -1);
  const end = bg.indexOf('])', i);
  assert.ok(end > -1, '找不到白名单数组结尾 ])');
  const lit = bg.slice(i, end);
  const ext = new Set([...lit.matchAll(/'((?:Page|Runtime|DOM|DOMSnapshot|Input|Network|Emulation|Accessibility|Target|Fetch|WebMCP)\.[a-zA-Z]+)'/g)].map((m) => m[1]));
  const shared = new Set([...CDP_ALLOWLIST]);
  for (const m of shared) assert.ok(ext.has(m), `扩展白名单缺少 ${m}`);
  for (const m of ext) assert.ok(shared.has(m), `扩展白名单多出 ${m}`);
});
