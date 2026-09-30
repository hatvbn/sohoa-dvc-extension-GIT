'use strict';

// URL của từng chức năng (mở khi bấm nút trong danh sách).
const URLS = {
  sohoa: 'https://dichvucong.bacninh.gov.vn/web/guest/so-hoa-cho-boc-tach',
  dinhkem: 'https://dichvucong.bacninh.gov.vn/web/guest/%C4%90%C3%ADnh-k%C3%A8m-%C4%91i%E1%BB%87n-t%E1%BB%AD',
  bosung: 'https://dichvucong.bacninh.gov.vn/web/guest/cho-bo-sung-ket-qua-dien-tu',
  vbdlis: 'https://dichvucong.bacninh.gov.vn/web/guest/h%E1%BB%93-s%C6%A1-vbdlis',
  trakq: 'https://dichvucong.bacninh.gov.vn/web/guest/h%E1%BB%93-s%C6%A1-ch%E1%BB%9D-tr%E1%BA%A3-k%E1%BA%BFt-qu%E1%BA%A3',
  taisohoa: 'https://dichvucong.bacninh.gov.vn/web/guest/h%E1%BB%93-s%C6%A1-%C4%91%C3%A3-s%E1%BB%91-h%C3%B3a',
};

const el = (id) => document.getElementById(id);
const logEl = el('sp-log');
const currentEl = el('sp-current');
const noneEl = el('sp-none');
const dlEl = el('sp-dl');

let activeTabId = null;

// ----- tiện ích ------------------------------------------------------------
function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve((tabs && tabs[0]) || null));
  });
}
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    } catch (e) {
      resolve(null);
    }
  });
}
function taskKeyFromUrl(url) {
  const u = decodeURIComponent(url || '').toLowerCase();
  if (u.includes('đã-số-hóa')) return 'taisohoa';
  if (u.includes('so-hoa-cho-boc-tach')) return 'sohoa';
  if (u.includes('cho-bo-sung-ket-qua-dien-tu')) return 'bosung';
  if (u.includes('chờ-trả-kết-quả') || u.includes('ch%e1%bb%9d-tr%e1%ba%a3')) return 'trakq';
  if (u.includes('hồ-sơ-vbdlis') || u.includes('vbdlis')) return 'vbdlis';
  if (u.includes('đính-kèm-điện-tử') || u.includes('kèm-điện-tử')) return 'dinhkem';
  return null;
}
function addLogLine(line) {
  const div = document.createElement('div');
  div.className = 'sp-log-line ' + (line.level || 'info');
  div.textContent = `[${line.t || ''}] ${line.msg || ''}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function setRunningUI(running) {
  el('sp-start').disabled = running;
  el('sp-stop').disabled = !running;
  el('sp-delay').disabled = running;
  el('sp-sign').disabled = running;
  if (running && !el('sp-summary').textContent) el('sp-summary').textContent = 'Đang xử lý...';
}
function setProgress(ok, skip, err, pct) {
  el('sp-bar').style.width = (pct || 0) + '%';
  el('sp-summary').textContent = `Đã xử lý ${ok + skip + err} — ${ok} xong · ${skip} bỏ qua · ${err} lỗi`;
}

// ----- kết nối với content script của tab đang mở --------------------------
function highlightTask(key) {
  document.querySelectorAll('.sp-task').forEach((b) => {
    b.classList.toggle('active', b.dataset.key === key);
  });
}

async function refresh(retries) {
  if (retries == null) retries = 8;
  const tab = await getActiveTab();
  activeTabId = tab ? tab.id : null;
  const key = tab ? taskKeyFromUrl(tab.url) : null;
  highlightTask(key);

  if (!tab) {
    showNone('Không tìm thấy tab đang mở.');
    return;
  }
  const resp = await sendToTab(tab.id, { ns: 'sp', cmd: 'hello' });
  if (resp && resp.who) {
    el('sp-who').textContent = resp.who;
    el('sp-who').hidden = false;
  }
  if (resp && resp.custom === 'taisohoa') {
    renderDownload(resp);
    return;
  }
  if (resp && resp.hasTask) {
    renderTask(resp);
    return;
  }
  // Chưa lấy được task: nếu URL đúng là trang chức năng thì content script có thể
  // đang dò bảng (tải trễ) -> thử lại vài lần, không kết luận vội.
  if (key && retries > 0) {
    showNone('Đang tải chức năng của trang...');
    setTimeout(() => refresh(retries - 1), 300);
    return;
  }
  showNone(
    resp
      ? 'Trang này không có chức năng xử lý hàng loạt.'
      : 'Trang hiện tại chưa phải trang chức năng HaTools. Bấm một chức năng ở trên để mở.'
  );
}

function renderTask(resp) {
  dlEl.hidden = true;
  noneEl.hidden = true;
  currentEl.hidden = false;
  el('sp-title').textContent = resp.taskTitle || '';
  el('sp-hint').textContent = resp.hint || '';
  el('sp-sign-wrap').hidden = !resp.showSignOption;
  // Khôi phục log + trạng thái đang chạy.
  logEl.innerHTML = '';
  (resp.logs || []).forEach(addLogLine);
  const st = resp.state || {};
  setRunningUI(!!st.running);
  setProgress(st.ok || 0, st.skip || 0, st.err || 0, st.pct || 0);
}

function showNone(msg) {
  currentEl.hidden = true;
  dlEl.hidden = true;
  noneEl.hidden = false;
  noneEl.textContent = msg;
}

// ----- chức năng Tải File Số Hóa -------------------------------------------
let dlUnitsKey = '';

function setDlRunning(running) {
  ['sp-dl-unit', 'sp-dl-name', 'sp-dl-from', 'sp-dl-to', 'sp-dl-start'].forEach((id) => {
    el(id).disabled = running;
  });
  el('sp-dl-stop').disabled = !running;
}
function setDlProgress(p) {
  el('sp-dl-bar').style.width = (p.pct || 0) + '%';
  el('sp-dl-summary').textContent = p.text || '';
}
function renderDownload(resp) {
  noneEl.hidden = true;
  currentEl.hidden = true;
  dlEl.hidden = false;
  // Chỉ dựng lại danh sách đơn vị khi thay đổi, để không mất lựa chọn của người dùng.
  const units = resp.units || [];
  const key = units.map((u) => u.value).join(',');
  if (key !== dlUnitsKey) {
    dlUnitsKey = key;
    const sel = el('sp-dl-unit');
    const keep = sel.value;
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '-1';
    all.textContent = '-- Tất cả đơn vị --';
    sel.appendChild(all);
    units.forEach((u) => {
      const o = document.createElement('option');
      o.value = u.value;
      o.textContent = (u.depth ? '\u00a0\u00a0– ' : '') + u.label;
      sel.appendChild(o);
    });
    if (Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
  }
  logEl.innerHTML = '';
  (resp.logs || []).forEach(addLogLine);
  const st = resp.state || {};
  setDlRunning(!!st.running);
  setDlProgress(st);
  if (!resp.ready) el('sp-dl-summary').textContent = 'Chưa thấy bảng hồ sơ trên trang — hãy tải lại trang.';
}

// ----- sự kiện UI ----------------------------------------------------------
document.querySelectorAll('.sp-task').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.key;
    const tab = await getActiveTab();
    if (!tab) return;
    chrome.tabs.update(tab.id, { url: URLS[key] }, () => void chrome.runtime.lastError);
    // Trang sẽ tải lại; onUpdated(complete) sẽ tự gọi refresh().
  });
});

el('sp-start').addEventListener('click', async () => {
  if (activeTabId == null) return;
  const delaySec = parseFloat(el('sp-delay').value);
  const sign = el('sp-sign').checked;
  const res = await sendToTab(activeTabId, {
    ns: 'sp',
    cmd: 'start',
    delaySec: isFinite(delaySec) ? delaySec : 1.2,
    sign,
  });
  if (res && res.ok) {
    logEl.innerHTML = '';
    setRunningUI(true);
  } else if (res && res.error) {
    addLogLine({ t: new Date().toLocaleTimeString('vi-VN'), msg: '✗ ' + res.error, level: 'err' });
  }
});

el('sp-stop').addEventListener('click', async () => {
  if (activeTabId == null) return;
  await sendToTab(activeTabId, { ns: 'sp', cmd: 'stop' });
  el('sp-stop').disabled = true;
});

el('sp-dl-start').addEventListener('click', async () => {
  if (activeTabId == null) return;
  const res = await sendToTab(activeTabId, {
    ns: 'sp',
    cmd: 'dl-start',
    unit: el('sp-dl-unit').value,
    name: el('sp-dl-name').value,
    from: el('sp-dl-from').value,
    to: el('sp-dl-to').value,
  });
  if (res && res.ok) {
    logEl.innerHTML = '';
    setDlRunning(true);
  } else {
    const msg = (res && res.error) || 'Không kết nối được với trang. Hãy tải lại trang rồi thử lại.';
    addLogLine({ t: new Date().toLocaleTimeString('vi-VN'), msg: '✗ ' + msg, level: 'err' });
  }
});
el('sp-dl-stop').addEventListener('click', async () => {
  if (activeTabId == null) return;
  await sendToTab(activeTabId, { ns: 'sp', cmd: 'dl-stop' });
  el('sp-dl-stop').disabled = true;
});

// ----- sự kiện từ content script (log/tiến độ) -----------------------------
chrome.runtime.onMessage.addListener((m, sender) => {
  if (!m || m.ns !== 'sp-evt') return;
  if (!sender || !sender.tab || sender.tab.id !== activeTabId) return; // chỉ nhận từ tab đang xem
  if (m.kind === 'log') addLogLine(m.line);
  else if (m.kind === 'clear') logEl.innerHTML = '';
  else if (m.kind === 'progress') setProgress(m.ok, m.skip, m.err, m.pct);
  else if (m.kind === 'running') setRunningUI(!!m.running);
  else if (m.kind === 'dl-progress') setDlProgress(m.prog || {});
  else if (m.kind === 'dl-running') setDlRunning(!!m.running);
  else if (m.kind === 'ready') refresh(); // content script vừa dò xong task -> làm mới UI
});

// Đổi tab / trang tải xong -> làm mới.
chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === activeTabId && info.status === 'complete') refresh();
});

// ----- thông báo cập nhật (hỏi background) ---------------------------------
function checkUpdate() {
  try {
    chrome.runtime.sendMessage({ type: 'check-update' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok || !res.data) return;
      const d = res.data;
      const tb = String(d.thongBao || '').trim();
      if (tb) {
        el('sp-thongbao').textContent = '📢 ' + tb;
        el('sp-thongbao').hidden = false;
      }
      const moi = String(d.phienBan || '').trim();
      const hienTai = chrome.runtime.getManifest().version;
      if (moi && phienBanCuHon(hienTai, moi)) {
        const link = String(d.link || '').trim();
        const up = el('sp-update');
        up.textContent = `⬆ Có bản cập nhật v${moi}` + (link ? ' — bấm để tải' : '');
        if (d.ghiChu) up.title = String(d.ghiChu);
        if (link) up.href = link;
        up.hidden = false;
      }
    });
  } catch (e) {
    /* im lặng */
  }
}
function phienBanCuHon(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

// ----- khởi động -----------------------------------------------------------
el('sp-ver').textContent = 'v' + chrome.runtime.getManifest().version;
checkUpdate();
refresh();
