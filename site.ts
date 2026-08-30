import type { SitePayload } from "./payload";

const CSS = `
:root{
  --paper:#DCE0D5; --paper-2:#E7EAE0; --card:#F1F3EB;
  --ink:#191E19; --muted:#6B7368; --rule:#BDC4B3;
  --brass:#9C7C2E; --spark:#B0432A;
  --p1:#2E6B57; --p2:#7A4B86;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:var(--paper); color:var(--ink);
  font-family:"Karla",system-ui,sans-serif; font-size:16px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 80px}

/* ---- masthead ---- */
.mast{border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:6px}
.mast h1{
  font-family:"Instrument Serif",Georgia,serif; font-weight:400;
  font-size:clamp(44px,13vw,76px); line-height:.9; letter-spacing:-.02em; margin:0;
}
.mast .sub{
  display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  font-family:"JetBrains Mono",ui-monospace,monospace;
  font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:12px;
}
.key{display:flex;gap:14px;align-items:center}
.who{display:flex;gap:6px;align-items:center}
.swatch{width:9px;height:9px;border-radius:50%}

/* ---- filters ---- */
.filters{display:flex;gap:6px;flex-wrap:wrap;margin:22px 0 4px}
.filters button{
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.1em;
  text-transform:uppercase;padding:7px 12px;border:1px solid var(--rule);background:transparent;
  color:var(--muted);border-radius:999px;cursor:pointer;transition:.16s;
}
.filters button:hover{border-color:var(--ink);color:var(--ink)}
.filters button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--paper-2)}
.filters button:focus-visible{outline:2px solid var(--brass);outline-offset:2px}

/* ---- entry ---- */
.entry{
  display:grid;grid-template-columns:38px 1fr;gap:0 14px;
  padding:22px 0;border-bottom:1px solid var(--rule);
}
.rank{
  font-family:"Instrument Serif",Georgia,serif;font-size:30px;line-height:1;
  color:var(--brass);padding-top:2px;
}
.rank.plain{color:var(--rule)}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.name{font-family:"Instrument Serif",Georgia,serif;font-size:25px;line-height:1.12;margin:0}
.total{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:19px;font-variant-numeric:tabular-nums}
.meta{
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted);margin-top:5px;
}

/* ---- the signature: both scores on one 1-10 track ---- */
.track{position:relative;height:26px;margin:14px 0 2px;grid-column:2}
.axis{position:absolute;top:12px;left:0;right:0;height:1px;background:var(--rule)}
.span{position:absolute;top:11px;height:3px;background:var(--ink);opacity:.22;border-radius:2px}
.span.wide{background:var(--spark);opacity:.5}
.dot{
  position:absolute;top:6px;width:13px;height:13px;border-radius:50%;
  margin-left:-6.5px;border:2px solid var(--paper);
}
.dot span{
  position:absolute;top:15px;left:50%;transform:translateX(-50%);
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:9.5px;color:var(--muted);
}
.ticks{
  position:absolute;top:-3px;left:0;right:0;display:flex;justify-content:space-between;
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:9px;color:var(--rule);
}

.photo{grid-column:2;margin-top:14px;border-radius:3px;overflow:hidden;background:var(--card)}
.photo img{display:block;width:100%;height:auto;max-height:300px;object-fit:cover}

.breakdown{grid-column:2;margin-top:12px;display:none}
.breakdown.open{display:block}
.bd-row{
  display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11.5px;
  padding:4px 0;border-bottom:1px dotted var(--rule);
}
.bd-row span:first-child{letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.bd-row b{font-weight:500;font-variant-numeric:tabular-nums;min-width:22px;text-align:right}
.toggle{
  grid-column:2;margin-top:10px;background:none;border:0;padding:0;cursor:pointer;
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--rule);
}
.toggle:hover{color:var(--ink)}
.toggle:focus-visible{outline:2px solid var(--brass);outline-offset:3px}

.section-label{
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10.5px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--muted);margin:40px 0 6px;
}
.pending li{
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;color:var(--muted);
  padding:7px 0;border-bottom:1px dotted var(--rule);list-style:none;
  display:flex;justify-content:space-between;gap:12px;
}
.pending ul{margin:0;padding:0}
.empty{
  font-family:"Instrument Serif",Georgia,serif;font-size:21px;color:var(--muted);
  padding:52px 0;text-align:center;
}
footer{
  margin-top:44px;font-family:"JetBrains Mono",ui-monospace,monospace;
  font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

export function renderSite(payload: SitePayload, key: string): string {
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>The List</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Karla:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head><body>
<div class="wrap">
  <header class="mast">
    <h1>The List</h1>
  </header>
  <div class="sub">
    <span id="count"></span>
    <span class="key" id="key"></span>
  </div>

  <nav class="filters" id="filters"></nav>
  <main id="board"></main>
  <section id="pending"></section>
  <footer id="foot"></footer>
</div>
<script>
const DATA = ${data};
const KEY = ${JSON.stringify(key)};
const P = ["--p1","--p2"];
const TIER = {cheap:"Cheap eats", normal:"Normal", fancy:"Fancy"};
const CATS = ["food","ambiance","aesthetics","service"];
let filter = "all";

const colourOf = i => getComputedStyle(document.documentElement).getPropertyValue(P[i % 2]).trim();
const person = id => DATA.people.find(p => p.id === id) || {name:"?"};
const personIndex = id => Math.max(0, DATA.people.findIndex(p => p.id === id));
const pos = s => ((s - 1) / 9) * 100;

function trackHtml(e){
  const sorted = [...e.scores].sort((a,b) => a.total - b.total);
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const wide = e.gap >= 1.5;
  const dots = e.scores.map(s => {
    const c = colourOf(personIndex(s.personId));
    return '<i class="dot" style="left:' + pos(s.total) + '%;background:' + c + '">'
      + '<span>' + s.total.toFixed(1) + '</span></i>';
  }).join("");
  return '<div class="track">'
    + '<div class="ticks"><span>1</span><span>10</span></div>'
    + '<div class="axis"></div>'
    + '<div class="span' + (wide ? " wide" : "") + '" style="left:' + pos(lo.total)
      + '%;width:' + (pos(hi.total) - pos(lo.total)) + '%"></div>'
    + dots + '</div>';
}

function entryHtml(e, i){
  const rank = filter === "all" ? e.overallRank : e.tierRank;
  const meta = [TIER[e.tier], e.visited_on || "date unknown"];
  if (e.gap >= 1.5) meta.push("split " + e.gap.toFixed(1));
  const photo = e.photo
    ? '<div class="photo"><img loading="lazy" alt="" src="/photo/' + e.id + (KEY ? "?k=" + encodeURIComponent(KEY) : "") + '"></div>'
    : "";
  const rows = CATS.map(c =>
    '<div class="bd-row"><span>' + c + '</span>'
    + e.scores.map(s => '<b style="color:' + colourOf(personIndex(s.personId)) + '">' + s[c] + '</b>').join("")
    + '</div>').join("");
  return '<article class="entry">'
    + '<div class="rank' + (rank > 3 ? " plain" : "") + '">' + rank + '</div>'
    + '<div><div class="head"><h2 class="name">' + esc(e.name) + '</h2>'
    + '<span class="total">' + e.combined.toFixed(2) + '</span></div>'
    + '<div class="meta">' + meta.join(" &middot; ") + '</div></div>'
    + trackHtml(e) + photo
    + '<button class="toggle" data-i="' + i + '" aria-expanded="false">All four scores</button>'
    + '<div class="breakdown">' + rows + '</div>'
    + '</article>';
}

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function render(){
  const list = DATA.entries.filter(e => filter === "all" || e.tier === filter);
  const board = document.getElementById("board");
  board.innerHTML = list.length
    ? list.map(entryHtml).join("")
    : '<p class="empty">Nothing rated here yet. Add a place with /add in Telegram.</p>';

  board.querySelectorAll(".toggle").forEach(btn => {
    btn.onclick = () => {
      const bd = btn.nextElementSibling;
      const open = bd.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Hide" : "All four scores";
    };
  });

  document.querySelectorAll("#filters button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.t === filter)));
}

document.getElementById("count").textContent =
  DATA.entries.length + " rated" + (DATA.pending.length ? " · " + DATA.pending.length + " in progress" : "");

document.getElementById("key").innerHTML = DATA.people.map((p, i) =>
  '<span class="who"><i class="swatch" style="background:' + colourOf(i) + '"></i>' + esc(p.name) + '</span>'
).join("");

document.getElementById("filters").innerHTML =
  [["all","Overall"],["cheap","Cheap"],["normal","Normal"],["fancy","Fancy"]]
    .map(([t,label]) => '<button data-t="' + t + '">' + label + " " + (DATA.counts[t] || 0) + "</button>")
    .join("");

document.querySelectorAll("#filters button").forEach(b => {
  b.onclick = () => { filter = b.dataset.t; render(); };
});

if (DATA.pending.length) {
  document.getElementById("pending").innerHTML =
    '<div class="section-label">Waiting on a rating</div><div class="pending"><ul>'
    + DATA.pending.map(p => "<li><span>" + esc(p.name) + "</span><span>" + esc(p.progress) + "</span></li>").join("")
    + "</ul></div>";
}

document.getElementById("foot").textContent =
  "Scores weighted by tier · dots are each of you, the bar between is how far apart";

render();
</script>
</body></html>`;
}
