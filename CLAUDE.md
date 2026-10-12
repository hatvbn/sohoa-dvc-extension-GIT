# HaTools DVCBacNinh — quy ước làm việc

Chrome/Edge extension (Manifest V3) hỗ trợ thao tác hàng loạt trên Cổng DVC Bắc Ninh.

## Quy trình phát hành bản mới (BẮT BUỘC)

Mỗi khi có thay đổi/bản mới, thực hiện đúng thứ tự:

1. Làm việc và commit trên nhánh phiên làm việc được giao (không push thẳng lên `main`).
2. Nâng `version` trong `manifest.json` khi thay đổi có ảnh hưởng người dùng.
3. Chạy kiểm tra cú pháp (`node --check` cho các file JS, parse JSON cho `manifest.json`) và các test liên quan.
4. **Tạo Pull Request từ nhánh đó vào `main`, rồi merge PR** (chủ dự án yêu cầu làm trọn: "tôi chỉ load lại extension"). Trước khi merge phải kiểm tra PR không xung đột và CI (nếu có) không đỏ. Sau khi PR đã merge, nhánh phiên làm việc được đặt lại từ `main` mới nhất cho lần thay đổi kế tiếp.
5. Báo cho người dùng cách cập nhật (việc duy nhất họ cần làm trên máy): Pull `main` trong GitHub Desktop → `chrome://extensions` → bấm nạp lại (⟳) extension → đóng/mở lại side panel → F5 tab của trang chức năng.

## Cấu trúc

- `manifest.json` — khai báo extension, content script theo từng trang chức năng.
- `background.js` — service worker (native messaging ký số, ghi nhận sử dụng, kiểm tra cập nhật).
- `sidepanel.html` / `sidepanel.js` — bảng điều khiển chính; `popup.html` / `popup.js` — menu mở trang.
- `content.js` — số hóa, đính kèm, bổ sung kết quả, VBDLIS, trả kết quả (các chức năng cũ, không sửa nếu không cần).
- `content-taisohoa.js` + `lib/zip-store.js` — chức năng **Tải File Số Hóa** (trang "Hồ sơ đã số hóa"). Đơn vị / từ ngày / đến ngày do người dùng chọn trực tiếp trên trang; content script đọc nguyên văn các ô lọc đó (không tự đoán định dạng ngày). Side panel có ô tên file, ô "Tiếp tục từ lần trước" và dòng trạng thái thư mục lưu.
  - Lưu file: mặc định gói ZIP (tải qua trình duyệt); nếu người dùng bấm nút 📁 do extension chèn trên trang và chọn thư mục (File System Access API, tay cầm lưu trong IndexedDB của trang) thì ghi thẳng từng PDF vào thư mục đó. Tên file là `Chủ hồ sơ Mã định danh.PDF`, các file nằm phẳng (cả ZIP lẫn thư mục đều KHÔNG tạo thư mục con); trùng tên thì thêm ` (2)`; không bao giờ ghi đè file có sẵn.
  - `content-taisohoa-main.js` chạy ở `world: "MAIN"` chỉ để gọi `Liferay.Session` (giữ phiên); content script chính nhắn tin qua `window.postMessage`.
- `tools/` — script ký số tự động và Apps Script.

## Nguyên tắc

- Các chức năng hiện có là được bảo vệ: không sửa/xóa hành vi cũ khi chưa được phê duyệt.
- Thay đổi lớn (kiến trúc, dependency mới, quyền manifest, cấu trúc project) phải xin phê duyệt trước.
- Không đưa secret/token/mật khẩu vào repo. Không commit file log.
- Mỗi chức năng trang web mới dùng content script riêng, khớp đúng URL trang đó.
- Manifest V3 chặn content script chèn `<script>` nội tuyến vào trang (CSP). Muốn gọi API của trang (ví dụ `Liferay`) phải dùng content script `world: "MAIN"` + `postMessage`.
- Chọn thư mục (`showDirectoryPicker`) chỉ mở được khi người dùng bấm ngay trên trang (không bấm được từ side panel).
- Kiểm thử: jsdom KHÔNG phát hiện được ràng buộc của trình duyệt thật (CSP của MV3, API thư mục...). Với thay đổi chạm vào các phần đó, phải kiểm bằng Chromium thật (Playwright `launchPersistentContext` với `--headless=new --load-extension=<repo>`, đặt `LANG=C.UTF-8` để tên file tiếng Việt hoạt động, giả lập cổng bằng `route`).
