// Read canvas dimensions without changing the generated image or adding a codec dependency.
export function imageDimensions(raw, mimeType) {
  const size = (width, height) => width > 0 && height > 0 ? { width, height } : null;
  if (mimeType === "image/png" && raw.length >= 24 && raw.toString("ascii", 12, 16) === "IHDR") {
    return size(raw.readUInt32BE(16), raw.readUInt32BE(20));
  }
  if (mimeType === "image/jpeg") {
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 1 < raw.length) {
      if (raw[offset] !== 0xff) return null;
      while (offset < raw.length && raw[offset] === 0xff) offset += 1;
      if (offset >= raw.length) return null;
      const marker = raw[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > raw.length) return null;
      const length = raw.readUInt16BE(offset);
      if (length < 2 || offset + length > raw.length) return null;
      if (frames.has(marker) && length >= 8) {
        return size(raw.readUInt16BE(offset + 5), raw.readUInt16BE(offset + 3));
      }
      offset += length;
    }
  }
  if (mimeType === "image/webp") {
    for (let offset = 12; offset + 8 <= raw.length;) {
      const kind = raw.toString("ascii", offset, offset + 4);
      const length = raw.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + length > raw.length) return null;
      if (kind === "VP8X" && length >= 10) {
        return size(raw.readUIntLE(start + 4, 3) + 1, raw.readUIntLE(start + 7, 3) + 1);
      }
      if (kind === "VP8L" && length >= 5 && raw[start] === 0x2f) {
        const bits = raw.readUInt32LE(start + 1);
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (kind === "VP8 " && length >= 10 && raw.toString("hex", start + 3, start + 6) === "9d012a") {
        return size(raw.readUInt16LE(start + 6) & 0x3fff, raw.readUInt16LE(start + 8) & 0x3fff);
      }
      offset = start + length + (length % 2);
    }
  }
  return null;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function pngCRC(raw, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ raw[index]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Check container completeness and PNG checksums, without decoding pixels.
export function imageStructureIsComplete(raw, mimeType) {
  if (mimeType === "image/png") {
    let offset = 8;
    let hasData = false;
    let hasHeader = false;
    while (offset + 12 <= raw.length) {
      const length = raw.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > raw.length) return false;
      if (pngCRC(raw, offset + 4, end - 4) !== raw.readUInt32BE(end - 4)) return false;
      const type = raw.toString("ascii", offset + 4, offset + 8);
      if (!hasHeader) {
        if (type !== "IHDR" || length !== 13) return false;
        hasHeader = true;
      } else if (type === "IHDR") return false;
      if (type === "IDAT" && length > 0) hasData = true;
      if (type === "IEND") return length === 0 && hasData && end === raw.length;
      offset = end;
    }
    return false;
  }
  if (mimeType === "image/jpeg") {
    if (raw.length < 4 || raw[raw.length - 2] !== 0xff || raw[raw.length - 1] !== 0xd9) return false;
    let offset = 2;
    while (offset + 1 < raw.length) {
      if (raw[offset++] !== 0xff) return false;
      while (raw[offset] === 0xff) offset += 1;
      const marker = raw[offset++];
      if (marker === 0xd9) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > raw.length) return false;
      const length = raw.readUInt16BE(offset);
      if (length < 2 || offset + length > raw.length) return false;
      if (marker === 0xda) return length >= 6 && offset + length < raw.length - 2;
      offset += length;
    }
    return false;
  }
  if (mimeType === "image/webp") {
    if (raw.length < 20 || raw.readUInt32LE(4) + 8 !== raw.length) return false;
    let offset = 12;
    let hasData = false;
    while (offset + 8 <= raw.length) {
      const type = raw.toString("ascii", offset, offset + 4);
      const length = raw.readUInt32LE(offset + 4);
      offset += 8 + length + (length % 2);
      if (offset > raw.length) return false;
      if ((type === "VP8 " && length >= 10) || (type === "VP8L" && length >= 5) ||
          (type === "ANMF" && length > 16)) hasData = true;
    }
    return hasData && offset === raw.length;
  }
  return false;
}
