/**
 * An inline SVG as an image `uri` that every platform decodes.
 *
 * expo-image on Android (Glide, `Base64DataFetcher`) always base64-decodes whatever follows the
 * comma of a `data:` URI. A percent-encoded (utf8) SVG URI therefore turns into
 * garbage there and the image stays empty, while iOS and the web show it: that is why the tab bar
 * icons, the restaurant check and the Pick Man walls and rivals were missing on Android
 * (owner 22.11.2026). Base64 is read the same way on iOS, Android and the web.
 *
 * Pure (no React Native import) so unit tests can run it.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return bytes;
}

export function base64Utf8(text: string): string {
  const bytes = utf8Bytes(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    const char = (shift: number) => ALPHABET.charAt((triple >> shift) & 0x3f);
    out += char(18) + char(12);
    out += b === undefined ? '=' : char(6);
    out += c === undefined ? '=' : char(0);
  }
  return out;
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${base64Utf8(svg)}`;
}
