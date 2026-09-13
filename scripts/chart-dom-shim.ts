/**
 * Минимальный headless-DOM для запуска lightweight-charts 5.2.1 в Node.
 *
 * Зачем: в песочнице/VPS-проверке нет браузера, а опции в исходнике — НЕ
 * доказательство runtime-поведения. Этот шим поднимает ровно тот минимум
 * DOM/Canvas/ResizeObserver, который нужен библиотеке, чтобы:
 *  - создать график и разложить панели (table → pane rows → axis widgets);
 *  - привязать MouseEventHandler к canvas'ам виджетов;
 *  - диспатчить НАСТОЯЩИЕ mousedown/mousemove/mouseup/dblclick/wheel и
 *    наблюдать результат через ПУБЛИЧНЫЙ API (priceScale().options(),
 *    getVisibleRange(), timeScale().getVisibleLogicalRange()).
 *
 * Никаких зависимостей (jsdom/canvas отсутствуют): только стандартный
 * Node API. Отрисовка не выполняется — 2D-контекст это no-op заглушка,
 * поэтому тесты проверяют СОСТОЯНИЕ и взаимодействие, а не пиксели.
 *
 * ВАЖНО: глобалы (window/document/…) устанавливаются ДО импорта
 * lightweight-charts, потому что библиотека на этапе импорта фиксирует
 * `isRunningOnClientSide = typeof window !== 'undefined'`.
 */

/* ------------------------------------------------------------------ */
/* 1. События                                                          */
/* ------------------------------------------------------------------ */

export interface ShimEventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  clientX?: number;
  clientY?: number;
  screenX?: number;
  screenY?: number;
  pageX?: number;
  pageY?: number;
  button?: number;
  buttons?: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  deltaX?: number;
  deltaY?: number;
  deltaZ?: number;
  deltaMode?: number;
  detail?: number;
  touches?: unknown[];
  changedTouches?: unknown[];
  timeStamp?: number;
}

/**
 * Отладочный трассировщик: на каких узлах какие слушатели сработали.
 * Включается только из тестов/проб (shimTrace.enabled = true).
 */
export const shimTrace: { enabled: boolean; log: string[] } = {
  enabled: false,
  log: []
};

/**
 * «Возраст страницы» для timeStamp событий.
 *
 * В браузере Event.timeStamp отсчитывается от timeOrigin, поэтому сразу
 * после загрузки страницы он мал. MouseEventHandler библиотеки глушит
 * мышиные события, пока timeStamp < lastTouchEventTimeStamp + 500
 * (защита от призрачных mouse-событий после touch), а
 * lastTouchEventTimeStamp инициализирован нулём: на первых 500 мс жизни
 * страницы мышь игнорировалась бы и в тесте. Сдвигаем часы на минуту —
 * как если бы пользователь уже работал со страницей.
 */
const SHIM_PAGE_AGE_MS = 60_000;

export class ShimEvent {
  readonly type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  propagationStopped = false;
  target: ShimEventTarget | null = null;
  currentTarget: ShimEventTarget | null = null;
  timeStamp: number;

  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  pageX: number;
  pageY: number;
  button: number;
  buttons: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  detail: number;
  touches: unknown[];
  changedTouches: unknown[];
  view: ShimWindow | null = null;

  constructor(type: string, init: ShimEventInit = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    /*
     * В браузере Event.timeStamp — это DOMHighResTimeStamp от timeOrigin
     * (та же шкала, что performance.now()), а НЕ epoch-мс. Это важно:
     * MouseEventHandler сравнивает timeStamp с lastTouchEventTimeStamp +
     * 500 (защита от «призрачных» мышиных событий после touch). С
     * epoch-значениями любое touch-событие навсегда глушило бы мышину.
     */
    this.timeStamp =
      init.timeStamp ?? performance.now() + SHIM_PAGE_AGE_MS;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.screenX = init.screenX ?? this.clientX;
    this.screenY = init.screenY ?? this.clientY;
    this.pageX = init.pageX ?? this.clientX;
    this.pageY = init.pageY ?? this.clientY;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.ctrlKey = init.ctrlKey ?? false;
    this.altKey = init.altKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
    this.detail = init.detail ?? 0;
    this.touches = init.touches ?? [];
    this.changedTouches = init.changedTouches ?? [];
  }

  preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }
}

/* ------------------------------------------------------------------ */
/* 2. EventTarget / Node / Element                                     */
/* ------------------------------------------------------------------ */

interface ListenerRecord {
  type: string;
  fn: (event: ShimEvent) => void;
  capture: boolean;
  once: boolean;
}

export class ShimEventTarget {
  /** Все зарегистрированные слушатели (порядок регистрации сохранён). */
  readonly shimListeners: ListenerRecord[] = [];

  addEventListener(
    type: string,
    fn: ((event: ShimEvent) => void) | null,
    options?: boolean | { capture?: boolean; passive?: boolean; once?: boolean }
  ): void {
    if (typeof fn !== "function") {
      return;
    }

    const capture =
      typeof options === "boolean"
        ? options
        : Boolean(options && options.capture);
    const once = Boolean(options && typeof options === "object" && options.once);

    this.shimListeners.push({ type, fn, capture, once });
  }

  removeEventListener(
    type: string,
    fn: ((event: ShimEvent) => void) | null
  ): void {
    if (typeof fn !== "function") {
      return;
    }

    for (let i = this.shimListeners.length - 1; i >= 0; i -= 1) {
      const rec = this.shimListeners[i];

      if (rec.type === type && rec.fn === fn) {
        this.shimListeners.splice(i, 1);
      }
    }
  }

  /** Количество слушателей типа — для диагностики «доходит ли жест». */
  shimListenerCount(type: string): number {
    return this.shimListeners.filter((l) => l.type === type).length;
  }

  private shimInvoke(
    event: ShimEvent,
    capture: boolean
  ): void {
    event.currentTarget = this;

    let invoked = 0;

    for (const rec of [...this.shimListeners]) {
      if (rec.type !== event.type || rec.capture !== capture) {
        continue;
      }

      invoked += 1;

      if (rec.once) {
        this.removeEventListener(rec.type, rec.fn);
      }

      rec.fn.call(this, event);

      if (event.propagationStopped) {
        return;
      }
    }

    if (shimTrace.enabled) {
      const name =
        this instanceof ShimNode
          ? this.nodeName
          : this.constructor.name;

      shimTrace.log.push(
        `${name}:${event.type}:handlers=${String(invoked)}`
      );
    }
  }

  /** Диспетчеризация с подъёмом события по дереву (bubble-фаза). */
  dispatchEvent(event: ShimEvent): boolean {
    const node = this as unknown as ShimNode;
    const path: ShimNode[] = [];

    if (typeof node === "object" && node !== null && "parentNode" in node) {
      let current: ShimNode | null = node;

      while (current !== null) {
        path.push(current);
        current = current.parentNode;
      }
    } else {
      path.push(node as unknown as ShimNode);
    }

    event.target = this;

    // capture: от корня к цели
    if (event.bubbles) {
      for (let i = path.length - 1; i >= 0; i -= 1) {
        path[i].shimInvokeCapture(event);

        if (event.propagationStopped) {
          return !event.defaultPrevented;
        }
      }
    }

    // target + bubble: от цели к корню
    for (const element of path) {
      element.shimInvokeBubble(event);

      if (event.propagationStopped || !event.bubbles) {
        break;
      }
    }

    return !event.defaultPrevented;
  }

  shimInvokeCapture(event: ShimEvent): void {
    (this as ShimEventTarget).shimInvokePrivate(event, true);
  }

  shimInvokeBubble(event: ShimEvent): void {
    (this as ShimEventTarget).shimInvokePrivate(event, false);
  }

  private shimInvokePrivate(event: ShimEvent, capture: boolean): void {
    this.shimInvoke(event, capture);
  }
}

export class ShimStyle {
  private readonly values = new Map<string, string>();
  private readonly onChanged: () => void;

  constructor(onChanged: () => void) {
    this.onChanged = onChanged;
  }

  setProperty(name: string, value: string): void {
    this.values.set(name, String(value));
    this.onChanged();
  }

  removeProperty(name: string): string {
    const prev = this.values.get(name) ?? "";

    this.values.delete(name);
    this.onChanged();

    return prev;
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }

  get cssText(): string {
    return [...this.values.entries()]
      .map(([k, v]) => `${k}: ${v};`)
      .join(" ");
  }

  set cssText(value: string) {
    this.values.clear();

    for (const part of String(value).split(";")) {
      const idx = part.indexOf(":");

      if (idx > 0) {
        this.values.set(
          part.slice(0, idx).trim(),
          part.slice(idx + 1).trim()
        );
      }
    }

    this.onChanged();
  }

  shimSnapshot(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function pxValue(raw: string | undefined): number | null {
  if (typeof raw !== "string") {
    return null;
  }

  const parsed = Number.parseFloat(raw);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Нормализация цвета — браузер на getComputedStyle отдаёт rgb()/rgba(),
 * а lightweight-charts парсит цвет именно так (getRgbStringViaBrowser →
 * ColorParser._private__parseColor). Без нормализации библиотека падает
 * на «transparent»/#hex ещё до создания панелей.
 */
export function normalizeCssColor(raw: string): string {
  const value = String(raw ?? "").trim();

  if (value === "" || value === "transparent" || value === "none") {
    return "rgba(0, 0, 0, 0)";
  }

  if (/^rgba?\s*\(/i.test(value)) {
    return value;
  }

  const named: Record<string, string> = {
    white: "rgb(255, 255, 255)",
    black: "rgb(0, 0, 0, 0)",
    red: "rgb(255, 0, 0)",
    green: "rgb(0, 128, 0)",
    blue: "rgb(0, 0, 255)",
    gray: "rgb(128, 128, 128)",
    grey: "rgb(128, 128, 128)"
  };

  if (named[value.toLowerCase()] !== undefined) {
    return value.toLowerCase() === "black"
      ? "rgb(0, 0, 0)"
      : named[value.toLowerCase()];
  }

  const hex = value.replace("#", "");

  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r, g, b] = hex.split("").map((c) => Number.parseInt(c + c, 16));

    return `rgb(${r}, ${g}, ${b})`;
  }

  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);

    return `rgb(${r}, ${g}, ${b})`;
  }

  if (/^[0-9a-f]{8}$/i.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    const a = Number.parseInt(hex.slice(6, 8), 16) / 255;

    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
  }

  // Неизвестный формат — оставляем как есть: ColorParser бросит
  // понятную ошибку (в браузере такое значение тоже не распарсилось бы).
  return value;
}

function createStyleProxy(onChanged: () => void): ShimStyle {
  const base = new ShimStyle(onChanged);

  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }

      const own = (target as unknown as Record<string, unknown>)[prop];

      if (own !== undefined) {
        return typeof own === "function"
          ? (own as (...args: unknown[]) => unknown).bind(target)
          : own;
      }

      return target.getPropertyValue(camelToKebab(prop));
    },
    set(target, prop, value) {
      if (typeof prop !== "string") {
        return true;
      }

      target.setProperty(camelToKebab(prop), String(value));

      return true;
    }
  }) as ShimStyle;
}

export class ShimClassList {
  private readonly classes = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) {
      this.classes.add(name);
    }
  }

  remove(...names: string[]): void {
    for (const name of names) {
      this.classes.delete(name);
    }
  }

  contains(name: string): boolean {
    return this.classes.has(name);
  }

  toggle(name: string): boolean {
    if (this.classes.has(name)) {
      this.classes.delete(name);

      return false;
    }

    this.classes.add(name);

    return true;
  }

  get value(): string {
    return [...this.classes].join(" ");
  }
}

export interface ShimRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

export class ShimNode extends ShimEventTarget {
  parentNode: ShimNode | null = null;
  readonly childNodes: ShimNode[] = [];
  ownerDocument: ShimDocument | null = null;
  textContentValue = "";

  /** DOM-имя узла: TAGNAME у элементов, #text/#document у остальных. */
  get nodeName(): string {
    return this instanceof ShimElement
      ? this.tagName
      : this instanceof ShimDocument
        ? "#document"
        : "#text";
  }

  appendChild<T extends ShimNode>(child: T): T {
    if (child.parentNode !== null) {
      child.parentNode.removeChild(child);
    }

    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    this.shimNotifyTreeChanged();

    return child;
  }

  insertBefore<T extends ShimNode>(child: T, ref: ShimNode | null): T {
    if (child.parentNode !== null) {
      child.parentNode.removeChild(child);
    }

    const index = ref === null ? -1 : this.childNodes.indexOf(ref);

    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;

    if (index === -1) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(index, 0, child);
    }

    this.shimNotifyTreeChanged();

    return child;
  }

  removeChild<T extends ShimNode>(child: T): T {
    const index = this.childNodes.indexOf(child);

    if (index !== -1) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
      this.shimNotifyTreeChanged();
    }

    return child;
  }

  remove(): void {
    if (this.parentNode !== null) {
      this.parentNode.removeChild(this);
    }
  }

  /** focus()/blur() — PaneWidget снимает фокус при mousedown. */
  blur(): void {
    const doc = this.ownerDocument;

    if (doc instanceof ShimDocument && doc.shimActiveElement === this) {
      doc.shimActiveElement = doc.body;
    }
  }

  focus(): void {
    const doc = this.ownerDocument;

    if (doc instanceof ShimDocument) {
      doc.shimActiveElement = this;
    }
  }

  contains(other: ShimNode | null): boolean {
    if (other === null) {
      return false;
    }

    let node: ShimNode | null = other;

    while (node !== null) {
      if (node === this) {
        return true;
      }

      node = node.parentNode;
    }

    return false;
  }

  get children(): ShimElement[] {
    return this.childNodes.filter(
      (n): n is ShimElement => n instanceof ShimElement
    );
  }

  get firstChild(): ShimNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): ShimNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get textContent(): string {
    return this.textContentValue;
  }

  set textContent(value: string) {
    this.textContentValue = String(value);
  }

  /** Глубина дерева (для отладки). */
  shimDepth(): number {
    let depth = 0;
    let node: ShimNode | null = this.parentNode;

    while (node !== null) {
      depth += 1;
      node = node.parentNode;
    }

    return depth;
  }

  shimNotifyTreeChanged(): void {
    const doc = this.ownerDocument;

    if (doc !== null) {
      doc.shimNotifyTreeChanged();
    }
  }
}

export class ShimElement extends ShimNode {
  readonly tagName: string;
  readonly classList = new ShimClassList();
  readonly attributes = new Map<string, string>();
  /** Явный layout, который задаёт тест (до того, как стиль выставит библиотека). */
  shimClientWidth = 0;
  shimClientHeight = 0;
  shimOffsetLeft = 0;
  shimOffsetTop = 0;
  innerHTMLValue = "";
  scrollLeft = 0;
  scrollTop = 0;

  readonly style: ShimStyle & Record<string, string>;

  constructor(tagName: string, doc: ShimDocument | null) {
    super();

    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = doc;

    this.style = createStyleProxy(() =>
      this.shimOnStyleChanged()
    ) as ShimStyle & Record<string, string>;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  /** Ближайший предок-элемент (нужен тестам: canvas → div → td). */
  get parentElement(): ShimElement | null {
    return this.parentNode instanceof ShimElement ? this.parentNode : null;
  }

  /**
   * Предок с указанным tagName (или null) — поиск ячейки/строки виджета.
   */
  closestTag(tagName: string): ShimElement | null {
    const wanted = tagName.toUpperCase();
    let node: ShimElement | null = this.parentElement;

    while (node !== null) {
      if (node.tagName === wanted) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  get innerHTML(): string {
    return this.innerHTMLValue;
  }

  set innerHTML(value: string) {
    this.innerHTMLValue = String(value);
    this.childNodes.length = 0;
  }

  get className(): string {
    return this.classList.value;
  }

  set className(value: string) {
    const parts = String(value).split(/\s+/).filter(Boolean);

    this.classList.remove(...[...this.attributes.keys()]);

    for (const part of parts) {
      this.classList.add(part);
    }
  }

  get clientWidth(): number {
    const fromStyle = pxValue(this.style.getPropertyValue("width"));

    return fromStyle !== null ? fromStyle : this.shimClientWidth;
  }

  get clientHeight(): number {
    const fromStyle = pxValue(this.style.getPropertyValue("height"));

    return fromStyle !== null ? fromStyle : this.shimClientHeight;
  }

  get offsetWidth(): number {
    return this.clientWidth;
  }

  get offsetHeight(): number {
    return this.clientHeight;
  }

  get offsetLeft(): number {
    return this.shimOffsetLeft;
  }

  get offsetTop(): number {
    return this.shimOffsetTop;
  }

  get offsetParent(): ShimElement | null {
    return this.parentNode instanceof ShimElement ? this.parentNode : null;
  }

  /**
   * Прямоугольник элемента. Тест задаёт геометрию через shimRect* —
   * библиотека считает localX/localY именно отсюда.
   */
  shimRectLeft = 0;
  shimRectTop = 0;

  getBoundingClientRect(): ShimRect {
    const width = this.clientWidth;
    const height = this.clientHeight;

    return {
      left: this.shimRectLeft,
      top: this.shimRectTop,
      right: this.shimRectLeft + width,
      bottom: this.shimRectTop + height,
      width,
      height,
      x: this.shimRectLeft,
      y: this.shimRectTop
    };
  }

  getClientRects(): ShimRect[] {
    return [this.getBoundingClientRect()];
  }

  focus(): void {
    /* noop */
  }

  blur(): void {
    /* noop */
  }

  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ShimElement[] {
    const all = this.shimAllElements();
    const wanted = selector.replace(/^[.#]/, "");
    const byClass = selector.startsWith(".");
    const byTag = !byClass && !selector.startsWith("[");

    return all.filter((el) =>
      byClass
        ? el.classList.contains(wanted)
        : byTag
          ? el.tagName === wanted.toUpperCase()
          : true
    );
  }

  shimAllElements(): ShimElement[] {
    const result: ShimElement[] = [];

    const walk = (node: ShimNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof ShimElement) {
          result.push(child);
          walk(child);
        } else {
          walk(child);
        }
      }
    };

    walk(this);

    return result;
  }

  /** Путь от корня до элемента (для поиска виджета в дереве графика). */
  shimPath(): string[] {
    const parts: string[] = [];
    let node: ShimNode | null = this;

    while (node !== null && node instanceof ShimElement) {
      const cls = node.classList.value;
      const size = `${Math.round(node.clientWidth)}x${Math.round(node.clientHeight)}`;

      parts.unshift(`${node.tagName.toLowerCase()}${cls ? `.${cls.split(" ").join(".")}` : ""}[${size}]`);
      node = node.parentNode;
    }

    return parts;
  }

  private shimOnStyleChanged(): void {
    const doc = this.ownerDocument;

    if (doc !== null) {
      doc.shimNotifyStyleChanged(this);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Canvas и 2D-контекст (no-op)                                     */
/* ------------------------------------------------------------------ */

interface TextMetricsStub {
  width: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
}

function createGradientStub(): Record<string, unknown> {
  return { addColorStop: () => undefined };
}

export function createContext2DStub(
  canvas: ShimCanvasElement
): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {
    canvas,
    measureText: (text: unknown): TextMetricsStub => {
      const str = String(text ?? "");

      return {
        width: str.length * 6,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2
      };
    },
    createLinearGradient: createGradientStub,
    createRadialGradient: createGradientStub,
    createPattern: createGradientStub,
    getImageData: (
      _x: number,
      _y: number,
      width: number,
      height: number
    ) => ({
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
      data: new Uint8ClampedArray(
        Math.max(4, Math.floor(width) * Math.floor(height) * 4)
      )
    }),
    putImageData: () => undefined,
    createImageData: (width: number, height: number) => ({
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
      data: new Uint8ClampedArray(
        Math.max(4, Math.floor(width) * Math.floor(height) * 4)
      )
    })
  };

  const noop = (): unknown => undefined;

  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) {
        return obj[prop as string];
      }

      return noop;
    },
    set(obj, prop, value) {
      obj[prop as string] = value;

      return true;
    }
  }) as unknown as CanvasRenderingContext2D;
}

export class ShimCanvasElement extends ShimElement {
  width = 0;
  height = 0;
  private ctx: CanvasRenderingContext2D | null = null;

  getContext(type: string): CanvasRenderingContext2D | null {
    if (type !== "2d") {
      return null;
    }

    if (this.ctx === null) {
      this.ctx = createContext2DStub(this);
    }

    return this.ctx;
  }

  toDataURL(): string {
    return "data:image/png;base64,";
  }
}

/* ------------------------------------------------------------------ */
/* 4. ResizeObserver                                                   */
/* ------------------------------------------------------------------ */

interface ResizeEntry {
  target: ShimElement;
  contentRect: { width: number; height: number };
  borderBoxSize: Array<{ inlineSize: number; blockSize: number }>;
  devicePixelContentBoxSize: Array<{ inlineSize: number; blockSize: number }>;
}

/**
 * ResizeObserver: библиотека через него узнаёт CSS-размер canvas'ов
 * (fancy-canvas, device-pixel-content-box). Срабатывает асинхронно —
 * как в браузере — и повторно, когда наблюдаемый элемент меняет
 * style.width/height.
 */
class ShimResizeObserver {
  private static readonly instances = new Set<ShimResizeObserver>();

  private readonly callback: (
    entries: ResizeEntry[],
    observer: ShimResizeObserver
  ) => void;
  private readonly observed = new Set<ShimElement>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    callback: (entries: ResizeEntry[], observer: ShimResizeObserver) => void
  ) {
    this.callback = callback;
    ShimResizeObserver.instances.add(this);
  }

  observe(target: unknown): void {
    if (target instanceof ShimElement) {
      this.observed.add(target);
      this.shimSchedule();
    }
  }

  unobserve(target: unknown): void {
    if (target instanceof ShimElement) {
      this.observed.delete(target);
    }
  }

  disconnect(): void {
    this.observed.clear();

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    ShimResizeObserver.instances.delete(this);
  }

  shimNotify(element: ShimElement): void {
    if (this.observed.has(element)) {
      this.shimSchedule();
    }
  }

  private shimSchedule(): void {
    if (this.timer !== null) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.shimFire();
    }, 0);
  }

  private shimFire(): void {
    const dpr = ShimResizeObserver.shimDevicePixelRatio();
    const entries: ResizeEntry[] = [...this.observed].map((el) => {
      const width = el.clientWidth;
      const height = el.clientHeight;

      return {
        target: el,
        contentRect: { width, height },
        borderBoxSize: [{ inlineSize: width, blockSize: height }],
        devicePixelContentBoxSize: [
          {
            inlineSize: Math.round(width * dpr),
            blockSize: Math.round(height * dpr)
          }
        ]
      };
    });

    if (entries.length === 0) {
      return;
    }

    this.callback(entries, this);
  }

  static shimDevicePixelRatio(): number {
    return 1;
  }

  static shimNotifyAll(element: ShimElement): void {
    for (const instance of ShimResizeObserver.instances) {
      instance.shimNotify(element);
    }
  }

  static shimReset(): void {
    ShimResizeObserver.instances.clear();
  }
}

/* ------------------------------------------------------------------ */
/* 5. Document / Window                                                */
/* ------------------------------------------------------------------ */

export class ShimDocument extends ShimNode {
  readonly documentElement: ShimElement;
  readonly body: ShimElement;
  readonly head: ShimElement;
  defaultView: ShimWindow | null = null;
  readonly readyState = "complete";
  title = "";
  /**
   * PaneWidget при mousedown сверяет document.activeElement с body и
   * documentElement, иначе вызывает blur(). По умолчанию «фокус на body»
   * — как на freshly loaded странице.
   */
  shimActiveElement: ShimNode | null = null;

  constructor() {
    super();

    this.ownerDocument = this;
    this.documentElement = new ShimElement("html", this);
    this.body = new ShimElement("body", this);
    this.head = new ShimElement("head", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.shimActiveElement = this.body;
  }

  get activeElement(): ShimNode | null {
    return this.shimActiveElement;
  }

  /** document.getSelection() — библиотека умеет работать с null. */
  getSelection(): null {
    return null;
  }

  createElement(tagName: string): ShimElement {
    const tag = String(tagName).toLowerCase();

    return tag === "canvas"
      ? new ShimCanvasElement(tag, this)
      : new ShimElement(tag, this);
  }

  createElementNS(_ns: string, tagName: string): ShimElement {
    return this.createElement(tagName);
  }

  createTextNode(text: string): ShimNode {
    const node = new ShimNode();

    node.ownerDocument = this;
    node.textContentValue = String(text);

    return node;
  }

  getElementById(id: string): ShimElement | null {
    return (
      this.documentElement
        .shimAllElements()
        .find((el) => el.getAttribute("id") === id) ?? null
    );
  }

  querySelector(selector: string): ShimElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): ShimElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  shimNotifyStyleChanged(element: ShimElement): void {
    ShimResizeObserver.shimNotifyAll(element);
  }

  shimNotifyTreeChanged(): void {
    /* noop: пересчёт размеров в шиме явный (shimLayout) */
  }
}

export class ShimWindow extends ShimEventTarget {
  readonly document: ShimDocument;
  readonly navigator = {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    platform: "Linux x86_64",
    maxTouchPoints: 0
  };
  devicePixelRatio = 1;
  innerWidth = 1280;
  innerHeight = 800;
  readonly ResizeObserver = ShimResizeObserver;
  readonly location = { href: "http://localhost/", search: "", hash: "" };
  private rafId = 0;
  private readonly rafCallbacks = new Map<number, () => void>();

  constructor(document: ShimDocument) {
    super();

    this.document = document;
    document.defaultView = this;
  }

  requestAnimationFrame(callback: (time: number) => void): number {
    this.rafId += 1;
    const id = this.rafId;

    this.rafCallbacks.set(id, () => callback(Date.now()));

    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.rafCallbacks.delete(id);
  }

  /** Прогнать все запросы на кадр (библиотека рисует через rAF). */
  shimFlushFrames(rounds = 4): void {
    for (let round = 0; round < rounds; round += 1) {
      const pending = [...this.rafCallbacks.entries()];

      this.rafCallbacks.clear();

      for (const [, callback] of pending) {
        callback();
      }
    }
  }

  matchMedia(query: string): {
    matches: boolean;
    media: string;
    addListener: (fn: unknown) => void;
    removeListener: (fn: unknown) => void;
    addEventListener: (type: string, fn: unknown) => void;
    removeEventListener: (type: string, fn: unknown) => void;
  } {
    return {
      matches: false,
      media: query,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    };
  }

  getComputedStyle(element?: unknown): Record<string, unknown> {
    const el =
      element instanceof ShimElement ? element : null;

    const read = (name: string): string => {
      const raw = el ? el.style.getPropertyValue(name) : "";

      return name === "color" ||
        name === "background-color" ||
        name === "border-color"
        ? normalizeCssColor(raw)
        : raw;
    };

    return {
      get color() {
        return read("color");
      },
      get backgroundColor() {
        return read("background-color");
      },
      getPropertyValue: (name: string) => read(name),
      fontFamily: "",
      fontSize: "12px",
      lineHeight: "normal"
    };
  }

  scrollTo(): void {
    /* noop */
  }
}

/* ------------------------------------------------------------------ */
/* 6. Layout-проход: таблица панелей → реальные rect'ы                 */
/* ------------------------------------------------------------------ */

/**
 * Библиотека раскладывает виджеты таблицей (table → tr → td → div →
 * canvas) и задаёт размеры через style.width/height, а позиции считает
 * браузер. В шиме позиций нет, поэтому rect'ы собираются здесь: строки
 * складываются по вертикали, ячейки — по горизонтали.
 *
 * Без этого getBoundingClientRect() вернул бы нули и MouseEventHandler
 * получил бы localY = clientY, то есть тест «тыкал» бы не туда.
 */
export function shimLayoutTree(root: ShimElement): void {
  const sizeOf = (el: ShimElement): { width: number; height: number } => {
    const own = { width: el.clientWidth, height: el.clientHeight };
    let width = own.width;
    let height = own.height;

    for (const child of el.children) {
      const childSize = sizeOf(child);

      width = Math.max(width, childSize.width);
      height = Math.max(height, childSize.height);
    }

    return { width, height };
  };

  const place = (
    el: ShimElement,
    left: number,
    top: number,
    width: number,
    height: number
  ): void => {
    el.shimRectLeft = left;
    el.shimRectTop = top;
    el.shimClientWidth = width;
    el.shimClientHeight = height;

    // Вложенные div/canvas у виджета занимают ту же коробку
    // (position: absolute, left/top = 0).
    const kids = el.children;

    if (kids.length > 0 && el.clientWidth === width) {
      for (const child of kids) {
        const childWidth = child.clientWidth || width;
        const childHeight = child.clientHeight || height;

        place(child, left, top, childWidth, childHeight);
      }
    }
  };

  const tables = root
    .shimAllElements()
    .filter((el) => el.tagName === "TABLE");

  for (const table of tables) {
    const rows = table.children.filter((el) => el.tagName === "TR");
    let top = table.shimRectTop;

    for (const row of rows) {
      const cells = row.children.filter((el) => el.tagName === "TD");
      const rowSize = sizeOf(row);
      let left = table.shimRectLeft;

      row.shimRectLeft = table.shimRectLeft;
      row.shimRectTop = top;
      row.shimClientWidth = rowSize.width;
      row.shimClientHeight = rowSize.height;

      for (const cell of cells) {
        const cellSize = sizeOf(cell);

        place(cell, left, top, cellSize.width, rowSize.height);
        left += cellSize.width;
      }

      top += rowSize.height;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6. Установка глобалов                                               */
/* ------------------------------------------------------------------ */

export interface ShimDom {
  window: ShimWindow;
  document: ShimDocument;
  /** Контейнер графика (его размер задаёт тест). */
  container: ShimElement;
  /** Ожидать завершения микро/макрозадач (ResizeObserver, таймеры). */
  settle: (ms?: number) => Promise<void>;
  /** Прогнать кадры отрисовки. */
  flushFrames: (rounds?: number) => void;
  /** Все элементы дерева (поиск виджетов). */
  allElements: () => ShimElement[];
  /** Все canvas'ы. */
  canvases: () => ShimCanvasElement[];
  /** Пересчитать rect'ы виджетов (после layout-изменений библиотеки). */
  layout: () => void;
  /** Диспатч события. */
  dispatch: (
    target: ShimElement | ShimDocument | ShimWindow,
    event: ShimEvent
  ) => void;
  mouse: (type: string, init?: ShimEventInit) => ShimEvent;
  wheel: (init?: ShimEventInit) => ShimEvent;
  /** Восстановить исходные глобалы. */
  restore: () => void;
}

const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "TouchEvent",
  "WheelEvent",
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "devicePixelRatio",
  "performance"
] as const;

/**
 * Поднимает DOM-глобалы. Вызывать ДО импорта lightweight-charts.
 */
export function installChartDom(options?: {
  width?: number;
  height?: number;
}): ShimDom {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const g = globalThis as unknown as Record<string, unknown>;

  for (const key of GLOBAL_KEYS) {
    saved.set(
      key,
      Object.getOwnPropertyDescriptor(g, key)
    );
  }

  const document = new ShimDocument();
  const window = new ShimWindow(document);

  const container = document.createElement("div");

  container.shimClientWidth = options?.width ?? 1200;
  container.shimClientHeight = options?.height ?? 560;
  document.body.appendChild(container);

  // Часть глобалов Node (navigator, performance) объявлены геттерами —
  // пишем через defineProperty, иначе «Cannot set property».
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(g, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true
    });
  };

  define("window", window);
  define("document", document);
  define("navigator", window.navigator);
  define("HTMLElement", ShimElement);
  define("Element", ShimElement);
  define("Node", ShimNode);
  define("Event", ShimEvent);
  define("MouseEvent", ShimEvent);
  define("TouchEvent", ShimEvent);
  define("WheelEvent", ShimEvent);
  define("ResizeObserver", ShimResizeObserver);
  define("requestAnimationFrame", (cb: (time: number) => void) =>
    window.requestAnimationFrame(cb));
  define("cancelAnimationFrame", (id: number) =>
    window.cancelAnimationFrame(id));
  define("getComputedStyle", (element?: unknown) =>
    window.getComputedStyle(element));
  define("devicePixelRatio", 1);

  const settle = async (ms = 12): Promise<void> => {
    // ResizeObserver в шиме срабатывает через setTimeout(0), поэтому
    // ждём реальные макрозадачи и прогоняем кадры; после каждого кадра
    // пересчитываем rect'ы виджетов.
    await new Promise((resolve) => setTimeout(resolve, ms));
    window.shimFlushFrames();
    shimLayoutTree(document.body);
    await new Promise((resolve) => setTimeout(resolve, ms));
    window.shimFlushFrames();
    shimLayoutTree(document.body);
  };

  const mouse = (type: string, init: ShimEventInit = {}): ShimEvent =>
    new ShimEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "mouseup" ? 0 : 1,
      ...init
    });

  const wheel = (init: ShimEventInit = {}): ShimEvent =>
    new ShimEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...init
    });

  return {
    window,
    document,
    container,
    settle,
    flushFrames: (rounds?: number) => window.shimFlushFrames(rounds),
    allElements: () => document.documentElement.shimAllElements(),
    canvases: () =>
      document.documentElement
        .shimAllElements()
        .filter((el): el is ShimCanvasElement => el instanceof ShimCanvasElement),
    layout: () => shimLayoutTree(document.body),
    dispatch: (target, event) => {
      event.view = window;
      target.dispatchEvent(event);
    },
    mouse,
    wheel,
    restore: () => {
      ShimResizeObserver.shimReset();

      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) {
          delete g[key];
        } else {
          Object.defineProperty(g, key, descriptor);
        }
      }
    }
  };
}
