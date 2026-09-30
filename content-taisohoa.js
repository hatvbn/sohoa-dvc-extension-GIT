// Chức năng "Tải File Số Hóa": tìm hồ sơ đã số hóa theo đơn vị / tên file / khoảng ngày rồi
// tải toàn bộ file PDF gộp vào ZIP. Chạy trên trang "Hồ sơ đã số hóa", dùng phiên đăng nhập
// sẵn có của người dùng (fetch cùng origin). Điều khiển từ side panel qua ns 'sp'.
(function () {
  'use strict';

  const TABLE_SUFFIX = 'tblSoHoa';
  const UNIT_SELECT_SUFFIX = 'srdonViHanhChinhId';
  const PAGE_SIZE = 20; // server trả tối đa 20 dòng/trang (đã kiểm chứng delta=20)
  const MAX_PAGES = 1000;
  const CONCURRENCY = 3;
  const DEFAULT_DELAY_MS = 200;
  const MAX_PART_BYTES = 1000 * 1024 * 1024; // tách ZIP khi vượt ~1 GB (không dùng ZIP64)
  const MAX_PART_FILES = 5000;
  const LOG_MAX = 500;
  const MIN_CELLS = 20;
  // Chỉ số cột trong bảng (theo tiêu đề thực tế của trang).
  const COL = { soDinhDanh: 1, chuHoSo: 2, maHoSo: 3, maFile: 4, giayTo: 5, ngayYeuCau: 19 };
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

  // "15/01/2026" hoặc "15/01/2026 14:30:23" -> Date (00:00 giờ địa phương) hoặc null.
  function parseDmy(str) {
    const m = String(str || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  // 'yyyy-MM-dd' (input type=date) -> Date hoặc null.
  function parseIso(str) {
    const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(iso, fmt) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    return fmt === 'iso' ? iso : m[3] + '/' + m[2] + '/' + m[1];
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
        ngayYeuCau: cellText(cells[COL.ngayYeuCau]),
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

  function outOfRange(rows, from, to) {
    return rows.some((r) => {
      const d = parseDmy(r.ngayYeuCau);
      if (!d) return false;
      return (from && d < from) || (to && d > to);
    });
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

  function listUnits(ctx) {
    if (!ctx || !ctx.select) return [];
    return Array.from(ctx.select.options)
      .filter((o) => o.value && o.value !== '-1')
      .map((o) => {
        const label = o.textContent.replace(/\s+/g, ' ').trim();
        return { value: o.value, label: label.replace(/^-+\s*/, ''), depth: /^-/.test(label) ? 1 : 0 };
      });
  }

  // ---- mạng -------------------------------------------------------------------
  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function searchPage(ctx, opts, cur, fmt) {
    const doc = await fetchDoc(
      buildUrl(ctx, {
        mvcRenderCommandName: 'daSoHoa',
        cmd: 'SEARCH',
        srsoDinhDanh: '',
        srchuHoSo: '',
        srmaHoSo: '',
        srmaFile: '',
        srdonViHanhChinhId: opts.unit || '-1',
        srtuNgay: formatDate(opts.from, fmt),
        srdenNgay: formatDate(opts.to, fmt),
        cur: String(cur),
        delta: String(PAGE_SIZE),
      })
    );
    return parseRows(doc, location.href);
  }

  // Quét các trang kết quả với một định dạng ngày. bad=true nếu gặp hồ sơ có "Ngày yêu cầu"
  // ngoài khoảng đã chọn (dấu hiệu máy chủ không hiểu định dạng ngày). stopOnBad: dừng sớm.
  async function collectRows(ctx, opts, fmt, stopOnBad) {
    const from = parseIso(opts.from);
    const to = parseIso(opts.to);
    const rows = [];
    const seen = new Set();
    let bad = false;

    for (let cur = 1; cur <= MAX_PAGES && !STATE.stop; cur++) {
      const page = await searchPage(ctx, opts, cur, fmt);
      if (!page.length) break;
      if ((from || to) && outOfRange(page, from, to)) {
        bad = true;
        if (stopOnBad) break;
      }
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
      if (!fresh || page.length < PAGE_SIZE) break;
    }
    return { rows, bad };
  }

  // Thử dd/MM/yyyy trước; nếu kết quả lệch khoảng ngày thì thử yyyy-MM-dd; nếu cả hai đều
  // lệch thì cảnh báo và dùng dd/MM/yyyy (máy chủ có thể lọc theo mốc thời gian khác).
  async function collectWithDateFormat(ctx, opts) {
    const first = await collectRows(ctx, opts, 'dmy', true);
    if (!first.bad) return first.rows;
    log('Kết quả lệch khoảng ngày với định dạng dd/MM/yyyy — thử định dạng yyyy-MM-dd...', 'warn');
    const second = await collectRows(ctx, opts, 'iso', true);
    if (!second.bad) {
      log('Máy chủ dùng định dạng ngày yyyy-MM-dd.', 'warn');
      return second.rows;
    }
    log(
      'Cảnh báo: có hồ sơ có "Ngày yêu cầu" nằm ngoài khoảng ngày đã chọn ở cả hai định dạng — kiểm tra lại bộ lọc ngày (có thể máy chủ lọc theo mốc thời gian khác).',
      'warn'
    );
    return (await collectRows(ctx, opts, 'dmy', false)).rows;
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
  function validate(opts, ctx) {
    if (!ctx) return 'Không tìm thấy bảng hồ sơ đã số hóa trên trang này.';
    const from = parseIso(opts.from);
    const to = parseIso(opts.to);
    if (opts.from && !from) return 'Ngày bắt đầu không hợp lệ.';
    if (opts.to && !to) return 'Ngày kết thúc không hợp lệ.';
    if (from && to && from > to) return '"Từ ngày" phải nhỏ hơn hoặc bằng "Đến ngày".';
    if (opts.unit && !/^-?\d+$/.test(String(opts.unit))) return 'Đơn vị không hợp lệ.';
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
      log(
        `Bắt đầu: đơn vị=${opts.unit && opts.unit !== '-1' ? opts.unit : 'tất cả'}, tên file="${term || '(tất cả)'}", ` +
          `từ ${opts.from || '—'} đến ${opts.to || '—'}.`
      );
      const all = await collectWithDateFormat(ctx, opts);
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
      const tag = (opts.from || 'all').replace(/-/g, '') + '_' + (opts.to || 'all').replace(/-/g, '');
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
    const opts = {
      unit: String(msg.unit || '-1'),
      name: String(msg.name || ''),
      from: String(msg.from || ''),
      to: String(msg.to || ''),
      delaySec: msg.delaySec,
    };
    const problem = validate(opts, ctx);
    if (problem) return { ok: false, error: problem };
    run(opts, ctx);
    return { ok: true };
  }

  function hello() {
    const ctx = getContext();
    return {
      custom: 'taisohoa',
      taskTitle: 'Tải File Số Hóa',
      ready: !!ctx,
      units: listUnits(ctx),
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
      fold, matchName, parseDmy, parseIso, formatDate, sanitizeName, fileNameFromUrl,
      uniqueName, buildEntryName, parseRows, findFileUrl, outOfRange, buildUrl, getContext, listUnits, validate,
    };
  }
})();
