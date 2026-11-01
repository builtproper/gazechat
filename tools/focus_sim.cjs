// Headless simulation of the messages-screen focus model.
// Mirrors the constants/logic of GlassesUI so the scroll walk can be tested
// without glasses. Run: node tools/focus_sim.cjs
const MSG_MAX_LINES = 7;
const BUBWRAP_CHARS = 45; // ~504px / ~11px per char

function wrapCount(m) {
  const t = (m.text && m.text.trim()) || "[media]";
  return Math.max(1, Math.ceil(t.length / BUBWRAP_CHARS));
}
const isMedia = (m) => m.type === "IMAGE" || m.type === "VIDEO";
const isTall = (m) => isMedia(m) || wrapCount(m) > 2;
const blocksOf = (m) => Math.max(1, Math.ceil(wrapCount(m) / MSG_MAX_LINES));

// pages from newest backwards; tall messages are their own page
function buildPages(ms) {
  const pages = [];
  let i = ms.length - 1;
  while (i >= 0) {
    if (isTall(ms[i])) { pages.push({ start: i, end: i }); i--; }
    else {
      let s = i;
      while (s > 0 && !isTall(ms[s - 1]) && i - s < 2) s--;
      pages.push({ start: s, end: i });
      i = s - 1;
    }
  }
  return pages;
}
const pageFor = (pages, f) =>
  f < 0 ? pages[0] : pages.find((p) => f >= p.start && f <= p.end) || pages[0];

function scroll(ms, focus, block, dir) {
  const pages = buildPages(ms);
  const down = dir === "down";
  if (ms.length === 0) return { focus, block };
  if (focus < 0) return down ? { focus, block } : { focus: pages[0].end, block: blocksOf(ms[pages[0].end]) - 1 };
  const p = pageFor(pages, focus);
  if (isTall(ms[focus])) {
    if (down && block < blocksOf(ms[focus]) - 1) return { focus, block: block + 1 };
    if (!down && block > 0) return { focus, block: block - 1 };
  }
  const pi = pages.indexOf(p);
  if (down) {
    if (focus < p.end) return { focus: focus + 1, block: blocksOf(ms[focus + 1]) - 1 };
    if (pi === 0) return { focus: -1, block: 0 }; // → mic
    const np = pages[pi - 1];
    return { focus: np.end, block: blocksOf(ms[np.end]) - 1 };
  } else {
    if (focus > p.start) return { focus: focus - 1, block: blocksOf(ms[focus - 1]) - 1 };
    if (pi === pages.length - 1) return { focus, block }; // oldest reached
    const np = pages[pi + 1];
    return { focus: np.end, block: blocksOf(ms[np.end]) - 1 };
  }
}

function show(ms, focus, block, label) {
  const pages = buildPages(ms);
  const p = pageFor(pages, focus);
  const items = [];
  for (let i = p.start; i <= p.end; i++) {
    const m = ms[i];
    if (isTall(m) && i === focus) {
      const lines = Math.min(MSG_MAX_LINES, wrapCount(m));
      items.push(`  [${i}]${focus === i ? " *FOCUS*" : ""} tall block ${block + 1}/${blocksOf(m)} (${lines} lines shown)`);
    } else {
      items.push(`  [${i}]${focus === i ? " *FOCUS*" : ""} ${Math.min(2, wrapCount(m))} line(s): ${m.text.slice(0, 28)}`);
    }
  }
  console.log(`${label} → focus=${focus === -1 ? "MIC" : focus} page=${p.start}..${p.end}`);
  console.log(items.join("\n"));
}

// scenario: 10 short, msg 5 is a photo, msg 2 is long text
const ms = Array.from({ length: 10 }, (_, i) => ({ text: `short message number ${i} here`, type: "TEXT" }));
ms[5] = { text: "", type: "IMAGE" };
ms[2] = { text: "L".repeat(200), type: "TEXT" };

console.log("pages:", JSON.stringify(buildPages(ms)));
let f = -1, b = 0;
show(ms, f, b, "open");
for (const [dir, note] of [["up","u1"], ["up","u2"], ["up","u3"], ["up","u4"], ["up","u5"], ["up","u6"], ["up","u7"], ["up","u8"], ["down","d1"], ["down","d2"], ["down","d3"], ["down","d4"], ["down","d5"], ["down","d6"], ["down","d7"], ["down","d8"]]) {
  ({ focus: f, block: b } = scroll(ms, f, b, dir));
  show(ms, f, b, note);
}
