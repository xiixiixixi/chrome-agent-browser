# 现成配方——browser_eval 直接抄

这一页收集「一段 `browser_eval` 代码解决一个真实任务」的现成配方。每篇都给出可直接粘贴的完整调用与逐行说明；配方里的页面侧提取代码经过仓库 E2E 的离线夹具验证（见 `test/e2e/run-e2e.mjs`），真实站点的效果请手动试。

## 配方一：YouTube 字幕导出

**用途**：把当前某个 YouTube 视频的字幕拉成 `[分:秒] 文本` 行，交给模型总结或存档。

**原理**：视频页的全局变量 `ytInitialPlayerResponse` 里带着字幕轨清单
（`captions.playerCaptionsTracklistRenderer.captionTracks`，含语言代码与取回地址 `baseUrl`）。
给 `baseUrl` 追加 `&fmt=json3` 再 `fetch`，得到带毫秒时间戳的 json3 事件流，拼成可读文本即可。

### 第 1 步：页面内提取（核心代码）

<!-- AB-RECIPE-YT-EXTRACT-START -->
```js
(async () => {
  const pr = window.ytInitialPlayerResponse;
  if (!pr) return { ok: false, reason: '非视频页：页面没有 ytInitialPlayerResponse（先导航到具体的视频 watch 页）' };
  const tracks = pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
  if (!tracks || !tracks.length) return { ok: false, reason: '此视频没有字幕轨（captions 缺失）' };
  // 语言优先级：中文 > 英文 > 第一轨
  const pick = tracks.find((t) => /^zh/i.test(t.languageCode || ''))
    || tracks.find((t) => /^en/i.test(t.languageCode || ''))
    || tracks[0];
  const res = await fetch(pick.baseUrl + '&fmt=json3');
  if (!res.ok) return { ok: false, reason: '字幕轨请求失败：HTTP ' + res.status };
  const data = await res.json();
  const lines = (data.events || [])
    .filter((e) => e.segs)
    .map((e) => {
      const s = Math.floor((e.tStartMs || 0) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      const text = e.segs.map((g) => g.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      return '[' + mm + ':' + ss + '] ' + text;
    })
    .filter((l) => l.length > 9); // 过滤纯时间戳空行（"> 9" = 至少一个非空字符）
  return { ok: true, language: pick.languageCode || '?', lineCount: lines.length, lines };
})()
```
<!-- AB-RECIPE-YT-EXTRACT-END -->

### 第 2 步：完整调用（browser_eval）

把上面第 1 步的整段 IIFE 粘进下面 `t.eval(...)` 的反引号里，作为 `browser_eval` 的 `code` 参数一次性发送
（外壳负责「开标签 → 导航 → 页面内执行 → 关标签」，结果经 `nodeRepl.write` 打印，同时出现在返回的 `output` 里）：

```js
const b = await agent.browsers.getDefault();
const t = await b.tabs.new();
try {
  await t.goto('https://www.youtube.com/watch?v=VIDEO_ID');
  const r = await t.eval(`(async () => {
    // ← 这里粘贴第 1 步「页面内提取」的整段代码（IIFE 花括号内的部分原样保留）
  })()`);
  if (!r.ok) nodeRepl.write('失败：' + r.reason);
  else {
    nodeRepl.write('语言=' + r.language + ' 行数=' + r.lineCount);
    nodeRepl.write(r.lines.join('\n'));
  }
} finally { await t.close(); }
```

不想开新标签的话，把 `b.tabs.new()` 换成 `b.user.claimTab({ providerTabId })` 认领你已打开的视频页即可。

### 第 3 步：把结果存成本地 .txt 文件

`browser_eval` 的沙箱**不注入 `require`/`fs`**（设计如此，见 README 的沙箱边界声明），落盘交给客户端侧：

- 你的 MCP 客户端一般自带写文件工具，把上一步返回 JSON 里 `result.lines.join("\n")` 的文本交给它存成 `字幕.txt` 即可；
- 或在终端会话里直接把 `output` 字段重定向：拿到工具返回的 `output` 文本后 `pbpaste > 字幕.txt`（macOS）/ 存剪贴板后手动粘贴。

### 说明与边界

- 语言优先级 `zh > en > 第一轨`；要别的语言改 `find` 里的正则即可。
- json3 的 `events[].segs[].utf8` 是分词碎片，代码里已 `join` 并压平空白。
- 仓库 E2E 用 `test/e2e/youtube-fixture.html`（内嵌仿真 `ytInitialPlayerResponse` + 本地 json3 路由）验证这段提取代码的行为；**真实 YouTube 不做网络验证，真站效果请手动试**（页面结构是 YouTube 的公开事实，若其改版请对照更新本配方）。
