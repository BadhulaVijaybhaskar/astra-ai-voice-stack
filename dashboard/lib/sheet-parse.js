/**
 * Astra AI. Zero-dep CSV + minimal XLSX (OOXML) sheet parser/writer.
 *
 * Used by Campaign bulk upload. No npm sheet libraries. XLSX support covers
 * simple first-sheet workbooks with shared strings or inline strings.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const zlib = require('zlib');

function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',' || ch === '\t') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((c) => String(c || '').trim() === '')) {
    rows.pop();
  }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h, idx) => {
    const label = String(h || '').trim();
    return label || ('column_' + (idx + 1));
  });
  const body = rows.slice(1).map((r) => {
    const out = {};
    headers.forEach((h, idx) => {
      out[h] = r[idx] != null ? String(r[idx]) : '';
    });
    return out;
  });
  return { headers, rows: body, matrix: rows };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (~c) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function zipStore(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const cen = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    central.push(cen);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat(locals.concat([centralBuf, end]));
}

function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const files = {};
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const compressed = buf.slice(start, start + compSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error('unsupported zip compression ' + method);
    files[name] = data;
    i = start + compSize;
  }
  return files;
}

function xmlDecode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlEncode(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    const texts = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) texts.push(xmlDecode(tm[1]));
    out.push(texts.join(''));
  }
  return out;
}

function colLettersToIndex(letters) {
  let n = 0;
  const s = String(letters || '').toUpperCase();
  for (let i = 0; i < s.length; i += 1) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return Math.max(0, n - 1);
}

function parseSheetRows(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = {};
    let maxIdx = -1;
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || cm[3] || '';
      const body = cm[2] || '';
      const refM = /\br="([A-Z]+)(\d+)"/i.exec(attrs);
      const typeM = /\bt="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : '';
      let value = '';
      const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
      const isM = /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body);
      if (type === 's' && vM) {
        const idx = Number(vM[1]);
        value = shared[idx] != null ? shared[idx] : '';
      } else if (type === 'inlineStr' && isM) {
        value = xmlDecode(isM[1]);
      } else if (vM) {
        value = xmlDecode(vM[1]);
      } else if (isM) {
        value = xmlDecode(isM[1]);
      }
      if (refM) {
        const idx = colLettersToIndex(refM[1]);
        cells[idx] = value;
        if (idx > maxIdx) maxIdx = idx;
      }
    }
    const row = [];
    for (let i = 0; i <= maxIdx; i += 1) row.push(cells[i] != null ? String(cells[i]) : '');
    rows.push(row);
  }
  return rows;
}

function matrixToObjects(matrix) {
  if (!matrix.length) return { headers: [], rows: [], matrix };
  const headers = matrix[0].map((h, idx) => {
    const label = String(h || '').trim();
    return label || ('column_' + (idx + 1));
  });
  const rows = matrix.slice(1).filter((r) => r.some((c) => String(c || '').trim() !== '')).map((r) => {
    const out = {};
    headers.forEach((h, idx) => {
      out[h] = r[idx] != null ? String(r[idx]) : '';
    });
    return out;
  });
  return { headers, rows, matrix };
}

function parseXlsx(buffer) {
  const files = readZip(buffer);
  const sheetName = Object.keys(files).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    || Object.keys(files).find((n) => /sheet1\.xml$/i.test(n));
  if (!sheetName) throw new Error('xlsx worksheet not found');
  const sharedXml = files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml'].toString('utf8') : '';
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const sheetXml = files[sheetName].toString('utf8');
  const matrix = parseSheetRows(sheetXml, shared);
  return matrixToObjects(matrix);
}

function parseUpload(bufferOrText, filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = Buffer.isBuffer(bufferOrText) ? bufferOrText.toString('utf8') : String(bufferOrText || '');
    return { ...parseCsv(text), format: 'csv' };
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    const buf = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText || ''), 'base64');
    return { ...parseXlsx(buf), format: 'xlsx' };
  }
  // Sniff ZIP / OOXML.
  const buf = Buffer.isBuffer(bufferOrText)
    ? bufferOrText
    : Buffer.from(String(bufferOrText || ''), 'utf8');
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return { ...parseXlsx(buf), format: 'xlsx' };
  }
  return { ...parseCsv(buf.toString('utf8')), format: 'csv' };
}

function indexToColLetters(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildXlsx(headers, rows) {
  const matrix = [headers].concat(rows.map((row) => headers.map((h) => (row[h] != null ? String(row[h]) : ''))));
  const shared = [];
  const sharedIndex = new Map();
  function addShared(text) {
    const t = String(text || '');
    if (sharedIndex.has(t)) return sharedIndex.get(t);
    const idx = shared.length;
    shared.push(t);
    sharedIndex.set(t, idx);
    return idx;
  }
  matrix.forEach((r) => r.forEach((c) => addShared(c)));
  const sheetRows = matrix.map((r, rIdx) => {
    const cells = r.map((c, cIdx) => {
      const ref = indexToColLetters(cIdx) + String(rIdx + 1);
      const si = sharedIndex.get(String(c || ''));
      return '<c r="' + ref + '" t="s"><v>' + si + '</v></c>';
    }).join('');
    return '<row r="' + (rIdx + 1) + '">' + cells + '</row>';
  }).join('');
  const sharedXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="'
    + shared.length + '" uniqueCount="' + shared.length + '">'
    + shared.map((t) => '<si><t>' + xmlEncode(t) + '</t></si>').join('')
    + '</sst>';
  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetData>' + sheetRows + '</sheetData></worksheet>';
  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    + '</Relationships>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '</Types>';
  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    { name: 'xl/sharedStrings.xml', data: sharedXml },
  ]);
}

function toCsv(headers, rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => esc(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  parseCsv,
  parseXlsx,
  parseUpload,
  buildXlsx,
  toCsv,
  zipStore,
};
