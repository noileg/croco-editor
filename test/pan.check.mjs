// 中ボタンドラッグのパン（src/pan.js）の回帰テスト。
// HTML プレビューの iframe の中は別の window なので、win 引数で渡した window に
// イベントが付くこと（親の window では反応しないこと）を確かめる。
//   node test/pan.check.mjs
import { JSDOM } from "jsdom";
import { attachMiddleDragPan, PAN_GAIN } from "../src/pan.js";

let bad = 0;
function check(name, cond) {
  console.log((cond ? "OK   " : "NG   ") + name);
  if (!cond) bad++;
}

function mouse(win, type, init) {
  return new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win, ...init });
}

// 親と、その中の iframe 相当（別 window）を用意する
const parent = new JSDOM("<!doctype html><body></body>");
const frame = new JSDOM("<!doctype html><body><p>x</p></body>");
globalThis.window = parent.window; // pan.js の既定引数 win = window 用
const root = frame.window.document.documentElement;

// jsdom は scrollTop を保持しないので、値を覚えるだけの scroller に差し替える
let top = 500;
let left = 0;
Object.defineProperty(root, "scrollTop", { get: () => top, set: (v) => (top = v) });
Object.defineProperty(root, "scrollLeft", { get: () => left, set: (v) => (left = v) });

attachMiddleDragPan(root, frame.window);

const body = frame.window.document.body;
body.dispatchEvent(mouse(frame.window, "mousedown", { button: 1, clientX: 100, clientY: 100 }));
frame.window.dispatchEvent(mouse(frame.window, "mousemove", { clientX: 100, clientY: 90 }));
check("iframe 内で中ボタンを押して上へ動かすと、内容が下へスクロールする", top === 500 + 10 * PAN_GAIN);

frame.window.dispatchEvent(mouse(frame.window, "mouseup", { button: 1 }));
frame.window.dispatchEvent(mouse(frame.window, "mousemove", { clientX: 100, clientY: 0 }));
check("離したあとはマウスを動かしても動かない", top === 500 + 10 * PAN_GAIN);

top = 500;
body.dispatchEvent(mouse(frame.window, "mousedown", { button: 0, clientX: 100, clientY: 100 }));
frame.window.dispatchEvent(mouse(frame.window, "mousemove", { clientX: 100, clientY: 50 }));
check("左ボタンではパンしない", top === 500);

process.exit(bad ? 1 : 0);
