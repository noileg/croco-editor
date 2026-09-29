// Middle-button drag scrolling.
//  - Inverted: moving the cursor up scrolls the content down
//  - Proportional to the distance moved, not a speed (stop moving and it stops)
//  - 7x by default (3 lines of cursor movement scroll 21 lines)
//
// Implemented explicitly so it doesn't depend on mouse drivers or system settings.
// Tune PAN_GAIN if the sensitivity feels wrong.

export const PAN_GAIN = 7;

// win: the window whose mouse moves etc. are tracked while dragging (defaults to our
// own). The HTML preview's iframe has its own window, so pass that one for it.
export function attachMiddleDragPan(scroller, win = window) {
  let a = null;

  const onMove = (e) => {
    if (!a) return;
    const dx = e.clientX - a.x;
    const dy = e.clientY - a.y;
    scroller.scrollTop = a.sy - dy * PAN_GAIN; // moving up (dy < 0) -> scrollTop grows -> content moves down
    scroller.scrollLeft = a.sx - dx * PAN_GAIN;
  };
  const end = () => {
    if (!a) return;
    a = null;
    win.removeEventListener("mousemove", onMove, true);
    win.removeEventListener("mouseup", onUp, true);
    scroller.style.cursor = "";
  };
  const onUp = (e) => {
    if (e.button === 1) end();
  };
  const onDown = (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); // Don't also trigger Chromium's built-in autoscroll
    e.stopPropagation(); // Don't let CodeMirror move the caret
    a = { x: e.clientX, y: e.clientY, sx: scroller.scrollLeft, sy: scroller.scrollTop };
    win.addEventListener("mousemove", onMove, true);
    win.addEventListener("mouseup", onUp, true);
    scroller.style.cursor = "grabbing";
  };

  scroller.addEventListener("mousedown", onDown, true);
  scroller.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.stopPropagation();
  }, true);
  win.addEventListener("blur", end);
  win.addEventListener("keydown", (e) => {
    if (e.key === "Escape") end();
  });
}
