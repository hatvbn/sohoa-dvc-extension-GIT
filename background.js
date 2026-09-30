// HaTools - service worker: nhan yeu cau tu content script va nho Chrome bat
// script PowerShell tu bam "Ky so" (qua Native Messaging).
const HOST_NAME = 'com.hatools.autokyso';

// Bam icon extension -> mo Side Panel (UI dieu khien). Goi khi SW khoi dong va khi cai dat.
function batMoSidePanelKhiBamIcon() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  } catch (e) {
    /* Chrome cu khong co sidePanel - bo qua */
  }
}
batMoSidePanelKhiBamIcon();
chrome.runtime.onInstalled.addListener(batMoSidePanelKhiBamIcon);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'start-auto-sign') return false;

  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    // Host chi lam nhiem vu bat PowerShell roi thoat, nen ngat ket noi la binh thuong.
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn('[HaTools] native host:', err.message);
      }
    });
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
  }
  return true;
});

// ---------------------------------------------------------------------------
// Ghi nhan su dung: dung chung Google Apps Script voi HaTools MPLiS.
// Service worker goi duoc vi co host_permissions; content script goi thang se bi CORS chan.
const USAGE_URL = 'https://script.google.com/macros/s/AKfycbx56pD0K63DvVPOX1OCyTmtn7ez1WZdin1Qffnk4lNc_1kLHuDIGZVapYSNfQke636R/exec';
const MACHINE_KEY = 'hatools_dvc_ma_may';
// Ten cong cu, trung cot D trang "CapNhat" va truong congCu khi ghi nhan su dung.
const USAGE_TOOL_NAME = 'HaTools DVCBacNinh';

async function getMachineId() {
  const saved = await chrome.storage.local.get(MACHINE_KEY);
  let id = saved[MACHINE_KEY];
  if (!id) {
    id = 'may-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    await chrome.storage.local.set({ [MACHINE_KEY]: id });
  }
  return id;
}

function getOs() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.getPlatformInfo((info) => resolve(info ? info.os : ''));
    } catch (e) {
      resolve('');
    }
  });
}

async function postUsage(payload) {
  // Giu cac khoa giong HaTools MPLiS (taiKhoan, hoTen, id, phienBan, heDieuHanh, thoiDiem)
  // de script cu van ghi duoc; cac khoa moi di kem them.
  const body = Object.assign({}, payload, {
    id: await getMachineId(),
    phienBan: chrome.runtime.getManifest().version,
    heDieuHanh: await getOs(),
    thoiDiem: new Date().toISOString(),
  });
  const res = await fetch(USAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('máy chủ trả HTTP ' + res.status);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'usage-ping') return false;
  postUsage(message.payload || {}).then(
    () => sendResponse({ ok: true }),
    (e) => {
      console.warn('[HaTools] Không ghi nhận được lượt sử dụng:', e && e.message);
      sendResponse({ ok: false, error: e && e.message });
    }
  );
  return true;
});

// ---------------------------------------------------------------------------
// Giu tab KHONG bi Chrome "discard" (huy nap roi tai lai) khi chay nen: dat
// autoDiscardable=false cho tab dang chay batch, tra lai true khi xong. Day la
// nguyen nhan pho bien khien app "tu dong tat" im lang (tab bi tai lai, panel reset).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'keep-tab-loaded') return false;
  try {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId === 'number' && chrome.tabs && chrome.tabs.update) {
      // keep=true -> autoDiscardable=false (khong cho huy nap)
      chrome.tabs.update(tabId, { autoDiscardable: message.keep === false }, () => {
        const err = chrome.runtime.lastError;
        sendResponse({ ok: !err, error: err && err.message });
      });
      return true;
    }
  } catch (e) {
    /* bo qua */
  }
  sendResponse({ ok: false });
  return true;
});

// ---------------------------------------------------------------------------
// Kiem tra phien ban moi nhat: goi doGet cua Apps Script (tra JSON
// { phienBan, link, ghiChu }). Goi tu service worker de tranh CORS.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'check-update') return false;
  const url = USAGE_URL + '?congCu=' + encodeURIComponent(USAGE_TOOL_NAME) + '&t=' + Date.now();
  fetch(url, { method: 'GET', redirect: 'follow', cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e && e.message }));
  return true;
});
