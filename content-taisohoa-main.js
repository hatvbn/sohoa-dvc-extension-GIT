// Chạy trong "thế giới của trang" (world: MAIN) để gọi được Liferay.Session của chính trang.
// Content script thường (isolated) không chèn được script nội tuyến vì Manifest V3 chặn, nên nó
// nhắn tin sang đây bằng window.postMessage. Chỉ có 3 lệnh, chỉ thao tác Liferay.Session:
//   on     bật tự gia hạn phiên của trang và tắt tự chuyển hướng khi hết phiên (nhớ giá trị cũ)
//   off    trả lại đúng giá trị cũ
//   extend gia hạn phiên ngay
(function () {
  'use strict';
  if (window.__hatoolsMain) return;
  window.__hatoolsMain = true;
  let saved = null;

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.origin !== location.origin || !d || d.hatools !== 'cmd' || typeof d.id !== 'string') return;
    const reply = (res) => window.postMessage({ hatools: 'res', id: d.id, res }, location.origin);
    try {
      const S = window.Liferay && window.Liferay.Session;
      if (d.cmd === 'on') {
        if (S && S.get && S.set) {
          if (!saved) saved = { a: S.get('autoExtend'), r: S.get('redirectOnExpire') };
          S.set('autoExtend', true);
          S.set('redirectOnExpire', false);
          reply('ok');
        } else reply('none');
      } else if (d.cmd === 'off') {
        if (S && saved) {
          S.set('autoExtend', saved.a);
          S.set('redirectOnExpire', saved.r);
        }
        saved = null;
        reply('ok');
      } else if (d.cmd === 'extend') {
        if (S && S.extend) {
          S.extend();
          reply('ok');
        } else reply('none');
      }
    } catch (e) {
      reply('err');
    }
  });
})();
