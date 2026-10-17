// service/cua-guide.mjs — CUA 授权引导（v0.5.3）
//
// 目标：像所有正规 macOS 产品一样走系统标准授权流程——helper 的 request-permissions
// 向系统「申请」权限（弹标准对话框、把负责进程注册进设置列表，未勾选状态），用户只需在
// 系统设置 → 隐私与安全性 里拨一下开关；全程人话引导。
//
// 本模块 = 纯逻辑（missingPermissions / permissionGuideText / cTierNote / degradedNote）
//        + 可注入 IO 的引导编排（runGuidedGrant）。被三处共用：
//   service/cua.mjs  —— status() 的 permissionGuide 拼装（纯逻辑）
//   cua-selftest.mjs —— 互动引导（TTY 回车推进；Ctrl+C 跳过并如实降级）
//   setup.mjs        —— 非交互指引（弹完对话框即打印两步说明，不等待）
// 测试直接注入 fake cua / fake io 覆盖各分支（见 test/cua.test.mjs）。

/** 缺权限判定：未授权或未知都算缺（引导一步到位总没错）。@returns {{ax: boolean, screen: boolean}} */
export function missingPermissions(st) {
  return { ax: st?.axGranted !== true, screen: st?.screenGranted !== true };
}

/** 人话授权指引：含设置面板路径与要勾选的名字（只列缺的项）。 */
export function permissionGuideText({ responsibleProcess, ax, screen } = {}) {
  const name = responsibleProcess || '运行本程序的终端/应用（列表里显示它的名字）';
  const steps = [];
  if (ax) steps.push(`①「辅助功能」勾选「${name}」（AI 才能读界面元素并点击/输入）`);
  if (screen) steps.push(`${ax ? '②' : '①'}「屏幕录制」勾选「${name}」（AI 才能截图/读到窗口标题）`);
  return `系统设置 → 隐私与安全性 → ${steps.join('；')}。跑 npm run cua-selftest 可自动弹出系统申请对话框。`;
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
 * 对话框并把负责进程注册进设置列表）→ [回车] 复测 probe 验证。
 * @param {object} opts
 *   cua        —— createCua() 的返回值（须已编译 helper，调用方保证）
 *   st         —— 当前 status() 结果
 *   io         —— {ask(prompt): 'enter'|'skip'}；null = 非交互（stdin 非 TTY）
 *   log        —— 输出函数（默认空）
 *   recompile  —— 可选 () => {compiled:boolean}（旧 helper 就地重编译用）
 * @returns {{mode: 'already-granted'|'no-tty'|'skipped'|'error'|'requested', st: object,
 *            missing?: {ax,screen}, requested?: object, error?: Error}}
 *   requested 模式的 st 为复测后的新 status（调用方以其继续后续链路）。
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
  log('');
  log(`→ 已向系统提交申请；请到 系统设置 → 隐私与安全性 打开「${requested.responsibleProcess || name}」的开关：`);
  if (requested.axRequested) log('  ① 辅助功能');
  if (requested.screenRequested) log('  ② 屏幕录制');
  if ((await io.ask('[开好后按回车继续验证…（Ctrl+C 跳过）] ')) === 'skip') {
    return { mode: 'skipped', st, missing, requested };
  }
  const stAfter = await cua.status(); // 重新 probe 验证
  return { mode: 'requested', st: stAfter, missing: missingPermissions(stAfter), requested };
}
