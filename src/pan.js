// 中ボタンドラッグでスクロールする。
//  - 方向は反転（カーソルを上へ動かすと内容は下へスクロール）
//  - 速度ではなく移動量に比例（位置追従。止めれば止まる）
//  - 既定 7 倍（本人談：カーソル3行ぶんでページ21行ぶん）
//
// 以前ブラウザ版で使えていた挙動（入っている Logitech の Universal Scroll
// だった可能性が高い）を、環境設定に依存せず出すための明示実装。
// 感度が合わなければ PAN_GAIN だけ変える。

export const PAN_GAIN = 7;

export function attachMiddleDragPan(scroller) {
  let a = null;

  const onMove = (e) => {
    if (!a) return;
    const dx = e.clientX - a.x;
    const dy = e.clientY - a.y;
    scroller.scrollTop = a.sy - dy * PAN_GAIN; // 上へ動かす(dy<0) → scrollTop 増 → 下へ
    scroller.scrollLeft = a.sx - dx * PAN_GAIN;
  };
  const end = () => {
    if (!a) return;
    a = null;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    scroller.style.cursor = "";
  };
  const onUp = (e) => {
    if (e.button === 1) end();
  };
  const onDown = (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); // Chromium 標準のオートスクロールと二重に効かせない
    e.stopPropagation(); // CodeMirror にキャレット移動をさせない
    a = { x: e.clientX, y: e.clientY, sx: scroller.scrollLeft, sy: scroller.scrollTop };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    scroller.style.cursor = "grabbing";
  };

  scroller.addEventListener("mousedown", onDown, true);
  scroller.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.stopPropagation();
  }, true);
  window.addEventListener("blur", end);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") end();
  });
}
