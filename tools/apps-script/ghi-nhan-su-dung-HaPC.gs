/**
 * HaTools - Ghi nhận lượt sử dụng, MỖI CÔNG CỤ MỘT TRANG (tab) trong cùng file Sheet.
 *
 *   congCu = "HaTools DVCBacNinh" → trang "HaTools DVCBacNinh"
 *   congCu = "HaTools MPLiS"      → trang "HaTools MPLiS"
 *   payload không có congCu       → trang mặc định (TRANG_MAC_DINH, mặc định là trang đầu)
 *
 * Trang chưa có thì tự tạo; trường mới thì tự thêm cột ở cuối, không đụng cột cũ.
 * Tiêu đề cột hiển thị tiếng Việt theo bảng NHAN; trường lạ giữ nguyên tên khoá.
 *
 * TRIỂN KHAI LẠI MÀ GIỮ NGUYÊN ĐƯỜNG LINK /exec:
 *   Triển khai → Quản lý các lần triển khai → ✏ Chỉnh sửa → Phiên bản: "Phiên bản mới" → Triển khai.
 *   KHÔNG bấm "Lần triển khai mới" — đường link sẽ đổi và cả hai tool đều gửi hụt.
 */

// Trang cho dữ liệu KHÔNG ghi rõ công cụ. Để trống = trang đầu tiên của file.
const TRANG_MAC_DINH = '';

// Nhãn cột tiếng Việt (khoá payload -> tiêu đề hiển thị). Trường không có ở đây giữ nguyên tên khoá.
const NHAN = {
  nhanLuc: 'Nhận lúc',
  thoiDiem: 'Thời điểm',
  congCu: 'Công cụ',
  loai: 'Loại',
  chucNang: 'Chức năng',
  taiKhoan: 'Tài khoản',
  hoTen: 'Họ tên',
  userId: 'Mã người dùng',
  donVi: 'Đơn vị',
  id: 'Mã máy',
  phienBan: 'Phiên bản',
  heDieuHanh: 'Hệ điều hành',
  thanhCong: 'Thành công',
  boQua: 'Bỏ qua',
  loi: 'Lỗi',
  thoiLuongGiay: 'Thời lượng (giây)',
  kySo: 'Ký số',
};

// Thứ tự cột ưu tiên; khoá ngoài danh sách xếp sau, theo thứ tự xuất hiện trong payload.
const THU_TU = ['nhanLuc', 'thoiDiem', 'congCu', 'loai', 'chucNang', 'taiKhoan', 'hoTen',
  'userId', 'donVi', 'id', 'phienBan', 'heDieuHanh', 'thanhCong', 'boQua', 'loi',
  'thoiLuongGiay', 'kySo'];

function doPost(e) {
  const khoa = LockService.getScriptLock();
  khoa.waitLock(10000);
  try {
    const duLieu = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (duLieu.hanhDong === 'capNhatPhienBan') return capNhatPhienBan(duLieu);
    if (duLieu.hanhDong === 'dangKyKhoa') return dangKyKhoa(duLieu);
    duLieu.nhanLuc = new Date();
    // thoiDiem gửi lên dạng chuỗi ISO -> đổi thành Date để hiển thị đẹp và
    // nhất quán với dữ liệu cũ (cột này vốn kiểu ngày giờ).
    if (duLieu.thoiDiem) {
      const d = new Date(duLieu.thoiDiem);
      if (!isNaN(d.getTime())) duLieu.thoiDiem = d;
    }
    const trang = chonTrang(SpreadsheetApp.getActiveSpreadsheet(), duLieu.congCu);

    // Khoá của các cột đang có (suy từ tiêu đề tiếng Việt về khoá).
    const soCot = trang.getLastColumn();
    let cotKey = soCot > 0 ? khoaTuTieuDe(trang.getRange(1, 1, 1, soCot).getValues()[0]) : [];

    // Thêm cột cho khoá mới: ưu tiên theo THU_TU, rồi tới khoá lạ.
    const khoaHang = Object.keys(duLieu);
    THU_TU.concat(khoaHang).forEach(function (k) {
      if (khoaHang.indexOf(k) >= 0 && cotKey.indexOf(k) < 0) cotKey.push(k);
    });

    // Ghi lại hàng tiêu đề (nhãn tiếng Việt).
    trang.getRange(1, 1, 1, cotKey.length)
      .setValues([cotKey.map(function (k) { return NHAN[k] || k; })]);

    const dong = cotKey.map(function (k) {
      return duLieu[k] !== undefined && duLieu[k] !== null ? duLieu[k] : '';
    });
    trang.appendRow(dong);

    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('loi: ' + err.message);
  } finally {
    khoa.releaseLock();
  }
}

// Đổi hàng tiêu đề (nhãn tiếng Việt) về danh sách khoá payload.
// Nhãn có trong bảng NHAN thì đổi ngược; ô lạ giữ nguyên chữ để không mất cột cũ.
function khoaTuTieuDe(tieuDe) {
  const nguoc = {};
  Object.keys(NHAN).forEach(function (k) { nguoc[NHAN[k]] = k; });
  return tieuDe.map(function (t) { return nguoc[t] || t; });
}

function chonTrang(bang, congCu) {
  const ten = tenTrangHopLe(congCu);
  if (!ten) {
    return (TRANG_MAC_DINH && bang.getSheetByName(TRANG_MAC_DINH)) || bang.getSheets()[0];
  }
  return bang.getSheetByName(ten) || bang.insertSheet(ten);
}

// Tên trang Google Sheet: tối đa 100 ký tự, không chứa [ ] : * ? / \
function tenTrangHopLe(congCu) {
  if (!congCu) return '';
  return String(congCu).replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// ---------------------------------------------------------------------------
// Tra ve phien ban moi nhat cho extension kiem tra (doc tu trang "CapNhat").
// MOI CONG CU MOT DONG — hai cong cu dung chung script nay nhung phien ban khac nhau.
//
//   Cot A = so phien ban moi nhat (vd 1.7.0)
//   Cot B = link tai (OneDrive/Drive...)
//   Cot C = ghi chu (tuy chon)
//   Cot D = ten cong cu, trung dung gia tri congCu extension gui len
//
//   Goi KHONG kem congCu  -> tra dong 2 (HaTools DVCBacNinh), giu nguyen nhu truoc.
//                            D2 PHAI de trong, neu khong se doc nham dong.
//   Goi kem ?congCu=...   -> tim dong co cot D trung ten, tra kem truong congCu
//                            de extension biet chac phan hoi dung la cua minh.
function doGet(e) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CapNhat');
    var congCu = e && e.parameter && e.parameter.congCu ? String(e.parameter.congCu).trim() : '';
    var out = { phienBan: '', link: '', ghiChu: '', thongBao: '' };
    if (sh) {
      var dong = 2;
      if (congCu) {
        dong = 0;
        var cot = sh.getRange('D2:D' + Math.max(sh.getLastRow(), 2)).getValues();
        for (var i = 0; i < cot.length; i++) {
          if (String(cot[i][0]).trim() === congCu) { dong = i + 2; break; }
        }
        out.congCu = congCu;
        // Cho phat-hanh.ps1 biet ban trien khai nay da co capNhatPhienBan, truoc khi gui khoa.
        // Ban cu se ghi nguyen yeu cau (ca khoa) vao trang thong ke su dung.
        out.coPhatHanh = true;
      }
      if (dong) {
        out.phienBan = String(sh.getRange('A' + dong).getValue() || '').trim();
        out.link = String(sh.getRange('B' + dong).getValue() || '').trim();
        out.ghiChu = String(sh.getRange('C' + dong).getValue() || '').trim();
        // Cot E = thong bao chung, hien tren app cho moi nguoi dang dung (moi phien ban).
        out.thongBao = String(sh.getRange('E' + dong).getValue() || '').trim();
      }
    }
    return ContentService.createTextOutput(JSON.stringify(out))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ loi: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ---------------------------------------------------------------------------
// Ghi phien ban moi len trang "CapNhat" khi PHAT HANH (goi tu phat-hanh.ps1 tren may tac gia).
//
//   Bat buoc kem khoa trung Script Properties cua RIENG cong cu do (Cai dat du an → Thuoc tinh tap lenh):
//     "HaTools MPLiS"      -> KHOA_PHAT_HANH_HATOOLS_MPLIS
//     "HaTools DVCBacNinh" -> KHOA_PHAT_HANH_HATOOLS_DVCBACNINH
//   Chua cai khoa thi tu choi tat ca. Doi khoa o do la khoa cu het tac dung.
//   Chi ghi cot A (phien ban) va C (ghi chu). KHONG ghi cot B: link tai co dinh, khong ai doi duoc qua day.
//   Khong ghi gi vao trang thong ke su dung, nen khoa khong bao gio lot vao Sheet.
function capNhatPhienBan(duLieu) {
  const tra = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  };

  const congCu = String(duLieu.congCu || '').trim();
  const phienBan = String(duLieu.phienBan || '').trim();
  if (!congCu) return tra({ ok: false, loi: 'Thiếu tên công cụ.' });

  const tenKhoa = tenThuocTinhKhoa(congCu);
  const khoaDung = PropertiesService.getScriptProperties().getProperty(tenKhoa) || '';
  if (khoaDung.length < 32) {
    return tra({ ok: false, loi: 'Máy chủ chưa cài khoá phát hành: thiếu thuộc tính ' + tenKhoa + '.' });
  }
  if (!khopKhoa(String(duLieu.khoa || ''), khoaDung)) {
    return tra({ ok: false, loi: 'Khoá phát hành không đúng (' + tenKhoa + ').' });
  }
  if (!/^\d+(\.\d+){1,3}$/.test(phienBan)) {
    return tra({ ok: false, loi: 'Số phiên bản không hợp lệ: ' + phienBan });
  }

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CapNhat');
  if (!sh) return tra({ ok: false, loi: 'Chưa có trang CapNhat.' });

  let dong = 0;
  const cot = sh.getRange('D2:D' + Math.max(sh.getLastRow(), 2)).getValues();
  for (let i = 0; i < cot.length; i++) {
    if (String(cot[i][0]).trim() === congCu) { dong = i + 2; break; }
  }
  if (!dong) return tra({ ok: false, loi: 'Cột D của trang CapNhat chưa có dòng "' + congCu + '".' });

  const phienBanCu = String(sh.getRange('A' + dong).getValue() || '').trim();
  if (phienBanCu && soSanhPhienBan(phienBan, phienBanCu) < 0) {
    return tra({ ok: false, loi: 'Không hạ phiên bản: trên Sheet đang là ' + phienBanCu + '.' });
  }

  // Dinh dang van ban truoc khi ghi: "1.10" se khong bi Sheet doi thanh so 1.1.
  sh.getRange('A' + dong).setNumberFormat('@').setValue(phienBan);
  // Ghi chu bat dau bang = + - @ se bi Sheet hieu la cong thuc: them dau nhay de giu la chu.
  let ghiChu = String(duLieu.ghiChu || '').trim().slice(0, 500);
  if (/^[=+\-@]/.test(ghiChu)) ghiChu = "'" + ghiChu;
  sh.getRange('C' + dong).setValue(ghiChu);
  SpreadsheetApp.flush();

  return tra({ ok: true, congCu: congCu, dong: dong, phienBanCu: phienBanCu, phienBan: phienBan });
}

// MOI CONG CU MOT KHOA RIENG. Truoc day dung chung ten "KHOA_PHAT_HANH" nen cong cu nao luu
// sau se de len khoa cua cong cu kia, va ben bi de mat quyen phat hanh.
//   "HaTools MPLiS" -> KHOA_PHAT_HANH_HATOOLS_MPLIS
function tenThuocTinhKhoa(congCu) {
  return 'KHOA_PHAT_HANH_' + String(congCu).toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// So khoa het chuoi (khong dung o ky tu sai dau tien) de khong do duoc khoa qua thoi gian tra loi.
function khopKhoa(a, b) {
  if (a.length !== b.length) return false;
  let khac = 0;
  for (let i = 0; i < a.length; i++) khac |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return khac === 0;
}

// -1 neu a < b, 0 neu bang, 1 neu a > b.
function soSanhPhienBan(a, b) {
  const x = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
  const y = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Dang ky khoa phat hanh cho MOT cong cu, goi tu phat-hanh.ps1 tren may tac gia.
// De khong ai phai go tay khoa vao o Thuoc tinh tap lenh.
//
//   - Chi dat duoc khi cong cu do CHUA co khoa. Muon doi khoa thi xoa thuoc tinh
//     trong Apps Script roi dang ky lai, nen khong the chiem khoa cua cong cu dang chay.
//   - Phai kem "khoaUyQuyen" trung khoa cua MOT cong cu da dang ky truoc do. Nguoi
//     ngoai biet duong link /exec nhung khong co khoa nao thi khong dang ky duoc.
function dangKyKhoa(duLieu) {
  const tra = function (obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
  };

  const congCu = String(duLieu.congCu || '').trim();
  if (!congCu) return tra({ ok: false, loi: 'Thiếu tên công cụ.' });
  const tenKhoa = tenThuocTinhKhoa(congCu);

  const khoaMoi = String(duLieu.khoa || '');
  if (!/^[0-9a-f]{64}$/.test(khoaMoi)) {
    return tra({ ok: false, loi: 'Khoá mới phải là 64 ký tự hex thường.' });
  }

  const props = PropertiesService.getScriptProperties();
  const tatCa = props.getProperties();
  if (String(tatCa[tenKhoa] || '').length >= 32) {
    return tra({ ok: false, loi: 'Đã có khoá cho công cụ này. Muốn đổi thì xoá thuộc tính ' + tenKhoa + ' rồi đăng ký lại.' });
  }

  const uyQuyen = String(duLieu.khoaUyQuyen || '');
  let duoc = false;
  Object.keys(tatCa).forEach(function (k) {
    if (k.indexOf('KHOA_PHAT_HANH_') !== 0) return;
    if (khopKhoa(uyQuyen, String(tatCa[k] || ''))) duoc = true;
  });
  if (!duoc) return tra({ ok: false, loi: 'Khoá uỷ quyền không khớp khoá của công cụ nào đang có.' });

  props.setProperty(tenKhoa, khoaMoi);
  return tra({ ok: true, tenKhoa: tenKhoa });
}
