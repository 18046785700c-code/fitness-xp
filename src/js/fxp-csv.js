/* Fitness XP V1 — CSV 解析模块（无依赖，UMD：Node 可 require，浏览器可 script 引入） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; Object.assign(root.FXP, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 去除 UTF-8 BOM */
  function stripBOM(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

  /** 缓冲区解码：UTF-8（含 BOM）优先，出现替换符时回退尝试 GBK（兼容 Excel 另存格式） */
  function decodeBuffer(buf) {
    var utf8 = new TextDecoder('utf-8').decode(buf);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return utf8; // 带 BOM
    if (utf8.indexOf('\uFFFD') === -1) return utf8; // 合法 UTF-8
    try { return new TextDecoder('gbk').decode(buf); } catch (e) { return utf8; }
  }

  /** 标准 CSV 解析（支持引号包裹、转义引号、CRLF）；返回二维数组，剔除全空行 */
  function parseCSV(text) {
    text = stripBOM(String(text));
    var rows = [], row = [], field = '', i = 0, inQ = false;
    while (i < text.length) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; } else { inQ = false; i++; } }
        else { field += c; i++; }
      } else {
        if (c === '"') { inQ = true; i++; }
        else if (c === ',') { row.push(field); field = ''; i++; }
        else if (c === '\r') {
          if (text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; }
          else { field += c; i++; }
        }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
        else { field += c; i++; }
      }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return !(r.length === 1 && String(r[0]).trim() === ''); });
  }

  /** 首行为表头 → 记录数组。每条记录附加 _row（Excel 行号，表头=1，数据从 2 开始） */
  function toRecords(rows) {
    if (!rows || !rows.length) return { header: [], records: [] };
    var header = rows[0].map(function (h) { return String(h).trim(); });
    var records = [];
    for (var i = 1; i < rows.length; i++) {
      var rec = { _row: i + 1 };
      for (var j = 0; j < header.length; j++) rec[header[j]] = rows[i][j] !== undefined ? String(rows[i][j]).trim() : '';
      records.push(rec);
    }
    return { header: header, records: records };
  }

  /** 记录数组 → CSV 文本（UTF-8 BOM），列顺序按 fields；字段含逗号/引号/换行时自动加引号 */
  function toCSV(records, fields) {
    var esc = function (v) {
      v = (v === undefined || v === null) ? '' : String(v);
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [fields.join(',')];
    records.forEach(function (r) {
      lines.push(fields.map(function (f) { return esc(r[f]); }).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  return { stripBOM: stripBOM, decodeBuffer: decodeBuffer, parseCSV: parseCSV, toRecords: toRecords, toCSV: toCSV };
});
