// ANSI (SGR) colours -> HTML spans, for the web UI's terminal panel. The same source runs in the browser (inlined
// into the page as ANSI_JS) and in Node (tests), so what's tested is exactly what the page runs.
// Handles reset, bold, dim, italic, underline, 16 colours (+ bright), 256-colour and 24-bit fore/background.
// Every other escape (cursor moves, erase line, OSC 8 hyperlinks) is dropped; the text is HTML-escaped.

export const ANSI_JS = String.raw`function ansiToHtml(input) {
  var BASE = ["#4b4b5c", "#ff6b8b", "#5ee3a1", "#f7c56b", "#8ab4ff", "#c4a7ff", "#6fe3e3", "#d9d9e3"];
  var BRIGHT = ["#8a8a9c", "#ff8fa6", "#86f0bb", "#ffd98f", "#b0cbff", "#dccbff", "#9ff0f0", "#ffffff"];
  function esc(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function c256(n) {
    if (n < 8) return BASE[n];
    if (n < 16) return BRIGHT[n - 8];
    if (n < 232) { n -= 16; var v = [0, 95, 135, 175, 215, 255]; return "rgb(" + v[Math.floor(n / 36)] + "," + v[Math.floor(n / 6) % 6] + "," + v[n % 6] + ")"; }
    var g = 8 + (n - 232) * 10; return "rgb(" + g + "," + g + "," + g + ")";
  }
  var s = String(input)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-La-lN-Zn-z@]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "");
  var st = { b: false, d: false, i: false, u: false, fg: null, bg: null };
  var out = "";
  var re = /\x1b\[([0-9;]*)m/g;
  var last = 0, m;
  function open() {
    var css = [];
    if (st.b) css.push("font-weight:700");
    if (st.d) css.push("opacity:.7");
    if (st.i) css.push("font-style:italic");
    if (st.u) css.push("text-decoration:underline");
    if (st.fg) css.push("color:" + st.fg);
    if (st.bg) css.push("background:" + st.bg);
    return css.length ? '<span style="' + css.join(";") + '">' : "";
  }
  function chunk(t) {
    t = t.replace(/\x1b/g, "");
    if (!t) return;
    var o = open();
    out += o + esc(t) + (o ? "</span>" : "");
  }
  while ((m = re.exec(s))) {
    chunk(s.slice(last, m.index));
    last = re.lastIndex;
    var codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (var k = 0; k < codes.length; k++) {
      var c = codes[k];
      if (c === 0) st = { b: false, d: false, i: false, u: false, fg: null, bg: null };
      else if (c === 1) st.b = true;
      else if (c === 2) st.d = true;
      else if (c === 3) st.i = true;
      else if (c === 4) st.u = true;
      else if (c === 22) { st.b = false; st.d = false; }
      else if (c === 23) st.i = false;
      else if (c === 24) st.u = false;
      else if (c >= 30 && c <= 37) st.fg = BASE[c - 30];
      else if (c >= 90 && c <= 97) st.fg = BRIGHT[c - 90];
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = BASE[c - 40];
      else if (c >= 100 && c <= 107) st.bg = BRIGHT[c - 100];
      else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && codes[k + 1] === 5) { var col = c256(codes[k + 2] || 0); if (c === 38) st.fg = col; else st.bg = col; k += 2; }
      else if ((c === 38 || c === 48) && codes[k + 1] === 2) { var rgb = "rgb(" + (codes[k + 2] || 0) + "," + (codes[k + 3] || 0) + "," + (codes[k + 4] || 0) + ")"; if (c === 38) st.fg = rgb; else st.bg = rgb; k += 4; }
    }
  }
  chunk(s.slice(last));
  return out;
}`;

export const ansiToHtml = new Function(`${ANSI_JS}\nreturn ansiToHtml;`)() as (s: string) => string;
