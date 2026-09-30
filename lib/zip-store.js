// Bộ ghi ZIP tối giản (chế độ "store", không nén) — dùng để gói các file PDF đã nén sẵn.
// Không phụ thuộc thư viện ngoài. Tên file mã hóa UTF-8 (cờ bit 11) nên giữ được tiếng Việt.
// Giới hạn: không hỗ trợ ZIP64 -> người gọi phải tách phần khi vượt ~1 GB hoặc ~5000 file.
(function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  class ZipStore {
    constructor() {
      this.parts = []; // Uint8Array (header) và Blob (dữ liệu) xen kẽ
      this.central = []; // bản ghi thư mục trung tâm
      this.offset = 0;
      this.count = 0;
    }

    get size() {
      return this.offset;
    }

    // name: đường dẫn trong ZIP (dùng "/" làm dấu phân cách); bytes: Uint8Array.
    add(name, bytes, when) {
      const nameBytes = new TextEncoder().encode(name);
      const crc = crc32(bytes);
      const { time, date } = dosDateTime(when || new Date());

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 tên file
      local.setUint16(8, 0, true); // method = store
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, bytes.length, true);
      local.setUint32(22, bytes.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      const headerBytes = new Uint8Array(30 + nameBytes.length);
      headerBytes.set(new Uint8Array(local.buffer), 0);
      headerBytes.set(nameBytes, 30);

      this.central.push({ nameBytes, crc, size: bytes.length, time, date, offset: this.offset });
      // Bọc dữ liệu vào Blob để trình duyệt có thể giải phóng ArrayBuffer gốc.
      this.parts.push(headerBytes, new Blob([bytes]));
      this.offset += headerBytes.length + bytes.length;
      this.count++;
    }

    finish() {
      const cdParts = [];
      let cdSize = 0;
      for (const e of this.central) {
        const dv = new DataView(new ArrayBuffer(46));
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true); // version made by
        dv.setUint16(6, 20, true); // version needed
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, 0, true);
        dv.setUint16(12, e.time, true);
        dv.setUint16(14, e.date, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.size, true);
        dv.setUint32(24, e.size, true);
        dv.setUint16(28, e.nameBytes.length, true);
        dv.setUint16(30, 0, true); // extra
        dv.setUint16(32, 0, true); // comment
        dv.setUint16(34, 0, true); // disk start
        dv.setUint16(36, 0, true); // internal attrs
        dv.setUint32(38, 0, true); // external attrs
        dv.setUint32(42, e.offset, true);
        const rec = new Uint8Array(46 + e.nameBytes.length);
        rec.set(new Uint8Array(dv.buffer), 0);
        rec.set(e.nameBytes, 46);
        cdParts.push(rec);
        cdSize += rec.length;
      }
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(4, 0, true);
      end.setUint16(6, 0, true);
      end.setUint16(8, this.count, true);
      end.setUint16(10, this.count, true);
      end.setUint32(12, cdSize, true);
      end.setUint32(16, this.offset, true);
      end.setUint16(20, 0, true);
      return new Blob(this.parts.concat(cdParts, [new Uint8Array(end.buffer)]), {
        type: 'application/zip',
      });
    }
  }

  const api = { ZipStore, crc32 };
  root.HaZipStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
