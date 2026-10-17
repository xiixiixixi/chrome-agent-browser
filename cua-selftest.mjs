#!/usr/bin/env node
// cua-selftest.mjs —— 屏幕操作（CUA）交互动全清单自检：探测 →（缺权限则）授权引导 → 编译 → windows →
// （有授权则）ax-tree + 截图 + 幽魂光标试闪，输出人话报告。
//
// 授权引导（v0.5.3；v0.5.4 加悬浮卡片）：缺权限时自动向系统申请（helper 的
// request-permissions 弹标准系统对话框、把负责进程注册进设置列表），同时自动打开
// 对应设置面板并浮起琥珀引导卡片（可拖进列表/点 + 号；helper 太旧时静默退化为纯文字），
// 人话带路，回车推进、Ctrl+C 跳过（跳过即如实降级报告）。
//
// 安全默认：本自检不做任何点击/输入/按键（只读探测 + 截一小块区域 +
// 屏幕中央闪一次叠加光标——纯可视化，点击穿透、不动任何应用与真鼠标）；
// 授权申请弹的是 macOS 系统自己的标准对话框，由用户决定是否授予。
// 用法：npm run cua-selftest
// 退出码：探测链路本身能跑通即 0（未授权/未编译等降级项如实报告，不算失败）。

import process from 'node:process';
import { compileHelper, createCua } from './service/cua.mjs';
import { missingPermissions, permissionGuideText, runGuidedGrant, degradedNote } from './service/cua-guide.mjs';

const log = (s) => console.log(s);
const results = [];
const step = (name, fn) => {
  // 只读步骤失败不算整体失败（降级项如实报告）；只有 status 本身跑不通才算 FAIL
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push([name, null, detail]); return detail; })
    .catch((err) => { results.push([name, err, null]); return null; });
};

/**
 * TTY 交互（授权引导用）：ask 等一行输入，任何输入=继续（'enter'），Ctrl+C='skip'。
 * 非 TTY（管道/CI）返回 null → 调用方降级为非交互指引。SIGINT 监听只在等待期间挂着，
 * 结束即拆——引导之外 Ctrl+C 恢复系统默认行为。
 */
function makeTtyIo() {
  if (!process.stdin.isTTY) return null;
  let cleanup = null;
  return {
    ask(prompt) {
      return new Promise((resolve) => {
        process.stdout.write(prompt);
        const done = (v) => { cleanup?.(); cleanup = null; resolve(v); };
        const onData = () => done('enter');
        const onSigint = () => done('skip');
        cleanup = () => {
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          process.removeListener('SIGINT', onSigint);
        };
        process.stdin.once('data', onData);
        process.once('SIGINT', onSigint);
      });
    },
    close() { cleanup?.(); cleanup = null; },
  };
}

log('chrome-agent-browser 屏幕操作（CUA）自检');
log('安全说明：本自检只做只读探测与截取一小块画面，不做任何点击/输入/按键；');
log('          缺权限时会先走系统标准授权申请（弹的是 macOS 自己的对话框，由你决定）。\n');

const cua = createCua({});
try {
  // 1. 平台与能力探测
  let st = null;
  await step('能力探测（cua_status）', async () => {
    st = await cua.status();
    return `tier ${st.tier}，能力 ${Object.entries(st.capabilities).filter(([, v]) => v).map(([k]) => k).join('/') || '无'}`;
  });
  if (!st) {
    for (const [name, err] of results) log(`FAIL  ${name}: ${err.message}`);
    log('\nSELFTEST FAIL（能力探测本身失败，属异常情况）');
    process.exit(1);
  }
  log(`平台 ${st.platform}；tier ${st.tier}（A=编译版助手 / B=osascript / C=无授权）`);
  log(`swiftc ${st.swiftcAvailable ? '✓' : '✗'}；helper ${st.helperCompiled ? '已编译' : '未编译'}；辅助功能 ${st.axGranted === true ? '✓' : st.axGranted === false ? '✗' : '未知'}；屏幕录制 ${st.screenGranted === true ? '✓' : st.screenGranted === false ? '✗' : '未知'}`);
  if (st.guidance.length) {
    log('指引：');
    for (const g of st.guidance) log(`  - ${g}`);
  }

  // 2. helper 未编译且 swiftc 可用 → 现场编译再复测（自检要把链路拉到能到的最高层）
  if (st.supported && !st.helperCompiled && st.swiftcAvailable) {
    const built = await step('编译 Swift 助手（host/cua-helper）', () => {
      const r = compileHelper({ log: () => {} });
      if (!r.compiled) throw new Error(r.reason ?? '编译失败');
      return `已编译 → ${r.path}`;
    });
    if (built) {
      const st2 = await step('复测能力（编译后 tier 应提升）', () => cua.status());
      if (st2) {
        log(`复测：tier ${st.tier} → ${st2.tier}；辅助功能 ${st2.axGranted === true ? '✓' : '✗/未知'}；屏幕录制 ${st2.screenGranted === true ? '✓' : '✗/未知'}`);
      }
    }
  }

  // 2.5 授权引导（v0.5.3）：缺权限时自动向系统申请 + 人话带路（回车推进 / Ctrl+C 跳过）。
  //     只在交互终端且 helper 已编译时进行（申请走 helper 的 request-permissions）；
  //     跳过/失败/复测仍缺都如实报告，然后继续只读自检（降级项本来就如实标注）。
  const miss = missingPermissions(st);
  if (st.supported && (miss.ax || miss.screen)) {
    if (!st.helperCompiled) {
      log('');
      log(`⚠ ${permissionGuideText({ responsibleProcess: st.responsibleProcess, ...miss })}`);
      log('  （自动申请需 A 层助手：跑一次 npm run setup 编译后，重跑本自检即可自动弹系统申请）');
    } else {
      const io = makeTtyIo();
      if (!io) {
        log('');
        log(`⚠ 缺权限，且当前不是交互终端（stdin 非 TTY），跳过自动申请。${permissionGuideText({ responsibleProcess: st.responsibleProcess, ...miss })}`);
      } else {
        try {
          const g = await runGuidedGrant({
            cua, st, io, log,
            recompile: st.swiftcAvailable ? () => compileHelper({ log: () => {} }) : null,
          });
          if (g.mode === 'requested') {
            results.push(['授权申请（request-permissions）', null,
              `ax 申请=${g.requested?.axRequested ? '是' : '否'}，屏幕申请=${g.requested?.screenRequested ? '是' : '否'}；引导卡片 ${g.cards?.length ?? 0} 张；复测 tier ${st.tier} → ${g.st.tier}`]);
            st = g.st; // 复测后的新状态：后续门（ax-tree/截图/叠加）按它走
          }
          if (g.mode === 'skipped') {
            log('');
            log(`已跳过授权引导：${degradedNote(st)}。随时重跑 npm run cua-selftest 再引导。`);
          } else if (g.mode === 'error') {
            log('');
            log(`⚠ 自动申请失败：${g.error.message}`);
            log(`  ${degradedNote(st)}；${permissionGuideText({ responsibleProcess: st.responsibleProcess, ...missingPermissions(st) })}`);
          } else if (g.mode === 'requested' && (g.missing.ax || g.missing.screen)) {
            const lack = [g.missing.ax && '辅助功能', g.missing.screen && '屏幕录制'].filter(Boolean).join('、');
            log('');
            log(`⚠ 复测仍有权限未授予（${lack}）：${degradedNote(g.st)}`);
          }
        } finally {
          io.close();
        }
      }
    }
  }

  // 3. 窗口清单（A/B/C+helper 层都应可用）
  let wins = null;
  await step('窗口清单（cua_windows）', async () => {
    wins = await cua.windows();
    return `共 ${wins.length} 个窗口，其中 ${wins.filter((w) => w.title).length} 个带标题`;
  });
  if (wins) {
    log(`共 ${wins.length} 个窗口；前 3 个：`);
    for (const w of wins.slice(0, 3)) {
      const title = w.title ? `「${w.title.slice(0, 40)}」` : '（无标题：屏幕录制未授权时系统不给标题，正常）';
      log(`  - ${w.ownerName} pid=${w.ownerPid} ${title} ${Math.round(w.bounds.w)}x${Math.round(w.bounds.h)}${w.windowId ? ` windowId=${w.windowId}` : ''}`);
    }
  }

  // 4. AX 授权时：读前台应用元素清单（截深度 3，别刷屏）
  if (st.axGranted === true) {
    let tree = null;
    await step('无障碍树（cua_ax_tree，前台应用，深度 3）', async () => {
      tree = await cua.axTree({ maxDepth: 3 });
      return `pid=${tree.pid} via=${tree.via} 共 ${tree.nodes.length} 节点`;
    });
    if (tree) {
      log(`pid=${tree.pid} via=${tree.via} 共 ${tree.nodes.length} 节点${tree.truncated ? '（触顶截断，正常）' : ''}；样例：`);
      for (const n of tree.nodes.slice(0, 5)) {
        log(`  d${n.depth} ${n.role}${n.title ? ` 「${String(n.title).slice(0, 30)}」` : ''}`);
      }
    }
  } else {
    log('\n跳过无障碍树：辅助功能未授权（见上面指引，授权后重跑本自检）');
  }

  // 5. 截一小块区域（屏幕录制授权的有效性试拍）
  const shot = await step('区域截图试拍（cua_screenshot，120x80）', async () => {
    const s = await cua.screenshot({ rect: { x: 0, y: 0, w: 120, h: 80 }, format: 'jpeg' });
    return `jpeg ${s.bytes} 字节`;
  });
  if (shot) log(`jpeg ${shot}（截到画面说明屏幕录制授权有效）`);

  // 6. 幽魂光标试闪（只读叠加：屏幕中央闪 800ms 后自动淡出，不动任何应用/真鼠标）
  if (!st.supported || !st.overlay?.available) {
    log('\n跳过幽魂光标试闪：叠加层需 A 层助手（host/cua-helper 未编译，跑一次 npm run setup）');
  } else if (st.overlay?.enabled === false) {
    log('\n跳过幽魂光标试闪：已在 policy 关闭（cuaOverlay=false）');
  } else {
    const flash = await step('幽魂光标试闪（overlay-show，屏幕中央 800ms）', async () => {
      const w = st.screen?.w ?? 1920;
      const h = st.screen?.h ?? 1080;
      const tryFlash = () => cua.overlayFlash({ x: Math.round(w / 2), y: Math.round(h / 2), kind: 'click', durationMs: 800 });
      let r;
      try {
        r = await tryFlash();
      } catch (err) {
        // 已编译的二进制是旧版（升级源码后没重跑 setup）：有 swiftc 就地重编译后重试一次
        if (err.code !== 'unknown-cmd' || !st.swiftcAvailable) throw err;
        const built = compileHelper({ log: () => {} });
        if (!built.compiled) throw err; // 重编译失败按原错误报告
        cua.stop(); // 结束常驻的旧二进制进程，下次请求自动从新编译产物拉起
        log('检测到旧版 host/cua-helper（无 overlay 命令），已就地重编译 → 重试');
        r = await tryFlash();
      }
      if (r.ok !== true) throw new Error(r.error ?? 'helper 未返回 ok');
      return `helper 返回 ok（此刻屏幕中央应闪过琥珀色 AI 光标 + 一圈涟漪后淡出）`;
    });
    if (flash) log(flash);
  }
} finally {
  cua.stop();
}

log('');
const failed = results.filter(([, err]) => err);
for (const [name, err, detail] of results) {
  if (err) log(`FAIL  ${name}: ${err.message}`);
  else if (detail) log(`PASS  ${name} — ${detail}`);
  else log(`PASS  ${name}`);
}
// 降级（未授权/未编译/截不到图）不算失败：自检验证的是「探测链路如实工作」
log(failed.length ? `\nSELFTEST FAIL（${failed.length} 步异常）` : '\nSELFTEST PASS（降级项已如实标注，授权后重跑可逐项点亮）');
process.exit(failed.length ? 1 : 0);
