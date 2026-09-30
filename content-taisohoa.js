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
  const MAX_PART_BYTES = 1000 * 1024 * 1024; // tách ZIP khi vượt ~1 GB (không dùng ZIP64)
  const MAX_PART_FILES = 5000;
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
  };

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
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function searchPage(ctx, filters, cur, size) {
    const params = { mvcRenderCommandName: 'daSoHoa', cmd: 'SEARCH', cur: String(cur), delta: String(size) };
    FILTER_FIELDS.forEach((n) => {
      params[n] = filters[n] || '';
    });
    return parseRows(await fetchDoc(buildUrl(ctx, params)), location.href);
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
        page = await searchPage(ctx, filters, cur, size);
      } catch (e) {
        if (cur !== 1 || size === FALLBACK_PAGE_SIZE) throw e;
        log(`Máy chủ không nhận ${size} bản ghi/trang (${e && e.message}) — dùng ${FALLBACK_PAGE_SIZE} bản ghi/trang.`, 'warn');
        size = FALLBACK_PAGE_SIZE;
        page = await searchPage(ctx, filters, cur, size);
      }
      if (!page.length) break;
      let fresh = 0;
      page.forEach((r) => {
        const key = r.id || r.maHoSo + '|' + r.maFile;
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
        lastErr = e;
      }
    }
    throw lastErr || new Error('hồ sơ không có mã để mở chi tiết');
  }

  async function downloadBytes(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('text/html')) throw new Error('máy chủ trả trang web thay vì file (phiên đăng nhập hết hạn?)');
    return new Uint8Array(await res.arrayBuffer());
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
    setRunning(true);
    keepAwake(true);
    STATE.stop = false;
    STATE.logs.length = 0;
    emit({ kind: 'clear' });
    progress({ phase: 'search', text: 'Đang tìm hồ sơ...', pct: 0, ok: 0, err: 0, total: 0 });

    try {
      const term = String(opts.name || '').trim();
      const f = opts.filters;
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

      const zips = [];
      let zip = new HaZipStore.ZipStore();
      const used = new Set();
      let ok = 0;
      let err = 0;
      let idx = 0;

      progress({ phase: 'download', text: `Đang tải 0/${rows.length}`, pct: 0, total: rows.length });

      const worker = async () => {
        while (!STATE.stop) {
          const i = idx++;
          if (i >= rows.length) return;
          const row = rows[i];
          const label = `${row.maHoSo} · ${row.maFile}`;
          try {
            const f = await resolveFile(row, ctx);
            const bytes = await downloadBytes(f.url);
            const path = uniqueName(used, buildEntryName(row, f.name));
            zip.add(path, bytes);
            ok++;
            log(`✓ ${label} (${Math.round(bytes.length / 1024)} KB)`, 'ok');
            if (zip.size >= MAX_PART_BYTES || zip.count >= MAX_PART_FILES) {
              zips.push(zip);
              zip = new HaZipStore.ZipStore();
            }
          } catch (e) {
            err++;
            log(`✗ ${label}: ${e && e.message ? e.message : e}`, 'err');
          }
          const done = ok + err;
          progress({ text: `Đang tải ${done}/${rows.length}`, pct: Math.round((done / rows.length) * 100), ok, err });
          if (delay) await sleepMs(delay);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

      if (zip.count) zips.push(zip);
      if (STATE.stop) log('Đã dừng theo yêu cầu — đóng gói các file đã tải được.', 'warn');
      if (!zips.length) {
        log('Không có file nào tải được để đóng gói.', 'err');
        return;
      }
      const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
      for (let p = 0; p < zips.length; p++) {
        const name = `TaiFileSoHoa_${tag}${zips.length > 1 ? '_p' + (p + 1) : ''}.zip`;
        saveBlob(zips[p].finish(), name);
        log(`Đã tạo ${name} (${zips[p].count} file).`, 'ok');
        if (p < zips.length - 1) await sleepMs(800);
      }
      log(`Hoàn tất: ${ok} file thành công, ${err} lỗi.`, err ? 'warn' : 'ok');
      progress({ phase: 'done', text: `Xong: ${ok} file · ${err} lỗi`, pct: 100, ok, err });
    } catch (e) {
      log('Lỗi: ' + (e && e.message ? e.message : e), 'err');
      progress({ phase: 'error', text: 'Có lỗi xảy ra — xem nhật ký.' });
    } finally {
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
    run({ filters, name: term, delaySec: msg.delaySec }, ctx);
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
    };
  }
})();
