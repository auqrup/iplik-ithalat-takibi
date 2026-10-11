/* İplik Takip Masası - app.js */

// =====================================================
// 1. YARDIMCI FONKSİYONLAR
// =====================================================
const $ = id => document.getElementById(id);

// HTML'e basılan her kullanıcı metni buradan geçer (XSS koruması)
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Yerel saate göre YYYY-MM-DD (toISOString UTC verdiği için gece yarısı hatası yapıyordu)
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Ekranda GG.AA.YYYY göster
function fmtDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? m[3] + '.' + m[2] + '.' + m[1] : iso;
}

function fmtNum(n) { return Number(n || 0).toLocaleString('tr-TR'); }
function nowStr() { return new Date().toLocaleString('tr-TR'); }

// =====================================================
// 2. FIREBASE (tek doğru kaynak) + OFFLINE PERSISTENCE
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
  // İnternet yokken de çalışsın; bağlantı gelince otomatik senkronize olur
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
// 3. DURUM (STATE) — localStorage sadece ilk çizim ve yerel mod için ÖNBELLEK
// =====================================================
function loadData(key, def) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : def; } catch (e) { return def; }
}
function saveData(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

function companyId(name) { return String(name).replace(/\//g, '_'); }

function companyTime(c) {
  if (typeof c.order === 'number') return c.order;
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
let companies = []; // sadece isimler, sıralı
let proformas = loadData("app_proformas_v1", []);
let containers = loadData("app_containers_v1", []);

function setCompanies(docs) {
  companyDocs = docs.slice().sort((a, b) => (companyTime(a) - companyTime(b)) || String(a.name).localeCompare(String(b.name), 'tr'));
  companies = companyDocs.map(c => c.name);
}
setCompanies(loadCompanyDocs());

function cacheAll() {
  saveData("app_companies_v2", companyDocs);
  saveData("app_proformas_v1", proformas);
  saveData("app_containers_v1", containers);
}

function pfTime(p) {
  return p.timestamp || (p.createdAt && p.createdAt.seconds ? p.createdAt.seconds * 1000 : 0) || parseInt(String(p.id).replace('pf_', ''), 10) || 0;
}
function getStatusPriority(status) {
  if (status === 'white' || status === 'yellow') return 1;
  if (status === 'green') return 2;
  if (status === 'red') return 3;
  if (status === 'blue') return 4;
  return 1;
}
function cntSort(a, b) {
  const pA = getStatusPriority(a.status), pB = getStatusPriority(b.status);
  if (pA !== pB) return pA - pB;
  return (a.orderIndex || 0) - (b.orderIndex || 0);
}
const findC = id => containers.find(c => c.id === id);

// Bir konteyneri hem yerelde hem bulutta güncelle
function updateContainer(id, patch) {
  const c = findC(id);
  if (!c) return;
  Object.assign(c, patch);
  cacheAll();
  remoteSet(containersCol, id, patch);
}

function setBadge(online) {
  const b = $("syncBadge");
  if (!b) return;
  if (!db) { b.className = "sync-badge"; b.innerText = "Yerel Mod 🟡"; return; }
  b.className = "sync-badge" + (online ? " online" : "");
  b.innerText = online ? "Bulut Senkronize 🟢" : "Çevrimdışı 🟡";
}

// =====================================================
// 4. MODALLAR & PIN
// =====================================================
let pendingDeletionAction = null;

function showModal(id) {
  if (id === "modalCompany") updateCompanyList();
  if (id === "modalProforma") {
    updateCompanyList();
    updateProformaList();
    if (!$("pfDate").value) $("pfDate").value = todayISO();
  }
  $(id).style.display = "flex";
}
function hideModal(id) { $(id).style.display = "none"; }

function triggerSuccessModal(title, desc) {
  $("successTitle").innerText = title;
  $("successDesc").innerText = desc;
  $("modalSuccess").style.display = "flex";
}

function requestPinProtectedAction(actionCallback) {
  pendingDeletionAction = actionCallback;
  const pinInput = $("inputPinCode");
  pinInput.value = "";
  $("pinErrorMsg").style.display = "none";
  $("modalPinAuth").style.display = "flex";
  setTimeout(() => pinInput.focus(), 100);
}

function validateAndExecutePin() {
  const entered = $("inputPinCode").value.trim();
  if (entered === "1989") {
    hideModal("modalPinAuth");
    if (typeof pendingDeletionAction === "function") pendingDeletionAction();
    pendingDeletionAction = null;
  } else {
    $("pinErrorMsg").style.display = "block";
  }
}

// =====================================================
// 5. FİRMA İŞLEMLERİ
// =====================================================
function addCompany() {
  const inp = $("inputCompName");
  const val = inp.value.trim().toUpperCase();
  if (!val) { alert("Lütfen firma adı yazınız!"); return; }
  if (companies.includes(val)) { alert("Bu firma zaten kayıtlı!"); return; }

  const id = companyId(val);
  const order = Date.now();
  setCompanies(companyDocs.concat([{ id, name: val, order }]));
  cacheAll();
  inp.value = "";

  hideModal("modalCompany");
  triggerSuccessModal("Firma Eklendi!", '"' + val + '" firması başarıyla eklendi.');
  renderBoard();
  remoteSet(companiesCol, id, { name: val, order, createdAt: serverTs() });
}

function removeCompany(name) {
  const hasActivePf = proformas.some(p => p.supplier === name && !p.isArchived);
  if (hasActivePf) {
    alert('UYARI: "' + name + '" firmasına ait henüz arşivlenmemiş aktif proformalar var!');
    return;
  }
  if (!confirm('"' + name + '" firmasını aktif listeden silmek istediğinize emin misiniz?')) return;

  const doc = companyDocs.find(c => c.name === name);
  setCompanies(companyDocs.filter(c => c.name !== name));
  cacheAll();
  updateCompanyList();
  renderBoard();
  if (doc) remoteDelete(companiesCol, doc.id);
}

function updateCompanyList() {
  let html = "";
  companies.forEach(c => {
    html += '<div class="list-row"><strong>' + esc(c) + '</strong>' +
      '<button class="btn btn-danger" data-action="removeCompany" data-name="' + esc(c) + '">Sil ✕</button></div>';
  });
  $("companyList").innerHTML = html;

  const sel = $("pfSupplierSelect");
  const cur = sel.value;
  sel.innerHTML = companies.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join("");
  if (companies.includes(cur)) sel.value = cur;
}

// =====================================================
// 6. PROFORMA İŞLEMLERİ
// =====================================================
function addProforma() {
  const supp = $("pfSupplierSelect").value;
  const no = $("pfNumber").value.trim().toUpperCase();
  const date = $("pfDate").value;
  const total = parseInt($("pfTotal").value, 10);
  const price = $("pfPrice").value.trim();

  if (!supp) { alert("Lütfen bir firma seçiniz!"); return; }
  if (!no) { alert("Lütfen Proforma No yazınız!"); return; }
  if (!total || total < 1) { alert("Lütfen geçerli konteyner sayısı giriniz!"); return; }

  const timestamp = Date.now();
  const pfId = "pf_" + timestamp;
  const newPf = { id: pfId, supplier: supp, no, date, total, price, isArchived: false, timestamp };

  const newContainers = [];
  for (let i = 1; i <= total; i++) {
    newContainers.push({
      id: "cnt_" + timestamp + "_" + i,
      pfId, supplier: supp, pfNo: no, pfDate: date,
      order: i + " / " + total, orderIndex: i,
      no: "", shippingLine: "", weightTon: 0, weightKg: 0, totalCost: "",
      orderDate: "", orderItems: [], loadedItems: [], details: "",
      status: "white", loadingDate: "", arrivalDate: "", warehouseDate: "", warehouseName: "",
      statusBeforeWarehouse: ""
    });
  }

  proformas.unshift(newPf);
  containers = containers.concat(newContainers);
  cacheAll();

  $("pfNumber").value = "";
  $("pfPrice").value = "";

  hideModal("modalProforma");
  triggerSuccessModal("Proforma Oluşturuldu!", '[' + supp + '] "' + no + '" proforması ve ' + total + ' adet konteyner oluşturuldu.');
  renderBoard();

  remoteBatch(b => {
    b.set(proformasCol.doc(pfId), Object.assign({}, newPf, { createdAt: serverTs() }));
    newContainers.forEach(c => b.set(containersCol.doc(c.id), Object.assign({}, c, { createdAt: serverTs() })));
  });
}

function permanentDeleteProforma(id) {
  requestPinProtectedAction(() => {
    if (!proformas.some(p => p.id === id)) return;
    const cntIds = containers.filter(c => c.pfId === id).map(c => c.id);

    proformas = proformas.filter(p => p.id !== id);
    containers = containers.filter(c => c.pfId !== id);
    cacheAll();
    updateProformaList();
    renderBoard();

    remoteBatch(b => {
      b.delete(proformasCol.doc(id));
      cntIds.forEach(cid => b.delete(containersCol.doc(cid)));
    });
  });
}

// Arşivden tek konteyner silinince proforma toplamı ve sıra numaraları güncellenir
function permanentDeleteContainer(id) {
  requestPinProtectedAction(() => {
    const c = findC(id);
    if (!c) return;
    const pf = proformas.find(p => p.id === c.pfId);

    containers = containers.filter(x => x.id !== id);
    const remaining = containers.filter(x => x.pfId === c.pfId).sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
    const pfGone = pf && remaining.length === 0;

    if (pfGone) {
      proformas = proformas.filter(p => p.id !== pf.id);
    } else if (pf) {
      pf.total = remaining.length;
      remaining.forEach((x, i) => { x.orderIndex = i + 1; x.order = (i + 1) + " / " + remaining.length; });
    }

    cacheAll();
    updateProformaList();
    renderBoard();

    remoteBatch(b => {
      b.delete(containersCol.doc(id));
      if (pfGone) {
        b.delete(proformasCol.doc(pf.id));
      } else if (pf) {
        b.set(proformasCol.doc(pf.id), { total: pf.total }, { merge: true });
        remaining.forEach(x => b.set(containersCol.doc(x.id), { orderIndex: x.orderIndex, order: x.order }, { merge: true }));
      }
    });
  });
}

function updateProformaList() {
  let html = "";
  proformas.forEach(p => {
    const cnt = containers.filter(c => c.pfId === p.id).length;
    html += '<div class="list-row"><div><strong>[' + esc(p.supplier) + '] ' + esc(p.no) + '</strong> ' +
      (p.isArchived ? '<span style="color:#0284c7; font-weight:bold;">(Arşivde)</span>' : '<span style="color:#059669; font-weight:bold;">(Aktif)</span>') + '<br>' +
      '<small>Konteyner: ' + cnt + '/' + esc(p.total) + (p.price ? ' | ' + esc(p.price) : '') + '</small></div>' +
      (p.isArchived
        ? '<button class="btn btn-danger" data-action="deleteProforma" data-id="' + esc(p.id) + '">Kalıcı Sil 🔒</button>'
        : '<small style="color:#64748b;">(Önce Arşivleyin)</small>') +
      '</div>';
  });
  $("proformaList").innerHTML = html || "<small>Kayıtlı proforma yok.</small>";
}

function toggleArchiveProforma(pfId, shouldArchive) {
  const p = proformas.find(item => item.id === pfId);
  if (!p) return;
  const q = shouldArchive ? ' proformasını arşive taşımak istiyor musunuz?' : ' proformasını aktif panoya geri getirmek istiyor musunuz?';
  if (!confirm('[' + p.supplier + '] "' + p.no + '"' + q)) return;

  p.isArchived = shouldArchive;
  cacheAll();
  renderBoard();
  remoteSet(proformasCol, pfId, { isArchived: shouldArchive });
}

// =====================================================
// 7. DİNAMİK İPLİK / RENK SATIRLARI (DOM ile, enjeksiyon yok)
// =====================================================
function buildYarnRow(codeClass, valClass, valPlaceholder, step, code, val) {
  const div = document.createElement('div');
  div.className = 'yarn-row';

  const i1 = document.createElement('input');
  i1.type = 'text'; i1.placeholder = 'İplik Kodu / Renk Kodu'; i1.style.flex = '2';
  i1.className = codeClass; i1.value = code || '';

  const i2 = document.createElement('input');
  i2.type = 'number'; i2.step = step; i2.placeholder = valPlaceholder; i2.style.flex = '1';
  i2.className = valClass; i2.value = val ? val : '';

  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-danger'; btn.style.padding = '4px 6px'; btn.textContent = '✕';
  btn.addEventListener('click', () => { div.remove(); updateWeightChecks(); });

  div.append(i1, i2, btn);
  return div;
}

function addOrderRow(code, ton) {
  $("orderItemsContainer").appendChild(buildYarnRow('order-code-input', 'order-ton-input', 'Miktar (Ton)', '0.01', code, ton));
  updateWeightChecks();
}
function addLoadedRow(code, kg) {
  $("loadedItemsContainer").appendChild(buildYarnRow('loaded-code-input', 'loaded-kg-input', 'Net (Kg)', '1', code, kg));
  updateWeightChecks();
}

// Canlı toplam / uyuşmazlık göstergesi
function updateWeightChecks() {
  let tons = 0;
  document.querySelectorAll('#orderItemsContainer .order-ton-input').forEach(i => { tons += parseFloat(i.value) || 0; });
  const oi = $("orderTotalInfo");
  if (oi) oi.textContent = 'Toplam: ' + tons.toLocaleString('tr-TR', { maximumFractionDigits: 3 }) + ' Ton';

  let sum = 0;
  document.querySelectorAll('#loadedItemsContainer .loaded-kg-input').forEach(i => { sum += parseFloat(i.value) || 0; });
  const total = parseFloat($("statusWeightKg").value) || 0;
  const el = $("weightCheck");
  if (!el) return;
  if (!sum && !total) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const diff = total - sum;
  if (Math.abs(diff) < 0.5) {
    el.className = 'weight-check ok';
    el.textContent = '✓ Kalemler toplamı (' + fmtNum(sum) + ' Kg) net kiloyla eşleşiyor.';
  } else {
    el.className = 'weight-check bad';
    el.textContent = '⚠ Kalemler toplamı ' + fmtNum(sum) + ' Kg, net kilo ' + fmtNum(total) + ' Kg → fark ' + fmtNum(Math.abs(diff)) + ' Kg';
  }
  el.style.display = 'block';
}
document.addEventListener('input', e => {
  if (e.target.matches('.order-ton-input, .loaded-kg-input, #statusWeightKg')) updateWeightChecks();
});

// =====================================================
// 8. AŞAMALI İŞ AKIŞLARI
// =====================================================
function openOrderModal(id) {
  const c = findC(id);
  if (!c) return;
  $("orderCntId").value = c.id;
  $("orderDateInput").value = c.orderDate || todayISO();

  $("orderItemsContainer").innerHTML = "";
  if (c.orderItems && c.orderItems.length > 0) c.orderItems.forEach(it => addOrderRow(it.code, it.ton));
  else addOrderRow("", "");
  showModal("modalOrder");
  updateWeightChecks();
}

function submitOrder() {
  const id = $("orderCntId").value;
  const orderDate = $("orderDateInput").value;
  const items = [];
  let totalTon = 0;

  document.querySelectorAll('#orderItemsContainer .yarn-row').forEach(row => {
    const code = row.querySelector('.order-code-input').value.trim().toUpperCase();
    const ton = parseFloat(row.querySelector('.order-ton-input').value) || 0;
    if (code) { items.push({ code, ton }); totalTon += ton; }
  });

  if (items.length === 0) { alert("Lütfen en az bir İplik / Renk kodu giriniz!"); return; }

  const c = findC(id);
  if (c) {
    const patch = { orderItems: items, weightTon: Math.round(totalTon * 1000) / 1000, orderDate };
    // Sadece yeni (beyaz) kart sarıya döner; ilerlemiş kart aşamasını korur
    if (c.status === "white") patch.status = "yellow";
    updateContainer(id, patch);
  }
  hideModal("modalOrder");
  renderBoard();
}

function openStatusModal(id) {
  const c = findC(id);
  if (!c) return;
  $("statusCntId").value = c.id;
  $("statusShippingLine").value = c.shippingLine || "";
  $("statusCntNo").value = c.no || "";
  $("statusLoadingDate").value = c.loadingDate || todayISO();
  $("statusWeightKg").value = c.weightKg || (c.weightTon ? Math.round(c.weightTon * 1000) : "");
  $("statusTotalCost").value = c.totalCost || "";
  $("statusErrorText").style.display = "none";

  $("loadedItemsContainer").innerHTML = "";
  if (c.loadedItems && c.loadedItems.length > 0) c.loadedItems.forEach(it => addLoadedRow(it.code, it.kg));
  else if (c.orderItems && c.orderItems.length > 0) c.orderItems.forEach(it => addLoadedRow(it.code, Math.round(it.ton * 1000)));
  else addLoadedRow("", "");

  showModal("modalStatus");
  updateWeightChecks();
}

function submitStatus() {
  const id = $("statusCntId").value;
  const shippingLine = $("statusShippingLine").value.trim().toUpperCase();
  const no = $("statusCntNo").value.trim().toUpperCase();
  const loadingDate = $("statusLoadingDate").value;
  const weightKg = parseFloat($("statusWeightKg").value) || 0;
  const totalCost = $("statusTotalCost").value.trim();
  const errEl = $("statusErrorText");

  if (!shippingLine || !no || !loadingDate || !weightKg || !totalCost) {
    errEl.style.display = "block";
    return;
  }
  errEl.style.display = "none";

  const loadedItems = [];
  let sum = 0;
  document.querySelectorAll('#loadedItemsContainer .yarn-row').forEach(row => {
    const code = row.querySelector('.loaded-code-input').value.trim().toUpperCase();
    const kg = parseFloat(row.querySelector('.loaded-kg-input').value) || 0;
    if (code) { loadedItems.push({ code, kg }); sum += kg; }
  });

  // Kalemler toplamı ≠ toplam net kilo ise onay iste
  if (loadedItems.length && Math.abs(sum - weightKg) >= 0.5) {
    const ok = confirm('Kalemler toplamı ' + fmtNum(sum) + ' Kg, toplam net kilo ' + fmtNum(weightKg) +
      ' Kg. Fark: ' + fmtNum(Math.abs(weightKg - sum)) + ' Kg.\n\nYine de kaydetmek istiyor musunuz?');
    if (!ok) return;
  }

  updateContainer(id, { status: "green", shippingLine, no, loadingDate, weightKg, totalCost, loadedItems });
  hideModal("modalStatus");
  renderBoard();
}

function openArrivalModal(id) {
  const c = findC(id);
  if (!c) return;
  $("arrivalCntId").value = c.id;
  $("arrivalDateInput").value = c.arrivalDate || "";
  $("arrivalStatusSelect").value = (c.status === "red" ? "red" : "green");
  showModal("modalArrival");
}

function submitArrival() {
  const id = $("arrivalCntId").value;
  updateContainer(id, { arrivalDate: $("arrivalDateInput").value, status: $("arrivalStatusSelect").value });
  hideModal("modalArrival");
  renderBoard();
}

function openWarehouseModal(id) {
  const c = findC(id);
  if (!c) return;
  $("warehouseCntId").value = c.id;
  $("whDateInput").value = c.warehouseDate || todayISO();
  $("whNameSelect").value = c.warehouseName || "RÜYA";
  showModal("modalWarehouse");
}

function submitWarehouse() {
  const id = $("warehouseCntId").value;
  const whDate = $("whDateInput").value;
  const whName = $("whNameSelect").value;
  if (!whDate) { alert("Lütfen depo teslim tarihini seçiniz!"); return; }

  const c = findC(id);
  if (!c) return;
  const patch = { status: "blue", warehouseDate: whDate, warehouseName: whName };
  // Geri alırken hangi aşamaya döneceğimizi hatırla (yeşil mi kırmızı mı)
  if (c.status !== "blue") patch.statusBeforeWarehouse = c.status;
  updateContainer(id, patch);
  hideModal("modalWarehouse");
  renderBoard();
}

// Bir önceki aşamaya geri al (veriler silinmez, sadece aşama değişir)
function revertStage(id) {
  const c = findC(id);
  if (!c) return;
  const map = { yellow: 'white', green: 'yellow', red: 'green' };
  const prev = c.status === 'blue' ? (c.statusBeforeWarehouse || 'green') : map[c.status];
  if (!prev) return;

  const names = { white: 'Detaysız', yellow: 'Sipariş Verildi', green: 'Yüklendi (Yolda)', red: 'Limanda' };
  if (!confirm('Bu konteyner "' + names[prev] + '" aşamasına geri alınacak. Devam edilsin mi?')) return;

  const patch = { status: prev };
  if (c.status === 'blue') { patch.warehouseDate = ''; patch.warehouseName = ''; patch.statusBeforeWarehouse = ''; }
  updateContainer(id, patch);
  renderBoard();
}

// =====================================================
// 9. EKRAN ÇİZİMİ
// =====================================================
function renderBoard() {
  let html = "";

  companies.forEach(comp => {
    const compPfs = proformas.filter(p => p.supplier === comp && !p.isArchived).sort((a, b) => pfTime(b) - pfTime(a));

    html += '<div class="column"><div class="col-head"><span>' + esc(comp) + '</span>' +
      '<span class="col-count">' + compPfs.length + ' Aktif Proforma</span></div>';

    if (compPfs.length === 0) {
      html += '<div class="empty-box">Aktif Proforma Yok</div>';
    } else {
      compPfs.forEach(pf => {
        const pfCnts = containers.filter(c => c.pfId === pf.id).sort(cntSort);
        html += '<div class="pf-block">' +
          '<div class="pf-block-head">' +
            '<span class="pf-tag">' + esc(pf.no) + '</span>' +
            '<span class="pf-price">' + esc(pf.price || '') + '</span>' +
            '<button class="btn-archive-pf" title="Bu proformayı arşive kaldır" data-action="archive" data-id="' + esc(pf.id) + '">📦 Arşivle</button>' +
          '</div>' +
          '<div class="pf-meta"><span>📅 ' + esc(fmtDate(pf.date) || 'Tarih Yok') + '</span>' +
          '<span>Konteyner: ' + pfCnts.length + ' / ' + esc(pf.total) + '</span></div>';
        pfCnts.forEach(c => { html += renderCard(c, false); });
        html += '</div>';
      });
    }
    html += '</div>';
  });

  $("boardContainer").innerHTML = html;

  // Arşiv
  const archived = proformas.filter(p => p.isArchived === true).sort((a, b) => pfTime(b) - pfTime(a));
  $("archiveCount").innerText = archived.length;

  let arc = "";
  archived.forEach(apf => {
    const cnts = containers.filter(c => c.pfId === apf.id).sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
    arc += '<div class="pf-block archived">' +
      '<div class="pf-block-head">' +
        '<span class="pf-tag">' + esc(apf.supplier) + ' - ' + esc(apf.no) + '</span>' +
        '<div style="display:flex; gap:4px;">' +
          '<button class="btn-restore-pf" data-action="restore" data-id="' + esc(apf.id) + '">↩ Geri Al</button>' +
          '<button class="btn btn-danger" data-action="deleteProforma" data-id="' + esc(apf.id) + '">🗑️ Sil 🔒</button>' +
        '</div>' +
      '</div>' +
      '<div class="pf-meta"><span>📅 ' + esc(fmtDate(apf.date) || 'Tarih Yok') + '</span><span>' + esc(apf.price || '') + '</span></div>';
    cnts.forEach(c => { arc += renderCard(c, true); });
    arc += '</div>';
  });
  $("archiveContainer").innerHTML = arc || "<small style='color:#94a3b8;'>Arşivlenmiş proforma bulunmuyor.</small>";
}

function renderCard(c, isArchivedView) {
  const styles = {
    white:  { bg: "bg-white",  border: "card-border-white",  label: "Detaysız" },
    yellow: { bg: "bg-yellow", border: "card-border-yellow", label: "Sipariş Verildi" },
    green:  { bg: "bg-green",  border: "card-border-green",  label: "Yüklendi (Yolda)" },
    red:    { bg: "bg-red",    border: "card-border-red",    label: "Limanda" },
    blue:   { bg: "bg-blue",   border: "card-border-blue",   label: "Depoda" }
  };
  const st = styles[c.status] || styles.white;
  const id = esc(c.id);

  let actionButton = '';
  if (!isArchivedView) {
    if (c.status === 'white') {
      actionButton = '<button class="btn btn-step-order" data-action="openOrder" data-id="' + id + '">📝 Sipariş Ver</button>';
    } else if (c.status === 'yellow') {
      actionButton = '<button class="btn btn-step-status" data-action="openStatus" data-id="' + id + '">🔄 Durumu Güncelle</button>';
    } else if (c.status === 'green' || c.status === 'red') {
      actionButton = '<button class="btn btn-step-arrival" data-action="openArrival" data-id="' + id + '">📅 Tahmini Varış</button>' +
                     '<button class="btn btn-step-warehouse" data-action="openWarehouse" data-id="' + id + '">🏢 Depo Girişi</button>';
    } else if (c.status === 'blue') {
      actionButton = '<button class="btn btn-step-warehouse" data-action="openWarehouse" data-id="' + id + '">🏢 Depo: ' + esc(c.warehouseName || 'Giriş Yapıldı') + '</button>';
    }
  } else {
    actionButton = '<button class="btn btn-danger" data-action="deleteContainer" data-id="' + id + '">🗑️ Sil 🔒</button>';
  }

  let sideButtons = '';
  if (!isArchivedView) {
    if (c.status && c.status !== 'white') {
      sideButtons += '<button class="btn btn-back" title="Bir önceki aşamaya geri al" data-action="revert" data-id="' + id + '">↩ Geri</button>';
    }
    if (c.status !== 'white') {
      sideButtons += '<button class="btn btn-gray btn-edit" data-action="openOrder" data-id="' + id + '">✏️ Sipariş</button>';
    }
  }

  let itemsHtml = '';
  if (c.status === 'yellow' && c.orderItems && c.orderItems.length > 0) {
    itemsHtml = '<div class="items-order"><b>📝 Sipariş Kalemleri (Ton):</b><br>' +
      c.orderItems.map(it => '• <b>' + esc(it.code) + '</b>: ' + esc(it.ton) + ' Ton').join('<br>') + '</div>';
  } else if ((c.status === 'green' || c.status === 'red' || c.status === 'blue') && c.loadedItems && c.loadedItems.length > 0) {
    itemsHtml = '<div class="items-loaded"><b>📦 Yüklenen Kalemler (Kg):</b><br>' +
      c.loadedItems.map(it => '• <b>' + esc(it.code) + '</b>: ' + fmtNum(it.kg) + ' Kg').join('<br>') + '</div>';
  }

  let summaryHtml = '';
  if (c.weightKg || c.weightTon || c.totalCost) {
    const wt = c.weightKg ? (fmtNum(c.weightKg) + ' Kg') : (esc(c.weightTon) + ' Ton');
    summaryHtml = '<div class="loaded-summary-box"><span>⚖️ Net: ' + wt + '</span><span>💵 Tutar: ' + esc(c.totalCost || '—') + '</span></div>';
  }

  let datesHtml = '';
  if (c.loadingDate || c.arrivalDate || c.warehouseDate) {
    datesHtml = '<div class="card-dates-box">' +
      (c.loadingDate ? '<div>📦 Yükleme Tarihi: <b>' + esc(fmtDate(c.loadingDate)) + '</b></div>' : '') +
      (c.arrivalDate ? '<div>⚓ Liman / Varış: <b style="color:#0284c7;">' + esc(fmtDate(c.arrivalDate)) + '</b></div>' : '') +
      (c.warehouseDate ? '<div style="color:#2563eb;">🏢 Depo Teslim: <b>' + esc(fmtDate(c.warehouseDate)) + ' (' + esc(c.warehouseName || '') + ')</b></div>' : '') +
      '</div>';
  }

  return '<div class="card ' + st.border + '">' +
    '<div class="card-head ' + st.bg + '">' +
      '<span style="font-size:11px; white-space:nowrap;">' + esc(c.order) + '</span>' +
      '<span class="card-head-center">' + esc(c.supplier) + '</span>' +
      '<span style="font-size:10px; opacity:0.9; white-space:nowrap;">' + st.label + '</span>' +
    '</div>' +
    '<div class="card-body">' +
      (c.orderDate ? '<div>📝 Sipariş Tarihi: <b style="color:#b45309;">' + esc(fmtDate(c.orderDate)) + '</b></div>' : '') +
      (c.shippingLine ? '<div>🚢 Hat/Firma: <b>' + esc(c.shippingLine) + '</b></div>' : '') +
      (c.no ? '<div class="cnt-no">Konteyner: ' + esc(c.no) + '</div>' : '') +
      itemsHtml + summaryHtml + datesHtml +
    '</div>' +
    '<div class="card-footer">' +
      '<div class="card-footer-main">' + actionButton + '</div>' +
      '<div class="card-footer-side">' + sideButtons + '</div>' +
    '</div>' +
  '</div>';
}

// Tüm dinamik düğmeler tek yerden (inline onclick yok → tırnak/XSS sorunu yok)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'openOrder': openOrderModal(id); break;
    case 'openStatus': openStatusModal(id); break;
    case 'openArrival': openArrivalModal(id); break;
    case 'openWarehouse': openWarehouseModal(id); break;
    case 'revert': revertStage(id); break;
    case 'archive': toggleArchiveProforma(id, true); break;
    case 'restore': toggleArchiveProforma(id, false); break;
    case 'deleteProforma': permanentDeleteProforma(id); break;
    case 'deleteContainer': permanentDeleteContainer(id); break;
    case 'removeCompany': removeCompany(el.dataset.name); break;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target && e.target.id === 'inputPinCode') validateAndExecutePin();
});

// =====================================================
// 10. RESİM RAPORU
// =====================================================
function captureActiveCardsAsImage() {
  const active = containers.filter(c => {
    const pf = proformas.find(p => p.id === c.pfId);
    return pf && !pf.isArchived && (c.status === 'yellow' || c.status === 'green' || c.status === 'red');
  });

  if (active.length === 0) {
    alert("Siparişte, yolda veya limanda olan aktif bir konteyner kartı bulunamadı!");
    return;
  }
  if (typeof html2canvas === 'undefined') { alert("Resim kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edin."); return; }

  const area = $("printCanvasArea");
  let html = '<div style="margin-bottom:15px; border-bottom:2px solid #0f172a; padding-bottom:10px;">' +
    '<h2 style="margin:0; color:#0f172a;">📦 Aktif Konteyner Sevkiyat Durum Raporu</h2>' +
    '<small style="color:#64748b;">Rapor Tarihi: ' + esc(nowStr()) + ' | Toplam: ' + active.length + ' Konteyner</small>' +
    '</div><div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:15px;">';
  active.forEach(c => { html += '<div>' + renderCard(c, true).replace(/<div class="card-footer">[\s\S]*$/, '</div>') + '</div>'; });
  html += '</div>';
  area.innerHTML = html;

  html2canvas(area, { scale: 2, useCORS: true }).then(canvas => {
    const link = document.createElement("a");
    link.download = "Aktif_Sevkiyat_Konteynerler_" + todayISO() + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();
    area.innerHTML = "";
  }).catch(err => {
    area.innerHTML = "";
    alert("Resim oluşturulurken hata oluştu: " + err);
  });
}

// =====================================================
// 11. GERÇEK .XLSX RAPORU (ExcelJS — renkler korunur)
// =====================================================
async function exportDetailedExcel() {
  if (containers.length === 0) { alert("Raporlanacak kayıtlı konteyner bulunamadı!"); return; }
  if (typeof ExcelJS === 'undefined') { alert("Excel kütüphanesi yüklenemedi. İnternet bağlantınızı kontrol edin."); return; }

  const statusLabels = {
    white: "Detaysız (Bekliyor)", yellow: "Sipariş Verildi", green: "Yüklendi (Yolda)",
    red: "Limana Ulaştı (Limanda)", blue: "Depoya Teslim Alındı"
  };
  const statusColors = { white: "F8FAFC", yellow: "FEF3C7", green: "DCFCE7", red: "FEE2E2", blue: "DBEAFE" };

  const fill = hex => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + hex } });
  const thin = { style: 'thin', color: { argb: 'FFCBD5E1' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  const pfMap = {};
  proformas.forEach(p => { pfMap[p.id] = p; });

  const rows = containers.slice().sort((a, b) => {
    const s = String(a.supplier || '').localeCompare(String(b.supplier || ''), 'tr');
    if (s) return s;
    const pa = pfMap[a.pfId], pb = pfMap[b.pfId];
    const t = (pb ? pfTime(pb) : 0) - (pa ? pfTime(pa) : 0);
    if (t) return t;
    return (a.orderIndex || 0) - (b.orderIndex || 0);
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'İplik Takip Masası';
  wb.created = new Date();

  // ---- Sayfa 1: Konteynerler ----
  const ws = wb.addWorksheet('Konteynerler', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Tedarikçi Firma', key: 'supplier', width: 20 },
    { header: 'Proforma No', key: 'pfNo', width: 16 },
    { header: 'Proforma Tarihi', key: 'pfDate', width: 14 },
    { header: 'Sıra', key: 'order', width: 8 },
    { header: 'Konteyner No', key: 'no', width: 16 },
    { header: 'Hat / Acente', key: 'line', width: 16 },
    { header: 'Sevkiyat Durumu', key: 'status', width: 24 },
    { header: 'Masa Durumu', key: 'desk', width: 13 },
    { header: 'Net Ağırlık (Kg)', key: 'kg', width: 16 },
    { header: 'Toplam Tutar ($)', key: 'cost', width: 16 },
    { header: 'Sipariş Giriş Tarihi', key: 'orderDate', width: 16 },
    { header: 'Yükleme Tarihi', key: 'loadDate', width: 14 },
    { header: 'Tahmini Varış', key: 'arrival', width: 14 },
    { header: 'Depo Teslim Tarihi', key: 'whDate', width: 16 },
    { header: 'Teslim Depo', key: 'whName', width: 13 },
    { header: 'İplik & Renk Kodları / Miktarlar', key: 'items', width: 50 }
  ];

  const hr = ws.getRow(1);
  hr.height = 30;
  hr.eachCell(cell => {
    cell.fill = fill('0F172A');
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border;
  });

  let totalKg = 0, onTheWay = 0, delivered = 0, ordered = 0;
  const bySupplier = {};

  rows.forEach(c => {
    const pf = pfMap[c.pfId];
    const kg = c.weightKg || (c.weightTon ? Math.round(c.weightTon * 1000) : 0);
    totalKg += kg;
    if (c.status === 'blue') delivered++;
    if (c.status === 'green' || c.status === 'red') onTheWay++;
    if (c.status === 'yellow') ordered++;
    const sName = c.supplier || '—';
    if (!bySupplier[sName]) bySupplier[sName] = { count: 0, kg: 0 };
    bySupplier[sName].count++;
    bySupplier[sName].kg += kg;

    let items = '';
    if (c.loadedItems && c.loadedItems.length) items = c.loadedItems.map(it => it.code + ': ' + fmtNum(it.kg) + ' Kg').join(' | ');
    else if (c.orderItems && c.orderItems.length) items = c.orderItems.map(it => it.code + ': ' + it.ton + ' Ton').join(' | ');

    const row = ws.addRow({
      supplier: c.supplier || '', pfNo: c.pfNo || '', pfDate: fmtDate(c.pfDate), order: c.order || '',
      no: c.no || '—', line: c.shippingLine || '—',
      status: statusLabels[c.status] || c.status,
      desk: (pf && pf.isArchived) ? 'Arşivde' : 'Aktif Masada',
      kg: kg || null, cost: c.totalCost || '—',
      orderDate: fmtDate(c.orderDate) || '—', loadDate: fmtDate(c.loadingDate) || '—',
      arrival: fmtDate(c.arrivalDate) || '—', whDate: fmtDate(c.warehouseDate) || '—',
      whName: c.warehouseName || '—', items
    });
    const bg = fill(statusColors[c.status] || "FFFFFF");
    row.eachCell(cell => {
      cell.fill = bg;
      cell.border = border;
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    row.getCell('supplier').font = { bold: true };
    row.getCell('status').font = { bold: true };
    row.getCell('status').alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell('kg').numFmt = '#,##0';
    row.getCell('kg').alignment = { vertical: 'middle', horizontal: 'right' };
    row.getCell('cost').font = { bold: true };
    row.getCell('cost').alignment = { vertical: 'middle', horizontal: 'right' };
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 16 } };

  // ---- Sayfa 2: Özet ----
  const sm = wb.addWorksheet('Özet');
  sm.columns = [{ width: 38 }, { width: 24 }, { width: 18 }];
  const title = sm.addRow(['İplik İthalat & Konteyner Sevkiyat Durum Raporu']);
  title.font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };
  sm.addRow(['Rapor Tarihi: ' + nowStr()]).font = { color: { argb: 'FF64748B' } };
  sm.addRow([]);

  const summaryLines = [
    ['Toplam Konteyner Sayısı', containers.length + ' Adet', 'F1F5F9'],
    ['Sipariş Verilen (Yüklenmemiş)', ordered + ' Konteyner', 'FEF3C7'],
    ['Yoldaki / Limandaki Sevkiyatlar', onTheWay + ' Konteyner', 'DCFCE7'],
    ['Depoya Teslim Alınanlar', delivered + ' Konteyner', 'DBEAFE'],
    ['Raporlanan Toplam Net Ağırlık', fmtNum(totalKg) + ' Kg (' + (totalKg / 1000).toFixed(2) + ' Ton)', 'FEF3C7']
  ];
  summaryLines.forEach(l => {
    const r = sm.addRow([l[0], l[1]]);
    r.eachCell(cell => { cell.fill = fill(l[2]); cell.border = border; });
    r.getCell(1).font = { bold: true };
    r.getCell(2).font = { bold: true };
  });

  sm.addRow([]);
  const bh = sm.addRow(['Firma', 'Konteyner Sayısı', 'Net Ağırlık (Kg)']);
  bh.eachCell(cell => {
    cell.fill = fill('0F172A');
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = border;
  });
  Object.keys(bySupplier).sort((a, b) => a.localeCompare(b, 'tr')).forEach(name => {
    const r = sm.addRow([name, bySupplier[name].count, bySupplier[name].kg]);
    r.eachCell(cell => { cell.border = border; });
    r.getCell(3).numFmt = '#,##0';
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "Detayli_Iplik_Konteyner_Raporu_" + todayISO() + ".xlsx";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// =====================================================
// 12. BAŞLANGIÇ VE CANLI BULUT DİNLEME
// =====================================================
function listen(col, apply) {
  col.onSnapshot({ includeMetadataChanges: true }, snap => {
    const online = !snap.metadata.fromCache;
    // Önbellekten gelen BOŞ sonuç doğrulanamaz → yoksay. Sunucudan gelen boş sonuç gerçektir
    // (son kayıt silindiğinde artık doğru şekilde boşalır).
    if (snap.empty && snap.metadata.fromCache) { setBadge(false); return; }
    apply(snap.docs.map(d => Object.assign({}, d.data(), { id: d.id })));
    cacheAll();
    setBadge(online);
  }, err => {
    console.warn(err);
    setBadge(false);
  });
}

function startCloudSync() {
  listen(companiesCol, docs => {
    if (docs.length === 0) {
      // Bulutta hiç firma yok: ilk kurulumda mevcut (varsayılan/yerel) firmaları bir kez yükle
      if (!loadData("app_companies_seeded", false)) {
        saveData("app_companies_seeded", true);
        remoteBatch(b => companyDocs.forEach((c, i) => {
          b.set(companiesCol.doc(c.id), { name: c.name, order: typeof c.order === 'number' ? c.order : i, createdAt: serverTs() });
        }));
        return;
      }
    }
    setCompanies(docs);
    updateCompanyList();
    renderBoard();
  });

  listen(proformasCol, docs => { proformas = docs; renderBoard(); updateProformaList(); });
  listen(containersCol, docs => { containers = docs; renderBoard(); });
}

window.addEventListener('offline', () => setBadge(false));

updateCompanyList();
renderBoard();
if (db) startCloudSync(); else setBadge(false);
