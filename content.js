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

  const WAIT_MODAL_OPEN_TIMEOUT = 12000;
  const WAIT_MODAL_CLOSE_TIMEOUT = 20000;
  const POLL_INTERVAL = 150;
  const MAX_CONSECUTIVE_ERRORS = 5;
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
  // Trang "Chờ bổ sung kết quả điện tử": bảng và modal GIỐNG HỆT đính kèm (form đuôi
  // _frmDinhKemAction, select ketQuaId), chỉ khác đường dẫn và tên mục menu.
  const BOSUNG_PATH_PART = 'cho-bo-sung-ket-qua-dien-tu';
  const DINHKEM_MENU_ITEM = 'Đính kèm kết quả điện tử';
  const BOSUNG_MENU_ITEM = 'Bổ sung kết quả điện tử';
  // Mục menu mở modal đính/bổ sung — đặt theo trang tại init() (2 trang dùng chung xử lý).
  let MUC_MENU_HOSO = DINHKEM_MENU_ITEM;
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

  // ===== Giữ nhịp thời gian khi tab CHẠY NỀN =====================================
  // Chrome bóp setTimeout của tab ẩn xuống ~1 nhịp/giây (đã đo: 27s nền chỉ ~8 nhịp
  // 250ms thay vì ~110). Web Worker KHÔNG bị bóp (đo được ~109). Nên dùng Worker phát
  // nhịp 100ms để đánh thức các "sleep" đúng hạn; nếu CSP trang chặn Worker (blob) thì
  // tự động rơi về setTimeout (vẫn chạy, chỉ chậm khi ẩn tab).
  const Ticker = (() => {
    let worker = null;
    let tried = false;
    const waiters = new Set();
    function ensure() {
      if (tried) return;
      tried = true;
      try {
        const url = URL.createObjectURL(
          new Blob(['setInterval(function(){postMessage(1)},100)'], {
            type: 'application/javascript',
          })
        );
        worker = new Worker(url);
        worker.onmessage = () => {
          const now = Date.now();
          waiters.forEach((w) => {
            if (now >= w.due) w.resolve();
          });
        };
        worker.onerror = () => {
          try {
            worker.terminate();
          } catch (e) {
            /* bỏ qua */
          }
          worker = null;
        };
      } catch (e) {
        worker = null;
      }
    }
    return {
      add(w) {
        ensure();
        waiters.add(w);
      },
      remove(w) {
        waiters.delete(w);
      },
    };
  })();

  function sleep(ms) {
    return new Promise((resolve) => {
      let done = false;
      const w = { due: Date.now() + ms, resolve: null };
      const finish = () => {
        if (done) return;
        done = true;
        Ticker.remove(w);
        resolve();
      };
      w.resolve = finish;
      Ticker.add(w); // Worker đánh thức đúng hạn kể cả khi ẩn tab
      setTimeout(finish, ms); // dự phòng nếu Worker bị chặn (khi hiện tab vẫn chuẩn)
    });
  }

  // Giữ tab không bị Chrome "đóng băng" (freeze) khi chạy nền lâu: nắm một Web Lock
  // suốt lượt chạy. Tab đang giữ Web Lock nằm trong danh sách miễn freeze của Chrome.
  // Im lặng, không cần thao tác người dùng, không hiện biểu tượng loa. Best-effort.
  const KeepAwake = (() => {
    let release = null;
    return {
      on() {
        // 1) Chống Chrome "discard" (huỷ nạp -> tải lại -> panel reset, app tắt im lặng).
        try {
          chrome.runtime.sendMessage({ type: 'keep-tab-loaded', keep: true }, () => {
            void chrome.runtime.lastError;
          });
        } catch (e) {
          /* bỏ qua */
        }
        // 2) Chống Chrome "freeze" tab nền: giữ một Web Lock suốt lượt chạy.
        if (release) return;
        try {
          if (navigator.locks && navigator.locks.request) {
            navigator.locks
              .request('hatools-dvc-keep-awake', { mode: 'exclusive' }, () =>
                new Promise((res) => {
                  release = res;
                })
              )
              .catch(() => {
                release = null;
              });
          }
        } catch (e) {
          /* không giữ được lock cũng không sao */
        }
      },
      off() {
        try {
          chrome.runtime.sendMessage({ type: 'keep-tab-loaded', keep: false }, () => {
            void chrome.runtime.lastError;
          });
        } catch (e) {
          /* bỏ qua */
        }
        try {
          if (release) release();
        } catch (e) {
          /* bỏ qua */
        }
        release = null;
      },
    };
  })();

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

  // ===== CHUẨN NHẬT KÝ DÙNG CHUNG CHO TOÀN APP ================================
  // Một chuẩn cho mọi tác vụ (không viết log riêng từng trang). Nguyên tắc:
  //   • Mỗi hồ sơ: 1 dòng bắt đầu (▸ MÃ) + 1 dòng kết quả (✓ xong / ⏭ bỏ qua / ✗ lỗi).
  //   • Luôn kèm MÃ hồ sơ và LÝ DO ngắn gọn -> dễ đọc, dễ truy vết, dễ hỗ trợ lỗi.
  //   • KHÔNG ghi dữ liệu công dân (tên, số định danh) vào log.
  //   • Định dạng gom về một nơi; task chỉ truyền hàm ghi (sink = ui.log) + dữ liệu.
  // Ký hiệu: ▸ bắt đầu · ✓ xong · ⏭ bỏ qua · ✗ lỗi · → bước chung · ⚠ cảnh báo · ↳ chi tiết · Σ tổng kết.
  const Log = {
    info: (sink, msg) => sink('• ' + msg, 'info'),
    step: (sink, msg) => sink('→ ' + msg, 'info'),
    warn: (sink, msg) => sink('⚠ ' + msg, 'warn'),
    loi: (sink, msg) => sink('✗ ' + msg, 'err'),
    note: (sink, msg) => sink('   ↳ ' + msg, 'info'),
    start: (sink, rec) => sink('▸ ' + rec.label, 'info'),
    ok: (sink, rec, ct) => sink('✓ ' + rec.label + (ct ? ' — ' + ct : ''), 'ok'),
    skip: (sink, rec, lyDo) => sink('⏭ ' + rec.label + (lyDo ? ' — ' + lyDo : ''), 'skip'),
    fail: (sink, rec, lyDo) => sink('✗ ' + rec.label + (lyDo ? ' — ' + lyDo : ''), 'err'),
    done: (sink, ok, skip, err) =>
      sink(`Σ Hoàn tất: ${ok} xong · ${skip} bỏ qua · ${err} lỗi`, err > 0 ? 'warn' : 'ok'),
  };

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
          Log.note(log, `${label}: đã tự bấm "${txt}" ở hộp thoại xác nhận`);
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
    // Đặt 200 hồ sơ/trang trước (giảm số lần chuyển trang), rồi mới kiểm tra ký số.
    await prepareTrang200(log, findTableFn);

    const table = findTableFn();
    const tong = table
      ? Array.from(table.querySelectorAll('tbody > tr')).filter((tr) => tr.querySelector('td')).length
      : 0;
    const daKy = countSoHoaDaKy();
    const dangKySo = !!(ui && ui.signEnabled && ui.signEnabled());

    if (dangKySo) {
      Log.info(log, `Trên trang có ${tong} hồ sơ: bỏ qua ${daKy} đã ký, sẽ làm ${tong - daKy}.`);
    } else {
      Log.info(log, `Trên trang có ${tong} hồ sơ, sẽ làm tất cả (đã tắt ký số).`);
      return;
    }

    const helper = await startAutoSignHelper();
    if (helper && helper.ok) {
      Log.info(log, 'Đã bật tự bấm "Ký số" trên máy (không cần bấm tay).');
    } else {
      Log.warn(
        log,
        `Chưa bật được tự bấm "Ký số" (${(helper && helper.error) || 'chưa cài'}) — bạn tự bấm "Ký số" trong cửa sổ VGCA.`
      );
    }

    const connected = await checkSignService();
    if (connected) {
      Log.info(log, 'Phần mềm ký số: đã kết nối (127.0.0.1:8987).');
    } else {
      Log.warn(
        log,
        'Chưa kết nối phần mềm ký số (127.0.0.1:8987). Mở phần mềm ký và cắm USB token, nếu không hồ sơ sẽ không ký được.'
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
      Log.fail(log, { label }, `không thấy nút "${SIGN_BUTTON_TEXT}" (không lưu, cần làm tay)`);
      return false;
    }

    const toastsBefore = new Set(toastElements());
    const uploadsBefore = countSignUploads();
    const stateBefore = signedFileState(modalRoot);
    signBtn.click();
    Log.note(
      log,
      `${label}: đã mở phần mềm ký — bấm "Ký số" trong cửa sổ VGCA (chờ tối đa ${Math.round(
        WAIT_SIGN_TIMEOUT / 1000
      )}s)`
    );

    const start = Date.now();
    while (Date.now() - start < WAIT_SIGN_TIMEOUT) {
      const toast = toastElements().find((el) => !toastsBefore.has(el));
      if (toast) {
        const cls = toast.className || '';
        const msg = (toast.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150);
        toast.remove();
        if (/toast-error|toast-warning/.test(cls)) {
          Log.fail(log, { label }, `ký số lỗi: ${msg}`);
          return false;
        }
        Log.note(log, `${label}: ${msg}`);
        return true;
      }
      const stateNow = signedFileState(modalRoot);
      if (stateNow.signed && (!stateBefore.signed || stateNow.fileId !== stateBefore.fileId)) {
        Log.note(log, `${label}: đã ký số (file đã chuyển sang bản đã ký)`);
        return true;
      }
      const uploadsNow = countSignUploads();
      if (uploadsBefore >= 0 && uploadsNow > uploadsBefore) {
        Log.note(log, `${label}: đã ký số (file ký đã tải lên hệ thống)`);
        return true;
      }
      // KHONG dung "nut ky bien mat" lam dau hieu da ky: do da bat duoc truong hop
      // modal ve lai khien nut tam an trong khi chua ky gi ca -> bao thanh cong nham.
      const mark = findSignedMark(modalRoot);
      if (mark) {
        Log.note(log, `${label}: đã ký số — ${mark}`);
        return true;
      }
      await sleep(POLL_INTERVAL);
    }

    Log.fail(
      log,
      { label },
      `chờ ${Math.round(
        WAIT_SIGN_TIMEOUT / 1000
      )}s vẫn chưa ký xong (chưa bấm "Ký số" trong VGCA?) — KHÔNG lưu để tránh lưu hồ sơ chưa ký`
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
      Log.fail(log, rec, 'không thấy mục "Số hóa giấy tờ" trong menu');
      return false;
    }
    item.click();

    const opened = await waitFor(
      () => findVisibleByExactText('button', 'Lưu thông tin số hóa'),
      WAIT_MODAL_OPEN_TIMEOUT
    );
    if (!opened) {
      Log.fail(log, rec, 'modal "Số hóa giấy tờ" không mở được (quá thời gian)');
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
        Log.skip(log, rec, 'đã ký số từ trước');
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
      Log.fail(log, rec, 'không thấy ô "Tên chủ thể" (cần kiểm tra thủ công)');
      tryCloseModal(formRoot);
      await sleep(300);
      return false;
    }

    setNativeValue(tenChuTheInput, rec.chuHoSo);
    await sleep(150);

    const saveBtn = findVisibleByExactText('button', 'Lưu thông tin số hóa');
    if (!saveBtn) {
      Log.fail(log, rec, 'mất nút "Lưu thông tin số hóa" trước khi bấm');
      tryCloseModal(modalRoot);
      return false;
    }
    const toastsBefore = new Set(toastElements());
    saveBtn.click();

    // Coi là XONG khi: modal ĐÓNG hoặc có TOAST thành công. Cửa sổ bị che (occlusion) làm
    // Chrome coi tab là ẩn -> animation đóng modal của cổng bị bóp, modal đóng rất trễ DÙ ĐÃ
    // LƯU; toast được thêm ngay khi AJAX trả về nên là dấu hiệu tin cậy hơn. Chỉ báo lỗi khi
    // có toast lỗi, hoặc quá lâu không có dấu hiệu nào.
    let toastLoi = null;
    const xong = await waitClosedAutoConfirm(
      () => {
        const t = toastElements().find((el) => !toastsBefore.has(el));
        if (t) {
          const cls = t.className || '';
          const msg = (t.textContent || '').replace(/\s+/g, ' ').replace(/^×\s*/, '').trim().slice(0, 150);
          t.remove();
          if (/toast-error|toast-warning/.test(cls)) toastLoi = msg || 'hệ thống báo lỗi';
          return true;
        }
        return !findVisibleByExactText('button', 'Lưu thông tin số hóa');
      },
      WAIT_MODAL_CLOSE_TIMEOUT,
      log,
      rec.label
    );
    if (toastLoi) {
      Log.fail(log, rec, toastLoi);
      tryCloseModal(modalRoot);
      await sleep(300);
      return false;
    }
    if (!xong) {
      Log.fail(log, rec, 'sau khi Lưu không thấy modal đóng/không có thông báo — kiểm tra thủ công');
      tryCloseModal(modalRoot);
      await sleep(300);
      return false;
    }
    tryCloseModal(modalRoot); // occlusion có thể để modal treo dù đã lưu -> dọn cho chắc
    await sleep(200);

    Log.ok(log, rec, 'đã số hóa');
    return true;
  }

  // Trang "Hồ sơ chờ trả kết quả" dung chung id bang voi trang dinh kem,
  // nen phai phan biet bang duong dan.
  function isTraKqPage() {
    return location.pathname.toLowerCase().indexOf(TRAKQ_PATH_PART) >= 0;
  }
  function isBoSungPage() {
    return location.pathname.toLowerCase().indexOf(BOSUNG_PATH_PART) >= 0;
  }

  // Bảng đính kèm và bổ sung cùng đuôi _tblDataHoSo -> phân biệt bằng đường dẫn.
  function findDinhKemTable() {
    if (isTraKqPage() || isBoSungPage()) return null;
    return document.querySelector('table[id$="_tblDataHoSo"]');
  }
  function findBoSungTable() {
    if (!isBoSungPage()) return null;
    return document.querySelector('table[id$="_tblDataHoSo"]');
  }

  // Đính kèm và Bổ sung lấy hồ sơ giống nhau (khác bảng + tiền tố khoá chống trùng).
  function getNextDinhKemLike(findTableFn, keyPrefix) {
    const table = findTableFn();
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('tbody > tr')).filter((tr) =>
      tr.querySelector('td')
    );
    for (const row of rows) {
      const tds = row.querySelectorAll('td');
      if (tds.length < 2) continue;
      const maBienNhan = (tds[1]?.textContent || '').trim();
      const key = `${keyPrefix}|${maBienNhan}`;
      if (STATE.processedKeys.has(key)) continue;
      const trigger = findRowTrigger(row);
      if (!trigger) continue;
      return { row, label: maBienNhan, maBienNhan, key, trigger };
    }
    return null;
  }
  function getNextDinhKemRecord() {
    return getNextDinhKemLike(findDinhKemTable, 'dinhkem');
  }
  function getNextBoSungRecord() {
    return getNextDinhKemLike(findBoSungTable, 'bosung');
  }

  // Trước khi chạy: đặt số bản ghi/trang lớn nhất (200) để đỡ phải chuyển trang nhiều lần.
  // Dùng chung cho Đính kèm, Trả kết quả (Số hóa gọi trong prepareSoHoa; VBDLIS có prepare riêng).
  async function prepareTrang200(log, findTableFn) {
    const sigBefore = tableSignature(findTableFn);
    if (setPageSize(log)) {
      const changed = await waitForTableChanged(findTableFn, sigBefore, WAIT_SEARCH_TIMEOUT);
      if (!changed) Log.note(log, 'danh sách chưa đổi sau khi đặt số bản ghi/trang');
    }
  }

  // Tạo hàm "chuyển sang trang kế" dùng chung cho mọi tác vụ danh sách (Đính kèm, Số hóa,
  // Trả kết quả). Hết hồ sơ CHƯA XỬ LÝ trên trang hiện tại -> bấm "Sau". Hồ sơ xử lý xong
  // rời danh sách, hồ sơ bỏ qua/lỗi ở lại và dồn đầy trang; lặp bấm "Sau" để vượt qua chúng
  // tới hồ sơ mới. `getNextRecordFn` = hàm lấy hồ sơ kế của đúng tác vụ. Trả false khi hết trang.
  function taoNextPage(getNextRecordFn) {
    return async function (log, findTableFn) {
      for (let hop = 0; hop < 500; hop++) {
        if (STATE.stopRequested) return false;
        const sau = Array.from(document.querySelectorAll('a, button')).find(
          (e) => isVisible(e) && (e.textContent || '').trim() === 'Sau'
        );
        const daKhoa =
          sau &&
          (sau.disabled ||
            /disabled/.test(typeof sau.className === 'string' ? sau.className : '') ||
            sau.closest('.disabled, [disabled]') != null);
        if (!sau || daKhoa) {
          Log.info(log, 'Đã tới trang cuối — không còn trang kế.');
          return false;
        }
        const before = tableSignature(findTableFn);
        sau.click();
        Log.step(log, 'Chuyển sang trang kế...');
        const changed = await waitForTableChanged(findTableFn, before, WAIT_SEARCH_TIMEOUT);
        if (!changed) {
          Log.note(log, 'Trang không đổi — coi như đã hết hồ sơ');
          return false;
        }
        if (getNextRecordFn()) return true; // trang mới có hồ sơ chưa xử lý
        Log.note(log, 'Trang này đã xử lý hết, sang tiếp');
      }
      return false;
    };
  }

  function getDinhKemForm() {
    // Cổng DVC có thể để sót form của hồ sơ TRƯỚC (không đóng hẳn) rồi tạo thêm form
    // cho hồ sơ hiện tại. Các form trùng id, nên phải lấy form visible MỚI NHẤT (cuối
    // danh sách theo DOM) mới đúng hồ sơ đang xử lý, không lấy form cũ (find đầu tiên).
    const visibles = Array.from(
      document.querySelectorAll('form[id$="_frmDinhKemAction"]')
    ).filter((f) => isVisible(f));
    return visibles.length ? visibles[visibles.length - 1] : null;
  }

  // Đóng modal "Đính kèm kết quả điện tử" một cách CHẮC CHẮN. Nút đóng (× bootbox và
  // nút "Đóng") nằm ở wrapper bootbox NGOÀI thẻ <form>, nên tryCloseModal(form) không
  // với tới được -> phải tìm trên toàn trang. Trả về true khi không còn form nào visible.
  async function dongModalDinhKem() {
    for (let lan = 0; lan < 8; lan++) {
      if (!getDinhKemForm()) return true;
      // Bấm HẾT các nút đóng đang hiện (× bootbox và "Đóng") để dọn cả form bị dồn,
      // rồi thêm Escape phòng khi không thấy nút. Lặp nhiều vòng cho chắc.
      const nuts = [
        ...document.querySelectorAll('.bootbox-close-button.close, button.bootbox-close-button'),
        ...Array.from(document.querySelectorAll('button, a.btn')).filter(
          (b) => (b.textContent || '').trim() === 'Đóng'
        ),
      ].filter(isVisible);
      if (nuts.length) nuts.forEach((b) => b.click());
      else
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
        );
      await sleep(350);
    }
    return !getDinhKemForm();
  }

  // Mở modal đính kèm, thử lại tối đa 3 lần. Đôi khi cú click mở menu/mục bị "rơi"
  // (menu đang chuyển cảnh, hoặc trang bận/ẩn tab làm chậm), hoặc modal mở trễ hơn
  // bình thường (thường ~1s). Thử lại + timeout dài xử lý được cả 2 trường hợp.
  async function moModalDinhKem(rec, log) {
    for (let lan = 1; lan <= 3; lan++) {
      if (getDinhKemForm()) await dongModalDinhKem(); // dọn sót trước mỗi lần thử
      try {
        rec.trigger.scrollIntoView({ block: 'center' });
      } catch (e) {
        /* không sao */
      }
      const item = await openRowMenuAndGetItem(rec.trigger, MUC_MENU_HOSO);
      if (!item) {
        if (lan < 3) {
          await sleep(600);
          continue;
        }
        Log.fail(log, rec, `không thấy mục "${MUC_MENU_HOSO}" trong menu`);
        return null;
      }
      // Đánh dấu các form đang có TRƯỚC khi mở, để nhận đúng form MỚI của hồ sơ này.
      const formsTruoc = new Set(document.querySelectorAll('form[id$="_frmDinhKemAction"]'));
      item.click();

      const openedForm = await waitFor(() => {
        const moi = Array.from(document.querySelectorAll('form[id$="_frmDinhKemAction"]')).filter(
          (f) => isVisible(f) && !formsTruoc.has(f)
        );
        if (moi.length) return moi[moi.length - 1];
        return getDinhKemForm();
      }, WAIT_MODAL_OPEN_TIMEOUT);
      if (openedForm) return openedForm;

      if (lan < 3) Log.note(log, `${rec.label}: chưa mở (lần ${lan}/3), thử lại`);
      await sleep(800);
    }
    Log.fail(log, rec, `modal "${MUC_MENU_HOSO}" không mở được sau 3 lần`);
    return null;
  }

  async function processDinhKemRecord(rec, log) {
    const openedForm = await moModalDinhKem(rec, log);
    if (!openedForm) return false;

    const rows = Array.from(openedForm.querySelectorAll('table tbody tr')).filter((tr) =>
      tr.querySelector('select[name*="ketQuaId"]')
    );

    if (rows.length === 0) {
      Log.fail(log, rec, 'không thấy dòng "Chọn file đã có" (cần kiểm tra thủ công)');
      await dongModalDinhKem();
      return false;
    }

    // Dropdown "Chọn file đã có" có thể nạp option BẤT ĐỒNG BỘ (AJAX) một nhịp sau khi
    // modal hiện. Nếu đọc quá sớm sẽ thấy 0 option -> tưởng "chưa có file điện tử sẵn có".
    // Chờ tới khi có ít nhất 1 option thực, rồi nghỉ thêm 1 nhịp để các dòng nạp nốt.
    const demOptThuc = () =>
      rows.reduce((tong, r) => {
        const sel = r.querySelector('select[name*="ketQuaId"]');
        return (
          tong +
          (sel
            ? Array.from(sel.options).filter(
                (o) => o.value !== '0' && o.textContent.trim() !== 'Chọn tệp tin'
              ).length
            : 0)
        );
      }, 0);
    const hanChoOpt = Date.now() + 3000;
    let soOptThuc = demOptThuc();
    while (soOptThuc === 0 && Date.now() < hanChoOpt) {
      await sleep(120);
      soOptThuc = demOptThuc();
    }
    if (soOptThuc > 0) await sleep(150);

    // Mỗi dòng kết quả có dropdown "Chọn file đã có" RIÊNG. Danh sách file theo từng dòng:
    const optsMoiDong = rows.map((r) =>
      Array.from(r.querySelector('select[name*="ketQuaId"]').options).filter(
        (o) => o.value !== '0' && o.textContent.trim() !== 'Chọn tệp tin'
      )
    );
    const fileKhacNhau = new Set();
    optsMoiDong.forEach((opts) => opts.forEach((o) => fileKhacNhau.add(o.value)));

    if (fileKhacNhau.size === 0) {
      Log.skip(log, rec, 'chưa có file điện tử sẵn có');
      await dongModalDinhKem();
      return 'skip';
    }

    const datFile = (i, val) => {
      const select = rows[i].querySelector('select[name*="ketQuaId"]');
      select.value = val;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return String(select.value) === String(val);
    };

    if (fileKhacNhau.size === 1) {
      // Chỉ có 1 file duy nhất -> đính file đó vào TẤT CẢ các dòng kết quả.
      const val = [...fileKhacNhau][0];
      for (let i = 0; i < rows.length; i++) {
        if (!optsMoiDong[i].some((o) => o.value === val) || !datFile(i, val)) {
          Log.fail(log, rec, `không đặt được file cho dòng ${i + 1}`);
          await dongModalDinhKem();
          return 'skip';
        }
      }
    } else {
      // Nhiều file -> mỗi dòng MỘT file khác nhau (không dùng lại file đã gán). Dòng nào
      // không còn file riêng để gán thì bỏ qua cả hồ sơ.
      const daDung = new Set();
      for (let i = 0; i < rows.length; i++) {
        const chon = optsMoiDong[i].find((o) => !daDung.has(o.value));
        if (!chon) {
          Log.skip(log, rec, `dòng ${i + 1} không còn file riêng để gán`);
          await dongModalDinhKem();
          return 'skip';
        }
        if (!datFile(i, chon.value)) {
          Log.fail(log, rec, `không đặt được file cho dòng ${i + 1}`);
          await dongModalDinhKem();
          return 'skip';
        }
        daDung.add(chon.value);
      }
    }
    await sleep(150);

    const saveBtn = Array.from(openedForm.querySelectorAll('button')).find(
      (b) => isVisible(b) && (b.textContent || '').trim() === 'Lưu'
    );
    if (!saveBtn) {
      Log.fail(log, rec, 'mất nút "Lưu" trước khi bấm');
      await dongModalDinhKem();
      return false;
    }
    const toastsBefore = new Set(toastElements());
    saveBtn.click();

    // Coi là XONG khi: modal ĐÓNG hoặc có TOAST thành công. Khi cửa sổ bị che (occlusion),
    // Chrome coi tab là ẩn -> animation đóng modal của cổng bị bóp, modal đóng rất trễ DÙ ĐÃ
    // LƯU; nhưng toast được thêm ngay khi AJAX trả về (không phụ thuộc animation) nên bắt toast
    // là dấu hiệu tin cậy. Chỉ xét đúng form của hồ sơ này (tránh form bỏ qua trước đó còn sót).
    let toastLoi = null;
    const xong = await waitClosedAutoConfirm(
      () => {
        const t = toastElements().find((el) => !toastsBefore.has(el));
        if (t) {
          const cls = t.className || '';
          const msg = (t.textContent || '').replace(/\s+/g, ' ').replace(/^×\s*/, '').trim().slice(0, 150);
          t.remove();
          if (/toast-error|toast-warning/.test(cls)) toastLoi = msg || 'hệ thống báo lỗi';
          return true;
        }
        return !openedForm.isConnected || !isVisible(openedForm);
      },
      WAIT_MODAL_CLOSE_TIMEOUT,
      log,
      rec.label
    );
    if (toastLoi) {
      Log.fail(log, rec, toastLoi);
      await dongModalDinhKem();
      return false;
    }
    if (!xong) {
      Log.fail(log, rec, 'sau khi Lưu không thấy modal đóng/không có thông báo — kiểm tra thủ công');
      await dongModalDinhKem();
      return false;
    }
    await dongModalDinhKem(); // occlusion có thể để modal treo dù đã lưu -> dọn cho chắc
    Log.ok(log, rec, 'đã lưu kết quả điện tử');
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
      Log.warn(log, `Không thấy nút "${SEARCH_BUTTON_TEXT}" — dùng danh sách đang hiển thị`);
      return false;
    }
    const before = tableSignature(findTableFn);
    searchBtn.click();
    Log.step(log, label);
    const changed = await waitForTableChanged(findTableFn, before, WAIT_SEARCH_TIMEOUT, () =>
      vbdlisListLooksFiltered(findTableFn)
    );
    if (!changed) {
      Log.note(log, 'danh sách không đổi sau khi tìm kiếm');
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
    Log.step(log, `Đặt ${best.size} bản ghi/trang.`);
    return true;
  }

  // Truoc khi chay: tu dat bo loc "Chua dong bo" roi bam Tim kiem.
  async function prepareVbdlis(log, findTableFn) {
    const select = document.querySelector(VBDLIS_FILTER_SELECT);
    if (!select) {
      Log.warn(log, 'Không thấy bộ lọc trạng thái đồng bộ — chạy trên danh sách hiện tại');
      return;
    }
    // 1. So ban ghi/trang: select nay co onchange tu goi tim kiem (mat ~8 giay),
    //    nen phai cho no xong han roi moi dat bo loc - neu khong se chong hai luot.
    const signatureBefore = tableSignature(findTableFn);
    if (setPageSize(log)) {
      const changed = await waitForTableChanged(findTableFn, signatureBefore, WAIT_SEARCH_TIMEOUT);
      if (!changed) {
        Log.note(log, 'danh sách chưa đổi sau khi đặt số bản ghi/trang');
      }
    }

    // 2. Bo loc trang thai: luon dat lai va bam "Tìm kiếm".
    //    Khong tin gia tri cua select: no co the la "Chưa đồng bộ" trong khi
    //    danh sach dang hien thi van la ket qua cu chua loc.
    setNativeValue(select, VBDLIS_FILTER_VALUE);
    await runVbdlisSearch(log, findTableFn, 'Đang lọc "Chưa đồng bộ"...');

    const table = findTableFn();
    const rows = table
      ? Array.from(table.querySelectorAll('tbody > tr')).filter((tr) => tr.querySelector('td'))
      : [];
    const chuaDongBo = rows.filter((row) => /Chưa đồng bộ/.test(vbdlisSyncStatus(row))).length;
    if (chuaDongBo === rows.length) {
      Log.info(log, `Đã lọc "Chưa đồng bộ" — ${chuaDongBo} hồ sơ trên trang này.`);
    } else {
      Log.warn(
        log,
        `Lọc chưa đúng: ${chuaDongBo}/${rows.length} chưa đồng bộ. Vẫn chạy, hồ sơ đã đồng bộ sẽ bỏ qua.`
      );
    }
  }

  // Het danh sach thi tim kiem lai: ho so vua dong bo xong se roi khoi ket qua,
  // ho so o trang sau se hien len.
  async function refreshVbdlis(log, findTableFn) {
    await runVbdlisSearch(log, findTableFn, 'Tải lại danh sách "Chưa đồng bộ"...');
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
      Log.fail(log, rec, `không thấy mục "${VBDLIS_MENU_ITEM}" trong menu`);
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
      Log.fail(log, rec, 'không thấy hộp xác nhận đồng bộ (quá thời gian)');
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
      Log.fail(log, rec, `không nhận được kết quả sau ${Math.round(WAIT_SYNC_RESULT_TIMEOUT / 1000)}s`);
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
        Log.skip(log, rec, 'đã có bên VBDLIS (người khác đồng bộ trước)');
      } else {
        Log.skip(log, rec, msg || 'hệ thống báo lỗi');
      }
      return 'skip';
    }

    Log.ok(log, rec, msg || 'đã đồng bộ');
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
    const ddIndex = columnIndexByHeader(table, 'Số định danh', 6);
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
      const soDinhDanh = (tds[ddIndex]?.textContent || '').replace(/\D/g, '');
      return { row, label: ma, chuHoSo, soDinhDanh, key, trigger };
    }
    return null;
  }

  function findTraKqForm() {
    return (
      Array.from(document.querySelectorAll('.bootbox form[id$="_frmWorkflowAction"]')).find(isVisible) ||
      null
    );
  }

  // Suy ngày sinh từ số định danh (CCCD 12 số): chữ số thứ 4 = mã thế kỷ + giới tính,
  // chữ số 5-6 = 2 số cuối năm sinh. Ngày/tháng mặc định 01/01.
  //   0,1→19xx; 2,3→20xx; 4,5→21xx; 6,7→22xx; 8,9→23xx  (thế kỷ = 19 + floor(d/2))
  function ngaySinhTuDinhDanh(dinhDanh) {
    const s = String(dinhDanh || '').replace(/\D/g, '');
    if (s.length !== 12) return null;
    const d3 = parseInt(s[3], 10);
    const yy = parseInt(s.slice(4, 6), 10);
    if (isNaN(d3) || isNaN(yy)) return null;
    const nam = (19 + Math.floor(d3 / 2)) * 100 + yy;
    return `01/01/${nam}`;
  }

  // Điền ngày sinh (dd/mm/yyyy) vào ô readonly + jQuery UI datepicker của form trả kết quả.
  // Đồng bộ cả text lẫn trạng thái nội bộ datepicker để qua bước validate khi bấm gửi.
  function dienNgaySinh(el, ddmmyyyy) {
    const wasRO = el.readOnly;
    if (wasRO) el.readOnly = false;
    el.value = ddmmyyyy;
    try {
      const $ = window.jQuery || window.$;
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
      if ($ && $.fn && $.fn.datepicker && el.classList.contains('hasDatepicker') && m) {
        $(el).datepicker('setDate', new Date(+m[3], +m[2] - 1, +m[1]));
      }
    } catch (e) {
      /* vẫn còn el.value */
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    if (wasRO) el.readOnly = true;
  }

  async function processTraKqRecord(rec, log) {
    rec.row.dataset.hatoolsDone = '1';

    const item = await openRowMenuAndGetItem(rec.trigger, TRAKQ_MENU_ITEM);
    if (!item) {
      Log.skip(log, rec, `không có mục "${TRAKQ_MENU_ITEM}"`);
      openRowMenu(rec.trigger); // dong menu vua mo
      return 'skip';
    }
    item.click();

    const form = await waitFor(() => findTraKqForm(), WAIT_MODAL_OPEN_TIMEOUT);
    if (!form) {
      Log.fail(log, rec, 'không mở được hộp thoại "Trả kết quả" (quá thời gian)');
      return false;
    }
    const dialog = form.closest('.bootbox') || form;
    await sleep(500);

    // Nếu thiếu Ngày sinh nhưng có Số định danh -> tự điền 01/01/<năm suy từ định danh>.
    // Cổng bắt buộc có Ngày sinh mới cho trả kết quả; suy năm sinh từ số định danh.
    const nsEl = form.querySelector('[name="ngaySinh"], [name$="ngaySinh"]');
    if (nsEl && !(nsEl.value || '').trim()) {
      const ddEl = form.querySelector('[name="soDinhDanh"], [name$="soDinhDanh"]');
      const dinhDanh = (ddEl && (ddEl.value || '').trim()) || rec.soDinhDanh || '';
      const ns = ngaySinhTuDinhDanh(dinhDanh);
      if (ns) {
        dienNgaySinh(nsEl, ns); // tự điền im lặng, không ghi log để tránh lộ dữ liệu công dân
      } else {
        Log.note(log, `${rec.label}: không suy được ngày sinh (số định danh không hợp lệ)`);
      }
    }

    // Thieu thong tin nguoi nhan thi khong tu dien bua - de lam tay.
    const thieu = TRAKQ_REQUIRED_FIELDS.filter(([name]) => {
      const el = form.querySelector(`[name="${name}"], [name$="${name}"]`);
      return !el || !(el.value || '').trim();
    }).map(([, nhan]) => nhan);
    if (thieu.length) {
      Log.skip(log, rec, `thiếu ${thieu.join(', ')} của người nhận`);
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
      Log.fail(log, rec, `không thấy nút "${TRAKQ_CONFIRM_TEXT}"`);
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
      Log.fail(
        log,
        rec,
        `không nhận được kết quả${loiForm.length ? ' (' + loiForm.join('; ') + ')' : ''}`
      );
      if (dialog.isConnected && isVisible(dialog)) tryCloseModal(dialog);
      return false;
    }

    const cls = toast.className || '';
    const msg = (toast.textContent || '').replace(/\s+/g, ' ').replace(/^×\s*/, '').trim().slice(0, 150);
    toast.remove();

    if (/toast-error|toast-warning/.test(cls)) {
      Log.fail(log, rec, msg || 'hệ thống báo lỗi');
      if (dialog.isConnected && isVisible(dialog)) tryCloseModal(dialog);
      return false;
    }

    // Đã có toast thành công = coi như trả xong (không phụ thuộc modal đóng — khi cửa sổ bị
    // che, animation đóng của cổng bị bóp nên đóng trễ). Dọn dialog nếu còn treo.
    await waitFor(() => !dialog.isConnected || !isVisible(dialog), 5000);
    if (dialog.isConnected && isVisible(dialog)) tryCloseModal(dialog);
    Log.ok(log, rec, msg || 'đã trả kết quả');
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
    KeepAwake.on(); // giữ tab không bị Chrome bóp/đóng băng khi chạy nền
    STATE.skipSigned = !!(ui.signEnabled && ui.signEnabled());
    const batDauLuc = Date.now();

    if (prepare) {
      try {
        await prepare(ui.log, findTableFn, ui);
      } catch (e) {
        Log.warn(ui.log, `Không chuẩn bị được danh sách: ${e && e.message ? e.message : e}`);
      }
    }

    let consecutiveErrors = 0;
    // Khong gioi han so lan lap: vong lap tu dung khi het ho so, bam Dung, hoac
    // 3 loi lien tiep. processedKeys + danh dau tren DOM bao dam khong lam trung.
    // Boc try/catch de mot loi bat ngo KHONG lam chet vong lap im lang (truoc day
    // se dung ma khong bao gi + ket UI); loi se hien ra va trang thai duoc don sach.
    try {
    while (true) {
      if (STATE.stopRequested) {
        Log.info(ui.log, 'Đã dừng theo yêu cầu.');
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
          Log.warn(ui.log, `Không tải lại được danh sách: ${e && e.message ? e.message : e}`);
        }
        rec = getNextRecord();
      }
      if (!rec) {
        Log.info(ui.log, 'Không còn hồ sơ nào để xử lý trong danh sách hiện tại.');
        break;
      }
      STATE.processedKeys.add(rec.key);
      Log.start(ui.log, rec);

      // true = xong, 'skip' = he thong tu choi ho so nay, false = hong that su.
      let outcome = false;
      try {
        outcome = await processRecord(rec, ui.log, ui);
      } catch (e) {
        Log.fail(ui.log, rec, `lỗi không mong đợi: ${e && e.message ? e.message : e}`);
        outcome = false;
      }

      if (outcome === 'abort') {
        STATE.errCount++;
        ui.updateProgress(STATE.okCount, STATE.skipCount, STATE.errCount, findTableFn);
        Log.loi(
          ui.log,
          'Dừng ngay: hồ sơ chưa ký xong. Mỗi hồ sơ cần bấm "Ký số" trong cửa sổ VGCA khi nó hiện lên.'
        );
        Log.note(ui.log, 'Nếu cửa sổ VGCA không hiện: kiểm tra phần mềm ký đã chạy và USB token đã cắm.');
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
        Log.loi(
          ui.log,
          `Dừng tự động: ${consecutiveErrors} hồ sơ lỗi liên tiếp. ${diagnoseBlock(findTableFn)}`
        );
        break;
      }

      await sleep(jitter(ui.getDelayMs()));
      await waitForTableReady(findTableFn);
    }
    } catch (e) {
      Log.loi(
        ui.log,
        `Dừng do lỗi hệ thống: ${e && e.message ? e.message : e}. Hãy tải lại trang (F5) rồi bấm Bắt đầu để chạy tiếp.`
      );
    }

    STATE.running = false;
    KeepAwake.off(); // trả Web Lock + cho phép discard lại khi chạy xong/dừng
    ui.setRunning(false);
    Log.done(ui.log, STATE.okCount, STATE.skipCount, STATE.errCount);
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

  // ===== SIDE PANEL: động cơ chạy trong trang, UI ở side panel qua nhắn tin =====
  // Không còn nút nổi/panel trong trang. content.js chỉ chạy batch và gửi log/tiến độ
  // ra side panel (chrome.runtime), nhận lệnh Bắt đầu/Dừng từ side panel (tabs.sendMessage).

  let SP_CONFIG = null; // cấu hình task của trang này (null nếu chưa/không có)
  let SP_UI = null; // ui "cầu nối" — gửi message thay vì ghi DOM
  const SP_LOG = []; // đệm log để side panel mở sau vẫn thấy lại
  let SP_STATE = { running: false, ok: 0, skip: 0, err: 0, pct: 0 };
  const SP_OPTS = { delayMs: DEFAULT_DELAY_MS, sign: true };
  const RESUME_KEY = 'hatools_dvc_resume_' + location.pathname;

  function spSend(payload) {
    try {
      chrome.runtime.sendMessage(
        Object.assign({ ns: 'sp-evt' }, payload),
        () => void chrome.runtime.lastError // side panel chưa mở -> nuốt lỗi "no receiver"
      );
    } catch (e) {
      /* bỏ qua */
    }
  }

  // ui gửi message thay cho DOM; giữ nguyên interface mà runBatch cần.
  function taoUiCauNoi(config) {
    return {
      toolTitle: config.title,
      log(msg, level) {
        const line = { t: new Date().toLocaleTimeString('vi-VN'), msg, level: level || 'info' };
        SP_LOG.push(line);
        if (SP_LOG.length > 800) SP_LOG.shift();
        spSend({ kind: 'log', line });
      },
      signEnabled() {
        return config.showSignOption ? !!SP_OPTS.sign : false;
      },
      getDelayMs() {
        const ms = SP_OPTS.delayMs;
        return isFinite(ms) && ms > 0 ? Math.min(30000, Math.max(300, Math.round(ms))) : DEFAULT_DELAY_MS;
      },
      setRunning(isRunning) {
        SP_STATE.running = isRunning;
        spSend({ kind: 'running', running: isRunning });
      },
      updateProgress(ok, skipped, err, findTableFn) {
        const total = ok + skipped + err;
        const table = findTableFn && findTableFn();
        const remaining = table ? table.querySelectorAll('tbody > tr').length : 0;
        const pct = total + remaining > 0 ? Math.min(100, Math.round((total / (total + remaining)) * 100)) : 0;
        SP_STATE = { running: SP_STATE.running, ok, skip: skipped, err, pct };
        spSend({ kind: 'progress', ok, skip: skipped, err, pct });
      },
    };
  }

  const docResume = () => {
    try {
      return JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
    } catch (e) {
      return null;
    }
  };
  const ghiResume = (obj) => {
    try {
      if (obj) sessionStorage.setItem(RESUME_KEY, JSON.stringify(obj));
      else sessionStorage.removeItem(RESUME_KEY);
    } catch (e) {
      /* bỏ qua */
    }
  };

  function khoiChay(tuKhoiPhuc) {
    if (STATE.running || !SP_CONFIG) return;
    if (!tuKhoiPhuc) {
      SP_LOG.length = 0;
      spSend({ kind: 'clear' });
    }
    const prev = docResume();
    ghiResume({ tool: SP_CONFIG.title, ts: Date.now(), resumeCount: (prev && prev.resumeCount) || 0 });
    sendUsage({ loai: 'mo-cong-cu', chucNang: SP_CONFIG.title });
    Promise.resolve(
      runBatch(
        SP_UI,
        SP_CONFIG.getNextRecord,
        SP_CONFIG.processRecord,
        SP_CONFIG.findTable,
        SP_CONFIG.prepare,
        SP_CONFIG.refreshList
      )
    ).finally(() => ghiResume(null)); // kết thúc/Dừng -> xoá cờ; reload giữa chừng thì cờ còn lại
  }

  // Nhận lệnh từ side panel (đăng ký MỘT lần khi content script nạp).
  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || m.ns !== 'sp') return false;
    if (m.cmd === 'hello') {
      const acc = (function () {
        try {
          return readPortalAccount();
        } catch (e) {
          return {};
        }
      })();
      sendResponse({
        hasTask: !!SP_CONFIG,
        taskTitle: SP_CONFIG ? SP_CONFIG.title : '',
        showSignOption: SP_CONFIG ? !!SP_CONFIG.showSignOption : false,
        hint: SP_CONFIG ? SP_CONFIG.hint || '' : '',
        state: SP_STATE,
        logs: SP_LOG.slice(-300),
        who: [acc.hoTen, acc.taiKhoan].filter(Boolean).join(' · '),
      });
      return true;
    }
    if (m.cmd === 'start') {
      if (!SP_CONFIG) {
        sendResponse({ ok: false, error: 'Trang này không có chức năng HaTools.' });
        return true;
      }
      if (STATE.running) {
        sendResponse({ ok: false, error: 'Đang chạy rồi.' });
        return true;
      }
      if (typeof m.delaySec === 'number') SP_OPTS.delayMs = Math.round(m.delaySec * 1000);
      if (typeof m.sign === 'boolean') SP_OPTS.sign = m.sign;
      khoiChay(false);
      sendResponse({ ok: true });
      return true;
    }
    if (m.cmd === 'stop') {
      STATE.stopRequested = true;
      ghiResume(null); // Dừng thủ công thì không tự khôi phục nữa
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // Xác định task của trang hiện tại (thay chuỗi if/else dựng panel trước đây).
  function configForPage() {
    if (findSoHoaTable()) {
      return {
        title: 'Số hóa hàng loạt',
        hint: 'Tự đặt 200 hồ sơ/trang, mở-ký-lưu từng hồ sơ rồi tự chuyển trang cho đến hết. Mỗi hồ sơ bạn chỉ cần bấm "Ký số" trong cửa sổ VGCA khi nó hiện lên.',
        showSignOption: true,
        prepare: prepareSoHoa,
        getNextRecord: getNextSoHoaRecord,
        processRecord: processSoHoaRecord,
        findTable: findSoHoaTable,
        refreshList: taoNextPage(getNextSoHoaRecord),
      };
    }
    if (findDinhKemTable()) {
      return {
        title: 'Đính kèm kết quả điện tử hàng loạt',
        hint: 'Tự đặt 200 hồ sơ/trang, đính kèm hết trang rồi tự chuyển trang cho đến hết. Hồ sơ thiếu file để làm tay.',
        getNextRecord: getNextDinhKemRecord,
        processRecord: processDinhKemRecord,
        findTable: findDinhKemTable,
        prepare: prepareTrang200,
        refreshList: taoNextPage(getNextDinhKemRecord),
      };
    }
    if (findBoSungTable()) {
      MUC_MENU_HOSO = BOSUNG_MENU_ITEM; // trang này mở modal bằng mục "Bổ sung..."
      return {
        title: 'Bổ sung kết quả điện tử hàng loạt',
        hint: 'Tự đặt 200 hồ sơ/trang, bổ sung kết quả điện tử hết trang rồi tự chuyển trang cho đến hết. Hồ sơ thiếu file để làm tay.',
        getNextRecord: getNextBoSungRecord,
        processRecord: processDinhKemRecord,
        findTable: findBoSungTable,
        prepare: prepareTrang200,
        refreshList: taoNextPage(getNextBoSungRecord),
      };
    }
    if (findTraKqTable()) {
      return {
        title: 'Trả kết quả hàng loạt',
        hint: 'Tự đặt 200 hồ sơ/trang, trả hết trang rồi tự chuyển trang cho đến hết. Chỉ trả hồ sơ có mục "Trả kết quả" và đủ thông tin người nhận; hồ sơ thiếu thông tin được bỏ qua để làm tay.',
        getNextRecord: getNextTraKqRecord,
        processRecord: processTraKqRecord,
        findTable: findTraKqTable,
        prepare: prepareTrang200,
        refreshList: taoNextPage(getNextTraKqRecord),
      };
    }
    if (findVbdlisTable()) {
      return {
        title: 'Đồng bộ hồ sơ VBDLIS',
        hint: 'Bấm "Bắt đầu": tool tự lọc "Chưa đồng bộ", đồng bộ hết trang rồi tìm kiếm lại để lấy tiếp hồ sơ còn lại.',
        getNextRecord: getNextVbdlisRecord,
        processRecord: processVbdlisRecord,
        findTable: findVbdlisTable,
        prepare: prepareVbdlis,
        refreshList: refreshVbdlis,
      };
    }
    return null;
  }

  let SP_TRIES = 0;
  function init() {
    const config = configForPage();
    if (!config) {
      // Bảng có thể tải trễ (AJAX) -> thử lại: dày lúc đầu cho nhanh, thưa dần về sau.
      if (SP_TRIES++ < 25) setTimeout(init, SP_TRIES < 10 ? 250 : 800);
      return;
    }
    SP_CONFIG = config;
    SP_UI = taoUiCauNoi(config);
    spSend({ kind: 'ready' }); // báo side panel (nếu đang mở) rằng task đã sẵn sàng -> tự làm mới

    // Tự khôi phục khi trang bị tải lại giữa chừng (cờ sống qua reload trong sessionStorage).
    const saved = docResume();
    if (saved && saved.tool === config.title) {
      const cnt = (saved.resumeCount || 0) + 1;
      if (cnt > 3) {
        ghiResume(null);
        Log.warn(SP_UI.log, 'Phiên bị gián đoạn nhiều lần — dừng tự khôi phục. Mở side panel rồi bấm "Bắt đầu".');
      } else {
        ghiResume({ tool: config.title, ts: Date.now(), resumeCount: cnt });
        Log.warn(SP_UI.log, `Phiên trước bị gián đoạn (trang tải lại lần ${cnt}/3). Tự chạy tiếp sau 3 giây.`);
        setTimeout(() => {
          if (!STATE.running && docResume()) khoiChay(true);
        }, 3000);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
