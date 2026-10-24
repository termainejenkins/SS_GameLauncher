import { CATEGORIES, DESC_MAX, DESC_MIN, SCREENSHOT_MAX_BYTES, ZIP_MAX_BYTES } from './limits.js';

export function json(status, obj, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

export function isMultipart(contentType) {
  return /^multipart\/form-data\b/i.test(contentType || '');
}

export function contentLengthTooBig(headerValue, max) {
  if (headerValue == null || headerValue === '') return false;
  const n = Number(headerValue);
  return !Number.isFinite(n) || n < 0 || n > max;
}

function isFile(value) {
  return !!value && typeof value === 'object' && typeof value.arrayBuffer === 'function' && typeof value.size === 'number';
}

function looksLikeZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function imageKind(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

export function redactIncoming(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\/(?:[\w.-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[webhook]')
    .replace(/https?:\/\/hooks\.slack\.com\/\S+/gi, '[webhook]');
}

function fieldText(form, name) {
  const value = form.get(name);
  if (value == null || typeof value !== 'string') return '';
  return value;
}

/**
 * Validate a parsed multipart body. Returns { ok: true, report } or { ok: false, response }.
 * Does not read the network and does not log field values.
 */
export async function validateReport(form) {
  const category = fieldText(form, 'category').trim().toLowerCase();
  if (!CATEGORIES.includes(category)) {
    return { ok: false, response: json(400, { error: 'invalid_category', message: 'Category must be crash, performance, gameplay, or other.' }) };
  }

  const rawDescription = fieldText(form, 'description').trim();
  if (rawDescription.length < DESC_MIN || rawDescription.length > DESC_MAX) {
    return { ok: false, response: json(400, { error: 'invalid_description', message: 'Description must be 20 to 2000 characters.' }) };
  }
  const description = redactIncoming(rawDescription);

  const installId = fieldText(form, 'installId').trim();
  if (!/^[a-f0-9]{64}$/.test(installId)) {
    return { ok: false, response: json(400, { error: 'invalid_install_id', message: 'Install id is not a SHA-256 hash.' }) };
  }

  const zip = form.get('zip');
  if (!isFile(zip)) {
    return { ok: false, response: json(400, { error: 'invalid_zip', message: 'Attach the report zip in the zip field.' }) };
  }
  if (zip.size > ZIP_MAX_BYTES) {
    return { ok: false, response: json(413, { error: 'too_large', message: 'Zip is over the 25 MB cap.' }) };
  }
  const zipBytes = new Uint8Array(await zip.arrayBuffer());
  if (!looksLikeZip(zipBytes)) {
    return { ok: false, response: json(400, { error: 'invalid_zip', message: 'Attachment is not a zip file.' }) };
  }

  let screenshot = null;
  const shot = form.get('screenshot');
  if (isFile(shot) && shot.size > 0) {
    if (shot.size > SCREENSHOT_MAX_BYTES) {
      return { ok: false, response: json(413, { error: 'too_large', message: 'Screenshot is over the 8 MB allowance.' }) };
    }
    const shotBytes = new Uint8Array(await shot.arrayBuffer());
    const kind = imageKind(shotBytes);
    if (!kind) {
      return { ok: false, response: json(400, { error: 'invalid_screenshot', message: 'Screenshot must be a PNG or JPG.' }) };
    }
    screenshot = { bytes: shotBytes, ext: kind === 'jpeg' ? 'jpg' : 'png', contentType: kind === 'jpeg' ? 'image/jpeg' : 'image/png' };
  }

  const clip = (name) => {
    const t = redactIncoming(fieldText(form, name).trim());
    return t ? t.slice(0, 200) : null;
  };

  return {
    ok: true,
    report: {
      category,
      description,
      installId,
      launcherVersion: clip('launcherVersion'),
      gameBuild: clip('gameBuild'),
      gpu: clip('gpu'),
      zipBytes,
      screenshot,
    },
  };
}
