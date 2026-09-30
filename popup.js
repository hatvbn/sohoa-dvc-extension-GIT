const URL_SOHOA = 'https://dichvucong.bacninh.gov.vn/web/guest/so-hoa-cho-boc-tach';
const URL_DINHKEM = 'https://dichvucong.bacninh.gov.vn/web/guest/%C4%90%C3%ADnh-k%C3%A8m-%C4%91i%E1%BB%87n-t%E1%BB%AD';

const URL_BOSUNG = 'https://dichvucong.bacninh.gov.vn/web/guest/cho-bo-sung-ket-qua-dien-tu';

const URL_VBDLIS = 'https://dichvucong.bacninh.gov.vn/web/guest/h%E1%BB%93-s%C6%A1-vbdlis';

const URL_TRAKQ = 'https://dichvucong.bacninh.gov.vn/web/guest/h%E1%BB%93-s%C6%A1-ch%E1%BB%9D-tr%E1%BA%A3-k%E1%BA%BFt-qu%E1%BA%A3';

const statusEl = document.getElementById('pp-status');

function goTo(url) {
  statusEl.textContent = 'Đang mở trang...';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) {
      statusEl.textContent = 'Không tìm thấy tab hiện tại.';
      return;
    }
    chrome.tabs.update(tab.id, { url }, () => {
      window.close();
    });
  });
}

document.getElementById('pp-sohoa').addEventListener('click', () => goTo(URL_SOHOA));
document.getElementById('pp-dinhkem').addEventListener('click', () => goTo(URL_DINHKEM));
document.getElementById('pp-bosung').addEventListener('click', () => goTo(URL_BOSUNG));
document.getElementById('pp-vbdlis').addEventListener('click', () => goTo(URL_VBDLIS));
document.getElementById('pp-trakq').addEventListener('click', () => goTo(URL_TRAKQ));
