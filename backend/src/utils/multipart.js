/**
 * Minimal multipart/form-data parser for small uploads (salary CSVs).
 * Use with express.raw({ type: 'multipart/form-data' }) so req.body is a Buffer.
 *
 * Returns { fields: { name: value }, files: { name: { filename, contentType, buffer } } }.
 */
export function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('Missing multipart boundary');
  if (!Buffer.isBuffer(body)) throw new Error('Expected a raw multipart body');

  const boundary = `--${match[1] || match[2]}`;
  // latin1 maps bytes 1:1, so offsets stay valid for slicing the Buffer
  const raw = body.toString('latin1');
  const fields = {};
  const files = {};

  for (const part of raw.split(boundary).slice(1)) {
    if (part.startsWith('--')) break; // closing boundary
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd);
    // Body ends with the CRLF that precedes the next boundary
    let content = part.slice(headerEnd + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);

    const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] || '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    const buffer = Buffer.from(content, 'latin1');

    if (filename !== undefined) {
      files[name] = {
        filename,
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || null,
        buffer
      };
    } else {
      fields[name] = buffer.toString('utf8');
    }
  }

  return { fields, files };
}
