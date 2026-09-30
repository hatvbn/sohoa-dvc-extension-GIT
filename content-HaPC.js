(function () {
  'use strict';

  const STATE = {
    running: false,
    stopRequested: false,
    processedKeys: new Set(),
    // Chi bo qua ho so da ky khi nguoi dung dang bat "Ký số giấy tờ".
    // Tat ky so = chi so hoa -> phai lam ca ho so da ky.
    skipSigned: true,
    okCount: 0,
    skipCount: 0,
    errCount: 0,
  };

  const WAIT_MODAL_OPEN_TIMEOUT = 8000;
  const WAIT_MODAL_CLOSE_TIMEOUT = 12000;
  const POLL_INTERVAL = 150;
  const MAX_CONSECUTIVE_ERRORS = 3;
  const DEFAULT_DELAY_MS = 1200;
  const WAIT_TABLE_READY_TIMEOUT = 10000;
  const TABLE_STABLE_MS = 600;
  const SIGN_BUTTON_TEXT = 'Ký số giấy tờ';
  const SIGN_BUTTON_SELECTOR = 'button.btn-kyso-action, .btn-kyso-action';
  const SIGNER_COLUMN_HEADER = 'Cán bộ ký số';
  const SIGNER_COLUMN_FALLBACK = 15;
  const WAIT_SIGN_TIMEOUT = 120000;
  // Ky xong, trang upload file da ky len duong dan nay -> dau hieu chac chan nhat.
  const SIGN_UPLOAD_URL_PART = '/o/dvcfiles/signed';
  // Phan mem ky VGCA chay tren may, lang nghe o cong nay.
  const SIGN_SERVICE_URL = 'wss://127.0.0.1:8987/Config';
  const SIGN_SERVICE_PROBE_TIMEOUT = 4000;
  const TRAKQ_PATH_PART = 'h%e1%bb%93-s%c6%a1-ch%e1%bb%9d-tr%e1%ba%a3-k%e1%ba%bft-qu%e1%ba%a3';
  const TRAKQ_MENU_ITEM = 'Trả kết quả';
  const TRAKQ_CONFIRM_TEXT = 'Xác nhận trả kết quả';
  const WAIT_TRAKQ_RESULT_TIMEOUT = 25000;
  // O bat buoc trong form tra ket qua (cong tu dien san tu thong tin chu ho so).
  const TRAKQ_REQUIRED_FIELDS = [
    ['soDinhDanh', 'Số định danh'],
    ['hoTen', 'Họ và tên'],
    ['ngaySinh', 'Ngày sinh'],
  ];
  const VBDLIS_TABLE_SELECTOR = 'table[id$="_tblThuaDatHoSo"]';
  const VBDLIS_MENU_ITEM = 'Đồng bộ hồ sơ';
  const VBDLIS_STATUS_COL = 5;
  const VBDLIS_FILTER_SELECT = 'select[id$="_srtrangThaiDongBo"]';
  const VBDLIS_FILTER_VALUE = '0'; // 0 = "Chưa đồng bộ"
  const SEARCH_BUTTON_TEXT = 'Tìm kiếm';
  const WAIT_SEARCH_TIMEOUT = 30000;
  const PAGE_SIZE_TEXT = /^(\d+)\s*bản ghi$/i;
  const PREFERRED_PAGE_SIZE = 200;
  const WAIT_SYNC_RESULT_TIMEOUT = 25000;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(checkFn, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = checkFn();
      if (result) return result;
      await sleep(POLL_INTERVAL);
    }
    return null;
  }

  // Gian nhip co ngau nhien de traffic khong deu tam tap nhu robot.
  function jitter(baseMs) {
    const factor = 0.75 + Math.random() * 0.6;
    return Math.round(baseMs * factor);
  }

  function isVisible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function findByExactText(root, tag, text) {
    const els = Array.from(root.querySelectorAll(tag));
    return els.find((el) => (el.textContent || '').trim() === text) || null;
  }

  function findVisibleByExactText(tag, text) {
    const els = Array.from(document.querySelectorAll(tag));
    return els.find((el) => isVisible(el) && (el.textContent || '').trim() === text) || null;
  }

  function findClickableByText(root, text) {
    const matches = Array.from(
      root.querySelectorAll('a, button, li, div[role="tab"], span')
    ).filter((el) => el.children.length <= 2 && (el.textContent || '').trim() === text);
    // Tab cua Liferay gan handler o the <a> ben trong <li>; bam vao <li> khong co tac dung.
    return matches.find((el) => el.tagName === 'A' || el.tagName === 'BUTTON') || matches[0] || null;
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findInputNearLabel(root, labelText) {
    const labelCandidates = Array.from(
      root.querySelectorAll('label, div, span, strong, b, p')
    ).filter((el) => {
      if (el.querySelector('input,textarea,select')) return false;
      const txt = (el.textContent || '').trim();
      return txt === labelText || txt.startsWith(labelText);
    });
    for (const labelEl of labelCandidates) {
      const container = labelEl.closest('div') || labelEl.parentElement;
      let input = container && container.querySelector('input[type="text"], input:not([type]), textarea');
      if (input) return input;
      let node = labelEl;
      for (let i = 0; i < 4 && node; i++) {
        node = node.nextElementSibling;
        if (node) {
          input = node.matches('input,textarea')
            ? node
            : node.querySelector('input,textarea');
          if (input) return input;
        }
      }
    }
    return null;
  }

  // Van tay cua bang de biet no da thuc su tai lai chua.
  function tableSignature(findTableFn) {
    const table = findTableFn();
    if (!table) return 'none';
    const rows = table.querySelectorAll('tbody > tr');
    const textOf = (tr) => (tr ? (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '');
    return `${rows.length}|${textOf(rows[0])}|${textOf(rows[rows.length - 1])}`;
  }

  // Sau khi bam Tim kiem: bang giu nguyen mot luc roi moi doi, nen phai cho DOI
  // truoc, roi moi cho on dinh - neu khong se doc nham danh sach cu.
  async function waitForTableChanged(findTableFn, signatureBefore, timeoutMs, settledOk) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (tableSignature(findTableFn) !== signatureBefore) {
        await waitForTableReady(findTableFn);
        return true;
      }
      // Ket qua moi trung het ket qua cu (danh sach von da dung) - khong cho them.
      if (settledOk && Date.now() - start > 3000 && settledOk()) return true;
      await sleep(POLL_INTERVAL);
    }
    return false;
  }

  // Cho danh sach tai lai xong: so dong phai giu nguyen trong TABLE_STABLE_MS.
  async function waitForTableReady(findTableFn, timeoutMs) {
    const start = Date.now();
    let lastCount = -1;
    let stableSince = Date.now();
    while (Date.now() - start < (timeoutMs || WAIT_TABLE_READY_TIMEOUT)) {
      const table = findTableFn();
      const count = table ? table.querySelectorAll('tbody > tr').length : -1;
      if (count >= 0 && count === lastCount) {
        if (Date.now() - stableSince >= TABLE_STABLE_MS) return true;
      } else {
        lastCount = count;
        stableSince = Date.now();
      }
      await sleep(POLL_INTERVAL);
    }
    return false;
  }

  const CONFIRM_TEXTS = ['Đồng ý', 'Xác nhận', 'Chấp nhận', 'Có', 'OK', 'Ok', 'Yes'];

  // Hop thoai xac nhan cua trang (bootbox / modal) hien de len modal dang lam.
  function findConfirmButton() {
    // Cong DVC dung bootbox: nut dong y luon la button.bootbox-accept.
    const accept = Array.from(document.querySelectorAll('.bootbox-confirm button.bootbox-accept'))
      .find(isVisible);
    if (accept) return accept;
    const dialogs = Array.from(
      document.querySelectorAll('.bootbox, .modal.in, .modal.show, [role="dialog"], [role="alertdialog"]')
    ).filter(isVisible);
    for (const dialog of dialogs) {
      // Bo qua chinh modal dang lam viec - chi bam nut o hop thoai hoi lai.
      if (
        findByExactText(dialog, 'button', 'Lưu thông tin số hóa') ||
        dialog.querySelector('form[id$="_frmDinhKemAction"]')
      ) {
        continue;
      }
      const btn = Array.from(
        dialog.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')
      ).find((b) => {
        if (!isVisible(b)) return false;
        const txt = (b.textContent || b.value || '').trim();
        return CONFIRM_TEXTS.includes(txt);
      });
      if (btn) return btn;
    }
    return null;
  }

  // Cho modal dong, dong thoi tu bam qua hop thoai xac nhan neu trang hoi lai.
  async function waitClosedAutoConfirm(isClosedFn, timeoutMs, log, label) {
    const start = Date.now();
    let confirmed = 0;
    while (Date.now() - start < timeoutMs) {
      if (isClosedFn()) return true;
      if (confirmed < 3) {
        const btn = findConfirmButton();
        if (btn) {
          const txt = (btn.textContent || btn.value || '').trim();
          btn.click();
          confirmed++;
          log(`  ↳ ${label}: đã tự bấm "${txt}" ở hộp thoại xác nhận`, 'info');
          await sleep(400);
          continue;
        }
      }
      await sleep(POLL_INTERVAL);
    }
    return false;
  }

  // Doan ly do khi loi lien tiep: het phien, bi chan, hay giao dien doi.
  function diagnoseBlock(findTableFn) {
    const pwd = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
    if (pwd) {
      return 'Phiên đăng nhập có thể đã hết hạn (trang đang hiện ô đăng nhập). Hãy đăng nhập lại rồi chạy tiếp.';
    }
    if (!findTableFn()) {
      return 'Không còn thấy bảng danh sách — trang có thể đã chuyển hướng hoặc phiên đã hết hạn.';
    }
    return 'Có thể do phiên hết hạn, hệ thống đang chặn/quá tải, hoặc giao diện đã thay đổi. Hãy thử làm tay 1 hồ sơ để kiểm tra trước khi chạy lại.';
  }

  function tryCloseModal(modalRoot) {
    const root = modalRoot || document;
    const closeSelectors = [
      '[aria-label="Close"]',
      '[aria-label="close"]',
      '.bootbox-cancel',
      '.close',
      'button.close',
      '[class*="close"]',
      '.lfr-icon-close',
    ];
    for (const sel of closeSelectors) {
      const btn = root.querySelector(sel);
      if (btn && isVisible(btn)) {
        btn.click();
        return true;
      }
    }
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
    );
    return false;
  }

  function findRowTrigger(row) {
    return row.querySelector('a.dropdown-toggle');
  }
  function findOpenMenuItemByText(text) {
    return Array.from(document.querySelectorAll('a.dropdown-item')).find(
      (a) => isVisible(a) && (a.textContent || '').trim() === text
    );
  }
  function fireMouse(el, type) {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })
    );
  }

  // Menu cua Liferay (lfr-icon-menu) mo bang mousedown chu khong phai click;
  // menu duoc chuyen vao mot overlay ngoai dong nen phai tim tren toan trang.
  function openRowMenu(trigger) {
    fireMouse(trigger, 'mousedown');
    fireMouse(trigger, 'mouseup');
    fireMouse(trigger, 'click');
  }

  async function openRowMenuAndGetItem(trigger, itemText) {
    openRowMenu(trigger);
    const item = await waitFor(() => findOpenMenuItemByText(itemText), 3000);
    return item;
  }

  // Thu mo ket noi toi phan mem ky roi dong ngay - khong gui lenh ky nao.
  function checkSignService() {
    return new Promise((resolve) => {
      let socket;
      const done = (result) => {
        clearTimeout(timer);
        try {
          if (socket) socket.close();
        } catch (e) {
          /* khong sao */
        }
        resolve(result);
      };
      const timer = setTimeout(() => done(false), SIGN_SERVICE_PROBE_TIMEOUT);
      try {
        socket = new WebSocket(SIGN_SERVICE_URL);
      } catch (e) {
        done(false);
        return;
      }
      socket.onopen = () => done(true);
      socket.onerror = () => done(false);
    });
  }

  // Nho service worker bat script PowerShell tu bam "Ký số" (qua Native Messaging).
  // Chua cai dat host thi chi bao mot dong, khong chan luot chay.
  function startAutoSignHelper() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'start-auto-sign' }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: 'không có phản hồi' });
        });
      } catch (e) {
        resolve({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
  }

  // Chay truoc mot luot so hoa co bat ky so: bao som neu phan mem ky chua chay.
  async function prepareSoHoa(log, findTableFn, ui) {
    const table = findTableFn();
    const tong = table
      ? Array.from(table.querySelectorAll('tbody > tr')).filter((tr) => tr.querySelector('td')).length
      : 0;
    const daKy = countSoHoaDaKy();
    const dangKySo = !!(ui && ui.signEnabled && ui.signEnabled());

    if (dangKySo) {
      log(
        `Trên trang có ${tong} hồ sơ: bỏ qua ${daKy} hồ sơ đã ký số, sẽ làm ${tong - daKy} hồ sơ.`,
        'info'
      );
    } else {
      log(
        `Trên trang có ${tong} hồ sơ, sẽ làm tất cả (đã tắt ký số nên không bỏ qua ${daKy} hồ sơ đã ký).`,
        'info'
      );
      return;
    }

    const helper = await startAutoSignHelper();
    if (helper && helper.ok) {
      log('Đã bật công cụ tự bấm "Ký số" trên máy (không cần bấm tay).', 'info');
    } else {
      log(
        `⚠ Chưa bật được công cụ tự bấm "Ký số" (${(helper && helper.error) || 'chưa cài'}) - bạn tự bấm "Ký số" trong cửa sổ VGCA.`,
        'err'
      );
    }

    const connected = await checkSignService();
    if (connected) {
      log('Phần mềm ký số: đã kết nối (127.0.0.1:8987).', 'info');
    } else {
      log(
        '⚠ Chưa kết nối được tới phần mềm ký số (127.0.0.1:8987). Hãy mở phần mềm ký và cắm USB token; nếu vẫn chạy thì hồ sơ sẽ không ký được.',
        'err'
      );
    }
  }

  function decodeSafe(text) {
    try {
      return decodeURIComponent(text);
    } catch (e) {
      return text;
    }
  }

  function findPdfViewer(root) {
    return (
      Array.from(root.querySelectorAll('iframe, embed, object')).find((el) =>
        /dvcfiles|\.pdf/i.test(el.src || el.data || '')
      ) || null
    );
  }

  // Ngay sau khi ky, khung xem PDF trong modal tro sang ban "....signed.PDF" va
  // input an fileId doi sang id cua file da ky - day la dau hieu ky THANH CONG
  // (khong co toast, va file da ky do phan mem tren may tu upload nen trinh
  // duyet khong ghi nhan request nao).
  // Luu y: ho so da ky tu truoc thi ten file KHONG con duoi ".signed" (vd
  // "GCN.PDF"), nen chi dung ham nay theo chieu duong, khong dung de ket luan
  // "chua ky". Dau hieu "da ky san" la KHONG CO nut ky - xem processSoHoaRecord.
  function signedFileState(root) {
    const viewer = findPdfViewer(root);
    const src = viewer ? viewer.src || viewer.data || '' : '';
    const fileIdInput = root.querySelector(
      'input[type="hidden"][name$="fileId"], input[type="hidden"][id$="fileId"]'
    );
    return {
      signed: /\.signed\./i.test(src) || /\.signed\./i.test(decodeSafe(src)),
      fileId: fileIdInput ? fileIdInput.value : '',
    };
  }

  function findSignButton(root) {
    const scope = root && root.querySelectorAll ? root : document;

    // Nút that la <button class="... btn-kyso-action"> - handler jQuery gan o day.
    const direct = scope.querySelector(SIGN_BUTTON_SELECTOR);
    if (direct) return direct;

    const matches = Array.from(
      scope.querySelectorAll('button, a, input[type="button"], span, div')
    ).filter((el) => {
      if (el.children.length > 2) return false;
      const txt = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
      return txt === SIGN_BUTTON_TEXT || txt === `${SIGN_BUTTON_TEXT} *`;
    });
    if (!matches.length) return null;

    // Cac the DIV boc ngoai cung khop chu nhung KHONG co handler - bam vao chung
    // thi khong co gi xay ra. Uu tien button/a, cuoi cung lay phan tu trong cung.
    return matches.find((el) => el.tagName === 'BUTTON' || el.tagName === 'A') ||
      matches[matches.length - 1];
  }

  function findSignedMark(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const el = Array.from(scope.querySelectorAll('*')).find(
      (e) => e.children.length <= 2 && isVisible(e) && /Đã ký/i.test(e.textContent || '')
    );
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  }

  // Dem so lan trinh duyet da goi len endpoint nhan file da ky.
  function countSignUploads() {
    try {
      return performance
        .getEntriesByType('resource')
        .filter((entry) => (entry.name || '').indexOf(SIGN_UPLOAD_URL_PART) >= 0).length;
    } catch (e) {
      return -1;
    }
  }

  // Bam "Ký số giấy tờ" roi cho phan mem ky VGCA lam viec.
  // Neu khong xac nhan duoc la da ky thi tra ve false va KHONG luu ho so.
  async function signSoHoaDocument(modalRoot, log, label) {
    const signBtn = findSignButton(modalRoot);
    if (!signBtn) {
      log(`✗ ${label}: không thấy nút "${SIGN_BUTTON_TEXT}" - không lưu, cần làm tay`, 'err');
      return false;
    }

    const toastsBefore = new Set(toastElements());
    const uploadsBefore = countSignUploads();
    const stateBefore = signedFileState(modalRoot);
    signBtn.click();
    log(
      `  ↳ ${label}: đã mở phần mềm ký - hãy bấm "Ký số" trong cửa sổ VGCA (chờ tối đa ${Math.round(
        WAIT_SIGN_TIMEOUT / 1000
      )}s).`,
      'info'
    );

    const start = Date.now();
    while (Date.now() - start < WAIT_SIGN_TIMEOUT) {
      const toast = toastElements().find((el) => !toastsBefore.has(el));
      if (toast) {
        const cls = toast.className || '';
        const msg = (toast.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150);
        toast.remove();
        if (/toast-error|toast-warning/.test(cls)) {
          log(`✗ ${label}: ký số lỗi - ${msg}`, 'err');
          return false;
        }
        log(`  ↳ ${label}: ${msg}`, 'info');
        return true;
      }
      const stateNow = signedFileState(modalRoot);
      if (stateNow.signed && (!stateBefore.signed || stateNow.fileId !== stateBefore.fileId)) {
        log(`  ↳ ${label}: đã ký số (file trong hồ sơ đã chuyển sang bản đã ký).`, 'info');
        return true;
      }
      const uploadsNow = countSignUploads();
      if (uploadsBefore >= 0 && uploadsNow > uploadsBefore) {
        log(`  ↳ ${label}: đã ký số (file ký đã được tải lên hệ thống).`, 'info');
        return true;
      }
      // KHONG dung "nut ky bien mat" lam dau hieu da ky: do da bat duoc truong hop
      // modal ve lai khien nut tam an trong khi chua ky gi ca -> bao thanh cong nham.
      const mark = findSignedMark(modalRoot);
      if (mark) {
        log(`  ↳ ${label}: đã ký số - ${mark}`, 'info');
        return true;
      }
      await sleep(POLL_INTERVAL);
    }

    log(
      `✗ ${label}: chờ ${Math.round(
        WAIT_SIGN_TIMEOUT / 1000
      )}s vẫn chưa ký xong (chưa bấm "Ký số" trong cửa sổ VGCA?) - KHÔNG lưu để tránh lưu hồ sơ chưa ký.`,
      'err'
    );
    return 'timeout';
  }

  function findSoHoaTable() {
    return document.querySelector('table[id$="_tblSoHoa"]');
  }

  // Tim cot theo tieu de, du phong theo vi tri neu cong doi giao dien.
  function columnIndexByHeader(table, headerText, fallbackIndex) {
    const headers = Array.from(table.querySelectorAll('thead th'));
    const index = headers.findIndex(
      (th) => (th.textContent || '').replace(/\s+/g, ' ').trim() === headerText
    );
    return index >= 0 ? index : fallbackIndex;
  }

  // Ho so da co ten can bo ky so tuc la da so hoa + ky xong -> khong dung toi nua.
  function soHoaDaKy(row, signerIndex) {
    const cell = row.querySelectorAll('td')[signerIndex];
    return !!cell && (cell.textContent || '').trim() !== '';
  }

  function countSoHoaDaKy() {
    const table = findSoHoaTable();
    if (!table) return 0;
    const signerIndex = columnIndexByHeader(table, SIGNER_COLUMN_HEADER, SIGNER_COLUMN_FALLBACK);
    return Array.from(table.querySelectorAll('tbody > tr'))
      .filter((tr) => tr.querySelector('td'))
      .filter((tr) => soHoaDaKy(tr, signerIndex)).length;
  }

  function getNextSoHoaRecord() {
    const table = findSoHoaTable();
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('tbody > tr')).filter((tr) =>
      tr.querySelector('td')
    );
    const signerIndex = columnIndexByHeader(table, SIGNER_COLUMN_HEADER, SIGNER_COLUMN_FALLBACK);
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (tds.length < 5) continue;
      // Da ky so thi bo qua - chi ap dung khi dang bat ky so.
      if (STATE.skipSigned && soHoaDaKy(row, signerIndex)) continue;
      const chuHoSo = (tds[2]?.textContent || '').trim();
      const maHoSo = (tds[3]?.textContent || '').trim();
      const maFile = (tds[4]?.textContent || '').split('\n')[0].trim();
      const key = `sohoa|${maHoSo}|${maFile}`;
      if (STATE.processedKeys.has(key)) continue;
      const trigger = findRowTrigger(row);
      if (!trigger) continue;
      return { row, label: maHoSo, chuHoSo, maHoSo, maFile, key, trigger };
    }
    return null;
  }

  function getSoHoaModalRoot() {
    const saveBtn = findVisibleByExactText('button', 'Lưu thông tin số hóa');
    if (!saveBtn) return null;
    let node = saveBtn;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      if (node.matches('[role="dialog"], .modal, .modal-content, .lfr-modal')) {
        return node;
      }
    }
    return document;
  }

  async function processSoHoaRecord(rec, log, ui) {
    const item = await openRowMenuAndGetItem(rec.trigger, 'Số hóa giấy tờ');
    if (!item) {
      log(`✗ ${rec.label}: không tìm thấy mục "Số hóa giấy tờ" trong menu`, 'err');
      return false;
    }
    item.click();

    const opened = await waitFor(
      () => findVisibleByExactText('button', 'Lưu thông tin số hóa'),
      WAIT_MODAL_OPEN_TIMEOUT
    );
    if (!opened) {
      log(`✗ ${rec.label}: modal "Số hóa giấy tờ" không mở được (timeout)`, 'err');
      return false;
    }

    const modalRoot = getSoHoaModalRoot();

    const tab2 = findClickableByText(modalRoot, 'Thuộc tính số hóa');
    if (tab2) {
      tab2.click();
      await sleep(300);
    }

    // Ký TRUOC roi moi dien: ky xong modal ve lai va xoa sach o da nhap.
    if (ui && ui.signEnabled && ui.signEnabled()) {
      // Ho so da ky thi modal khong co nút "Ký số giấy tờ" nua -> bo qua.
      if (!findSignButton(modalRoot)) {
        log(`⚠ ${rec.label}: đã ký số từ trước (không còn nút "${SIGN_BUTTON_TEXT}") - bỏ qua.`, 'err');
        tryCloseModal(modalRoot);
        await sleep(300);
        return 'skip';
      }
      const signed = await signSoHoaDocument(modalRoot, log, rec.label);
      if (signed !== true) {
        tryCloseModal(modalRoot);
        await sleep(300);
        // Het gio ky la loi he thong (phan mem ky chua chay), khong phai loi rieng
        // ho so nay - dung han thay vi cho tung ho so tiep theo.
        return signed === 'timeout' ? 'abort' : false;
      }
      await sleep(500);
    }

    // Lay lai modal: sau khi ky, phan than modal da duoc ve lai.
    const formRoot = getSoHoaModalRoot();
    const tenChuTheInput =
      findInputNearLabel(formRoot, 'Tên chủ thể') ||
      formRoot.querySelector('input[name$="hoTen"], input[id$="hoTen"]');
    if (!tenChuTheInput) {
      log(`✗ ${rec.label}: không xác định được ô "Tên chủ thể" - bỏ qua, cần kiểm tra thủ công`, 'err');
      tryCloseModal(formRoot);
      await sleep(300);
      return false;
    }

    setNativeValue(tenChuTheInput, rec.chuHoSo);
    await sleep(150);

    const saveBtn = findVisibleByExactText('button', 'Lưu thông tin số hóa');
    if (!saveBtn) {
      log(`✗ ${rec.label}: mất nút "Lưu thông tin số hóa" trước khi bấm`, 'err');
      tryCloseModal(modalRoot);
      return false;
    }
    saveBtn.click();

    const closed = await waitClosedAutoConfirm(
      () => !findVisibleByExactText('button', 'Lưu thông tin số hóa'),
      WAIT_MODAL_CLOSE_TIMEOUT,
      log,
      rec.label
    );
    if (!closed) {
      log(`✗ ${rec.label}: sau khi Lưu, modal không đóng (có thể lỗi validate) - đóng thủ công`, 'err');
      tryCloseModal(modalRoot);
      await sleep(300);
      return false;
    }

    log(`✓ ${rec.label} — ${rec.chuHoSo}`, 'ok');
    return true;
  }

  // Trang "Hồ sơ chờ trả kết quả" dung chung id bang voi trang dinh kem,
  // nen phai phan biet bang duong dan.
  function isTraKqPage() {
    return location.pathname.toLowerCase().indexOf(TRAKQ_PATH_PART) >= 0;
  }

  function findDinhKemTable() {
    if (isTraKqPage()) return null;
    return document.querySelector('table[id$="_tblDataHoSo"]');
  }

  function getNextDinhKemRecord() {
    const table = findDinhKemTable();
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('tbody > tr')).filter((tr) =>
      tr.querySelector('td')
    );
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (tds.length < 2) continue;
      const maBienNhan = (tds[1]?.textContent || '').trim();
      const key = `dinhkem|${maBienNhan}`;
      if (STATE.processedKeys.has(key)) continue;
      const trigger = findRowTrigger(row);
      if (!trigger) continue;
      return { row, label: maBienNhan, maBienNhan, key, trigger };
    }
    return null;
  }

  function getDinhKemForm() {
    const forms = Array.from(document.querySelectorAll('form[id$="_frmDinhKemAction"]'));
    return forms.find((f) => isVisible(f)) || null;
  }

  async function processDinhKemRecord(rec, log) {
    const item = await openRowMenuAndGetItem(rec.trigger, 'Đính kèm kết quả điện tử');
    if (!item) {
      log(`✗ ${rec.label}: không tìm thấy mục "Đính kèm kết quả điện tử" trong menu`, 'err');
      return false;
    }
    item.click();

    const openedForm = await waitFor(() => getDinhKemForm(), WAIT_MODAL_OPEN_TIMEOUT);
    if (!openedForm) {
      log(`✗ ${rec.label}: modal "Đính kèm kết quả điện tử" không mở được (timeout)`, 'err');
      return false;
    }

    const rows = Array.from(openedForm.querySelectorAll('table tbody tr')).filter((tr) =>
      tr.querySelector('select[name*="ketQuaId"]')
    );

    if (rows.length === 0) {
      log(`✗ ${rec.label}: không tìm thấy dòng "Chọn file đã có" trong modal - bỏ qua, cần kiểm tra thủ công`, 'err');
      tryCloseModal(openedForm);
      await sleep(300);
      return false;
    }

    for (const row of rows) {
      const select = row.querySelector('select[name*="ketQuaId"]');
      const realOptions = Array.from(select.options).filter(
        (o) => o.value !== '0' && o.textContent.trim() !== 'Chọn tệp tin'
      );
      if (realOptions.length !== 1) {
        const reason =
          realOptions.length === 0
            ? 'chưa có file điện tử sẵn có trong hệ thống'
            : `có ${realOptions.length} file sẵn có, cần chọn tay`;
        log(`⚠ ${rec.label}: bỏ qua (${reason})`, 'err');
        tryCloseModal(openedForm);
        await sleep(300);
        return 'skip';
      }
      select.value = realOptions[0].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(150);

    const saveBtn = Array.from(openedForm.querySelectorAll('button')).find(
      (b) => isVisible(b) && (b.textContent || '').trim() === 'Lưu'
    );
    if (!saveBtn) {
      log(`✗ ${rec.label}: mất nút "Lưu" trước khi bấm`, 'err');
      tryCloseModal(openedForm);
      return false;
    }
    saveBtn.click();

    const closed = await waitClosedAutoConfirm(
      () => !getDinhKemForm(),
      WAIT_MODAL_CLOSE_TIMEOUT,
      log,
      rec.label
    );
    if (!closed) {
      log(`✗ ${rec.label}: sau khi Lưu, modal không đóng (có thể lỗi validate) - đóng thủ công`, 'err');
      tryCloseModal(openedForm);
      await sleep(300);
      return false;
    }

    log(`✓ ${rec.label} — đã đính kèm kết quả điện tử`, 'ok');
    return true;
  }

  function findVbdlisTable() {
    return document.querySelector(VBDLIS_TABLE_SELECTOR);
  }

  function vbdlisSyncStatus(row) {
    const cell = row.querySelectorAll('td')[VBDLIS_STATUS_COL];
    return cell ? (cell.textContent || '').replace(/\s+/g, ' ') : '';
  }

  function getNextVbdlisRecord() {
    const table = findVbdlisTable();
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('tbody > tr')).filter((tr) =>
      tr.querySelector('td')
    );
    for (const row of rows) {
      if (row.dataset.hatoolsDone === '1') continue;
      // Chi lam ho so chua dong bo - da dong bo thi bo qua du nguoi dung khong loc.
      if (!/Chưa đồng bộ/.test(vbdlisSyncStatus(row))) continue;
      const tds = row.querySelectorAll('td');
      const soBienNhan = (tds[0]?.textContent || '').trim();
      const maHoSo = (tds[1]?.textContent || '').trim();
      const key = `vbdlis|${soBienNhan}|${maHoSo}`;
      if (STATE.processedKeys.has(key)) continue;
      const trigger = findRowTrigger(row);
      if (!trigger) continue;
      return { row, label: maHoSo || soBienNhan, soBienNhan, maHoSo, key, trigger };
    }
    return null;
  }

  function vbdlisListLooksFiltered(findTableFn) {
    const table = findTableFn();
    if (!table) return false;
    const rows = Array.from(table.querySelectorAll('tbody > tr')).filter((tr) =>
      tr.querySelector('td')
    );
    return rows.length > 0 && rows.every((row) => /Chưa đồng bộ/.test(vbdlisSyncStatus(row)));
  }

  function findSearchButton() {
    return Array.from(document.querySelectorAll('button')).find(
      (b) => isVisible(b) && (b.textContent || '').trim() === SEARCH_BUTTON_TEXT
    );
  }

  async function runVbdlisSearch(log, findTableFn, label) {
    const searchBtn = findSearchButton();
    if (!searchBtn) {
      log(`⚠ Không tìm thấy nút "${SEARCH_BUTTON_TEXT}" - dùng danh sách đang hiển thị.`, 'err');
      return false;
    }
    const before = tableSignature(findTableFn);
    searchBtn.click();
    log(label, 'info');
    const changed = await waitForTableChanged(findTableFn, before, WAIT_SEARCH_TIMEOUT, () =>
      vbdlisListLooksFiltered(findTableFn)
    );
    if (!changed) {
      log('  ↳ danh sách không đổi sau khi tìm kiếm.', 'info');
    }
    return changed;
  }

  function pageSizeOf(option) {
    const m = ((option && option.textContent) || '').trim().match(PAGE_SIZE_TEXT);
    return m ? parseInt(m[1], 10) : 0;
  }

  function findPageSizeSelect() {
    return Array.from(document.querySelectorAll('select')).find(
      (sel) => isVisible(sel) && Array.from(sel.options).some((o) => pageSizeOf(o) > 0)
    );
  }

  // Lay so ban ghi/trang lon nhat (toi da PREFERRED_PAGE_SIZE) de do phai tim kiem lai nhieu lan.
  function setPageSize(log) {
    const select = findPageSizeSelect();
    if (!select) return false;
    const sizes = Array.from(select.options)
      .map((o) => ({ option: o, size: pageSizeOf(o) }))
      .filter((x) => x.size > 0 && x.size <= PREFERRED_PAGE_SIZE);
    if (!sizes.length) return false;
    const best = sizes.reduce((a, b) => (b.size > a.size ? b : a));
    if (pageSizeOf(select.options[select.selectedIndex]) === best.size) return false;
    setNativeValue(select, best.option.value);
    log(`→ Đặt ${best.size} bản ghi/trang.`, 'info');
    return true;
  }

  // Truoc khi chay: tu dat bo loc "Chua dong bo" roi bam Tim kiem.
  async function prepareVbdlis(log, findTableFn) {
    const select = document.querySelector(VBDLIS_FILTER_SELECT);
    if (!select) {
      log('⚠ Không tìm thấy bộ lọc trạng thái đồng bộ - chạy trên danh sách đang hiển thị.', 'err');
      return;
    }
    // 1. So ban ghi/trang: select nay co onchange tu goi tim kiem (mat ~8 giay),
    //    nen phai cho no xong han roi moi dat bo loc - neu khong se chong hai luot.
    const signatureBefore = tableSignature(findTableFn);
    if (setPageSize(log)) {
      const changed = await waitForTableChanged(findTableFn, signatureBefore, WAIT_SEARCH_TIMEOUT);
      if (!changed) {
        log('  ↳ danh sách chưa đổi sau khi đặt số bản ghi/trang.', 'info');
      }
    }

    // 2. Bo loc trang thai: luon dat lai va bam "Tìm kiếm".
    //    Khong tin gia tri cua select: no co the la "Chưa đồng bộ" trong khi
    //    danh sach dang hien thi van la ket qua cu chua loc.
    setNativeValue(select, VBDLIS_FILTER_VALUE);
    await runVbdlisSearch(log, findTableFn, '→ Đang lọc "Chưa đồng bộ"...');

    const table = findTableFn();
    const rows = table
      ? Array.from(table.querySelectorAll('tbody > tr')).filter((tr) => tr.querySelector('td'))
      : [];
    const chuaDongBo = rows.filter((row) => /Chưa đồng bộ/.test(vbdlisSyncStatus(row))).length;
    if (chuaDongBo === rows.length) {
      log(`Bộ lọc "Chưa đồng bộ" đã áp dụng - ${chuaDongBo} hồ sơ trên trang này.`, 'info');
    } else {
      log(
        `⚠ Lọc chưa áp dụng đúng: ${chuaDongBo}/${rows.length} hồ sơ chưa đồng bộ. Vẫn chạy, hồ sơ đã đồng bộ sẽ được bỏ qua.`,
        'err'
      );
    }
  }

  // Het danh sach thi tim kiem lai: ho so vua dong bo xong se roi khoi ket qua,
  // ho so o trang sau se hien len.
  async function refreshVbdlis(log, findTableFn) {
    await runVbdlisSearch(log, findTableFn, '↻ Tải lại danh sách "Chưa đồng bộ"...');
  }

  function toastElements() {
    const container = document.getElementById('toast-container');
    return container ? Array.from(container.children) : [];
  }

  async function processVbdlisRecord(rec, log) {
    // Danh dau ngay tren DOM: bang co tai lai ma dong van con thi khong lam lai.
    rec.row.dataset.hatoolsDone = '1';
    const toastsBefore = new Set(toastElements());

    const item = await openRowMenuAndGetItem(rec.trigger, VBDLIS_MENU_ITEM);
    if (!item) {
      log(`✗ ${rec.label}: không mở được menu hoặc không có mục "${VBDLIS_MENU_ITEM}"`, 'err');
      return false;
    }
    item.click();

    // Hop thoai bootbox: "Bạn muốn đồng bộ hồ sơ này?" - nut dong y la .bootbox-accept ("Có").
    const acceptBtn = await waitFor(() => {
      const dialog = Array.from(document.querySelectorAll('.bootbox-confirm')).find(isVisible);
      if (!dialog) return null;
      const btn = dialog.querySelector('button.bootbox-accept');
      return btn && isVisible(btn) ? btn : null;
    }, WAIT_MODAL_OPEN_TIMEOUT);

    if (!acceptBtn) {
      log(`✗ ${rec.label}: không thấy hộp xác nhận đồng bộ (timeout) - bỏ qua`, 'err');
      tryCloseModal(null);
      await sleep(300);
      return false;
    }
    acceptBtn.click();

    // Ket qua tra ve bang toast (toastr) o goc phai tren.
    const toast = await waitFor(
      () => toastElements().find((el) => !toastsBefore.has(el)),
      WAIT_SYNC_RESULT_TIMEOUT
    );
    if (!toast) {
      log(`✗ ${rec.label}: không nhận được thông báo kết quả sau ${Math.round(WAIT_SYNC_RESULT_TIMEOUT / 1000)}s`, 'err');
      return false;
    }

    const cls = toast.className || '';
    const msg = (toast.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    toast.remove();

    if (/toast-error|toast-warning/.test(cls)) {
      // He thong tra loi tu te, chi la khong dong bo duoc ho so nay - bo qua,
      // KHONG coi la dau hieu bi chan.
      if (/đã tồn tại/i.test(msg)) {
        // Nguoi khac vua dong bo ho so nay truoc: ban ghi da co ben VBDLIS va
        // cong se danh dau "Đã đồng bộ" - khong phai loi cua minh.
        log(`⚠ ${rec.label}: đã có bên VBDLIS (người khác đã đồng bộ trước) - hồ sơ vẫn được đánh dấu "Đã đồng bộ".`, 'err');
      } else {
        log(`⚠ ${rec.label}: ${msg || 'hệ thống báo lỗi'}`, 'err');
      }
      return 'skip';
    }

    log(`✓ ${rec.label} — ${msg || 'đã đồng bộ'}`, 'ok');
    return true;
  }

  function findTraKqTable() {
    if (!isTraKqPage()) return null;
    return document.querySelector('table[id$="_tblDataHoSo"]');
  }

  function getNextTraKqRecord() {
    const table = findTraKqTable();
    if (!table) return null;
    const maIndex = columnIndexByHeader(table, 'Mã biên nhận', 1);
    const chuIndex = columnIndexByHeader(table, 'Chủ hồ sơ', 5);
    const rows = Array.from(table.querySelectorAll('tbody > tr')).filter((tr) =>
      tr.querySelector('td')
    );
    for (const row of rows) {
      if (row.dataset.hatoolsDone === '1') continue;
      const tds = row.querySelectorAll('td');
      const ma = (tds[maIndex]?.textContent || '').trim();
      if (!ma) continue;
      const key = `trakq|${ma}`;
      if (STATE.processedKeys.has(key)) continue;
      // Menu chua mo thi cac muc van nam trong dong: dong khong co "Tra ket qua"
      // (vd ho so da rut) thi bo qua luon, khong mo hop thoai.
      const items = Array.from(row.querySelectorAll('a.dropdown-item'));
      if (items.length && !items.some((a) => (a.textContent || '').trim() === TRAKQ_MENU_ITEM)) {
        continue;
      }
      const trigger = findRowTrigger(row);
      if (!trigger) continue;
      const chuHoSo = (tds[chuIndex]?.textContent || '').replace(/\s+/g, ' ').trim();
      return { row, label: ma, chuHoSo, key, trigger };
    }
    return null;
  }

  function findTraKqForm() {
    return (
      Array.from(document.querySelectorAll('.bootbox form[id$="_frmWorkflowAction"]')).find(isVisible) ||
      null
    );
  }

  async function processTraKqRecord(rec, log) {
    rec.row.dataset.hatoolsDone = '1';

    const item = await openRowMenuAndGetItem(rec.trigger, TRAKQ_MENU_ITEM);
    if (!item) {
      log(`⚠ ${rec.label}: không có mục "${TRAKQ_MENU_ITEM}" - bỏ qua.`, 'err');
      openRowMenu(rec.trigger); // dong menu vua mo
      return 'skip';
    }
    item.click();

    const form = await waitFor(() => findTraKqForm(), WAIT_MODAL_OPEN_TIMEOUT);
    if (!form) {
      log(`✗ ${rec.label}: không mở được hộp thoại "Trả kết quả" (timeout)`, 'err');
      return false;
    }
    const dialog = form.closest('.bootbox') || form;
    await sleep(500);

    // Thieu thong tin nguoi nhan thi khong tu dien bua - de lam tay.
    const thieu = TRAKQ_REQUIRED_FIELDS.filter(([name]) => {
      const el = form.querySelector(`[name="${name}"], [name$="${name}"]`);
      return !el || !(el.value || '').trim();
    }).map(([, nhan]) => nhan);
    if (thieu.length) {
      log(`⚠ ${rec.label}: thiếu ${thieu.join(', ')} của người nhận - bỏ qua, cần làm tay.`, 'err');
      tryCloseModal(dialog);
      await sleep(400);
      return 'skip';
    }

    const confirmBtn =
      form.querySelector('.xacNhanBtn') ||
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => isVisible(b) && (b.textContent || '').trim() === TRAKQ_CONFIRM_TEXT
      );
    if (!confirmBtn) {
      log(`✗ ${rec.label}: không thấy nút "${TRAKQ_CONFIRM_TEXT}"`, 'err');
      tryCloseModal(dialog);
      return false;
    }

    const toastsBefore = new Set(toastElements());
    confirmBtn.click();

    // Cong gui form bang AJAX roi bao ket qua bang thong bao goc phai tren.
    const toast = await waitFor(
      () => toastElements().find((el) => !toastsBefore.has(el)),
      WAIT_TRAKQ_RESULT_TIMEOUT
    );
    if (!toast) {
      const loiForm = Array.from(dialog.querySelectorAll('.error, .invalid-feedback, label.error'))
        .filter(isVisible)
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      log(
        `✗ ${rec.label}: không nhận được thông báo kết quả${
          loiForm.length ? ' - ' + loiForm.join('; ') : ''
        }`,
        'err'
      );
      if (dialog.isConnected && isVisible(dialog)) tryCloseModal(dialog);
      return false;
    }

    const cls = toast.className || '';
    const msg = (toast.textContent || '').replace(/\s+/g, ' ').replace(/^×\s*/, '').trim().slice(0, 150);
    toast.remove();

    if (/toast-error|toast-warning/.test(cls)) {
      log(`✗ ${rec.label}: ${msg || 'hệ thống báo lỗi'}`, 'err');
      if (dialog.isConnected && isVisible(dialog)) tryCloseModal(dialog);
      return false;
    }

    await waitFor(() => !dialog.isConnected || !isVisible(dialog), 5000);
    log(`✓ ${rec.label} — ${rec.chuHoSo}${msg ? ' · ' + msg : ''}`, 'ok');
    return true;
  }

  async function runBatch(ui, getNextRecord, processRecord, findTableFn, prepare, refreshList) {
    STATE.running = true;
    STATE.stopRequested = false;
    STATE.okCount = 0;
    STATE.skipCount = 0;
    STATE.errCount = 0;
    STATE.processedKeys.clear();
    ui.setRunning(true);
    STATE.skipSigned = !!(ui.signEnabled && ui.signEnabled());
    const batDauLuc = Date.now();

    if (prepare) {
      try {
        await prepare(ui.log, findTableFn, ui);
      } catch (e) {
        ui.log(`⚠ Không chuẩn bị được danh sách: ${e && e.message ? e.message : e}`, 'err');
      }
    }

    let consecutiveErrors = 0;
    // Khong gioi han so lan lap: vong lap tu dung khi het ho so, bam Dung, hoac
    // 3 loi lien tiep. processedKeys + danh dau tren DOM bao dam khong lam trung.
    while (true) {
      if (STATE.stopRequested) {
        ui.log('⏹ Đã dừng theo yêu cầu.', 'info');
        break;
      }
      let rec = getNextRecord();
      if (!rec) {
        // Co the danh sach dang tai lai - cho on dinh roi tim lai truoc khi ket luan.
        await waitForTableReady(findTableFn);
        rec = getNextRecord();
      }
      if (!rec && refreshList) {
        // Het ho so tren trang: tai lai danh sach xem con ho so nao khac khong.
        try {
          await refreshList(ui.log, findTableFn);
        } catch (e) {
          ui.log(`⚠ Không tải lại được danh sách: ${e && e.message ? e.message : e}`, 'err');
        }
        rec = getNextRecord();
      }
      if (!rec) {
        ui.log('✅ Không còn hồ sơ nào để xử lý trong danh sách hiện tại.', 'info');
        break;
      }
      STATE.processedKeys.add(rec.key);
      ui.log(`→ Đang xử lý: ${rec.label}`, 'info');

      // true = xong, 'skip' = he thong tu choi ho so nay, false = hong that su.
      let outcome = false;
      try {
        outcome = await processRecord(rec, ui.log, ui);
      } catch (e) {
        ui.log(`✗ ${rec.label}: lỗi không mong đợi - ${e && e.message ? e.message : e}`, 'err');
        outcome = false;
      }

      if (outcome === 'abort') {
        STATE.errCount++;
        ui.updateProgress(STATE.okCount, STATE.skipCount, STATE.errCount, findTableFn);
        ui.log(
          '⛔ Dừng ngay: hồ sơ chưa ký xong. Mỗi hồ sơ bạn cần bấm "Ký số" trong cửa sổ VGCA khi nó hiện lên.',
          'err'
        );
        ui.log(
          '  ↳ Nếu cửa sổ VGCA không hiện: kiểm tra phần mềm ký đã chạy chưa và USB token đã cắm chưa.',
          'err'
        );
        break;
      }

      if (outcome === true) {
        STATE.okCount++;
        consecutiveErrors = 0;
      } else if (outcome === 'skip') {
        STATE.skipCount++;
        consecutiveErrors = 0;
      } else {
        STATE.errCount++;
        consecutiveErrors++;
      }
      ui.updateProgress(STATE.okCount, STATE.skipCount, STATE.errCount, findTableFn);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        ui.log(
          `⛔ Dừng tự động: ${consecutiveErrors} hồ sơ lỗi liên tiếp. ${diagnoseBlock(findTableFn)}`,
          'err'
        );
        break;
      }

      await sleep(jitter(ui.getDelayMs()));
      await waitForTableReady(findTableFn);
    }

    STATE.running = false;
    ui.setRunning(false);
    ui.log(
      `Hoàn tất: ${STATE.okCount} thành công, ${STATE.skipCount} bỏ qua, ${STATE.errCount} lỗi.`,
      'info'
    );
    sendUsage({
      loai: 'chay',
      chucNang: ui.toolTitle || '',
      thanhCong: STATE.okCount,
      boQua: STATE.skipCount,
      loi: STATE.errCount,
      thoiLuongGiay: Math.round((Date.now() - batDauLuc) / 1000),
      kySo: !!(ui.signEnabled && ui.signEnabled()),
    });
  }

  const USAGE_TOOL_NAME = 'HaTools DVCBacNinh';

  // Tai khoan dang dang nhap: Liferay nhung san trong the <script> cua moi trang
  // (themeDisplay). Content script khong doc duoc bien toan cuc cua trang, nen doc
  // qua noi dung the. Da doi chieu voi themeDisplay tren cong that: khop ca 3 truong.
  function readPortalAccount() {
    const text = Array.from(document.querySelectorAll('script:not([src])'))
      .map((sc) => sc.textContent)
      .join('\n');
    const unescapeJs = (v) =>
      v
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const lay = (re) => {
      const m = text.match(re);
      return m ? unescapeJs(m[1]) : '';
    };
    const donViSelect = document.querySelector('select[id$="changeDonViHanhChinhId"]');
    const donVi =
      donViSelect && donViSelect.selectedIndex >= 0
        ? (donViSelect.options[donViSelect.selectedIndex].textContent || '').trim()
        : '';
    return {
      userId: lay(/getUserId\s*:\s*function\s*\(\)\s*\{\s*return\s*'((?:[^'\\]|\\.)*)'/),
      hoTen: lay(/getUserName\s*:\s*function\s*\(\)\s*\{\s*return\s*'((?:[^'\\]|\\.)*)'/),
      taiKhoan: lay(/getUserEmailAddress\s*:\s*function\s*\(\)\s*\{\s*return\s*'((?:[^'\\]|\\.)*)'/),
      donVi,
    };
  }

  // Ghi nhan su dung - gui qua service worker vi content script bi CORS chan khi goi
  // thang Google Apps Script. CHI gui thong tin can bo va so lieu tong hop; KHONG
  // bao gio gui ten chu ho so, so dinh danh, ma ho so hay noi dung ho so.
  function sendUsage(fields) {
    try {
      const account = readPortalAccount();
      if (!account.taiKhoan && !account.userId) return;
      chrome.runtime.sendMessage(
        { type: 'usage-ping', payload: Object.assign({ congCu: USAGE_TOOL_NAME }, account, fields) },
        () => void chrome.runtime.lastError
      );
    } catch (e) {
      /* ghi nhan hong khong duoc lam hong luot chay */
    }
  }

  // Tra ve true neu phien ban a CU HON b (vd "1.6.0" < "1.7.0").
  function phienBanCuHon(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  // Hoi Apps Script phien ban moi nhat; neu ban dang chay cu hon thi hien banner.
  // Loi mang / chua cau hinh -> im lang, khong lam phien.
  function checkForUpdate(updateEl, thongBaoEl) {
    try {
      chrome.runtime.sendMessage({ type: 'check-update' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok || !res.data) return;
        const d = res.data;

        // Thông báo chung: hiện rõ cho MỌI người đang dùng, không phụ thuộc phiên bản.
        // Quản trị đặt/xoá nội dung ở cột "thongBao" trên trang CapNhat.
        if (thongBaoEl) {
          const tb = String(d.thongBao || '').trim();
          if (tb) {
            thongBaoEl.textContent = `📢 ${tb}`;
            thongBaoEl.hidden = false;
          } else {
            thongBaoEl.hidden = true;
          }
        }

        // Băng "có bản cập nhật": chỉ khi bản đang chạy cũ hơn.
        if (!updateEl) return;
        const moi = String(d.phienBan || '').trim();
        if (!moi) return;
        const hienTai = chrome.runtime.getManifest().version;
        if (!phienBanCuHon(hienTai, moi)) return;
        const link = String(d.link || '').trim();
        updateEl.textContent = `⬆ Có bản cập nhật v${moi}` + (link ? ' — bấm để tải' : '');
        if (d.ghiChu) updateEl.title = String(d.ghiChu);
        if (link) updateEl.href = link;
        else updateEl.removeAttribute('href');
        updateEl.hidden = false;
      });
    } catch (e) {
      /* im lang */
    }
  }

  function buildPanel(config) {
    const fab = document.createElement('button');
    fab.id = 'sohoa-dvc-fab';
    fab.innerHTML = `${config.fabIcon}<span>${config.fabLabel}</span>`;
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'sohoa-dvc-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="sh-header">
        <span>${config.title}</span>
        <span class="sh-close" title="Đóng">✕</span>
      </div>
      <div class="sh-who" hidden></div>
      <div class="sh-thongbao" hidden></div>
      <a class="sh-update" hidden target="_blank" rel="noopener"></a>
      <div class="sh-body">
        <div class="sh-summary">${config.hint || 'Sẵn sàng. Bấm "Bắt đầu" để xử lý các hồ sơ trong danh sách hiện tại.'}</div>
        <div class="sh-opts">
          ${
            config.showSignOption
              ? '<label class="sh-sign"><input type="checkbox" class="sh-sign-cb" checked /> Ký số giấy tờ</label>'
              : ''
          }
          <label>Nghỉ giữa hồ sơ
            <input class="sh-delay" type="number" min="0.3" max="30" step="0.1" value="1.2" />
            giây
          </label>
        </div>
        <div class="sh-progress-wrap"><div class="sh-progress-bar"></div></div>
        <div class="sh-actions">
          <button class="sh-start">▶ Bắt đầu</button>
          <button class="sh-stop" disabled>⏹ Dừng</button>
        </div>
        <div class="sh-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const logEl = panel.querySelector('.sh-log');
    const summaryEl = panel.querySelector('.sh-summary');
    const progressBar = panel.querySelector('.sh-progress-bar');
    const delayInput = panel.querySelector('.sh-delay');
    const signCheckbox = panel.querySelector('.sh-sign-cb');

    const whoLine = panel.querySelector('.sh-who');
    const account = readPortalAccount();
    if (whoLine && (account.hoTen || account.taiKhoan)) {
      whoLine.textContent = [account.hoTen, account.taiKhoan].filter(Boolean).join(' · ');
      whoLine.title = 'Lượt sử dụng công cụ được ghi nhận theo tài khoản này';
      whoLine.hidden = false;
    }
    checkForUpdate(panel.querySelector('.sh-update'), panel.querySelector('.sh-thongbao'));
    const startBtn = panel.querySelector('.sh-start');
    const stopBtn = panel.querySelector('.sh-stop');

    let usageOpenSent = false;
    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      if (!usageOpenSent && panel.style.display !== 'none') {
        usageOpenSent = true;
        sendUsage({ loai: 'mo-cong-cu', chucNang: config.title });
      }
    });
    panel.querySelector('.sh-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });

    const ui = {
      toolTitle: config.title,
      log(msg, level) {
        const line = document.createElement('div');
        line.className = `sh-log-line ${level || 'info'}`;
        const time = new Date().toLocaleTimeString('vi-VN');
        line.textContent = `[${time}] ${msg}`;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
      },
      signEnabled() {
        return !!(signCheckbox && signCheckbox.checked);
      },
      getDelayMs() {
        const seconds = parseFloat(delayInput.value);
        if (!isFinite(seconds) || seconds <= 0) return DEFAULT_DELAY_MS;
        return Math.min(30000, Math.max(300, Math.round(seconds * 1000)));
      },
      setRunning(isRunning) {
        delayInput.disabled = isRunning;
        if (signCheckbox) signCheckbox.disabled = isRunning;
        startBtn.disabled = isRunning;
        stopBtn.disabled = !isRunning;
        summaryEl.textContent = isRunning
          ? 'Đang xử lý...'
          : 'Đã dừng. Bấm "Bắt đầu" để chạy lại.';
      },
      updateProgress(ok, skipped, err, findTableFn) {
        const total = ok + skipped + err;
        summaryEl.textContent = `Đã xử lý ${total} hồ sơ — ${ok} thành công, ${skipped} bỏ qua, ${err} lỗi.`;
        const table = findTableFn();
        const remaining = table ? table.querySelectorAll('tbody > tr').length : 0;
        const pct = total + remaining > 0 ? Math.min(100, Math.round((total / (total + remaining)) * 100)) : 0;
        progressBar.style.width = pct + '%';
      },
    };

    startBtn.addEventListener('click', () => {
      if (STATE.running) return;
      logEl.innerHTML = '';
      runBatch(
        ui,
        config.getNextRecord,
        config.processRecord,
        config.findTable,
        config.prepare,
        config.refreshList
      );
    });
    stopBtn.addEventListener('click', () => {
      STATE.stopRequested = true;
      stopBtn.disabled = true;
    });
  }

  function init() {
    if (findSoHoaTable()) {
      buildPanel({
        fabIcon: `<svg class="sh-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>`,
        fabLabel: 'Số hóa hàng loạt',
        title: 'Số hóa hàng loạt',
        hint: 'Tool tự mở, ký và lưu từng hồ sơ - mỗi hồ sơ bạn chỉ cần bấm "Ký số" trong cửa sổ VGCA khi nó hiện lên.',
        showSignOption: true,
        prepare: prepareSoHoa,
        getNextRecord: getNextSoHoaRecord,
        processRecord: processSoHoaRecord,
        findTable: findSoHoaTable,
      });
    } else if (findDinhKemTable()) {
      buildPanel({
        fabIcon: `<svg class="sh-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05 12.2 20.25a5.5 5.5 0 0 1-7.78-7.78l9.2-9.2a3.67 3.67 0 0 1 5.19 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.6-2.59l8.5-8.49"/></svg>`,
        fabLabel: 'Đính kèm hàng loạt',
        title: 'Đính kèm kết quả điện tử hàng loạt',
        getNextRecord: getNextDinhKemRecord,
        processRecord: processDinhKemRecord,
        findTable: findDinhKemTable,
      });
    } else if (findTraKqTable()) {
      buildPanel({
        fabIcon: `<svg class="sh-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
        fabLabel: 'Trả kết quả hàng loạt',
        title: 'Trả kết quả hàng loạt',
        hint: 'Chỉ trả hồ sơ có mục "Trả kết quả" và đủ thông tin người nhận; hồ sơ thiếu thông tin được bỏ qua để làm tay.',
        getNextRecord: getNextTraKqRecord,
        processRecord: processTraKqRecord,
        findTable: findTraKqTable,
      });
    } else if (findVbdlisTable()) {
      buildPanel({
        fabIcon: `<svg class="sh-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>`,
        fabLabel: 'Đồng bộ hàng loạt',
        title: 'Đồng bộ hồ sơ VBDLIS',
        hint: 'Bấm "Bắt đầu": tool tự lọc "Chưa đồng bộ", đồng bộ hết trang rồi tìm kiếm lại để lấy tiếp hồ sơ còn lại.',
        getNextRecord: getNextVbdlisRecord,
        processRecord: processVbdlisRecord,
        findTable: findVbdlisTable,
        prepare: prepareVbdlis,
        refreshList: refreshVbdlis,
      });
    }
    else {
      setTimeout(() => {
        if (!document.getElementById('sohoa-dvc-fab')) init();
      }, 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
