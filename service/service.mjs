#!/usr/bin/env node
// service/service.mjs — 服务入口
//
//   node service/service.mjs [--port 7331] [--policy <json>] [--selftest]
//
// 常驻模式：监听 127.0.0.1:<port> 等 host 主动连入（见 docs/PROTOCOL.md），对外提供
// createAgentApi 的浏览器控制面（MCP 层另行挂接）。
// --selftest：不起真浏览器，内部起伪扩展（mock-extension.mjs），跑通
//   注册 → tabs.new → locator click → CDP 白名单拒绝 → policy 拦截，打印 PASS/FAIL。

import process from 'node:process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ConnectionManager } from './connection.mjs';
import { createAgentApi } from './api.mjs';
import { loadPolicy } from './policy.mjs';
import { startMockExtension } from './mock-extension.mjs';
import { ERR } from '../shared/protocol.mjs';

const USAGE = 'usage: node service/service.mjs [--port 7331] [--policy <json>] [--selftest]';

export function parseArgs(argv) {
  const out = { port: 7331, policy: null, selftest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--policy') out.policy = argv[++i];
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error(`invalid port: ${out.port}`);
  return out;
}

/** 自检：全链路（真实 WS + 伪扩展），不需要真浏览器。 */
export async function runSelfTest() {
  const steps = [];
  const step = async (name, fn) => {
    try { await fn(); steps.push([name, null]); } catch (err) { steps.push([name, err]); }
  };

  const manager = new ConnectionManager({ port: 0 });
  await manager.start();
  const policy = loadPolicy(null);
  const api = createAgentApi(() => manager.liveConnections(), { policy });
  let mock = null;
  let tab = null;

  await step('伪扩展连接注册（ext/hello → browsers.list）', async () => {
    const got = once(manager, 'browser');
    mock = await startMockExtension({ port: manager.port });
    await got;
    const list = api.browsers.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'mock-instance-1');
    assert.equal(list[0].type, 'extension');
  });

  await step('tabs.new 参数透传', async () => {
    const browser = api.browsers.getDefault();
    tab = await browser.tabs.new({ url: 'https://selftest.example/' });
    assert.equal(typeof tab.id, 'number');
    const call = mock.calls.find((c) => c.method === 'tab_create');
    assert.deepEqual(call.params, { url: 'https://selftest.example/' });
  });

  await step('locator 链式 click（nth/first 序列化）', async () => {
    await tab.playwright.getByRole('button', { name: 'Go' }).first().click();
    const call = mock.calls.filter((c) => c.method === 'locator_action').at(-1);
    assert.equal(call.params.action, 'click');
    assert.deepEqual(call.params.selector, { kind: 'role', value: 'button', name: 'Go', first: true });
  });

  await step('CDP 白名单服务端预检拒绝', async () => {
    const cdp = tab.capabilities.get('cdp');
    await assert.rejects(cdp.send('Page.crash'), (err) => err.code === ERR.CDP_DENIED);
    assert.ok(!mock.calls.some((c) => c.method === 'tab_cdp_call'), '被拒命令不应到达扩展');
  });

  await step('policy 拦截 chrome://settings 导航', async () => {
    await assert.rejects(tab.goto('chrome://settings/passwords'), (err) => err.code === 'POLICY_BLOCKED');
  });

  if (mock) mock.close();
  await manager.stop();

  for (const [name, err] of steps) console.log(err ? `FAIL  ${name}: ${err.message}` : `PASS  ${name}`);
  return steps.every(([, err]) => !err);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }

  if (args.selftest) {
    const ok = await runSelfTest();
    console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
    return ok ? 0 : 1;
  }

  const policy = loadPolicy(args.policy);
  // 与 mcp-entry 一致：未显式给 --port 时，优先用 setup 写入的 host-config.json
  //（浏览器扩展的宿主按这份配置拨号；两边端口不一致 = 永远连不上）
  if (!process.argv.includes('--port')) {
    try {
      const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'host-config.json'), 'utf8'));
      if (Number.isInteger(cfg.servicePort) && cfg.servicePort > 0 && cfg.servicePort < 65536) args.port = cfg.servicePort;
    } catch { /* 无配置文件则用默认端口 */ }
  }
  const manager = new ConnectionManager({ port: args.port });
  await manager.start();
  console.log(`[cab-service] listening ws://127.0.0.1:${manager.port} (protocol v1, policy: ${args.policy ?? 'defaults'})`);
  manager.on('browser', (c) => console.log(`[browser] connected ${c.instanceId} (${c.family} ${c.browserVersion ?? ''})${c.restored ? ' [restored]' : ''}`));
  manager.on('browserClosed', (c) => console.log(`[browser] closed ${c.instanceId}; lease mirror retained for reconnect window`));

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[cab-service] ${signal}, shutting down`);
    await manager.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise(() => {}); // 常驻
  return 0;
}

// 作为脚本直接运行时才启动（被 import 时不执行）
const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`[cab-service] fatal: ${err.message}`);
    process.exit(1);
  });
}
