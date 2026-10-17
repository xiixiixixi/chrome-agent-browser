// service/cua-guide.mjs — CUA 授权引导（v0.5.3；v0.5.4 加悬浮引导卡片）
//
// 目标：像所有正规 macOS 产品一样走系统标准授权流程——helper 的 request-permissions
// 向系统「申请」权限（弹标准对话框、把负责进程注册进设置列表，未勾选状态），用户只需在
// 系统设置 → 隐私与安全性 里拨一下开关；全程人话引导。
//
// v0.5.4 引导卡片（照抄成熟 macOS 工具的授权引导模式）：申请的同时自动打开对应设置面板，
// 并在屏幕上浮一张可拖拽的琥珀卡片（helper 的 show-permission-card；卡片图标句柄拖出的
// 就是负责进程的 .app bundle，可直接放进设置列表，等同点 + 号选 App）；权限到手或引导
// 结束即收卡。卡片是纯增益——helper 太旧/缺失时静默跳过，终端文字引导仍然完整。
//
// 本模块 = 纯逻辑（missingPermissions / missingCardKinds / permissionGuideText / cTierNote / degradedNote）
//        + 可注入 IO 的引导编排（runGuidedGrant）与卡片开关（showGuideCards / hideGuideCards）。被三处共用：
//   service/cua.mjs  —— status() 的 permissionGuide 拼装（纯逻辑）
//   cua-selftest.mjs —— 互动引导（TTY 回车推进；Ctrl+C 跳过并如实降级）
//   setup.mjs        —— 非交互指引（弹完对话框后留卡片在屏上自动淡出，不等待）
// 测试直接注入 fake cua / fake io 覆盖各分支（见 test/cua.test.mjs）。

/** 引导卡片默认寿命：setup 非交互模式留卡给用户看的窗口期。 */
export const CARD_DEFAULT_SEC = 120;

/** 缺权限判定：未授权或未知都算缺（引导一步到位总没错）。@returns {{ax: boolean, screen: boolean}} */
export function missingPermissions(st) {
  return { ax: st?.axGranted !== true, screen: st?.screenGranted !== true };
}

/** 缺权限 → 引导卡片 kinds（accessibility 在前、screen 在后，与 helper 的卡片排布一致）。 */
export function missingCardKinds(missing) {
  const kinds = [];
  if (missing?.ax) kinds.push('accessibility');
  if (missing?.screen) kinds.push('screen');
  return kinds;
}

/** 人话授权指引：含设置面板路径与要勾选的名字（只列缺的项）。 */
export function permissionGuideText({ responsibleProcess, ax, screen } = {}) {
  const name = responsibleProcess || '运行本程序的终端/应用（列表里显示它的名字）';
  const steps = [];
  if (ax) steps.push(`①「辅助功能」勾选「${name}」（AI 才能读界面元素并点击/输入）`);
  if (screen) steps.push(`${ax ? '②' : '①'}「屏幕录制」勾选「${name}」（AI 才能截图/读到窗口标题）`);
  return `系统设置 → 隐私与安全性 → ${steps.join('；')}。跑 npm run cua-selftest 可自动弹出系统申请对话框。`;
}

/**
 * 显示引导卡片（每缺一项一张；失败自吞——helper 太旧/缺失时静默降级为纯文字引导）。
 * @returns {Promise<string[]>} 实际显示成功的 kinds（空数组=本机无卡片能力）
 */
export async function showGuideCards(cua, missing, appName, { durationSec = CARD_DEFAULT_SEC, log = () => {} } = {}) {
  const shown = [];
  for (const kind of missingCardKinds(missing)) {
    // 方法不存在（v0.5.3 旧二进制/无 helper 的纯 fake）= 无卡片能力：静默降级为纯文字引导
    if (typeof cua?.showPermissionCard !== 'function') continue;
    try {
      await cua.showPermissionCard({ kind, appName, durationSec });
      shown.push(kind);
    } catch { /* 旧版 helper 回 unknown-cmd 等：失败的卡不进列表（调用方据此只收已浮的卡） */ }
  }
  if (shown.length) log(`屏幕上已出现琥珀色引导卡片（${durationSec} 秒后自动消失），拖进系统设置列表即可授权`);
  return shown;
}

/** 收起引导卡片（幂等；失败自吞）。 */
export async function hideGuideCards(cua, kinds) {
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    try { await cua.hidePermissionCard?.(kind); } catch { /* 收卡失败最多多浮一会儿，无害 */ }
  }
}

/** 跳过授权 / AX 未授权时的诚实降级说明。 */
export function cTierNote() {
  return '权限未授予，CUA 限制在 C 层（仅窗口清单；截图可能只剩桌面壁纸）';
}

/** 按缺什么给诚实的降级说明（AX 缺 → C 层；只缺屏幕录制 → 截图降级但元素操作可用）。 */
export function degradedNote(st) {
  const miss = missingPermissions(st);
  if (miss.ax) return cTierNote();
  return '屏幕录制未授权：截图可能只剩桌面壁纸、窗口标题为空（界面元素操作不受影响）';
}

/** 旧版 helper 没有 request-permissions（unknown-cmd）→ 可重编译时就地重编译重试一次。 */
async function requestWithRecompile(cua, recompile, log) {
  try {
    return await cua.requestPermissions();
  } catch (err) {
    if (err.code !== 'unknown-cmd' || !recompile) throw err;
    const built = recompile();
    if (!built?.compiled) throw err; // 重编译失败按原错误报告
    cua.stop(); // 结束常驻的旧二进制，下次请求自动从新编译产物拉起
    log('检测到旧版 host/cua-helper（无 request-permissions 命令），已就地重编译 → 重试');
    return cua.requestPermissions();
  }
}

/**
 * 互动授权引导（cua-selftest 用）：讲清两步 → [回车] 调 request-permissions（弹系统
 * 对话框并把负责进程注册进设置列表）→ 自动打开对应设置面板 + 浮起引导卡片 →
 * [回车] 复测 probe 验证并收卡。
 * @param {object} opts
 *   cua        —— createCua() 的返回值（须已编译 helper，调用方保证）
 *   st         —— 当前 status() 结果
 *   io         —— {ask(prompt): 'enter'|'skip'}；null = 非交互（stdin 非 TTY）
 *   log        —— 输出函数（默认空）
 *   recompile  —— 可选 () => {compiled:boolean}（旧 helper 就地重编译用）
 * @returns {{mode: 'already-granted'|'no-tty'|'skipped'|'error'|'requested', st: object,
 *            missing?: {ax,screen}, requested?: object, cards?: string[], error?: Error}}
 *   requested 模式的 st 为复测后的新 status（调用方以其继续后续链路）；
 *   cards 为本轮实际浮起的引导卡片 kinds（引导结束时已全部收起）。
 */
export async function runGuidedGrant({ cua, st, io, log = () => {}, recompile = null } = {}) {
  const missing = missingPermissions(st);
  if (!missing.ax && !missing.screen) return { mode: 'already-granted', st, missing };
  if (!io) return { mode: 'no-tty', st, missing };
  const name = st.responsibleProcess || '运行本命令的终端（列表里显示它的名字，如 Ghostty）';
  log('');
  log('⚠ 屏幕操作需要两个 macOS 权限，现在帮你申请：');
  if (missing.ax) {
    log('');
    log('第 1 步：辅助功能（让 AI 能看到和点击界面元素）');
    log('→ 马上会弹一个系统对话框，点「打开系统设置」');
    log(`→ 在列表里找到「${name}」（或你看到的运行本命令的应用名），打开开关`);
  }
  if (missing.screen) {
    log('');
    log(`${missing.ax ? '第 2 步' : '第 1 步'}：屏幕录制（让 AI 能截屏）`);
    log('→ 同上：在系统对话框/系统设置里给同一项打开开关');
  }
  log('');
  if ((await io.ask('[按回车开始申请…（Ctrl+C 跳过）] ')) === 'skip') return { mode: 'skipped', st, missing };
  let requested = null;
  try {
    requested = await requestWithRecompile(cua, recompile, log);
  } catch (err) {
    return { mode: 'error', st, missing, error: err };
  }
  // v0.5.4：弹引导卡片（图标句柄=可拖进设置列表的负责进程 .app）+ 直接开到对应设置面板。
  // 卡片/面板都是纯增益：helper 太旧或方法缺失时静默跳过，文字引导仍然完整。
  const nameAfter = requested.responsibleProcess || name;
  const stillMissing = { ax: requested.axGranted !== true, screen: requested.screenGranted !== true };
  const cards = await showGuideCards(cua, stillMissing, nameAfter, { log });
  if (stillMissing.ax || stillMissing.screen) {
    try { await cua.openPrivacyPane?.(stillMissing.ax ? 'accessibility' : 'screen'); } catch { /* 打不开面板不算事：文字指引里有路径 */ }
  }
  log('');
  log(`→ 已向系统提交申请${cards.length ? '并打开系统设置' : ''}；请打开「${nameAfter}」的开关：`);
  if (stillMissing.ax) log('  ① 辅助功能');
  if (stillMissing.screen) log('  ② 屏幕录制');
  const askVerify = cards.length
    ? '[看屏幕上的琥珀色引导卡片 → 拖进列表或点 + 号；完成后按回车验证…（Ctrl+C 跳过）] '
    : '[开好后按回车继续验证…（Ctrl+C 跳过）] ';
  if ((await io.ask(askVerify)) === 'skip') {
    await hideGuideCards(cua, cards); // 引导中止也要收卡（不然要等自动淡出）
    return { mode: 'skipped', st, missing, requested, cards };
  }
  const stAfter = await cua.status(); // 重新 probe 验证
  await hideGuideCards(cua, cards); // 权限到手与否都收卡：复测后卡片使命已完成
  return { mode: 'requested', st: stAfter, missing: missingPermissions(stAfter), requested, cards };
}
