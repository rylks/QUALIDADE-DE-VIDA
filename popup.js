const DEFAULTS = { enabled: false, livesText: "", resetZone: 1, scanGapSec: 120, autoJogar: true };
const $ = (id) => document.getElementById(id);
const nums = ["resetZone", "scanGapSec"];
const checks = ["autoJogar"];

function parseLives(text) {
  const out = [];
  for (let s of text.split(/[\s,;]+/)) {
    s = s.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?twitch\.tv\//i, "").split(/[/?#]/)[0].replace(/^@/, "");
    if (/^[A-Za-z0-9_]{2,25}$/.test(s) && !out.includes(s.toLowerCase())) out.push(s.toLowerCase());
  }
  return out;
}

function render(st) {
  if (document.activeElement !== $("livesText")) $("livesText").value = st.livesText;
  nums.forEach((f) => { if (document.activeElement !== $(f)) $(f).value = st[f]; });
  checks.forEach((f) => ($(f).checked = !!st[f]));
  $("toggle").textContent = st.enabled ? "Desligar" : "Ligar";
  $("toggle").className = st.enabled ? "on" : "";
  $("status").textContent = st.status || (st.enabled ? "Iniciando..." : "Desligado.");
  $("summary").textContent = st.scanSummary ? "Última busca: " + st.scanSummary : "";
}

async function load() { render({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) }); }

async function save() {
  const v = { livesText: $("livesText").value };
  v.lives = parseLives(v.livesText);
  nums.forEach((f) => (v[f] = Math.max(0, parseInt($(f).value, 10) || 0)));
  checks.forEach((f) => (v[f] = $(f).checked));
  await chrome.storage.local.set(v);
  chrome.runtime.sendMessage({ type: "apply" });
}

["livesText", ...nums, ...checks].forEach((f) => $(f).addEventListener("change", save));
$("toggle").addEventListener("click", async () => {
  await save();
  const st = { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
  await chrome.storage.local.set({ enabled: !st.enabled, phase: "idle", status: st.enabled ? "Desligado." : "Iniciando..." });
  if (!st.enabled) chrome.runtime.sendMessage({ type: "apply" });
});
$("scanNow").addEventListener("click", async () => {
  await save();
  const st = await chrome.storage.local.get("enabled");
  if (!st.enabled) { await chrome.storage.local.set({ status: "Ligue a extensão primeiro." }); return; }
  chrome.runtime.sendMessage({ type: "scanNow" });
});
chrome.storage.onChanged.addListener(load);
load();
