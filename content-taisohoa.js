// Chức năng "Tải File Số Hóa": lấy đúng bộ lọc người dùng đã chọn ngay trên trang "Hồ sơ đã số
// hóa" (đơn vị, từ ngày, đến ngày...), lọc thêm theo tên file nhập ở side panel rồi tải toàn bộ
// file PDF gộp vào ZIP. Dùng phiên đăng nhập sẵn có (fetch cùng origin). Điều khiển từ side
// panel qua ns 'sp'.
(function () {
  'use strict';

  const TABLE_SUFFIX = 'tblSoHoa';
  const UNIT_SELECT_SUFFIX = 'srdonViHanhChinhId';
  // Các ô lọc của trang (tên tham số = tiền tố portlet + tên này). Giá trị được gửi NGUYÊN VĂN,
  // nên đúng định dạng ngày của trang, không phải đoán.
  const FILTER_FIELDS = ['srsoDinhDanh', 'srchuHoSo', 'srmaHoSo', 'srmaFile', 'srdonViHanhChinhId', 'srtuNgay', 'srdenNgay'];
  const PAGE_SIZE = 200; // số bản ghi/trang khi quét, như các chức năng khác (tối đa 200)
  const FALLBACK_PAGE_SIZE = 20; // giá trị máy chủ đã được kiểm chứng chấp nhận, dùng khi 200 bị từ chối
  const MAX_PAGES = 1000;
  const CONCURRENCY = 3;
  const DEFAULT_DELAY_MS = 200;
  const STORE_KEY = 'hatools_taisohoa_done_v1'; // tiến độ để "tiếp tục từ lần trước"
  const STORE_MAX_RUNS = 20;
  const RETRIES = 3;
  const MAX_PAUSES_PER_JOB = 2;
  // Có thể chỉnh khi kiểm thử. partBytes/partFiles: lưu ZIP thành từng phần ngay khi đủ, để mất
  // trang (hết phiên, chuyển hướng) cũng không mất toàn bộ phần đã tải (cũng không dùng ZIP64).
  const CFG = {
    partBytes: 200 * 1024 * 1024,
    partFiles: 150,
    retryBaseMs: 1500,
    sessionPollMs: 10000,
    keepAliveMs: 60000,
  };
  // URL điển hình của trang đăng nhập / SSO (dùng để nhận ra bị đẩy ra khỏi phiên).
  const LOGIN_URL_RE = /\/c\/portal\/login|\/login(\/|$|\?)|dang-nhap|đăng-nhập|\/(sso|oauth2?|openid|auth)(\/|$|\?)/i;
  const LOG_MAX = 500;
  const MIN_CELLS = 20;
  // Chỉ số cột trong bảng (theo tiêu đề thực tế của trang).
  const COL = { soDinhDanh: 1, chuHoSo: 2, maHoSo: 3, maFile: 4, giayTo: 5 };
  const VIEWER_RE = /\/file\/-\/dvc\/download\/|dvcfiles|\.pdf(\?|$)/i;

  const STATE = {
    running: false,
    stop: false,
    logs: [],
    prog: { phase: '', text: '', pct: 0, ok: 0, err: 0, total: 0 },
    sessionWait: null, // Promise khi đang tạm dừng chờ đăng nhập lại
    lastGoodUrl: '', // URL file đã tải thành công gần nhất, dùng để thăm dò phiên
  };

  class SessionError extends Error {}
  // Máy chủ trả trang web thay vì file: có thể do phiên hỏng hoặc file lỗi riêng -> thử lại rồi thăm dò phiên.
  class HtmlError extends Error {}
  class HttpError extends Error {
    constructor(status) {
      super('HTTP ' + status);
      this.status = status;
    }
  }

  // ---- tiện ích thuần (kiểm thử được) --------------------------------------
  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase();
  }

  function matchName(row, term) {
    const t = fold(term).trim();
    if (!t) return true;
    return fold(row.giayTo + ' ' + row.maFile).includes(t);
  }

  function sanitizeName(name, max) {
    const s = String(name || '')
      .replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '');
    return (s || 'file').slice(0, max || 150);
  }

  function fileNameFromUrl(url) {
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(last.replace(/\+/g, ' '));
    } catch (e) {
      return '';
    }
  }

  function uniqueName(used, name) {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf('.');
    const base = dot > name.lastIndexOf('/') ? name.slice(0, dot) : name;
    const ext = dot > name.lastIndexOf('/') ? name.slice(dot) : '';
    for (let i = 2; ; i++) {
      const cand = `${base} (${i})${ext}`;
      if (!used.has(cand)) {
        used.add(cand);
        return cand;
      }
    }
  }

  // Quy tắc đặt tên: "Chủ hồ sơ Mã định danh.<đuôi gốc>", nằm trong thư mục theo mã hồ sơ.
  // Thiếu cả chủ hồ sơ lẫn số định danh thì dùng mã file để không bị trùng/trống tên.
  function buildEntryName(row, srcName) {
    const ext = (String(srcName || '').match(/\.[A-Za-z0-9]{1,6}$/) || ['.pdf'])[0];
    const base = [row.chuHoSo, row.soDinhDanh].filter(Boolean).join(' ') || row.maFile;
    return `${sanitizeName(row.maHoSo, 80)}/${sanitizeName(base, 120)}${ext}`;
  }

  function isLoginUrl(u) {
    try {
      const x = new URL(u);
      return LOGIN_URL_RE.test(decodeURIComponent(x.pathname) + x.search);
    } catch (e) {
      return false;
    }
  }

  function isLoginHtml(html) {
    return /<input[^>]+type=["']?password/i.test(String(html || ''));
  }

  function rowKey(r) {
    return r.id || r.maHoSo + '|' + r.maFile;
  }

  // Khóa nhận diện "cùng một việc": cùng bộ lọc trên trang + cùng tên file.
  function runKey(filters, term) {
    return JSON.stringify([FILTER_FIELDS.map((n) => filters[n] || ''), fold(term).trim()]);
  }

  function cellText(cell, dropBadges) {
    if (!cell) return '';
    const c = cell.cloneNode(true);
    if (dropBadges) c.querySelectorAll('.badge').forEach((b) => b.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  }

  // Phân tích các dòng của một trang kết quả (Document đã parse từ HTML server trả về).
  function parseRows(doc, baseHref) {
    const rows = [];
    doc.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = tr.cells;
      if (!cells || cells.length < MIN_CELLS) return;
      const fileCell = cells[COL.maFile];
      const first = fileCell.childNodes[0];
      const maFile = ((first && first.textContent) || cellText(fileCell, true)).trim();
      const a = tr.querySelector('a[onclick*="soHoaItem"]');
      const m = a && (a.getAttribute('onclick') || '').match(/soHoaItem\('([^']+)'/);
      let detailUrl = '';
      if (m) {
        try {
          const u = new URL(m[1].replace(/&amp;/g, '&'), baseHref);
          if (u.origin === new URL(baseHref).origin) detailUrl = u.href; // chỉ nhận cùng origin
        } catch (e) {
          /* bỏ qua URL hỏng */
        }
      }
      const idm = detailUrl.match(/_id=(\d+)/);
      rows.push({
        id: idm ? idm[1] : '',
        detailUrl,
        soDinhDanh: cellText(cells[COL.soDinhDanh]),
        chuHoSo: cellText(cells[COL.chuHoSo]),
        maHoSo: cellText(cells[COL.maHoSo]),
        maFile,
        giayTo: cellText(cells[COL.giayTo], true),
      });
    });
    return rows;
  }

  // Tìm URL file trong HTML chi tiết: khung xem PDF, dự phòng theo input ẩn fileId.
  function findFileUrl(doc, baseHref) {
    const viewer = Array.from(doc.querySelectorAll('iframe, embed, object')).find((el) =>
      VIEWER_RE.test(el.getAttribute('src') || el.getAttribute('data') || '')
    );
    if (viewer) {
      const raw = viewer.getAttribute('src') || viewer.getAttribute('data');
      try {
        const u = new URL(raw, baseHref);
        if (u.origin === new URL(baseHref).origin) return { url: u.href, name: fileNameFromUrl(u.href) };
      } catch (e) {
        /* thử dự phòng */
      }
    }
    const idInput = doc.querySelector('input[type="hidden"][name$="fileId"], input[type="hidden"][id$="fileId"]');
    if (idInput && /^\d+$/.test(idInput.value)) {
      return { url: new URL('/file/-/dvc/download/' + idInput.value, baseHref).href, name: '' };
    }
    return null;
  }

  // ---- phát sự kiện tới side panel -------------------------------------------
  function emit(msg) {
    try {
      chrome.runtime.sendMessage(Object.assign({ ns: 'sp-evt' }, msg), () => void chrome.runtime.lastError);
    } catch (e) {
      /* panel chưa mở */
    }
  }
  function log(msg, level) {
    const line = { t: new Date().toLocaleTimeString('vi-VN'), msg, level: level || 'info' };
    STATE.logs.push(line);
    if (STATE.logs.length > LOG_MAX) STATE.logs.shift();
    emit({ kind: 'log', line });
  }
  function progress(patch) {
    Object.assign(STATE.prog, patch);
    emit({ kind: 'dl-progress', prog: STATE.prog });
  }
  function setRunning(v) {
    STATE.running = v;
    emit({ kind: 'dl-running', running: v });
  }

  // ---- ngữ cảnh trang ---------------------------------------------------------
  function getContext() {
    const table = document.querySelector('table[id$="_' + TABLE_SUFFIX + '"]');
    const select = document.querySelector('select[id$="_' + UNIT_SELECT_SUFFIX + '"]');
    const ref = table || select;
    if (!ref) return null;
    const suffix = table ? TABLE_SUFFIX : UNIT_SELECT_SUFFIX;
    const ns = ref.id.slice(0, ref.id.length - suffix.length); // "_org_..._zfzc_"
    const portletId = ns.replace(/^_+|_+$/g, '');
    return { ns, portletId, select };
  }

  function buildUrl(ctx, params) {
    const q = new URLSearchParams({
      p_p_id: ctx.portletId,
      p_p_lifecycle: '0',
      p_p_state: 'exclusive',
      p_p_mode: 'view',
    });
    Object.keys(params).forEach((k) => q.set(ctx.ns + k, params[k]));
    return location.origin + location.pathname + '?' + q.toString();
  }

  // Đọc bộ lọc hiện tại trên trang (đơn vị, ngày, mã...). Ô không tồn tại coi như để trống.
  function readFilters(ctx) {
    const f = {};
    FILTER_FIELDS.forEach((name) => {
      const el = document.getElementById(ctx.ns + name);
      f[name] = el && typeof el.value === 'string' ? el.value.trim() : '';
    });
    if (!f.srdonViHanhChinhId) f.srdonViHanhChinhId = '-1';
    const sel = document.getElementById(ctx.ns + UNIT_SELECT_SUFFIX);
    const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
    f.unitLabel =
      opt && f.srdonViHanhChinhId !== '-1' ? opt.textContent.replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '') : '';
    return f;
  }

  function hasAnyFilter(filters, term) {
    return !!(
      String(term || '').trim() ||
      filters.srdonViHanhChinhId !== '-1' ||
      FILTER_FIELDS.some((n) => n !== 'srdonViHanhChinhId' && filters[n])
    );
  }

  // ---- mạng -------------------------------------------------------------------
  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401 || res.status === 403) throw new SessionError('HTTP ' + res.status);
    if (res.redirected && isLoginUrl(res.url)) throw new SessionError('bị chuyển tới trang đăng nhập');
    if (!res.ok) throw new HttpError(res.status);
    const html = await res.text();
    if (isLoginHtml(html)) throw new SessionError('máy chủ trả màn hình đăng nhập');
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function searchPage(ctx, filters, cur, size) {
    const params = { mvcRenderCommandName: 'daSoHoa', cmd: 'SEARCH', cur: String(cur), delta: String(size) };
    FILTER_FIELDS.forEach((n) => {
      params[n] = filters[n] || '';
    });
    const doc = await fetchDoc(buildUrl(ctx, params));
    if (!doc.querySelector('table')) {
      log('Phản hồi không có bảng kết quả (không có hồ sơ nào, hoặc phiên đã hết hạn).', 'warn');
    }
    return parseRows(doc, location.href);
  }

  // Quét toàn bộ các trang kết quả của bộ lọc hiện tại trên trang, mỗi trang tối đa 200 bản ghi.
  // Không suy ra "hết dữ liệu" từ việc trang ngắn hơn 200 (máy chủ có thể giới hạn thấp hơn và
  // sẽ bỏ sót hồ sơ): chỉ dừng khi gặp trang trống hoặc trang không có dòng mới.
  async function collectRows(ctx, filters) {
    const rows = [];
    const seen = new Set();
    let size = PAGE_SIZE;
    for (let cur = 1; cur <= MAX_PAGES && !STATE.stop; cur++) {
      let page;
      try {
        page = await guarded(() => withRetry(() => searchPage(ctx, filters, cur, size)), ctx, filters);
      } catch (e) {
        if (cur !== 1 || size === FALLBACK_PAGE_SIZE || e instanceof SessionError) throw e;
        log(`Máy chủ không nhận ${size} bản ghi/trang (${e && e.message}) — dùng ${FALLBACK_PAGE_SIZE} bản ghi/trang.`, 'warn');
        size = FALLBACK_PAGE_SIZE;
        page = await guarded(() => withRetry(() => searchPage(ctx, filters, cur, size)), ctx, filters);
      }
      if (!page.length) break;
      let fresh = 0;
      page.forEach((r) => {
        const key = rowKey(r);
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(r);
          fresh++;
        }
      });
      progress({ phase: 'search', text: `Đang tìm hồ sơ... đã quét ${rows.length} dòng (trang ${cur})`, pct: 0 });
      if (!fresh) break;
    }
    return rows;
  }

  async function resolveFile(row, ctx) {
    const candidates = [];
    if (row.detailUrl) candidates.push(row.detailUrl);
    if (row.id) {
      candidates.push(
        buildUrl(ctx, { mvcRenderCommandName: 'soHoa', id: row.id, cmd: 'VIEWDETAIL' })
      );
    }
    let lastErr = null;
    for (const url of candidates) {
      try {
        const doc = await fetchDoc(url);
        const f = findFileUrl(doc, location.href);
        if (f) return f;
        lastErr = new Error('không thấy đường dẫn file trong trang chi tiết');
      } catch (e) {
        if (e instanceof SessionError) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error('hồ sơ không có mã để mở chi tiết');
  }

  async function downloadBytes(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) throw new SessionError('HTTP ' + res.status);
    if (res.redirected && isLoginUrl(res.url)) throw new SessionError('bị chuyển tới trang đăng nhập');
    if (!res.ok) throw new HttpError(res.status);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) {
      if (isLoginHtml(await res.text())) throw new SessionError('máy chủ trả màn hình đăng nhập');
      throw new HtmlError('máy chủ trả trang web thay vì file');
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    STATE.lastGoodUrl = url;
    return bytes;
  }

  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 120000);
  }

  function keepAwake(on) {
    try {
      chrome.runtime.sendMessage({ type: 'keep-tab-loaded', keep: !!on }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* bỏ qua */
    }
  }

  // ---- giữ phiên / phục hồi khi hết phiên ----------------------------------------
  function sleepCancelable(ms) {
    return new Promise((resolve) => {
      let left = ms;
      (function tick() {
        if (STATE.stop || left <= 0) return resolve();
        const step = Math.min(250, left);
        left -= step;
        setTimeout(tick, step);
      })();
    });
  }

  // Chạy mã trong thế giới của trang (content script không gọi được Liferay của trang).
  function pageWorld(code) {
    const el = document.createElement('script');
    el.textContent = code;
    document.documentElement.appendChild(el);
    el.remove();
  }

  function sessionGuardOn() {
    const ATTR = 'data-hatools-sess';
    try {
      pageWorld(
        'try{var S=window.Liferay&&window.Liferay.Session,d=document.documentElement;' +
          'if(S&&S.get&&S.set){window.__hatoolsSess={a:S.get("autoExtend"),r:S.get("redirectOnExpire")};' +
          'S.set("autoExtend",true);S.set("redirectOnExpire",false);d.setAttribute("' + ATTR + '","ok");}' +
          'else{d.setAttribute("' + ATTR + '","none");}}catch(e){document.documentElement.setAttribute("' + ATTR + '","err");}'
      );
      const v = document.documentElement.getAttribute(ATTR) || 'none';
      document.documentElement.removeAttribute(ATTR);
      return v;
    } catch (e) {
      return 'err';
    }
  }

  function sessionGuardOff() {
    try {
      pageWorld(
        'try{var S=window.Liferay&&window.Liferay.Session,o=window.__hatoolsSess;' +
          'if(S&&o){S.set("autoExtend",o.a);S.set("redirectOnExpire",o.r);}window.__hatoolsSess=null;}catch(e){}'
      );
    } catch (e) {
      /* bỏ qua */
    }
  }

  // Gia hạn phiên như chính trang vẫn làm khi người dùng thao tác.
  function keepAliveOnce() {
    try {
      pageWorld('try{var S=window.Liferay&&window.Liferay.Session;if(S&&S.extend)S.extend();}catch(e){}');
    } catch (e) {
      /* bỏ qua */
    }
    try {
      fetch(location.origin + '/c/portal/extend_session', { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
    } catch (e) {
      /* bỏ qua */
    }
  }

  // Thăm dò phiên còn hợp lệ không: ưu tiên tải lại file đã từng tải thành công (chỉ đọc phần đầu).
  async function probeSession(ctx, filters) {
    try {
      if (STATE.lastGoodUrl) {
        const ac = new AbortController();
        const res = await fetch(STATE.lastGoodUrl, { credentials: 'same-origin', signal: ac.signal });
        const type = (res.headers.get('content-type') || '').toLowerCase();
        const good = res.ok && !type.includes('text/html') && !(res.redirected && isLoginUrl(res.url));
        ac.abort();
        return good;
      }
      await searchPage(ctx, filters, 1, 1);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Tạm dừng toàn bộ công việc, thăm dò định kỳ và tự chạy tiếp khi phiên hợp lệ trở lại.
  function waitForSession(ctx, filters, why) {
    if (!STATE.sessionWait) {
      STATE.sessionWait = (async () => {
        log(
          `Phiên đăng nhập có vẻ đã hết hạn (${why}). Tạm dừng — hãy đăng nhập lại (ở tab khác hoặc ngay trang này); tool tự chạy tiếp khi phiên hợp lệ.`,
          'warn'
        );
        progress({ text: 'Tạm dừng — chờ đăng nhập lại...' });
        const t0 = Date.now();
        while (!STATE.stop) {
          await sleepCancelable(CFG.sessionPollMs);
          if (STATE.stop) break;
          if (await probeSession(ctx, filters)) {
            log(`Phiên hợp lệ trở lại sau ${Math.round((Date.now() - t0) / 1000)} giây — tiếp tục.`, 'ok');
            break;
          }
        }
        STATE.sessionWait = null;
      })();
    }
    return STATE.sessionWait;
  }

  // Chạy fn; nếu hết phiên thì chờ đăng nhập lại rồi chạy lại đúng việc đó. Với HtmlError (đã thử
  // lại hết lượt): phiên hỏng thì chờ rồi làm lại; phiên vẫn tốt thì đó là lỗi riêng của file này.
  async function guarded(fn, ctx, filters) {
    let pauses = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (STATE.stop) throw e;
        let why = e && e.message;
        if (e instanceof HtmlError) {
          if (await probeSession(ctx, filters)) throw e;
          why = 'file trả về trang web và phiên không còn hợp lệ';
        } else if (!(e instanceof SessionError)) {
          throw e;
        }
        // Đã chờ đăng nhập lại mà việc này vẫn lỗi phiên: coi là lỗi riêng, tránh tạm dừng lặp vô hạn.
        if (pauses >= MAX_PAUSES_PER_JOB) throw new Error('vẫn lỗi phiên sau khi đã chờ đăng nhập lại (' + why + ')');
        pauses++;
        await waitForSession(ctx, filters, why);
        if (STATE.stop) throw e;
      }
    }
  }

  // Thử lại có chờ với lỗi tạm thời (mạng, 5xx, 429). Mất mạng/chuyển hướng bất thường kéo dài
  // được coi như hết phiên để tạm dừng chờ thay vì ghi lỗi hàng loạt.
  async function withRetry(fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof SessionError || STATE.stop) throw e;
        const net = e instanceof TypeError;
        const transient = net || e instanceof HtmlError || (e instanceof HttpError && (e.status >= 500 || e.status === 429));
        if (!transient) throw e;
        if (attempt >= RETRIES) {
          if (net) throw new SessionError('mất kết nối hoặc bị chuyển hướng bất thường');
          throw e;
        }
        await sleepCancelable(CFG.retryBaseMs * attempt);
      }
    }
  }

  // ---- lưu tiến độ để tiếp tục lần sau ---------------------------------------
  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (o) => resolve((chrome.runtime.lastError ? {} : o) || {}));
      } catch (e) {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve(!chrome.runtime.lastError));
      } catch (e) {
        resolve(false);
      }
    });
  }
  async function loadDone(key) {
    const all = (await storageGet(STORE_KEY))[STORE_KEY] || {};
    const e = all[key];
    return new Set(e && Array.isArray(e.keys) ? e.keys : []);
  }
  async function saveDone(key, set) {
    const all = (await storageGet(STORE_KEY))[STORE_KEY] || {};
    all[key] = { keys: Array.from(set), t: Date.now() };
    Object.keys(all)
      .sort((a, b) => all[b].t - all[a].t)
      .slice(STORE_MAX_RUNS)
      .forEach((k) => delete all[k]);
    return storageSet({ [STORE_KEY]: all });
  }
  async function clearDone(key) {
    const all = (await storageGet(STORE_KEY))[STORE_KEY] || {};
    if (key in all) {
      delete all[key];
      await storageSet({ [STORE_KEY]: all });
    }
  }

  // ---- luồng chính ----------------------------------------------------------
  function validate(filters, term, ctx) {
    if (!ctx) return 'Không tìm thấy bảng hồ sơ đã số hóa trên trang này.';
    if (!/^-?\d+$/.test(filters.srdonViHanhChinhId)) return 'Đơn vị đang chọn trên trang không hợp lệ.';
    if (!hasAnyFilter(filters, term)) {
      return 'Hãy chọn đơn vị/khoảng ngày trên trang (hoặc nhập tên file) trước khi tải, để tránh tải toàn bộ dữ liệu.';
    }
    return '';
  }

  async function run(opts, ctx) {
    const delay = Math.max(0, Math.min(10000, (Number(opts.delaySec) || DEFAULT_DELAY_MS / 1000) * 1000));
    const filters = opts.filters;
    const term = String(opts.name || '').trim();
    const key = runKey(filters, term);
    const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

    setRunning(true);
    keepAwake(true);
    STATE.stop = false;
    STATE.sessionWait = null;
    STATE.lastGoodUrl = '';
    STATE.logs.length = 0;
    emit({ kind: 'clear' });
    progress({ phase: 'search', text: 'Đang tìm hồ sơ...', pct: 0, ok: 0, err: 0, total: 0 });

    const guard = sessionGuardOn();
    log(
      guard === 'ok'
        ? 'Giữ phiên: đã bật tự gia hạn phiên của trang và gia hạn định kỳ.'
        : 'Giữ phiên: không thấy Liferay.Session trên trang — chỉ gia hạn định kỳ bằng request.',
      'info'
    );
    keepAliveOnce();
    const keepTimer = setInterval(() => {
      if (!STATE.sessionWait) keepAliveOnce();
    }, CFG.keepAliveMs);

    const done = new Set(); // khóa các file đã được LƯU vào ZIP (đã giao cho trình duyệt)
    let zip = new HaZipStore.ZipStore();
    let pendingKeys = []; // file đã tải nhưng ZIP chứa chúng chưa được lưu
    let partNo = 0;
    let ok = 0;
    let err = 0;
    let total = 0;
    let fatal = false;
    let completed = false;

    // Lưu phần ZIP hiện tại; chỉ sau khi lưu mới ghi nhận "đã xong" để lần sau không tải lại.
    const flushZip = async (final) => {
      if (!zip.count) return;
      const z = zip;
      const keys = pendingKeys;
      zip = new HaZipStore.ZipStore();
      pendingKeys = [];
      const n = ++partNo;
      const name = `TaiFileSoHoa_${tag}${final && n === 1 ? '' : '_p' + String(n).padStart(2, '0')}.zip`;
      saveBlob(z.finish(), name);
      keys.forEach((k) => done.add(k));
      log(`Đã lưu ${name} (${z.count} file).`, 'ok');
      if (!(await saveDone(key, done))) log('Cảnh báo: không ghi nhớ được tiến độ để tiếp tục lần sau.', 'warn');
    };

    try {
      const f = filters;
      log(
        `Bộ lọc trên trang: đơn vị="${f.unitLabel || 'tất cả'}", từ ${f.srtuNgay || '—'} đến ${f.srdenNgay || '—'}` +
          `${f.srmaFile ? ', mã file=' + f.srmaFile : ''}${f.srmaHoSo ? ', mã hồ sơ=' + f.srmaHoSo : ''}` +
          `${f.srsoDinhDanh ? ', số định danh=' + f.srsoDinhDanh : ''}${f.srchuHoSo ? ', chủ hồ sơ=' + f.srchuHoSo : ''}; ` +
          `tên file="${term || '(tất cả)'}".`
      );
      const all = await collectRows(ctx, f);
      const rows = all.filter((r) => matchName(r, term));
      log(`Tìm thấy ${all.length} dòng, khớp tên file: ${rows.length}.`, rows.length ? 'ok' : 'warn');
      if (!rows.length) return;

      if (opts.resume) (await loadDone(key)).forEach((k) => done.add(k));
      else await clearDone(key);
      const todo = rows.filter((r) => !done.has(rowKey(r)));
      if (opts.resume && todo.length < rows.length) {
        log(`Tiếp tục từ lần trước: bỏ qua ${rows.length - todo.length} file đã lưu, còn ${todo.length} file cần tải.`, 'info');
      }
      if (!todo.length) {
        log('Tất cả file khớp đều đã được lưu ở lần trước. Bỏ chọn "Tiếp tục từ lần trước" nếu muốn tải lại.', 'ok');
        progress({ phase: 'done', text: 'Xong: không còn file mới', pct: 100 });
        return;
      }
      total = todo.length;

      const used = new Set();
      let idx = 0;
      progress({ phase: 'download', text: `Đang tải 0/${total}`, pct: 0, total });

      const fetchRow = async (row) => {
        const file = await resolveFile(row, ctx);
        return { file, bytes: await downloadBytes(file.url) };
      };
      const worker = async () => {
        while (!STATE.stop) {
          const i = idx++;
          if (i >= todo.length) return;
          const row = todo[i];
          const label = `${row.maHoSo} · ${row.maFile}`;
          try {
            const { file, bytes } = await guarded(() => withRetry(() => fetchRow(row)), ctx, f);
            zip.add(uniqueName(used, buildEntryName(row, file.name)), bytes);
            pendingKeys.push(rowKey(row));
            ok++;
            log(`✓ ${label} (${Math.round(bytes.length / 1024)} KB)`, 'ok');
            if (zip.size >= CFG.partBytes || zip.count >= CFG.partFiles) await flushZip(false);
          } catch (e) {
            if (STATE.stop && (e instanceof SessionError || e instanceof HtmlError)) return; // dừng khi đang chờ phiên: file này chưa tải
            err++;
            log(`✗ ${label}: ${e && e.message ? e.message : e}`, 'err');
          }
          const n = ok + err;
          progress({ text: `Đang tải ${n}/${total}`, pct: Math.round((n / total) * 100), ok, err });
          if (delay) await sleepMs(delay);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

      if (STATE.stop) log('Đã dừng theo yêu cầu — lưu các file đã tải được.', 'warn');
      completed = !STATE.stop && err === 0;
    } catch (e) {
      fatal = true;
      if (STATE.stop && e instanceof SessionError) log('Đã dừng khi đang chờ đăng nhập lại.', 'warn');
      else log('Lỗi: ' + (e && e.message ? e.message : e), 'err');
      progress({ phase: 'error', text: 'Có lỗi xảy ra — xem nhật ký.' });
    } finally {
      // Luôn lưu phần đang dở (kể cả khi dừng/lỗi) để không mất những gì đã tải.
      try {
        await flushZip(true);
        if (completed) {
          await clearDone(key);
          log('Hoàn tất toàn bộ — đã xóa trạng thái "tiếp tục".', 'info');
        } else if (total && ok) {
          log('Chưa hoàn tất — lần chạy sau (giữ chọn "Tiếp tục từ lần trước") sẽ bỏ qua các file đã lưu.', 'info');
        }
      } catch (e) {
        log('Lỗi khi lưu ZIP: ' + (e && e.message ? e.message : e), 'err');
      }
      if (total && !fatal) {
        log(`Kết thúc: ${ok} file thành công, ${err} lỗi.`, err ? 'warn' : 'ok');
        progress({ phase: 'done', text: `Xong: ${ok} file · ${err} lỗi`, pct: STATE.stop ? STATE.prog.pct : 100, ok, err });
      }
      clearInterval(keepTimer);
      sessionGuardOff();
      keepAwake(false);
      setRunning(false);
    }
  }

  function start(msg) {
    if (STATE.running) return { ok: false, error: 'Đang chạy, hãy dừng hoặc chờ hoàn tất.' };
    const ctx = getContext();
    const term = String(msg.name || '');
    const filters = ctx ? readFilters(ctx) : null;
    const problem = validate(filters, term, ctx);
    if (problem) return { ok: false, error: problem };
    run({ filters, name: term, delaySec: msg.delaySec, resume: msg.resume !== false }, ctx);
    return { ok: true };
  }

  function hello() {
    const ctx = getContext();
    return {
      custom: 'taisohoa',
      taskTitle: 'Tải File Số Hóa',
      ready: !!ctx,
      state: Object.assign({ running: STATE.running }, STATE.prog),
      logs: STATE.logs,
    };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.ns !== 'sp') return false;
      if (msg.cmd === 'hello') sendResponse(hello());
      else if (msg.cmd === 'dl-start') sendResponse(start(msg));
      else if (msg.cmd === 'dl-stop') {
        STATE.stop = true;
        sendResponse({ ok: true });
      } else return false;
      return false;
    });
  }

  // Xuất hàm thuần để kiểm thử bằng Node (không ảnh hưởng khi chạy trong trình duyệt).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      fold, matchName, sanitizeName, fileNameFromUrl, uniqueName, buildEntryName, parseRows,
      findFileUrl, buildUrl, getContext, readFilters, hasAnyFilter, validate,
      CFG, isLoginUrl, isLoginHtml, runKey, rowKey,
    };
  }
})();
