// Regression test for middle-button drag panning (src/pan.js).
// The HTML preview's iframe has its own window, so the events must be attached to the
// window passed as win (and not react on the parent window).
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

// A parent and an iframe stand-in (a separate window)
const parent = new JSDOM("<!doctype html><body></body>");
const frame = new JSDOM("<!doctype html><body><p>x</p></body>");
globalThis.window = parent.window; // for pan.js's default argument win = window
const root = frame.window.document.documentElement;

// jsdom doesn't keep scrollTop, so swap in a scroller that just remembers the value
let top = 500;
let left = 0;
Object.defineProperty(root, "scrollTop", { get: () => top, set: (v) => (top = v) });
Object.defineProperty(root, "scrollLeft", { get: () => left, set: (v) => (left = v) });

attachMiddleDragPan(root, frame.window);

const body = frame.window.document.body;
body.dispatchEvent(mouse(frame.window, "mousedown", { button: 1, clientX: 100, clientY: 100 }));
frame.window.dispatchEvent(mouse(frame.window, "mousemove", { clientX: 100, clientY: 90 }));
check("middle-drag upward inside the iframe scrolls the content down", top === 500 + 10 * PAN_GAIN);

frame.window.dispatchEvent(mouse(frame.window, "mouseup", { button: 1 }));
frame.window.dispatchEvent(mouse(frame.window, "mousemove", { clientX: 100, clientY: 0 }));
check("moving the mouse after release does nothing", top === 500 + 10 * PAN_GAIN);

top = 500;
body.dispatchEvent(mouse(frame.window, "mousedown", { button: 0, clientX: 100, clientY: 100 }));
frame.window.dispatchEvent(mouse(frame.window, "mousemove", { clientX: 100, clientY: 50 }));
check("the left button doesn't pan", top === 500);

process.exit(bad ? 1 : 0);
