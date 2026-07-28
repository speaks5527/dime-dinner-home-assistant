/**
 * Tiny PDF generators for the ebook import tests.
 *
 * The point of building these here rather than committing sample files is that
 * the real ebook this feature was written for is someone else's copyrighted
 * book — it must never enter the repository. These fixtures are a few hundred
 * bytes of hand-assembled PDF and cover the two cases that matter: a PDF with a
 * real text layer, and one whose page is a bare image so there is nothing for
 * pdftotext to find and OCR is the only way through.
 */
import zlib from "node:zlib";

function pdfEscape(text: string): string {
  return text.replace(/([\\()])/g, "\\$1");
}

/** Assemble objects into a PDF with a correct xref table. */
function assemble(objects: string[], extra: Buffer[] = []): Buffer {
  const header = "%PDF-1.4\n";
  const chunks: Buffer[] = [Buffer.from(header, "latin1")];
  const offsets: number[] = [];
  let position = header.length;

  objects.forEach((body, index) => {
    const raw = extra[index] ?? Buffer.from(body, "latin1");
    offsets.push(position);
    chunks.push(raw);
    position += raw.length;
  });

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

function contentStream(id: number, lines: string[]): string {
  let text = "BT\n/F1 11 Tf\n1 0 0 1 40 750 Tm\n13 TL\n";
  for (const line of lines) text += `(${pdfEscape(line)}) Tj\nT*\n`;
  text += "ET\n";
  return `${id} 0 obj\n<< /Length ${text.length} >>\nstream\n${text}endstream\nendobj\n`;
}

/**
 * A PDF whose pages carry selectable text — the path where `pdftotext` alone is
 * enough and OCR must not be triggered.
 */
export function makeTextPdf(pages: string[][], meta: { title?: string; author?: string } = {}): Buffer {
  const pageCount = pages.length;
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>\nendobj\n`,
    `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ];

  pages.forEach((lines, index) => {
    const pageId = 4 + index * 2;
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>\nendobj\n`,
    );
    objects.push(contentStream(pageId + 1, lines));
  });

  const info =
    `${objects.length + 1} 0 obj\n<< /Title (${pdfEscape(meta.title ?? "Test Cookbook")}) ` +
    `/Author (${pdfEscape(meta.author ?? "Test Author")}) >>\nendobj\n`;
  objects.push(info);
  return assemble(objects);
}

/** A 1-bit image of `text`, drawn with a crude 5x7 font. */
function renderBitmap(lines: string[], width: number, height: number, scale: number): Buffer {
  const rowBytes = Math.ceil(width / 8);
  // 0 is black in DeviceGray; start white.
  const bitmap = Buffer.alloc(rowBytes * height, 0xff);

  const setPixel = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * rowBytes + (x >> 3);
    bitmap[index] &= ~(0x80 >> (x & 7));
  };

  lines.forEach((line, lineIndex) => {
    const baseY = 12 + lineIndex * (7 * scale + 8);
    [...line.toUpperCase()].forEach((char, charIndex) => {
      const glyph = GLYPHS[char];
      if (!glyph) return;
      const baseX = 12 + charIndex * (5 * scale + scale);
      glyph.forEach((row, y) => {
        for (let x = 0; x < 5; x += 1) {
          if (!(row & (0b10000 >> x))) continue;
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) setPixel(baseX + x * scale + dx, baseY + y * scale + dy);
          }
        }
      });
    });
  });

  return bitmap;
}

/**
 * A PDF whose only page content is a bitmap — no font objects at all, so
 * `pdftotext` returns nothing and the importer has to fall back to OCR. This is
 * the shape of the flattened design-tool ebook the feature was built for.
 */
export function makeImagePdf(pages: string[][], options: { scale?: number } = {}): Buffer {
  const scale = options.scale ?? 4;
  const width = 1240;
  const height = 1754;
  const objects: string[] = [];
  const raw: Buffer[] = [];

  const push = (body: string, buffer?: Buffer) => {
    objects.push(body);
    raw.push(buffer ?? Buffer.from(body, "latin1"));
  };

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  push(`2 0 obj\n<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\nendobj\n`);

  pages.forEach((lines, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;

    push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );

    const bitmap = zlib.deflateSync(renderBitmap(lines, width, height, scale));
    const imageHeader =
      `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${bitmap.length} >>\nstream\n`;
    push(
      "",
      Buffer.concat([Buffer.from(imageHeader, "latin1"), bitmap, Buffer.from("\nendstream\nendobj\n", "latin1")]),
    );

    const draw = "q\n595 0 0 842 0 0 cm\n/Im0 Do\nQ\n";
    push(`${contentId} 0 obj\n<< /Length ${draw.length} >>\nstream\n${draw}endstream\nendobj\n`);
  });

  push(`${objects.length + 1} 0 obj\n<< /Title (Scanned Test Cookbook) /Author (Test Author) >>\nendobj\n`);
  return assemble(objects, raw);
}

/** 5x7 bitmap font, enough for the words the fixtures use. */
const GLYPHS: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b11110, 0b10001, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  ".": [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ",": [0, 0, 0, 0, 0b01100, 0b01100, 0b11000],
  "/": [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  "-": [0, 0, 0, 0b11111, 0, 0, 0],
  ":": [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0],
  " ": [0, 0, 0, 0, 0, 0, 0],
};
