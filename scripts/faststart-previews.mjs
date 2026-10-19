import fs from 'node:fs';
import path from 'node:path';

const dir = 'd:/my-portfolio/public/previews';
const files = [
  'CMU Preview.mp4',
  'pures nus preview.mp4',
  '720x480_demoreel_homepage.mp4',
  'QBP.mp4',
  'YPT.mp4',
];

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'mvex', 'moof', 'traf',
]);

function readBoxHeader(fd, pos, fileSize) {
  const hdr = Buffer.alloc(16);
  const n = fs.readSync(fd, hdr, 0, 16, pos);
  if (n < 8) return null;
  let size = hdr.readUInt32BE(0);
  const type = hdr.toString('ascii', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (n < 16) return null;
    size = Number(hdr.readBigUInt64BE(8));
    headerSize = 16;
  } else if (size === 0) {
    size = fileSize - pos;
  }
  if (size < headerSize) return null;
  return { pos, size, type, headerSize };
}

function listBoxes(fd, fileSize) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const box = readBoxHeader(fd, pos, fileSize);
    if (!box) break;
    boxes.push(box);
    pos += box.size;
  }
  return boxes;
}

function patchOffsets(buf, start, end, shift) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    if (type === 'cmov') throw new Error('compressed moov is not supported');
    if (type === 'stco') {
      const count = buf.readUInt32BE(p + header + 4);
      for (let i = 0; i < count; i++) {
        const off = p + header + 8 + i * 4;
        const next = buf.readUInt32BE(off) + shift;
        if (next > 0xffffffff) throw new Error('stco offset overflow');
        buf.writeUInt32BE(next, off);
      }
    } else if (type === 'co64') {
      const count = buf.readUInt32BE(p + header + 4);
      for (let i = 0; i < count; i++) {
        const off = p + header + 8 + i * 8;
        buf.writeBigUInt64BE(buf.readBigUInt64BE(off) + BigInt(shift), off);
      }
    } else if (CONTAINERS.has(type)) {
      patchOffsets(buf, p + header, p + size, shift);
    }
    p += size;
  }
}

function copyRange(srcFd, destFd, start, length) {
  const buf = Buffer.alloc(1024 * 1024);
  let left = length;
  let pos = start;
  while (left > 0) {
    const n = fs.readSync(srcFd, buf, 0, Math.min(buf.length, left), pos);
    if (n <= 0) throw new Error('unexpected EOF while copying');
    fs.writeSync(destFd, buf, 0, n);
    pos += n;
    left -= n;
  }
}

function firstChunkOffset(moov) {
  let found = null;
  function walk(start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = moov.readUInt32BE(p);
      const type = moov.toString('ascii', p + 4, p + 8);
      let header = 8;
      if (size === 1) {
        size = Number(moov.readBigUInt64BE(p + 8));
        header = 16;
      }
      if (size < header || p + size > end) break;
      if (type === 'stco' && found == null) {
        const count = moov.readUInt32BE(p + header + 4);
        if (count > 0) found = moov.readUInt32BE(p + header + 8);
      } else if (type === 'co64' && found == null) {
        const count = moov.readUInt32BE(p + header + 4);
        if (count > 0) found = Number(moov.readBigUInt64BE(p + header + 8));
      } else if (CONTAINERS.has(type)) {
        walk(p + header, p + size);
      }
      p += size;
    }
  }
  walk(0, moov.length);
  return found;
}

for (const name of files) {
  const filePath = path.join(dir, name);
  const fd = fs.openSync(filePath, 'r');
  const fileSize = fs.fstatSync(fd).size;
  const boxes = listBoxes(fd, fileSize);
  const moov = boxes.find((b) => b.type === 'moov');
  const mdat = boxes.find((b) => b.type === 'mdat');
  if (!moov || !mdat) {
    fs.closeSync(fd);
    console.log('skip', name, 'missing moov or mdat');
    continue;
  }
  if (moov.pos < mdat.pos) {
    fs.closeSync(fd);
    console.log('already fast', name);
    continue;
  }

  const moovBuf = Buffer.alloc(moov.size);
  fs.readSync(fd, moovBuf, 0, moov.size, moov.pos);
  patchOffsets(moovBuf, moov.headerSize, moovBuf.length, moov.size);

  const outPath = filePath + '.faststart';
  const out = fs.openSync(outPath, 'w');
  for (const box of boxes) {
    if (box === mdat) fs.writeSync(out, moovBuf);
    if (box === moov) continue;
    copyRange(fd, out, box.pos, box.size);
  }
  fs.closeSync(out);
  fs.closeSync(fd);

  const checkFd = fs.openSync(outPath, 'r');
  const checkSize = fs.fstatSync(checkFd).size;
  const checkBoxes = listBoxes(checkFd, checkSize);
  const newMoov = checkBoxes.find((b) => b.type === 'moov');
  const newMdat = checkBoxes.find((b) => b.type === 'mdat');
  const newMoovBuf = Buffer.alloc(newMoov.size);
  fs.readSync(checkFd, newMoovBuf, 0, newMoov.size, newMoov.pos);
  fs.closeSync(checkFd);
  const chunk = firstChunkOffset(newMoovBuf);
  const mdatDataStart = newMdat.pos + newMdat.headerSize;
  const mdatEnd = newMdat.pos + newMdat.size;
  const ok = newMoov.pos < newMdat.pos && chunk >= mdatDataStart && chunk < mdatEnd && checkSize === fileSize;
  if (!ok) {
    fs.unlinkSync(outPath);
    throw new Error(`${name} failed verification chunk=${chunk} mdat=${mdatDataStart}-${mdatEnd} size ${checkSize}/${fileSize}`);
  }
  fs.renameSync(outPath, filePath);
  console.log('faststart', name, 'moov now before mdat');
}
