/* İplik Takip Masası — app.js (v3)
   Veri: Firebase Firestore (tek doğru kaynak) + çevrimdışı önbellek.
   Koleksiyon adları ve konteyner alanları eski sürümle uyumludur. */

// =====================================================
// 1. AYARLAR VE SABİTLER
// =====================================================
const WAREHOUSES = ["RÜYA", "KARAMAN", "ACAR"];          // depo listesi: buradan değiştirilir

// Konteyner kapasitesi (ton): normal aralık ve mutlak üst sınır. Buradan değiştirilir.
const CAPACITY = { min: 21, max: 24.5, hard: 25 };
const DEFAULT_PLAN_TON = 22;   // siparişte konteynere yazılan hedef ton

const STAGE_ORDER = ["white", "yellow", "green", "red", "blue"];
const STAGE = {
  white:  { label: "Beklemede" },
  yellow: { label: "Siparişte" },
  green:  { label: "Yolda" },
  red:    { label: "Limanda" },
  blue:   { label: "Depoda" }
};

const INCOTERMS = {
  FOB: { hint: "Mal yükleme limanında teslim edilir. Navlun alıcıya aittir.", freight: "Navlun alıcıda" },
  CNF: { hint: "Varış limanına kadar navlun satıcıya aittir. Sigorta alıcıdadır.", freight: "Navlun satıcıda" },
  CIF: { hint: "Navlun ve sigorta varış limanına kadar satıcıya aittir.", freight: "Navlun satıcıda" },
  EXW: { hint: "Mal satıcının deposunda teslim edilir. Tüm nakliye alıcıya aittir.", freight: "Navlun alıcıda" }
};

// =====================================================
// 2. YARDIMCILAR
// =====================================================
const $ = id => document.getElementById(id);

// Ekrana basılan her kullanıcı metni buradan geçer
function esc(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fmtDate(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? m[3] + "." + m[2] + "." + m[1] : iso;
}
function fmtShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? m[3] + "." + m[2] : (iso || "");
}
function daysUntil(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3]);
  const n = new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((t - today) / 86400000);
}
function relDays(d) {
  if (d === 0) return "bugün";
  return d > 0 ? d + " gün kaldı" : Math.abs(d) + " gün gecikti";
}
function relClass(d) { return d < 0 ? "late" : (d <= 3 ? "soon" : ""); }

function fmtNum(n) { return Number(n || 0).toLocaleString("tr-TR"); }
function fmtTon(kg) { return (Number(kg || 0) / 1000).toLocaleString("tr-TR", { maximumFractionDigits: 2 }) + " t"; }
function fmtTonRaw(t) { return Number(t || 0).toLocaleString("tr-TR", { maximumFractionDigits: 3 }); }
function nowStr() { return new Date().toLocaleString("tr-TR"); }

// "58.750 $", "58,750.50", "24500" gibi yazımları sayıya çevirir
function parseMoney(t) {
  if (t === null || t === undefined) return 0;
  let s = String(t).replace(/[^\d.,]/g, "");
  if (!s) return 0;
  const hasDot = s.includes("."), hasCom = s.includes(",");
  if (hasDot && hasCom) {
    const dec = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const thou = dec === "." ? "," : ".";
    s = s.split(thou).join("").replace(dec, ".");
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  } else if (hasCom) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function fmtMoney(n) { return n ? Number(n).toLocaleString("tr-TR", { maximumFractionDigits: 2 }) + " $" : "—"; }
function round2(n) { return Math.round(n * 100) / 100; }
function fmtPriceVal(n) { return Number(n || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }

// Konteyner ağırlığının (kg) kapasiteye göre durumu
function capState(kg) {
  if (!kg) return null;
  const t = kg / 1000;
  if (t < CAPACITY.min) return { cls: "low", short: "Kapasite altı", text: "kapasite altı (en az " + fmtTonRaw(CAPACITY.min) + " t)" };
  if (t <= CAPACITY.max) return { cls: "ok", short: "Normal", text: "normal aralıkta" };
  if (t <= CAPACITY.hard) return { cls: "edge", short: "Üst sınırda", text: "üst sınırda (" + fmtTonRaw(CAPACITY.max) + " t üstü)" };
  return { cls: "over", short: "Kapasite aşıldı", text: "kapasite aşıldı (en çok " + fmtTonRaw(CAPACITY.hard) + " t)" };
}
function capTag(c) {
  if (stageOf(c) === "white") return "";
  const cs = capState(bestKg(c));
  return cs && cs.cls !== "ok" ? '<span class="cap cap-' + cs.cls + '">' + esc(cs.short) + "</span>" : "";
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  box: '<rect x="3" y="7" width="18" height="11" rx="1"/><path d="M7 7v11M11 7v11M15 7v11M19 7v11"/>',
  stack: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="18" height="8" rx="1"/>',
  ship: '<path d="M3 17l2 3h14l2-3H3z"/><path d="M6 17v-6h12v6M9 11V7h6v4"/>',
  anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 12H3a9 9 0 0 0 18 0h-2M8 12h8"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  dots: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  warehouse: '<path d="M3 21V9l9-5 9 5v12M9 21v-6h6v6"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'
};
function ic(name) {
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
}

// =====================================================
// 3. FIREBASE
// =====================================================
const firebaseConfig = {
  apiKey: "AIzaSyCwwSwyzbCKYj2D7JEwtQe13rT_8IPg7O8",
  authDomain: "yarn-tracking-65734.firebaseapp.com",
  projectId: "yarn-tracking-65734",
  storageBucket: "yarn-tracking-65734.firebasestorage.app",
  messagingSenderId: "493441372255",
  appId: "1:493441372255:web:14bc6e52f15feca8724bea"
};

let db = null;
let companiesCol, proformasCol, containersCol;

try {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  db.enablePersistence({ synchronizeTabs: true }).catch(err => console.warn("Persistence:", err.code));
  companiesCol = db.collection("yarn_companies");
  proformasCol = db.collection("yarn_proformas");
  containersCol = db.collection("yarn_containers");
} catch (err) {
  db = null;
  console.warn("Firebase kullanılamıyor, yerel mod:", err);
}

const serverTs = () => (db ? firebase.firestore.FieldValue.serverTimestamp() : null);
function warnWrite(e) { console.warn("Yazma hatası:", e); }
function remoteSet(col, id, data) { if (col) col.doc(id).set(data, { merge: true }).catch(warnWrite); }
function remoteDelete(col, id) { if (col) col.doc(id).delete().catch(warnWrite); }
function remoteBatch(fn) {
  if (!db) return;
  const b = db.batch();
  fn(b);
  b.commit().catch(warnWrite);
}

// =====================================================
// 4. DURUM
// =====================================================
function loadData(key, def) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : def; } catch (e) { return def; }
}
function saveData(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

function companyId(name) { return String(name).replace(/\//g, "_"); }
function companyTime(c) {
  if (typeof c.order === "number") return c.order;
  if (c.createdAt && c.createdAt.seconds) return c.createdAt.seconds * 1000;
  return 0;
}
function loadCompanyDocs() {
  const v2 = loadData("app_companies_v2", null);
  if (v2) return v2;
  const v1 = loadData("app_companies_v1", ["DODHIA", "HARMONY", "AYM"]);
  return v1.map((n, i) => ({ id: companyId(n), name: n, order: i }));
}

let companyDocs = [];
let companies = [];
let proformas = loadData("app_proformas_v1", []);
let containers = loadData("app_containers_v1", []);

function setCompanies(docs) {
  companyDocs = docs.slice().sort((a, b) => (companyTime(a) - companyTime(b)) || String(a.name).localeCompare(String(b.name), "tr"));
  companies = companyDocs.map(c => c.name);
}
setCompanies(loadCompanyDocs());

function cacheAll() {
  saveData("app_companies_v2", companyDocs);
  saveData("app_proformas_v1", proformas);
  saveData("app_containers_v1", containers);
}

// Ekran durumu (filtreler, açık/kapalı bölümler)
const ui = { tab: "active", company: "all", stage: "all", q: "", expanded: new Set() };

function pfTime(p) {
  return p.timestamp || (p.createdAt && p.createdAt.seconds ? p.createdAt.seconds * 1000 : 0) || parseInt(String(p.id).replace("pf_", ""), 10) || 0;
}
function stageOf(c) { return STAGE[c.status] ? c.status : "white"; }
function stagePriority(st) { return { white: 1, yellow: 1, green: 2, red: 3, blue: 4 }[st] || 1; }
function cntSort(a, b) {
  const pa = stagePriority(stageOf(a)), pb = stagePriority(stageOf(b));
  if (pa !== pb) return pa - pb;
  return (a.orderIndex || 0) - (b.orderIndex || 0);
}
function byIndex(a, b) { return (a.orderIndex || 0) - (b.orderIndex || 0); }
const findC = id => containers.find(c => c.id === id);
const findPf = id => proformas.find(p => p.id === id);

function orderKg(c) { return c.weightTon ? Math.round(c.weightTon * 1000) : 0; }
function cartonsOf(c) { return (c.loadedItems || []).reduce((a, it) => a + (Number(it.cartons) || 0), 0); }
function docLabel(c) { const d = c.docsStatus || "pending"; return d === "received" ? "Tamam" : d === "partial" ? "Eksik" : "Bekleniyor"; }
function bestKg(c) {
  const st = stageOf(c);
  if (st === "white" || st === "yellow") return orderKg(c);
  return c.weightKg || orderKg(c);
}

function updateContainer(id, patch) {
  const c = findC(id);
  if (!c) return;
  Object.assign(c, patch);
  cacheAll();
  remoteSet(containersCol, id, patch);
}

function blankContainer(pf, idx, total, stamp) {
  return {
    id: "cnt_" + stamp + "_" + idx,
    pfId: pf.id, supplier: pf.supplier, pfNo: pf.no, pfDate: pf.date || "",
    order: idx + " / " + total, orderIndex: idx,
    no: "", shippingLine: "", blNo: "", weightTon: 0, weightKg: 0, totalCost: "", unitPrice: 0, extraCost: 0, calcNote: "", docsStatus: "pending", docsDate: "", docsNote: "",
    orderDate: "", orderItems: [], loadedItems: [], details: "",
    status: "white", loadingDate: "", arrivalDate: "", warehouseDate: "", warehouseName: "",
    statusBeforeWarehouse: ""
  };
}

// Bir proformanın konteyner sıra numaralarını 1..n olarak yeniden yazar
function renumber(pfId) {
  const list = containers.filter(c => c.pfId === pfId).sort(byIndex);
  list.forEach((c, i) => { c.orderIndex = i + 1; c.order = (i + 1) + " / " + list.length; });
  return list;
}

function setBadge(online) {
  const b = $("syncBadge");
  if (!b) return;
  if (!db) { b.className = "sync"; b.innerText = "Yerel mod"; return; }
  b.className = "sync" + (online ? " online" : "");
  b.innerText = online ? "Bulut senkron" : "Çevrimdışı";
}

// =====================================================
// 5. PENCERELER, BİLDİRİM, ONAY, PIN
// =====================================================
function showModal(id) { $(id).classList.add("open"); }
function hideModal(id) { $(id).classList.remove("open"); }
function closeAllModals() { document.querySelectorAll(".modal.open").forEach(m => m.classList.remove("open")); }

function toast(msg, kind) {
  const t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.textContent = msg;
  $("toasts").appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, kind === "err" ? 4200 : 2600);
}

let confirmResolve = null;
function askConfirm(opt) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    $("confirmTitle").textContent = opt.title;
    $("confirmText").textContent = opt.text || "";
    const ok = $("confirmOk");
    ok.textContent = opt.okText || "Onayla";
    ok.className = "btn " + (opt.danger ? "btn-danger" : "btn-primary");
    showModal("modalConfirm");
  });
}
function resolveConfirm(v) {
  hideModal("modalConfirm");
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(v); }
}

let pendingDeletionAction = null;
function requestPinProtectedAction(cb) {
  pendingDeletionAction = cb;
  const pin = $("inputPinCode");
  pin.value = "";
  $("pinErrorMsg").style.display = "none";
  showModal("modalPinAuth");
  setTimeout(() => pin.focus(), 100);
}
function validateAndExecutePin() {
  if ($("inputPinCode").value.trim() === "1989") {
    hideModal("modalPinAuth");
    if (typeof pendingDeletionAction === "function") pendingDeletionAction();
    pendingDeletionAction = null;
  } else {
    $("pinErrorMsg").style.display = "block";
  }
}

// =====================================================
// 6. FİRMALAR
// =====================================================
function openCompanies() { updateCompanyList(); showModal("modalCompany"); setTimeout(() => $("inputCompName").focus(), 80); }

function addCompany() {
  const inp = $("inputCompName");
  const val = inp.value.trim().toLocaleUpperCase("tr-TR");
  if (!val) { toast("Firma adını yazın.", "err"); return; }
  if (companies.includes(val)) { toast("Bu firma zaten kayıtlı.", "err"); return; }

  const id = companyId(val);
  const order = Date.now();
  setCompanies(companyDocs.concat([{ id, name: val, order }]));
  cacheAll();
  inp.value = "";
  updateCompanyList();
  renderAll();
  toast(val + " eklendi");
  remoteSet(companiesCol, id, { name: val, order, createdAt: serverTs() });
}

async function removeCompany(name) {
  if (proformas.some(p => p.supplier === name && !p.isArchived)) {
    toast(name + " firmasının aktif proforması var. Önce arşivleyin.", "err");
    return;
  }
  const ok = await askConfirm({ title: name + " silinsin mi?", text: "Firma listeden kalkar. Arşivdeki kayıtları etkilenmez.", okText: "Evet, sil", danger: true });
  if (!ok) return;
  const doc = companyDocs.find(c => c.name === name);
  setCompanies(companyDocs.filter(c => c.name !== name));
  if (ui.company === name) ui.company = "all";
  cacheAll();
  updateCompanyList();
  renderAll();
  if (doc) remoteDelete(companiesCol, doc.id);
}

function updateCompanyList() {
  $("companyList").innerHTML = companies.map(c =>
    '<div class="list-row"><span>' + esc(c) + '</span><button class="btn btn-ghost btn-sm" data-action="removeCompany" data-name="' + esc(c) + '">Sil</button></div>'
  ).join("") || '<p class="sheet-sub">Henüz firma yok.</p>';
}

// =====================================================
// 7. PROFORMA (OLUŞTUR / DÜZENLE / KONTEYNER EKLE / ARŞİV / SİL)
// =====================================================
let editingPfId = null;

function updateIncotermHelp() {
  const v = $("pfIncoterm").value;
  $("pfIncotermHelp").textContent = v && INCOTERMS[v] ? INCOTERMS[v].hint : "";
}

function updatePfEstimate() {
  const n = parseInt($("pfTotal").value, 10) || 0;
  const plan = parseFloat($("pfPlanTon").value) || 0;
  const price = parseFloat($("pfPriceKg").value) || 0;
  const parts = [];
  if (n && plan) parts.push(n + " konteyner × " + fmtTonRaw(plan) + " t = " + fmtTonRaw(n * plan) + " t");
  if (n && plan && price) parts.push("tahmini " + fmtMoney(n * plan * 1000 * price));
  let txt = parts.join(" → ");
  const cs = capState(plan * 1000);
  if (cs && cs.cls !== "ok") txt += (txt ? " · " : "") + "plan " + cs.text;
  $("pfEstimate").textContent = txt;
}

function openProformaModal(pfId, presetSupplier) {
  if (!companies.length) {
    toast("Önce bir firma ekleyin.", "err");
    openCompanies();
    return;
  }
  editingPfId = pfId || null;
  const sel = $("pfSupplierSelect");
  sel.innerHTML = companies.map(c => '<option value="' + esc(c) + '">' + esc(c) + "</option>").join("");
  $("pfError").style.display = "none";

  if (editingPfId) {
    const p = findPf(editingPfId);
    if (!p) return;
    $("pfModalTitle").textContent = "Proformayı düzenle";
    $("pfModalSub").textContent = p.supplier + " firması";
    if (!companies.includes(p.supplier)) sel.innerHTML += '<option value="' + esc(p.supplier) + '">' + esc(p.supplier) + "</option>";
    sel.value = p.supplier;
    sel.disabled = true;
    $("pfNumber").value = p.no || "";
    $("pfDate").value = p.date || "";
    $("pfIncoterm").value = p.incoterm || "";
    $("pfTotal").value = p.total;
    $("pfTotal").disabled = true;
    $("pfPriceKg").value = p.pricePerKg || "";
    $("pfPlanTon").value = p.planTon || DEFAULT_PLAN_TON;
    $("pfNote").value = p.note || "";
    $("pfSaveBtn").textContent = "Değişiklikleri kaydet";
  } else {
    $("pfModalTitle").textContent = "Yeni proforma";
    $("pfModalSub").textContent = "Konteynerler otomatik oluşturulur";
    sel.disabled = false;
    if (presetSupplier && companies.includes(presetSupplier)) sel.value = presetSupplier;
    else if (ui.company !== "all" && companies.includes(ui.company)) sel.value = ui.company;
    $("pfNumber").value = "";
    $("pfDate").value = todayISO();
    $("pfIncoterm").value = "";
    $("pfTotal").value = 3;
    $("pfTotal").disabled = false;
    $("pfPriceKg").value = "";
    $("pfPlanTon").value = DEFAULT_PLAN_TON;
    $("pfNote").value = "";
    $("pfSaveBtn").textContent = "Proformayı kaydet";
  }
  updateIncotermHelp();
  updatePfEstimate();
  showModal("modalProforma");
}

function saveProforma() {
  const supplier = $("pfSupplierSelect").value;
  const no = $("pfNumber").value.trim().toUpperCase();
  const date = $("pfDate").value;
  const incoterm = $("pfIncoterm").value;
  const total = parseInt($("pfTotal").value, 10);
  const pricePerKg = parseFloat($("pfPriceKg").value) || 0;
  const planTon = parseFloat($("pfPlanTon").value) || DEFAULT_PLAN_TON;
  const note = $("pfNote").value.trim();
  const err = $("pfError");

  const fail = msg => { err.textContent = msg; err.style.display = "block"; };
  if (!supplier) return fail("Firma seçin.");
  if (!no) return fail("Proforma numarasını yazın.");
  if (!incoterm) return fail("Teslim şeklini seçin (FOB, CNF...).");
  if (!editingPfId && (!total || total < 1)) return fail("Konteyner sayısı en az 1 olmalı.");
  err.style.display = "none";

  if (editingPfId) {
    const p = findPf(editingPfId);
    if (!p) return;
    const relabel = p.no !== no || (p.date || "") !== (date || "");
    const patch = { no, date, incoterm, pricePerKg, planTon, note };
    Object.assign(p, patch);
    let changed = [];
    if (relabel) {
      changed = containers.filter(c => c.pfId === p.id);
      changed.forEach(c => { c.pfNo = no; c.pfDate = date; });
    }
    cacheAll();
    hideModal("modalProforma");
    renderAll();
    toast("Proforma güncellendi");
    remoteBatch(b => {
      b.set(proformasCol.doc(p.id), patch, { merge: true });
      changed.forEach(c => b.set(containersCol.doc(c.id), { pfNo: no, pfDate: date }, { merge: true }));
    });
    return;
  }

  const stamp = Date.now();
  const pf = { id: "pf_" + stamp, supplier, no, date, incoterm, total, pricePerKg, planTon, note, isArchived: false, timestamp: stamp };
  const list = [];
  for (let i = 1; i <= total; i++) list.push(blankContainer(pf, i, total, stamp));

  proformas.unshift(pf);
  containers = containers.concat(list);
  cacheAll();
  hideModal("modalProforma");
  ui.tab = "active";
  renderAll();
  toast(no + " oluşturuldu, " + total + " konteyner eklendi");

  remoteBatch(b => {
    b.set(proformasCol.doc(pf.id), Object.assign({}, pf, { createdAt: serverTs() }));
    list.forEach(c => b.set(containersCol.doc(c.id), Object.assign({}, c, { createdAt: serverTs() })));
  });
}

function addContainerToProforma(pfId) {
  const pf = findPf(pfId);
  if (!pf) return;
  const existing = containers.filter(c => c.pfId === pfId);
  const idx = existing.reduce((m, c) => Math.max(m, c.orderIndex || 0), 0) + 1;
  const stamp = Date.now();
  const fresh = blankContainer(pf, idx, existing.length + 1, stamp);
  containers.push(fresh);
  const list = renumber(pfId);
  pf.total = list.length;
  cacheAll();
  renderAll();
  toast("Konteyner eklendi (" + list.length + " adet)");
  remoteBatch(b => {
    b.set(proformasCol.doc(pf.id), { total: pf.total }, { merge: true });
    list.forEach(c => {
      if (c.id === fresh.id) b.set(containersCol.doc(c.id), Object.assign({}, c, { createdAt: serverTs() }));
      else b.set(containersCol.doc(c.id), { orderIndex: c.orderIndex, order: c.order }, { merge: true });
    });
  });
}

async function toggleArchive(pfId, archive) {
  const p = findPf(pfId);
  if (!p) return;
  const ok = await askConfirm(archive
    ? { title: p.no + " arşive taşınsın mı?", text: "Tüm konteynerleriyle birlikte arşive gider. İstediğiniz zaman geri alabilirsiniz.", okText: "Arşive taşı" }
    : { title: p.no + " panoya dönsün mü?", text: "Proforma aktif listeye geri gelir.", okText: "Panoya al" });
  if (!ok) return;
  p.isArchived = archive;
  cacheAll();
  renderAll();
  toast(archive ? "Arşive taşındı" : "Panoya alındı");
  remoteSet(proformasCol, pfId, { isArchived: archive });
}

function permanentDeleteProforma(id) {
  requestPinProtectedAction(() => {
    if (!findPf(id)) return;
    const cntIds = containers.filter(c => c.pfId === id).map(c => c.id);
    proformas = proformas.filter(p => p.id !== id);
    containers = containers.filter(c => c.pfId !== id);
    cacheAll();
    renderAll();
    toast("Proforma kalıcı olarak silindi");
    remoteBatch(b => {
      b.delete(proformasCol.doc(id));
      cntIds.forEach(cid => b.delete(containersCol.doc(cid)));
    });
  });
}

function permanentDeleteContainer(id) {
  requestPinProtectedAction(() => {
    const c = findC(id);
    if (!c) return;
    const pf = findPf(c.pfId);
    containers = containers.filter(x => x.id !== id);
    const remaining = renumber(c.pfId);
    const pfGone = pf && remaining.length === 0;
    if (pfGone) proformas = proformas.filter(p => p.id !== pf.id);
    else if (pf) pf.total = remaining.length;
    cacheAll();
    renderAll();
    toast("Konteyner kalıcı olarak silindi");
    remoteBatch(b => {
      b.delete(containersCol.doc(id));
      if (pfGone) b.delete(proformasCol.doc(pf.id));
      else if (pf) {
        b.set(proformasCol.doc(pf.id), { total: pf.total }, { merge: true });
        remaining.forEach(x => b.set(containersCol.doc(x.id), { orderIndex: x.orderIndex, order: x.order }, { merge: true }));
      }
    });
  });
}

// =====================================================
// 8. KONTEYNER AŞAMALARI
// =====================================================
function cntLabel(c) {
  const pf = findPf(c.pfId);
  return (pf ? pf.supplier + " / " + pf.no : c.pfNo || "") + " / Konteyner " + c.order;
}

function buildYarnRow(codeClass, valClass, placeholder, step, code, val, onChange, third) {
  const div = document.createElement("div");
  div.className = "yarn-row";
  const i1 = document.createElement("input");
  i1.type = "text"; i1.placeholder = "İplik / renk kodu"; i1.className = codeClass; i1.value = code || "";
  const i2 = document.createElement("input");
  i2.type = "number"; i2.step = step; i2.placeholder = placeholder; i2.className = valClass; i2.value = val ? val : "";
  let i3 = null;
  if (third) {
    i3 = document.createElement("input");
    i3.type = "number"; i3.step = "1"; i3.min = "0"; i3.placeholder = third.ph; i3.className = third.cls; i3.value = third.val ? third.val : "";
  }
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "icon-btn"; btn.textContent = "✕"; btn.setAttribute("aria-label", "Satırı sil");
  btn.addEventListener("click", () => { div.remove(); onChange(); });
  div.append.apply(div, i3 ? [i1, i2, i3, btn] : [i1, i2, btn]);
  return div;
}

function addOrderRow(code, ton) {
  $("orderItemsContainer").appendChild(buildYarnRow("order-code-input", "order-ton-input", "Ton", "0.01", code, ton, updateOrderTotal));
  updateOrderTotal();
}
function addLoadedRow(code, kg, cartons) {
  $("loadedItemsContainer").appendChild(buildYarnRow("loaded-code-input", "loaded-kg-input", "Kg", "1", code, kg,
    () => { syncAutoWeight(); refreshStatusCalc(); }, { cls: "loaded-ctn-input", ph: "Karton", val: cartons }));
  updateWeightCheck();
}

function updateOrderTotal() {
  let tons = 0;
  document.querySelectorAll("#orderItemsContainer .order-ton-input").forEach(i => { tons += parseFloat(i.value) || 0; });
  const c = findC($("orderCntId").value);
  const pf = c && findPf(c.pfId);
  const plan = (pf && pf.planTon) || DEFAULT_PLAN_TON;
  const cs = capState(tons * 1000);
  const el = $("orderTotalInfo");
  el.textContent = "Toplam: " + fmtTonRaw(tons) + " ton" + (cs ? " · " + cs.text : "");
  el.className = "total-line" + (cs ? " cap-" + cs.cls : "");
  $("orderTarget").textContent = "Hedef " + fmtTonRaw(plan) + " t · kapasite " + fmtTonRaw(CAPACITY.min) + " – " + fmtTonRaw(CAPACITY.max) + " t (en çok " + fmtTonRaw(CAPACITY.hard) + " t)";
  if (pf && pf.pricePerKg && tons) $("orderTarget").textContent += " · tahmini " + fmtMoney(tons * 1000 * pf.pricePerKg);
}
function loadedSum() {
  let s = 0;
  document.querySelectorAll("#loadedItemsContainer .loaded-kg-input").forEach(i => { s += parseFloat(i.value) || 0; });
  return s;
}
// Toplam kilo elle yazılmadıysa kalemlerin toplamı otomatik gelir
function syncAutoWeight() {
  const w = $("statusWeightKg");
  if (w.dataset.manual !== "1") { const s = loadedSum(); w.value = s || ""; }
}
function updateWeightCheck() {
  const sum = loadedSum();
  const total = parseFloat($("statusWeightKg").value) || 0;
  const cap = $("capCheck");
  const el = $("weightCheck");
  const cs = capState(total || sum);
  if (cs) {
    cap.className = "wcheck " + (cs.cls === "ok" ? "ok" : cs.cls === "over" ? "bad" : "warn");
    cap.textContent = "Konteyner ağırlığı " + fmtTonRaw((total || sum) / 1000) + " t: " + cs.text + ".";
  } else { cap.className = "wcheck"; cap.textContent = ""; }
  if (!sum && !total) { el.className = "wcheck"; el.textContent = ""; return; }
  const diff = total - sum;
  if (Math.abs(diff) < 0.5) {
    el.className = "wcheck ok";
    el.textContent = "Kalemlerin toplamı (" + fmtNum(sum) + " kg) toplam net kiloyla aynı.";
  } else {
    el.className = "wcheck bad";
    el.textContent = "Kalemler " + fmtNum(sum) + " kg, toplam net kilo " + fmtNum(total) + " kg. Fark: " + fmtNum(Math.abs(diff)) + " kg.";
  }
}

// ---- Hesap bölümü: kilo x birim fiyat = tutar ----
function calcNums() {
  const kg = parseFloat($("statusWeightKg").value) || 0;
  const unit = parseFloat($("statusUnitPrice").value) || 0;
  return { kg, unit, invoice: parseMoney($("statusTotalCost").value), extra: parseFloat($("statusExtraCost").value) || 0, calc: kg && unit ? round2(kg * unit) : 0 };
}
function syncAutoCost() {
  const f = $("statusTotalCost");
  if (f.dataset.manual === "1") return;
  const n = calcNums();
  f.value = n.calc ? String(n.calc) : "";
}
function updateCalc() {
  const n = calcNums();
  const rows = [];
  if (n.calc) rows.push(["Hesaplanan tutar", fmtNum(n.kg) + " kg × " + fmtPriceVal(n.unit) + " = " + fmtMoney(n.calc), ""]);
  if (n.calc && n.invoice) {
    const d = round2(n.invoice - n.calc);
    rows.push(["Fatura farkı", Math.abs(d) < 0.5 ? "yok" : (d > 0 ? "+" : "−") + fmtMoney(Math.abs(d)), Math.abs(d) < 0.5 ? "good" : "bad"]);
  }
  if (n.invoice && n.extra) rows.push(["Toplam maliyet (fatura + ek masraf)", fmtMoney(n.invoice + n.extra), "strong"]);
  if (n.invoice && n.kg) rows.push(["Kilo başına maliyet", fmtPriceVal((n.invoice + n.extra) / n.kg) + " $/kg", "strong"]);
  const c = findC($("statusCntId").value);
  const planKg = c ? orderKg(c) : 0;
  if (planKg && n.kg) {
    const d = n.kg - planKg;
    rows.push(["Plana göre", fmtTonRaw(n.kg / 1000) + " t, plan " + fmtTonRaw(planKg / 1000) + " t (" + (d >= 0 ? "+" : "−") + fmtTonRaw(Math.abs(d) / 1000) + " t)", ""]);
  }
  let ctn = 0;
  document.querySelectorAll("#loadedItemsContainer .loaded-ctn-input").forEach(i => { ctn += parseFloat(i.value) || 0; });
  if (ctn) rows.push(["Toplam karton", fmtNum(ctn) + (n.kg ? " (ort. " + fmtNum(Math.round(n.kg / ctn * 100) / 100) + " kg/karton)" : ""), ""]);
  $("calcSummary").innerHTML = rows.map(r => '<div class="calc-row' + (r[2] ? " " + r[2] : "") + '"><span>' + esc(r[0]) + "</span><b>" + esc(r[1]) + "</b></div>").join("");
}
function refreshStatusCalc() { syncAutoCost(); updateWeightCheck(); updateCalc(); }

document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "statusWeightKg") { t.dataset.manual = t.value ? "1" : ""; refreshStatusCalc(); }
  else if (t.id === "statusTotalCost") { t.dataset.manual = t.value.trim() ? "1" : ""; updateCalc(); }
  else if (t.id === "statusUnitPrice" || t.id === "statusExtraCost") refreshStatusCalc();
  else if (t.id === "pfTotal" || t.id === "pfPlanTon" || t.id === "pfPriceKg") updatePfEstimate();
  else if (t.matches && t.matches(".loaded-kg-input")) { syncAutoWeight(); refreshStatusCalc(); }
  else if (t.matches && t.matches(".loaded-ctn-input")) updateCalc();
  else if (t.matches && t.matches(".order-ton-input")) updateOrderTotal();
  else if (t.id === "pfIncoterm") updateIncotermHelp();
});
document.addEventListener("change", e => {
  if (e.target.id === "pfIncoterm") updateIncotermHelp();
  if (e.target.id === "docsStatus") { const d = $("docsDate"); if (e.target.value === "pending") d.value = ""; else if (!d.value) d.value = todayISO(); }
  if (e.target.id === "statusTotalCost" && !e.target.value.trim()) { e.target.dataset.manual = ""; refreshStatusCalc(); }
});

function openOrderModal(id) {
  const c = findC(id);
  if (!c) return;
  $("orderCntId").value = c.id;
  $("orderSub").textContent = cntLabel(c);
  $("orderDateInput").value = c.orderDate || todayISO();
  $("orderItemsContainer").innerHTML = "";
  if (c.orderItems && c.orderItems.length) c.orderItems.forEach(it => addOrderRow(it.code, it.ton));
  else { const pf0 = findPf(c.pfId); addOrderRow("", (pf0 && pf0.planTon) || DEFAULT_PLAN_TON); }
  showModal("modalOrder");
}

async function submitOrder() {
  const id = $("orderCntId").value;
  const orderDate = $("orderDateInput").value;
  const items = [];
  let totalTon = 0;
  document.querySelectorAll("#orderItemsContainer .yarn-row").forEach(row => {
    const code = row.querySelector(".order-code-input").value.trim().toUpperCase();
    const ton = parseFloat(row.querySelector(".order-ton-input").value) || 0;
    if (code) { items.push({ code, ton }); totalTon += ton; }
  });
  if (!items.length) { toast("En az bir iplik / renk kodu girin.", "err"); return; }
  const cs = capState(totalTon * 1000);
  if (cs && (cs.cls === "over" || cs.cls === "low")) {
    const ok = await askConfirm({ title: "Kapasite dışı", text: "Toplam " + fmtTonRaw(totalTon) + " ton: " + cs.text + ". Yine de kaydedilsin mi?", okText: "Yine de kaydet" });
    if (!ok) return;
  }

  const c = findC(id);
  if (!c) return;
  const patch = { orderItems: items, weightTon: Math.round(totalTon * 1000) / 1000, orderDate };
  if (stageOf(c) === "white") patch.status = "yellow";   // ilerlemiş konteyner aşamasını korur
  updateContainer(id, patch);
  hideModal("modalOrder");
  renderAll();
  toast("Sipariş kaydedildi");
}

function openStatusModal(id) {
  const c = findC(id);
  if (!c) return;
  const pf = findPf(c.pfId);
  const first = stageOf(c) === "yellow" || stageOf(c) === "white";
  $("statusCntId").value = c.id;
  $("statusSub").textContent = cntLabel(c);
  $("statusCntNo").value = c.no || "";
  $("statusLoadingDate").value = c.loadingDate || todayISO();
  $("statusShippingLine").value = c.shippingLine || "";
  $("statusBl").value = c.blNo || "";
  $("statusArrivalDate").value = c.arrivalDate || "";
  $("statusUnitPrice").value = c.unitPrice || (pf && pf.pricePerKg) || "";
  $("statusExtraCost").value = c.extraCost || "";
  $("statusCalcNote").value = c.calcNote || "";
  $("statusTotalCost").value = c.totalCost ? String(parseMoney(c.totalCost)) : "";
  $("statusErrorText").style.display = "none";
  $("statusSaveBtn").textContent = first ? "Yüklemeyi kaydet" : "Değişiklikleri kaydet";

  $("loadedItemsContainer").innerHTML = "";
  const w = $("statusWeightKg");
  w.dataset.manual = c.weightKg ? "1" : "";
  w.value = c.weightKg || "";
  if (c.loadedItems && c.loadedItems.length) c.loadedItems.forEach(it => addLoadedRow(it.code, it.kg, it.cartons));
  else if (c.orderItems && c.orderItems.length) c.orderItems.forEach(it => addLoadedRow(it.code, Math.round(it.ton * 1000)));
  else addLoadedRow("", "");
  syncAutoWeight();
  // Kayıtlı fatura tutarı hesaplananla aynı değilse elle girilmiş sayılır
  const kg = parseFloat(w.value) || 0;
  const unit = parseFloat($("statusUnitPrice").value) || 0;
  const saved = parseMoney(c.totalCost);
  $("statusTotalCost").dataset.manual = saved && !(unit && kg && Math.abs(saved - round2(kg * unit)) < 0.5) ? "1" : "";
  refreshStatusCalc();
  showModal("modalStatus");
}

async function submitStatus() {
  const id = $("statusCntId").value;
  const no = $("statusCntNo").value.trim().toUpperCase();
  const loadingDate = $("statusLoadingDate").value;
  const shippingLine = $("statusShippingLine").value.trim().toUpperCase();
  const blNo = $("statusBl").value.trim().toUpperCase();
  const weightKg = parseFloat($("statusWeightKg").value) || 0;
  const unitPrice = parseFloat($("statusUnitPrice").value) || 0;
  const extraCost = parseFloat($("statusExtraCost").value) || 0;
  const calcNote = $("statusCalcNote").value.trim();
  const arrivalDate = $("statusArrivalDate").value;
  const invoice = parseMoney($("statusTotalCost").value);
  const errEl = $("statusErrorText");

  if (!no || !loadingDate || !shippingLine || !weightKg || !invoice) { errEl.textContent = "Kırmızı yıldızlı alanların hepsini doldurun."; errEl.style.display = "block"; return; }
  errEl.style.display = "none";

  const loadedItems = [];
  let sum = 0, missingCtn = false;
  document.querySelectorAll("#loadedItemsContainer .yarn-row").forEach(row => {
    const code = row.querySelector(".loaded-code-input").value.trim().toUpperCase();
    const kg = parseFloat(row.querySelector(".loaded-kg-input").value) || 0;
    const cartons = parseInt(row.querySelector(".loaded-ctn-input").value, 10) || 0;
    if (code) { loadedItems.push({ code, kg, cartons }); sum += kg; if (!cartons) missingCtn = true; }
  });
  if (missingCtn) { errEl.textContent = "Her iplik kalemi için karton adedini yazın."; errEl.style.display = "block"; return; }

  const msgs = [];
  if (loadedItems.length && Math.abs(sum - weightKg) >= 0.5) {
    msgs.push("Kalemler " + fmtNum(sum) + " kg, toplam net kilo " + fmtNum(weightKg) + " kg (fark " + fmtNum(Math.abs(weightKg - sum)) + " kg).");
  }
  const cs = capState(weightKg);
  if (cs && (cs.cls === "over" || cs.cls === "low")) msgs.push("Toplam " + fmtTonRaw(weightKg / 1000) + " t: " + cs.text + ".");
  if (msgs.length) {
    const ok = await askConfirm({ title: "Kontrol edin", text: msgs.join(" ") + " Yine de kaydedilsin mi?", okText: "Yine de kaydet" });
    if (!ok) return;
  }

  const c = findC(id);
  if (!c) return;
  const patch = { no, loadingDate, shippingLine, blNo, weightKg, totalCost: String(round2(invoice)), unitPrice, extraCost, calcNote, arrivalDate, loadedItems };
  // Sadece ilk yüklemede yeşile geçer; düzenleme mevcut aşamayı bozmaz
  if (stageOf(c) === "yellow" || stageOf(c) === "white") patch.status = "green";
  updateContainer(id, patch);
  hideModal("modalStatus");
  renderAll();
  toast("Yükleme kaydedildi");
}

function openArrivalModal(id) {
  const c = findC(id);
  if (!c) return;
  $("arrivalCntId").value = c.id;
  $("arrivalSub").textContent = cntLabel(c);
  $("arrivalDateInput").value = c.arrivalDate || "";
  $("arrivalAtPort").checked = stageOf(c) === "red";
  showModal("modalArrival");
}

function submitArrival() {
  const id = $("arrivalCntId").value;
  const c = findC(id);
  if (!c) return;
  const atPort = $("arrivalAtPort").checked;
  updateContainer(id, { arrivalDate: $("arrivalDateInput").value, status: atPort ? "red" : "green" });
  hideModal("modalArrival");
  renderAll();
  toast(atPort ? "Limana ulaştı olarak işaretlendi" : "Varış tarihi kaydedildi");
}

function openWarehouseModal(id) {
  const c = findC(id);
  if (!c) return;
  $("warehouseCntId").value = c.id;
  $("warehouseSub").textContent = cntLabel(c);
  const names = WAREHOUSES.slice();
  if (c.warehouseName && !names.includes(c.warehouseName)) names.push(c.warehouseName);
  $("whNameSelect").innerHTML = names.map(n => '<option value="' + esc(n) + '">' + esc(n) + "</option>").join("");
  $("whNameSelect").value = c.warehouseName || names[0];
  $("whDateInput").value = c.warehouseDate || todayISO();
  showModal("modalWarehouse");
}

function submitWarehouse() {
  const id = $("warehouseCntId").value;
  const whDate = $("whDateInput").value;
  const whName = $("whNameSelect").value;
  if (!whDate) { toast("Teslim tarihini seçin.", "err"); return; }
  const c = findC(id);
  if (!c) return;
  const patch = { status: "blue", warehouseDate: whDate, warehouseName: whName };
  if (stageOf(c) !== "blue") patch.statusBeforeWarehouse = c.status;   // geri alınırsa nereye döneceğini hatırla
  updateContainer(id, patch);
  hideModal("modalWarehouse");
  renderAll();
  toast("Depoya teslim kaydedildi");
}

// Evrak durumu: bekleniyor / eksik / tamam
function openDocsModal(id) {
  const c = findC(id);
  if (!c) return;
  $("docsCntId").value = c.id;
  $("docsSub").textContent = cntLabel(c);
  $("docsStatus").value = c.docsStatus || "pending";
  $("docsDate").value = c.docsDate || "";
  $("docsNote").value = c.docsNote || "";
  showModal("modalDocs");
}
function submitDocs() {
  const id = $("docsCntId").value;
  const status = $("docsStatus").value;
  let date = $("docsDate").value;
  if (status === "pending") date = "";
  else if (!date) date = todayISO();
  updateContainer(id, { docsStatus: status, docsDate: date, docsNote: $("docsNote").value.trim() });
  hideModal("modalDocs");
  renderAll();
  toast("Evrak durumu kaydedildi");
}

// Önceki aşamaya alma: menüden, onay penceresiyle. Girilen bilgiler silinmez.
async function revertStage(id) {
  const c = findC(id);
  if (!c) return;
  const st = stageOf(c);
  const map = { yellow: "white", green: "yellow", red: "green" };
  const prev = st === "blue" ? (c.statusBeforeWarehouse || "green") : map[st];
  if (!prev) return;
  const ok = await askConfirm({
    title: "Önceki aşamaya alınsın mı?",
    text: "Konteyner " + c.order + " “" + STAGE[prev].label + "” aşamasına dönecek. Girdiğiniz bilgiler silinmez.",
    okText: "Evet, geri al", danger: true
  });
  if (!ok) return;
  const patch = { status: prev };
  if (st === "blue") { patch.warehouseDate = ""; patch.warehouseName = ""; patch.statusBeforeWarehouse = ""; }
  updateContainer(id, patch);
  renderAll();
  toast("“" + STAGE[prev].label + "” aşamasına alındı");
}

// =====================================================
// 9. HESAPLAMALAR
// =====================================================
function activeContainers() {
  const act = new Set(proformas.filter(p => !p.isArchived).map(p => p.id));
  return containers.filter(c => act.has(c.pfId));
}

function pfStats(pf, list) {
  const s = { count: list.length, white: 0, yellow: 0, green: 0, red: 0, blue: 0, orderedKg: 0, loadedKg: 0, deliveredKg: 0, money: 0, extra: 0, costKg: 0, estMoney: 0, cartons: 0 };
  list.forEach(c => {
    const st = stageOf(c);
    s[st]++;
    if (st !== "white") s.orderedKg += orderKg(c) || (c.weightKg || 0);
    if (st === "green" || st === "red" || st === "blue") {
      s.loadedKg += bestKg(c);
      s.cartons += cartonsOf(c);
      const m = parseMoney(c.totalCost);
      if (m) { s.money += m; s.extra += Number(c.extraCost) || 0; s.costKg += bestKg(c); }
    }
    if (st === "yellow" && pf && pf.pricePerKg) s.estMoney += orderKg(c) * pf.pricePerKg;
    if (st === "blue") s.deliveredKg += bestKg(c);
  });
  return s;
}

function stageMatch(c) { return ui.stage === "all" || stageOf(c) === ui.stage; }
function haystack(parts) { return parts.filter(Boolean).join(" ").toLocaleLowerCase("tr-TR"); }
function pfHit(pf) {
  return haystack([pf.no, pf.supplier, pf.incoterm, pf.note]).includes(ui.q);
}
function cHit(c) {
  const items = (c.orderItems || []).concat(c.loadedItems || []).map(i => i.code);
  return haystack([c.no, c.shippingLine, c.blNo, c.pfNo, c.supplier, c.warehouseName].concat(items)).includes(ui.q);
}
function isFiltering() { return ui.stage !== "all" || !!ui.q; }

// Filtreye uyan konteynerler
function visibleContainers(pf, all) {
  if (!isFiltering()) return all;
  const pfMatch = ui.q ? pfHit(pf) : false;
  return all.filter(c => stageMatch(c) && (!ui.q || pfMatch || cHit(c)));
}

// =====================================================
// 10. ÇİZİM
// =====================================================
function docChip(c, archived) {
  const st = stageOf(c);
  if (st !== "green" && st !== "red" && st !== "blue") return "";
  const d = c.docsStatus || "pending";
  const label = d === "received" ? "Evrak tamam" : d === "partial" ? "Evrak eksik" : "Evrak bekleniyor";
  const cls = "doc doc-" + d + (st === "red" && d !== "received" ? " doc-alert" : "");
  const title = [c.docsDate ? fmtDate(c.docsDate) : "", c.docsNote || ""].filter(Boolean).join(" · ");
  const inner = ic("file") + esc(label) + (d !== "pending" && c.docsDate ? " " + esc(fmtShort(c.docsDate)) : "");
  if (archived) return '<span class="' + cls + '" title="' + esc(title) + '">' + inner + "</span>";
  return '<button class="' + cls + '" data-action="openDocs" data-id="' + esc(c.id) + '" title="' + esc(title || "Evrak durumunu değiştir") + '">' + inner + "</button>";
}

function rowMenu(c) {
  const st = stageOf(c);
  const id = esc(c.id);
  const items = [];
  if (st !== "white") items.push('<button data-action="openOrder" data-id="' + id + '">' + ic("edit") + "Sipariş bilgisini düzenle</button>");
  if (st === "green" || st === "red" || st === "blue") items.push('<button data-action="openStatus" data-id="' + id + '">' + ic("edit") + "Yükleme bilgisini düzenle</button>");
  if (st === "blue") items.push('<button data-action="openWarehouse" data-id="' + id + '">' + ic("edit") + "Depo bilgisini düzenle</button>");
  if (st !== "white") items.push('<hr><button class="danger" data-action="revert" data-id="' + id + '">' + ic("undo") + "Önceki aşamaya al</button>");
  if (!items.length) return "";
  return '<div class="menu-wrap"><button class="icon-btn" data-action="menu" aria-label="Diğer işlemler">' + ic("dots") + '</button><div class="menu">' + items.join("") + "</div></div>";
}

function dateLines(c) {
  const st = stageOf(c);
  const L = [];
  const line = (k, v, rel, relCls) =>
    '<div class="dl"><span class="dk">' + esc(k) + '</span><span class="dv">' + esc(v) + "</span>" +
    (rel ? '<span class="rel ' + (relCls || "") + '">' + esc(rel) + "</span>" : "") + "</div>";
  if (c.orderDate) L.push(line("Sipariş", fmtDate(c.orderDate)));
  if (c.loadingDate && st !== "yellow" && st !== "white") L.push(line("Yükleme", fmtDate(c.loadingDate)));
  if (st === "green") {
    if (c.arrivalDate) { const d = daysUntil(c.arrivalDate); L.push(line("Tahmini varış", fmtDate(c.arrivalDate), relDays(d), relClass(d))); }
    else L.push(line("Tahmini varış", "girilmedi", "", "warn"));
  }
  if (st === "red") L.push(line("Limanda", c.arrivalDate ? fmtDate(c.arrivalDate) : "tarih yok"));
  if (st === "blue") L.push(line("Depo", (c.warehouseName || "") + " " + fmtDate(c.warehouseDate)));
  return L.join("");
}

function renderRow(c, archived) {
  const st = stageOf(c);
  const id = esc(c.id);

  const top = '<span class="stchip">' + STAGE[st].label + "</span>" +
    (c.no ? '<span class="cno">' + esc(c.no) + "</span>" : '<span class="cno cno-empty">' + (st === "white" ? "Detay bekleniyor" : "Konteyner no girilmedi") + "</span>") +
    (c.shippingLine ? '<span class="tag">' + ic("ship") + esc(c.shippingLine) + "</span>" : "") +
    (c.blNo ? '<span class="tag">B/L ' + esc(c.blNo) + "</span>" : "") + capTag(c) + docChip(c, archived);

  let items = "";
  const loaded = st === "green" || st === "red" || st === "blue";
  if (loaded && c.loadedItems && c.loadedItems.length) {
    items = c.loadedItems.map(it => '<span class="yarn"><b>' + esc(it.code) + "</b><span>" + fmtNum(it.kg) + " kg</span>" + (it.cartons ? '<span class="ctn">' + fmtNum(it.cartons) + " karton</span>" : "") + "</span>").join("");
  } else if (c.orderItems && c.orderItems.length && st !== "white") {
    items = c.orderItems.map(it => '<span class="yarn"><b>' + esc(it.code) + "</b><span>" + fmtTonRaw(it.ton) + " t</span></span>").join("");
  }

  let meta = "";
  const kg = bestKg(c);
  if (kg) meta += '<div class="num">' + (st === "white" || st === "yellow" ? fmtTon(kg) : fmtNum(kg) + " kg") + '</div><div class="numl">' + (st === "white" || st === "yellow" ? "sipariş" : "net ağırlık") + "</div>";
  if (loaded && cartonsOf(c)) meta += '<div class="numl">' + fmtNum(cartonsOf(c)) + " karton</div>";
  if (loaded && c.totalCost) meta += '<div class="cost">' + esc(fmtMoney(parseMoney(c.totalCost))) + (c.unitPrice ? '<span class="unit"> · ' + esc(fmtPriceVal(c.unitPrice)) + " $/kg</span>" : "") + "</div>";
  const pfx = findPf(c.pfId);
  if (st === "yellow" && pfx && pfx.pricePerKg && kg) meta += '<div class="est">≈ ' + esc(fmtMoney(kg * pfx.pricePerKg)) + " tahmini</div>";

  let actions = "";
  if (!archived) {
    if (st === "white") actions = '<button class="btn btn-primary btn-sm" data-action="openOrder" data-id="' + id + '">Sipariş gir</button>';
    else if (st === "yellow") actions = '<button class="btn btn-primary btn-sm" data-action="openStatus" data-id="' + id + '">Yükleme bilgisi gir</button>';
    else if (st === "green" || st === "red") {
      actions = '<button class="btn btn-ghost btn-sm" data-action="openArrival" data-id="' + id + '">Varış</button>' +
                '<button class="btn btn-primary btn-sm" data-action="openWarehouse" data-id="' + id + '">Depoya teslim</button>';
    }
    actions += rowMenu(c);
  } else {
    actions = '<button class="btn btn-ghost btn-sm" data-action="deleteContainer" data-id="' + id + '">' + ic("trash") + "Sil</button>";
  }

  const idx = String(c.order || "").split("/");
  return '<div class="crow s-' + st + '" data-id="' + id + '">' +
    '<div class="c-idx">' + esc((idx[0] || "").trim()) + "<small>/ " + esc((idx[1] || "").trim()) + "</small></div>" +
    '<div class="c-main"><div class="c-top">' + top + "</div>" + (items ? '<div class="yarns">' + items + "</div>" : "") + (loaded && c.docsNote && (c.docsStatus || "pending") !== "received" ? '<div class="docnote">Evrak notu: ' + esc(c.docsNote) + "</div>" : "") + "</div>" +
    '<div class="c-meta">' + meta + "</div>" +
    '<div class="c-dates">' + dateLines(c) + "</div>" +
    '<div class="c-actions">' + actions + "</div>" +
  "</div>";
}

function yardStrip(list) {
  const blocks = list.map(c => {
    const st = stageOf(c);
    return '<span class="blk s-' + st + '" title="' + esc("Konteyner " + c.order + ": " + STAGE[st].label) + '">' + esc(c.orderIndex || "") + "</span>";
  }).join("");
  const legend = STAGE_ORDER.map(k => {
    const n = list.filter(c => stageOf(c) === k).length;
    return n ? '<span class="s-' + k + '"><i></i>' + n + " " + STAGE[k].label.toLowerCase() + "</span>" : "";
  }).join("");
  return '<div class="yard-wrap"><div class="yard">' + blocks + '</div><div class="legend">' + legend + "</div></div>";
}

function renderPfCard(pf, opt) {
  const all = containers.filter(c => c.pfId === pf.id).sort(byIndex);
  const s = pfStats(pf, all);
  const inc = INCOTERMS[pf.incoterm];
  const archived = !!opt.archived;
  const vis = opt.vis || all;

  const meta = [];
  if (pf.date) meta.push("<span>" + ic("calendar") + esc(fmtDate(pf.date)) + "</span>");
  if (inc) meta.push("<span>" + esc(inc.freight) + "</span>");
  if (pf.planTon) meta.push("<span>Plan: " + fmtTonRaw(pf.planTon) + " t / konteyner</span>");

  const done = s.count > 0 && s.blue === s.count;
  let right = "";
  if (pf.pricePerKg) right += '<span class="pf-price">' + fmtPriceVal(pf.pricePerKg) + " $/kg</span>";
  else if (pf.price) right += '<span class="pf-price">' + esc(pf.price) + "</span>";
  if (archived) {
    right += '<button class="btn btn-ghost btn-sm" data-action="restore" data-id="' + esc(pf.id) + '">' + ic("undo") + "Panoya al</button>" +
             '<button class="btn btn-ghost btn-sm" data-action="deleteProforma" data-id="' + esc(pf.id) + '">' + ic("trash") + "Kalıcı sil</button>";
  } else {
    right += '<div class="menu-wrap"><button class="icon-btn" data-action="menu" aria-label="Proforma işlemleri">' + ic("dots") + '</button><div class="menu">' +
      '<button data-action="editProforma" data-id="' + esc(pf.id) + '">' + ic("edit") + "Proformayı düzenle</button>" +
      '<button data-action="addContainer" data-id="' + esc(pf.id) + '">' + ic("plus") + "Konteyner ekle</button>" +
      '<hr><button data-action="archive" data-id="' + esc(pf.id) + '">' + ic("archive") + "Arşive taşı</button></div></div>";
  }

  const stats = [];
  if (s.orderedKg) stats.push(["Sipariş", fmtTon(s.orderedKg)]);
  if (s.loadedKg) stats.push(["Yüklenen", fmtTon(s.loadedKg)]);
  if (s.cartons) stats.push(["Karton", fmtNum(s.cartons)]);
  if (s.deliveredKg) stats.push(["Depoya girişi", fmtTon(s.deliveredKg)]);
  if (s.money) stats.push(["Yüklenen tutar", fmtMoney(s.money)]);
  if (s.estMoney) stats.push(["Siparişteki tahmini", fmtMoney(s.estMoney)]);
  if (s.money && s.costKg) stats.push(["Ort. maliyet", fmtPriceVal((s.money + s.extra) / s.costKg) + " $/kg"]);

  const contract = "";

  // Satırlar
  let rows = "";
  if (archived) {
    rows = all.map(c => renderRow(c, true)).join("");
  } else {
    const filtering = isFiltering();
    const open = vis.filter(c => stageOf(c) !== "blue").sort(cntSort);
    const delivered = vis.filter(c => stageOf(c) === "blue").sort(byIndex);
    const expanded = ui.expanded.has(pf.id);
    rows = open.map(c => renderRow(c, false)).join("");
    if (delivered.length) {
      if (filtering || expanded) {
        if (!filtering) rows += '<button class="done-row" data-action="toggleDelivered" data-id="' + esc(pf.id) + '">' + ic("check") + "Teslim edilenleri gizle</button>";
        rows += delivered.map(c => renderRow(c, false)).join("");
      } else {
        const kg = delivered.reduce((a, c) => a + bestKg(c), 0);
        rows += '<button class="done-row" data-action="toggleDelivered" data-id="' + esc(pf.id) + '">' + ic("check") +
          delivered.length + " konteyner depoya teslim edildi" + (kg ? " (" + fmtTon(kg) + ")" : "") +
          '<span class="sp">Göster' + ic("chevron") + "</span></button>";
      }
    }
  }

  return '<article class="pf" data-pf="' + esc(pf.id) + '">' +
    '<div class="pf-top"><div class="pf-id"><div class="pf-line1">' +
      (opt.showCompany ? '<span class="pf-co">' + esc(pf.supplier) + "</span>" : "") +
      '<span class="pf-no">' + esc(pf.no) + "</span>" +
      (inc ? '<span class="inc inc-' + esc(pf.incoterm) + '" title="' + esc(inc.hint) + '">' + esc(pf.incoterm) + "</span>" : '<span class="badge" style="background:var(--st-yellow-bg);color:var(--st-yellow-ink)">Teslim şekli yok</span>') +
      (done && !archived ? '<span class="badge ok">Tamamlandı</span>' : "") +
    '</div><div class="pf-meta">' + meta.join("") + '</div></div><div class="pf-right">' + right + "</div></div>" +
    (all.length ? yardStrip(all) : "") +
    (stats.length ? '<div class="stats">' + stats.map(x => '<div class="stat"><b>' + esc(x[1]) + "</b><span>" + esc(x[0]) + "</span></div>").join("") + "</div>" : "") +
    contract +
    (pf.note ? '<p class="pf-note">' + esc(pf.note) + "</p>" : "") +
    '<div class="rows">' + rows + "</div>" +
  "</article>";
}

function renderPipeline() {
  const agg = {};
  STAGE_ORDER.forEach(k => { agg[k] = { n: 0, kg: 0 }; });
  activeContainers().forEach(c => { const k = stageOf(c); agg[k].n++; agg[k].kg += bestKg(c); });
  $("pipeline").innerHTML = STAGE_ORDER.map(k =>
    '<button class="seg s-' + k + (ui.stage === k ? " on" : "") + '" data-action="filterStage" data-stage="' + k + '" aria-pressed="' + (ui.stage === k) + '">' +
    '<span class="seg-n">' + agg[k].n + '</span><span class="seg-l">' + STAGE[k].label + '</span><span class="seg-t">' + (agg[k].kg ? fmtTon(agg[k].kg) : "") + "</span></button>"
  ).join("");
}

function renderArrivals() {
  const el = $("arrivals");
  if (ui.tab !== "active") { el.hidden = true; return; }
  const act = activeContainers();
  const green = act.filter(c => stageOf(c) === "green");
  const portNoDocs = act.filter(c => stageOf(c) === "red" && (c.docsStatus || "pending") !== "received");
  if (!green.length && !portNoDocs.length) { el.hidden = true; return; }
  el.hidden = false;
  let html = "";
  if (green.length) {
    const withEta = green.filter(c => c.arrivalDate).sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
    const noEta = green.length - withEta.length;
    html += '<span class="arrivals-title">Yaklaşan varışlar</span>';
    withEta.slice(0, 6).forEach(c => {
      const d = daysUntil(c.arrivalDate);
      html += '<span class="arr-chip ' + relClass(d) + '"><b>' + esc(c.supplier) + '</b><span class="mono">' + esc(c.no || "Konteyner " + c.order) + '</span><span class="when">' +
        esc(fmtShort(c.arrivalDate)) + " " + esc(relDays(d)) + "</span></span>";
    });
    if (withEta.length > 6) html += '<span class="arr-chip"><span class="when">+' + (withEta.length - 6) + " konteyner daha</span></span>";
    if (noEta) html += '<span class="arr-chip warn">' + noEta + " konteynerin tahmini varışı girilmedi</span>";
  }
  if (portNoDocs.length) html += '<span class="arr-chip late"><b>Limanda</b><span class="when">' + portNoDocs.length + " konteynerin evrakı tamam değil</span></span>";
  el.innerHTML = html;
}

function renderToolbar() {
  const act = proformas.filter(p => !p.isArchived);
  const arc = proformas.filter(p => p.isArchived);
  const pool = ui.tab === "active" ? act : arc;
  let chips = '<button class="chip-btn' + (ui.company === "all" ? " on" : "") + '" data-action="filterCompany" data-company="all">Tüm firmalar<span class="n">' + pool.length + "</span></button>";
  companies.forEach(c => {
    const n = pool.filter(p => p.supplier === c).length;
    chips += '<button class="chip-btn' + (ui.company === c ? " on" : "") + '" data-action="filterCompany" data-company="' + esc(c) + '">' + esc(c) + '<span class="n">' + n + "</span></button>";
  });
  const clear = isFiltering() ? '<button class="btn btn-ghost btn-sm" data-action="clearFilters">Filtreyi temizle</button>' : "";
  $("toolbar").innerHTML =
    '<div class="tabs"><button class="tab' + (ui.tab === "active" ? " on" : "") + '" data-action="setTab" data-tab="active">Panel<span class="n">' + act.length + "</span></button>" +
    '<button class="tab' + (ui.tab === "archive" ? " on" : "") + '" data-action="setTab" data-tab="archive">Arşiv<span class="n">' + arc.length + "</span></button></div>" +
    '<div class="chips">' + chips + "</div>" + clear;
}

function renderBoard() {
  const wrap = $("boardContainer");
  wrap.hidden = ui.tab !== "active";
  if (ui.tab !== "active") return;

  if (!companies.length) {
    wrap.innerHTML = '<div class="empty"><h3>Henüz firma yok</h3><p>Önce anlaşma yaptığınız tedarikçi firmayı ekleyin, sonra proformasını oluşturun.</p><button class="btn btn-primary" data-action="openCompanies">Firma ekle</button></div>';
    return;
  }

  let html = "";
  let shown = 0;
  companies.forEach(comp => {
    if (ui.company !== "all" && ui.company !== comp) return;
    const pfs = proformas.filter(p => p.supplier === comp && !p.isArchived).sort((a, b) => pfTime(b) - pfTime(a));
    let cards = "";
    pfs.forEach(pf => {
      const all = containers.filter(c => c.pfId === pf.id).sort(byIndex);
      const vis = visibleContainers(pf, all);
      if (isFiltering() && !vis.length) return;
      cards += renderPfCard(pf, { vis, showCompany: false });
      shown++;
    });
    if (isFiltering() && !cards) return;
    html += '<section class="grp"><div class="grp-head"><h2>' + esc(comp) + '</h2><span class="grp-count">' + pfs.length + ' aktif proforma</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="newProformaFor" data-company="' + esc(comp) + '">' + ic("plus") + "Proforma</button></div>" +
      (cards || '<div class="grp-empty">Bu firmada aktif proforma yok.</div>') + "</section>";
  });

  if (!html || (isFiltering() && !shown)) {
    html = '<div class="empty"><h3>' + (isFiltering() ? "Eşleşen kayıt yok" : "Henüz proforma yok") + "</h3><p>" +
      (isFiltering() ? "Arama veya aşama filtresini değiştirin." : "Firmayla anlaştığınız proformayı oluşturun. Konteynerler otomatik açılır.") + "</p>" +
      (isFiltering() ? '<button class="btn btn-ghost" data-action="clearFilters">Filtreyi temizle</button>' : '<button class="btn btn-primary" data-action="newProforma">+ Yeni proforma</button>') + "</div>";
  }
  wrap.innerHTML = html;
}

function renderArchive() {
  const wrap = $("archiveContainer");
  wrap.hidden = ui.tab !== "archive";
  if (ui.tab !== "archive") return;
  const list = proformas.filter(p => p.isArchived && (ui.company === "all" || p.supplier === ui.company)).sort((a, b) => pfTime(b) - pfTime(a));
  const q = ui.q;
  const shown = q ? list.filter(pf => pfHit(pf) || containers.some(c => c.pfId === pf.id && cHit(c))) : list;
  wrap.innerHTML = shown.length
    ? '<div class="grp">' + shown.map(pf => renderPfCard(pf, { archived: true, showCompany: true })).join("") + "</div>"
    : '<div class="empty"><h3>Arşiv boş</h3><p>Tamamlanan proformaları üç nokta menüsünden arşive taşıyın.</p></div>';
}

function renderAll() {
  renderPipeline();
  renderArrivals();
  renderToolbar();
  renderBoard();
  renderArchive();
}

// =====================================================
// 11. OLAYLAR (tek noktadan)
// =====================================================
function closeMenus() { document.querySelectorAll(".menu-wrap.open").forEach(m => m.classList.remove("open")); }

document.addEventListener("click", e => {
  if (e.target.classList && e.target.classList.contains("modal")) return;   // dışarı tıklamak pencereyi kapatmaz, yazılanlar kaybolmaz
  const el = e.target.closest("[data-action]");
  const wrap = e.target.closest(".menu-wrap");
  if (el && el.dataset.action === "menu") {
    const was = wrap.classList.contains("open");
    closeMenus();
    if (!was) wrap.classList.add("open");
    return;
  }
  closeMenus();
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case "newProforma": openProformaModal(); break;
    case "newProformaFor": openProformaModal(null, el.dataset.company); break;
    case "editProforma": openProformaModal(id); break;
    case "addContainer": addContainerToProforma(id); break;
    case "openCompanies": openCompanies(); break;
    case "removeCompany": removeCompany(el.dataset.name); break;
    case "openOrder": openOrderModal(id); break;
    case "openStatus": openStatusModal(id); break;
    case "openArrival": openArrivalModal(id); break;
    case "openWarehouse": openWarehouseModal(id); break;
    case "revert": revertStage(id); break;
    case "openDocs": openDocsModal(id); break;
    case "archive": toggleArchive(id, true); break;
    case "restore": toggleArchive(id, false); break;
    case "deleteProforma": permanentDeleteProforma(id); break;
    case "deleteContainer": permanentDeleteContainer(id); break;
    case "setTab": ui.tab = el.dataset.tab; renderAll(); break;
    case "filterCompany": ui.company = el.dataset.company; renderAll(); break;
    case "filterStage": ui.stage = ui.stage === el.dataset.stage ? "all" : el.dataset.stage; if (ui.tab !== "active") ui.tab = "active"; renderAll(); break;
    case "clearFilters": ui.stage = "all"; ui.q = ""; $("searchInput").value = ""; renderAll(); break;
    case "toggleDelivered": if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id); renderAll(); break;
    case "exportExcel": exportDetailedExcel(); break;
    case "exportImage": captureActiveCardsAsImage(); break;
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if ($("modalConfirm").classList.contains("open")) resolveConfirm(false);
    else closeAllModals();
  }
  if (e.key === "Enter" && e.target) {
    if (e.target.id === "inputPinCode") validateAndExecutePin();
    if (e.target.id === "inputCompName") addCompany();
  }
});

$("searchInput").addEventListener("input", e => {
  ui.q = e.target.value.trim().toLocaleLowerCase("tr-TR");
  renderAll();
});

// =====================================================
// 12. RESİM RAPORU
// =====================================================
function captureActiveCardsAsImage() {
  const active = activeContainers().filter(c => ["yellow", "green", "red"].includes(stageOf(c)));
  if (!active.length) { toast("Siparişte, yolda veya limanda konteyner yok.", "err"); return; }
  if (typeof html2canvas === "undefined") { toast("Resim kütüphanesi yüklenemedi. İnternet bağlantısını kontrol edin.", "err"); return; }

  const by = k => active.filter(c => stageOf(c) === k);
  const sumKg = list => list.reduce((a, c) => a + bestKg(c), 0);
  const notDone = c => (c.docsStatus || "pending") !== "received";
  const noDocs = active.filter(c => stageOf(c) !== "yellow" && notDone(c));
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

  const tile = (k, label, list) => '<div class="rp-tile s-' + k + '"><div class="rp-tn">' + list.length + '</div><div class="rp-tl">' + label +
    '</div><div class="rp-tt">' + (list.length ? fmtTon(sumKg(list)) : "&nbsp;") + "</div></div>";
  const docCell = c => {
    const st = stageOf(c);
    if (st === "yellow") return '<span class="rp-muted">—</span>';
    const d = c.docsStatus || "pending";
    if (d === "received") return '<span class="rp-ok">Tamam</span>' + (c.docsDate ? '<div class="rp-line2">' + esc(fmtDate(c.docsDate)) + "</div>" : "");
    return '<span class="' + (st === "red" ? "rp-late" : "rp-soon") + '">' + (d === "partial" ? "Eksik" : "Bekleniyor") + "</span>" + (c.docsNote ? '<div class="rp-line2">' + esc(c.docsNote) + "</div>" : "");
  };

  let html = '<div class="rp-top"><div><div class="rp-title">Sevkiyat Durum Raporu</div><div class="rp-sub">Aktif proformalar · sipariş, yol ve liman durumu</div></div>' +
    '<div class="rp-date">' + esc(fmtDate(todayISO())) + "<small>saat " + hhmm + "</small></div></div>";

  html += '<div class="rp-tiles">' + tile("yellow", "Siparişte", by("yellow")) + tile("green", "Yolda", by("green")) + tile("red", "Limanda", by("red")) +
    '<div class="rp-tile rp-docs' + (noDocs.length ? " warn" : "") + '"><div class="rp-tn">' + noDocs.length + '</div><div class="rp-tl">Evrakı tamam olmayan</div><div class="rp-tt">yolda ve limanda</div></div></div>';

  // 1) Varış takvimi: limanda olanlar, sonra tahmini varışa göre, tarihsizler en sonda
  const moving = active.filter(c => stageOf(c) !== "yellow");
  if (moving.length) {
    const rank = c => stageOf(c) === "red" ? 0 : (c.arrivalDate ? 1 : 2);
    moving.sort((a, b) => rank(a) - rank(b) || String(a.arrivalDate || "").localeCompare(String(b.arrivalDate || "")));
    html += '<div class="rp-h">Varış takvimi</div><table class="rp-table rp-sch"><thead><tr><th>Varış</th><th>Kalan</th><th>Firma / proforma</th><th>Konteyner</th><th style="text-align:right">Net ağırlık</th><th>Evrak</th></tr></thead><tbody>';
    moving.forEach(c => {
      const st = stageOf(c);
      const pf = findPf(c.pfId);
      let when = '<span class="rp-muted">girilmedi</span>', left = '<span class="rp-muted">—</span>';
      if (st === "red") { when = c.arrivalDate ? esc(fmtDate(c.arrivalDate)) : "—"; left = '<span class="rp-late">Limanda</span>'; }
      else if (c.arrivalDate) {
        const d = daysUntil(c.arrivalDate);
        when = esc(fmtDate(c.arrivalDate));
        left = '<span class="' + (d < 0 ? "rp-late" : d <= 3 ? "rp-soon" : "rp-ok") + '">' + esc(relDays(d)) + "</span>";
      }
      html += '<tr class="s-' + st + '"><td class="m">' + when + "</td><td>" + left + "</td><td><b>" + esc(c.supplier) + "</b> · " + esc(pf ? pf.no : c.pfNo || "") +
        '</td><td class="m">' + esc(c.no || "—") + (c.shippingLine ? '<div class="rp-line2">' + esc(c.shippingLine) + "</div>" : "") +
        '</td><td class="r">' + fmtNum(bestKg(c)) + " kg</td><td>" + docCell(c) + "</td></tr>";
    });
    html += "</tbody></table>";
  }

  // 2) Firma ve proforma ayrıntıları
  html += '<div class="rp-h">Proforma ayrıntıları</div>';
  companies.forEach(comp => {
    proformas.filter(p => p.supplier === comp && !p.isArchived).sort((a, b) => pfTime(b) - pfTime(a)).forEach(pf => {
      const list = active.filter(c => c.pfId === pf.id).sort(cntSort);
      if (!list.length) return;
      const total = containers.filter(c => c.pfId === pf.id).length;
      html += '<div class="rp-pf2"><div class="rp-pfbar"><span class="co">' + esc(comp) + "</span><b>" + esc(pf.no) + "</b>" +
        (pf.incoterm ? "<span>" + esc(pf.incoterm) + "</span>" : "") +
        (pf.pricePerKg ? "<span>" + fmtPriceVal(pf.pricePerKg) + " $/kg</span>" : "") +
        '<span class="sp">' + list.length + " / " + total + " konteyner yolda veya siparişte</span></div>" +
        '<table class="rp-table"><thead><tr><th>Sıra</th><th>Durum</th><th>Konteyner / hat</th><th>İçerik</th><th style="text-align:right">Net ağırlık</th><th style="text-align:right">Karton</th><th>Varış</th><th>Evrak</th></tr></thead><tbody>';
      list.forEach(c => {
        const st = stageOf(c);
        const loaded = st !== "yellow";
        const items = loaded && c.loadedItems && c.loadedItems.length
          ? c.loadedItems.map(i => '<div class="rp-it"><b>' + esc(i.code) + "</b> <span>" + fmtNum(i.kg) + " kg" + (i.cartons ? " · " + fmtNum(i.cartons) + " karton" : "") + "</span></div>").join("")
          : (c.orderItems || []).map(i => '<div class="rp-it"><b>' + esc(i.code) + "</b> <span>" + fmtTonRaw(i.ton) + " t</span></div>").join("");
        let arr;
        if (st === "yellow") arr = '<span class="rp-muted">Sipariş ' + esc(fmtShort(c.orderDate)) + "</span>";
        else if (st === "red") arr = '<span class="rp-late">Limanda</span>' + (c.arrivalDate ? '<div class="rp-line2">' + esc(fmtDate(c.arrivalDate)) + "</div>" : "");
        else if (c.arrivalDate) { const d = daysUntil(c.arrivalDate); arr = esc(fmtDate(c.arrivalDate)) + '<div class="' + (d < 0 ? "rp-late" : d <= 3 ? "rp-soon" : "rp-ok") + '">' + esc(relDays(d)) + "</div>"; }
        else arr = '<span class="rp-muted">girilmedi</span>';
        html += '<tr class="s-' + st + '"><td class="m">' + esc(c.order) + '</td><td><span class="rp-st">' + STAGE[st].label + '</span></td><td class="m">' +
          esc(c.no || "—") + (c.shippingLine ? '<div class="rp-line2">' + esc(c.shippingLine) + (c.blNo ? " · B/L " + esc(c.blNo) : "") + "</div>" : "") +
          "</td><td>" + items + '</td><td class="r">' + (loaded && c.weightKg ? fmtNum(c.weightKg) + " kg" : fmtTon(bestKg(c))) + '</td><td class="r">' +
          (loaded && cartonsOf(c) ? fmtNum(cartonsOf(c)) : "—") + "</td><td>" + arr + "</td><td>" + docCell(c) + "</td></tr>";
      });
      html += "</tbody></table></div>";
    });
  });

  html += '<div class="rp-foot"><span>İplik Takip Masası</span><span>' + active.length + " konteyner · " + fmtTon(sumKg(active)) + "</span></div>";

  const area = $("printCanvasArea");
  area.innerHTML = html;
  html2canvas(area, { scale: 2, useCORS: true, backgroundColor: "#ffffff" }).then(canvas => {
    const link = document.createElement("a");
    link.download = "Sevkiyat_Durum_Raporu_" + todayISO() + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();
    area.innerHTML = "";
    toast("Resim indirildi");
  }).catch(err => {
    area.innerHTML = "";
    toast("Resim oluşturulamadı: " + err, "err");
  });
}

// =====================================================
// 13. EXCEL RAPORU (.xlsx, renkli)
// =====================================================
async function exportDetailedExcel() {
  if (!containers.length) { toast("Raporlanacak konteyner yok.", "err"); return; }
  if (typeof ExcelJS === "undefined") { toast("Excel kütüphanesi yüklenemedi. İnternet bağlantısını kontrol edin.", "err"); return; }

  const statusColors = { white: "ECEFF2", yellow: "FFF2CC", green: "D9F3E5", red: "FDE1DF", blue: "DCE8FB" };
  const fill = hex => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + hex } });
  const thin = { style: "thin", color: { argb: "FFC8D0D8" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  const pfMap = {};
  proformas.forEach(p => { pfMap[p.id] = p; });

  const rows = containers.slice().sort((a, b) => {
    const s = String(a.supplier || "").localeCompare(String(b.supplier || ""), "tr");
    if (s) return s;
    const pa = pfMap[a.pfId], pb = pfMap[b.pfId];
    const t = (pb ? pfTime(pb) : 0) - (pa ? pfTime(pa) : 0);
    return t || byIndex(a, b);
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "İplik Takip Masası";
  wb.created = new Date();

  const ws = wb.addWorksheet("Konteynerler", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Tedarikçi firma", key: "supplier", width: 20 },
    { header: "Proforma no", key: "pfNo", width: 16 },
    { header: "Proforma tarihi", key: "pfDate", width: 14 },
    { header: "Teslim şekli", key: "inc", width: 12 },
    { header: "Sıra", key: "order", width: 8 },
    { header: "Konteyner no", key: "no", width: 16 },
    { header: "Hat / acente", key: "line", width: 16 },
    { header: "B/L no", key: "bl", width: 16 },
    { header: "Durum", key: "status", width: 14 },
    { header: "Masa", key: "desk", width: 13 },
    { header: "Evrak", key: "docs", width: 12 },
    { header: "Evrak tarihi", key: "docsDate", width: 13 },
    { header: "Net ağırlık (kg)", key: "kg", width: 16 },
    { header: "Toplam karton", key: "cartons", width: 14 },
    { header: "Fatura tutarı ($)", key: "cost", width: 16 },
    { header: "Birim fiyat ($/kg)", key: "unit", width: 14 },
    { header: "Ek masraf ($)", key: "extra", width: 14 },
    { header: "Toplam maliyet ($)", key: "landed", width: 16 },
    { header: "Maliyet ($/kg)", key: "perkg", width: 14 },
    { header: "Sipariş tarihi", key: "orderDate", width: 14 },
    { header: "Yükleme tarihi", key: "loadDate", width: 14 },
    { header: "Tahmini varış", key: "arrival", width: 14 },
    { header: "Depo teslim tarihi", key: "whDate", width: 16 },
    { header: "Teslim depo", key: "whName", width: 13 },
    { header: "İplik ve renk kodları", key: "items", width: 50 }
  ];
  const hr = ws.getRow(1);
  hr.height = 30;
  hr.eachCell(cell => {
    cell.fill = fill("10283B");
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = border;
  });

  let totalKg = 0, ordered = 0, onTheWay = 0, delivered = 0, totalInvoice = 0, totalExtra = 0, totalCartons = 0;
  const bySupplier = {};

  rows.forEach(c => {
    const pf = pfMap[c.pfId] || {};
    const st = stageOf(c);
    const kg = bestKg(c);
    totalKg += kg;
    if (st === "yellow") ordered++;
    if (st === "green" || st === "red") onTheWay++;
    if (st === "blue") delivered++;
    const sName = c.supplier || "—";
    if (!bySupplier[sName]) bySupplier[sName] = { count: 0, kg: 0 };
    bySupplier[sName].count++;
    bySupplier[sName].kg += kg;

    const loaded = st === "green" || st === "red" || st === "blue";
    let items = "";
    if (loaded && c.loadedItems && c.loadedItems.length) items = c.loadedItems.map(i => i.code + ": " + fmtNum(i.kg) + " kg" + (i.cartons ? " / " + fmtNum(i.cartons) + " karton" : "")).join(" | ");
    else if (c.orderItems && c.orderItems.length) items = c.orderItems.map(i => i.code + ": " + fmtTonRaw(i.ton) + " t").join(" | ");

    const invoice = parseMoney(c.totalCost), extra = Number(c.extraCost) || 0;
    totalInvoice += invoice; totalExtra += extra; totalCartons += cartonsOf(c);
    const kgForCost = c.weightKg || kg;
    const row = ws.addRow({
      supplier: c.supplier || "", pfNo: c.pfNo || "", pfDate: fmtDate(c.pfDate), inc: pf.incoterm || "—",
      order: c.order || "",
      no: c.no || "—", line: c.shippingLine || "—", bl: c.blNo || "—",
      status: STAGE[st].label, desk: pf.isArchived ? "Arşivde" : "Aktif",
      docs: loaded ? docLabel(c) : "—", docsDate: loaded && c.docsDate ? fmtDate(c.docsDate) : "—", kg: kg || null, cartons: cartonsOf(c) || null, cost: invoice || null, unit: c.unitPrice || null, extra: extra || null, landed: invoice ? invoice + extra : null, perkg: invoice && kgForCost ? Math.round((invoice + extra) / kgForCost * 10000) / 10000 : null,
      orderDate: fmtDate(c.orderDate) || "—", loadDate: fmtDate(c.loadingDate) || "—",
      arrival: fmtDate(c.arrivalDate) || "—", whDate: fmtDate(c.warehouseDate) || "—",
      whName: c.warehouseName || "—", items
    });
    const bg = fill(statusColors[st]);
    row.eachCell(cell => { cell.fill = bg; cell.border = border; cell.alignment = { vertical: "middle", wrapText: true }; });
    row.getCell("supplier").font = { bold: true };
    row.getCell("status").font = { bold: true };
    row.getCell("kg").numFmt = "#,##0";
    row.getCell("kg").alignment = { vertical: "middle", horizontal: "right" };
    ["cost", "extra", "landed"].forEach(k => { row.getCell(k).numFmt = "#,##0.00"; row.getCell(k).alignment = { vertical: "middle", horizontal: "right" }; });
    ["unit", "perkg"].forEach(k => { row.getCell(k).numFmt = "0.0000"; row.getCell(k).alignment = { vertical: "middle", horizontal: "right" }; });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 25 } };

  const sm = wb.addWorksheet("Özet");
  sm.columns = [{ width: 38 }, { width: 26 }, { width: 18 }];
  sm.addRow(["İplik ithalat sevkiyat raporu"]).font = { bold: true, size: 14, color: { argb: "FF10283B" } };
  sm.addRow(["Rapor tarihi: " + nowStr()]).font = { color: { argb: "FF6B7D8C" } };
  sm.addRow([]);
  [
    ["Toplam konteyner", containers.length + " adet", "ECEFF2"],
    ["Siparişte (yüklenmemiş)", ordered + " konteyner", "FFF2CC"],
    ["Yolda veya limanda", onTheWay + " konteyner", "D9F3E5"],
    ["Depoya teslim edilen", delivered + " konteyner", "DCE8FB"],
    ["Toplam ağırlık", fmtNum(totalKg) + " kg (" + (totalKg / 1000).toFixed(2) + " ton)", "FFF2CC"],
    ["Toplam karton", fmtNum(totalCartons) + " adet", "ECEFF2"],
    ["Toplam fatura tutarı", fmtMoney(totalInvoice), "DCE8FB"],
    ["Toplam maliyet (fatura + ek masraf)", fmtMoney(totalInvoice + totalExtra), "DCE8FB"]
  ].forEach(l => {
    const r = sm.addRow([l[0], l[1]]);
    r.eachCell(cell => { cell.fill = fill(l[2]); cell.border = border; });
    r.getCell(1).font = { bold: true };
    r.getCell(2).font = { bold: true };
  });
  sm.addRow([]);
  const bh = sm.addRow(["Firma", "Konteyner sayısı", "Ağırlık (kg)"]);
  bh.eachCell(cell => { cell.fill = fill("10283B"); cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.alignment = { horizontal: "center" }; cell.border = border; });
  Object.keys(bySupplier).sort((a, b) => a.localeCompare(b, "tr")).forEach(name => {
    const r = sm.addRow([name, bySupplier[name].count, bySupplier[name].kg]);
    r.eachCell(cell => { cell.border = border; });
    r.getCell(3).numFmt = "#,##0";
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "Iplik_Konteyner_Raporu_" + todayISO() + ".xlsx";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast("Excel dosyası indirildi");
}

// =====================================================
// 14. BULUT DİNLEME VE BAŞLANGIÇ
// =====================================================
function listen(col, apply) {
  col.onSnapshot({ includeMetadataChanges: true }, snap => {
    const online = !snap.metadata.fromCache;
    // Önbellekten gelen boş sonuç doğrulanamaz; sunucudan gelen boş sonuç gerçektir
    if (snap.empty && snap.metadata.fromCache) { setBadge(false); return; }
    apply(snap.docs.map(d => Object.assign({}, d.data(), { id: d.id })));
    cacheAll();
    setBadge(online);
  }, err => { console.warn(err); setBadge(false); });
}

function startCloudSync() {
  listen(companiesCol, docs => {
    if (docs.length === 0 && !loadData("app_companies_seeded", false)) {
      saveData("app_companies_seeded", true);
      remoteBatch(b => companyDocs.forEach((c, i) => {
        b.set(companiesCol.doc(c.id), { name: c.name, order: typeof c.order === "number" ? c.order : i, createdAt: serverTs() });
      }));
      return;
    }
    setCompanies(docs);
    if (ui.company !== "all" && !companies.includes(ui.company)) ui.company = "all";
    updateCompanyList();
    renderAll();
  });
  listen(proformasCol, docs => { proformas = docs; renderAll(); });
  listen(containersCol, docs => { containers = docs; renderAll(); });
}

function init() {
  $("brandMark").innerHTML = ic("stack");
  $("searchBox").insertAdjacentHTML("afterbegin", ic("search"));
  updateCompanyList();
  renderAll();
  window.addEventListener("offline", () => setBadge(false));
  setInterval(renderAll, 30 * 60 * 1000);   // gün değişince "kaç gün kaldı" yazıları tazelenir
  if (db) startCloudSync(); else setBadge(false);
}
init();
