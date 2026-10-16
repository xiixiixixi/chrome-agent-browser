// service/locator.mjs — Playwright 风格定位器（链式、惰性）
//
// 设计：Locator 只持有「selector 描述对象」{kind, value, exact?, name?, nth?, first?}，
// 动作执行时才把描述对象原样发给扩展（locator_count / locator_action，由扩展在页面里求值）。
// 服务端不做 DOM 解析，因此链式调用是零成本的描述变换。
//
// v1 限制（README 已注明）：不支持嵌套 frame 定位（无 frameLocator）；
// 不支持 hasText/has 等过滤伪方法。

/** 定位器句柄。所有动作走 tab._locator() 下发命令。 */
export class Locator {
  constructor(tab, selector) {
    this.tab = tab;
    this.selector = selector;
  }

  /** 克隆描述对象并清理 undefined 键（保证 JSON 序列化稳定）。 */
  _with(patch) {
    const next = { ...this.selector, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return new Locator(this.tab, next);
  }

  first() { return this._with({ first: true, nth: undefined }); }

  nth(i) {
    if (!Number.isInteger(i) || i < 0) throw new TypeError('nth() requires a non-negative integer');
    return this._with({ nth: i, first: undefined });
  }

  /** 交集定位（对应 Playwright locator.and）。 */
  and(locator) {
    if (!(locator instanceof Locator)) throw new TypeError('and() expects a Locator');
    return new Locator(this.tab, { kind: 'and', value: [this.selector, locator.selector] });
  }

  async count() {
    const r = await this.tab._locator('locator_count', this.selector);
    return typeof r?.count === 'number' ? r.count : 0;
  }

  async click() { return this._action('click'); }
  async hover() { return this._action('hover'); }
  async fill(value) { return this._action('fill', String(value)); }
  async press(key) { return this._action('press', String(key)); }
  async textContent() { return this._action('textContent'); }
  async allTextContents() { return this._action('allTextContents'); }

  /** 元素级截图（PNG Buffer）：扩展侧 scrollIntoView 后按元素矩形 clip 截取。 */
  async screenshot() {
    const r = await this.tab._locator('element_screenshot', this.selector);
    if (!r || typeof r.dataBase64 !== 'string') {
      throw new Error('element_screenshot: no image data');
    }
    return Buffer.from(r.dataBase64, 'base64');
  }

  async _action(action, value) {
    const params = value === undefined ? { action } : { action, value };
    const r = await this.tab._locator('locator_action', this.selector, params);
    if (r && r.ok === false) {
      const e = new Error(r.error ?? `locator ${action} failed`);
      if (r.errorCode !== undefined) e.code = r.errorCode;
      throw e;
    }
    return r ? r.value : undefined;
  }
}

/** tab.playwright 工厂集（绑定在某个 tab 句柄上）。 */
export function createPlaywright(tab) {
  const L = (selector) => new Locator(tab, selector);
  return {
    css: (sel) => L({ kind: 'css', value: sel }),
    getByRole: (role, { name } = {}) => L({ kind: 'role', value: role, ...(name !== undefined ? { name } : {}) }),
    getByText: (text, { exact } = {}) => L({ kind: 'text', value: text, ...(exact !== undefined ? { exact } : {}) }),
    getByLabel: (label) => L({ kind: 'label', value: label }),
    getByTestId: (id) => L({ kind: 'testid', value: id }),
    getByPlaceholder: (t) => L({ kind: 'placeholder', value: t }),
  };
}
