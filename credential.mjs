#!/usr/bin/env node
// credential.mjs — 凭据仓 CLI（仓库根；npm run credential）
//
//   npm run credential -- set <origin>     # 存/更新一组凭据（交互：用户名回显，密码/TOTP 静默）
//   npm run credential -- list             # 只列已存 origin，不显示任何秘密
//   npm run credential -- remove <origin>  # 删除一组凭据
//
// 凭据只进 macOS 钥匙串（服务名 chrome-agent-browser）；service 端 ab_login 据此
// 全自动登录，凭据永不进入 AI 对话。非 macOS 明确报"当前仅支持 macOS 钥匙串"。

import process from 'node:process';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createCredentials } from './service/credentials.mjs';

const USAGE = [
  '用法（凭据只存本机 macOS 钥匙串，AI 永远看不到明文）：',
  '  npm run credential -- set <origin>     # 存/更新一组登录凭据（origin 如 https://github.com）',
  '  npm run credential -- list             # 列出已存凭据的站点清单（只列 origin）',
  '  npm run credential -- remove <origin>  # 删除一组凭据',
].join('\n');

/** 交互问答器：整个 CLI 会话共用一个 readline 接口 + 持久 line 队列。
 * 不用逐问 rl.question：两次提问的间隙里预喂数据（管道）的 line 事件会因无监听者
 * 丢失。这里持久挂 'line' 监听，答案先入队、ask 按序取；静默输入靠临时把 rl.output
 * 换成哑流（TTY 下不再回显，只放行换行）。EOF 时以空行兜底（上层按"输入为空"报错）。 */
function makeAsker() {
  let rl = null;
  const queue = [];    // 已到未取的答案行
  const waiters = [];  // 等答案的 ask（resolve 函数）
  const muted = new Writable({
    write(chunk, _enc, cb) {
      const s = String(chunk);
      if (s.includes('\n')) process.stdout.write('\n'); // 只回显换行，字符全部吃掉
      cb();
    },
  });
  function ensureRl() {
    if (rl) return;
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdout.isTTY });
    rl.on('line', (line) => {
      const w = waiters.shift();
      if (w) w(line);
      else queue.push(line);
    });
    rl.on('close', () => {
      while (waiters.length) waiters.shift()('');
    });
  }
  return {
    async ask(prompt, { silent }) {
      ensureRl();
      return new Promise((res) => {
        const orig = rl.output;
        if (silent) rl.output = muted;
        process.stdout.write(prompt); // 提示直接写 stdout（不经 rl，避免被哑流吃掉）
        const deliver = (line) => {
          if (silent) rl.output = orig;
          res(line ?? '');
        };
        if (queue.length) deliver(queue.shift());
        else waiters.push(deliver);
      });
    },
    close() {
      if (rl) { try { rl.close(); } catch { /* 已关 */ } rl = null; }
    },
  };
}

/**
 * CLI 主逻辑（io/credentials 可注入，单测用）。
 * @returns {Promise<number>} 退出码
 */
export async function runCli(argv, { credentials = createCredentials(), io = null } = {}) {
  // io 可只注入 print（不含 ask）——此时 ask 仍走真实终端问答
  const asker = (io && typeof io.ask === 'function') ? null : makeAsker();
  const print = (io && typeof io.print === 'function') ? io.print : (s) => process.stdout.write(`${s}\n`);
  const ask = asker ? asker.ask : io.ask;
  const [cmd, origin] = Array.isArray(argv) ? argv : [];
  try {
    if (!credentials.supported) {
      print('当前仅支持 macOS 钥匙串（本平台没有 security 命令）');
      return 1;
    }
    if (cmd === 'set') {
      if (!origin) { print(USAGE); return 1; }
      const username = String(await ask('用户名: ', { silent: false })).trim();
      if (!username) { print('✗ 用户名不能为空'); return 1; }
      const password = String(await ask('密码: ', { silent: true }));
      if (!password) { print('✗ 密码不能为空'); return 1; }
      const totp = String(await ask('TOTP 种子（Base32；不用动态口令直接回车）: ', { silent: true })).trim();
      try {
        await credentials.set(origin, { username, password, ...(totp ? { totp } : {}) });
      } catch (err) {
        print(`✗ ${err.message}`);
        return 1;
      }
      print(`✓ 已存入钥匙串: ${origin}${totp ? '（用户名 + 密码 + TOTP 种子）' : '（用户名 + 密码）'}`);
      print('  之后对 AI 说「帮我登录这个站」即可全自动（ab_login）。');
      return 0;
    }
    if (cmd === 'list') {
      const origins = await credentials.list();
      print(origins.length ? `已存 ${origins.length} 个站点:\n${origins.join('\n')}` : '（还没有存过任何站点；先 set <origin>）');
      return 0;
    }
    if (cmd === 'remove') {
      if (!origin) { print(USAGE); return 1; }
      try {
        const r = await credentials.remove(origin);
        print(r.ok ? `✓ 已删除: ${origin}` : `✗ 未找到: ${origin}`);
        return r.ok ? 0 : 1;
      } catch (err) {
        print(`✗ ${err.message}`);
        return 1;
      }
    }
    print(USAGE);
    return (cmd === 'help' || cmd === '--help' || cmd === '-h') ? 0 : 1;
  } finally {
    if (asker) asker.close(); // 不关 readline，TTY 下进程会挂着等输入
  }
}

// 作为脚本直接运行时才启动（被 import 时不执行）
const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`credential: ${err.message}\n`);
    process.exit(1);
  });
}
