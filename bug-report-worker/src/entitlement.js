// Ed25519 check for the launcher's entitlement token. WebCrypto only (no Node crypto).
// A failure here means "not a developer", never "reject the report". The token is not logged.

function bytesFromHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesFromBase64Url(value) {
  if (typeof value !== 'string' || !value || /[^A-Za-z0-9_-]/.test(value)) return null;
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * True only when the token's signature matches publicKeyHex, exp is still in the
 * future, and entitlements includes "developer". Anything else is false.
 * nowSec is unix seconds. Token format matches the launcher: base64url(json).base64url(sig).
 */
export async function developerFromToken(token, publicKeyHex, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    if (typeof token !== 'string') return false;
    const trimmed = token.trim();
    if (!trimmed || trimmed.length > 16384) return false;
    const parts = trimmed.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const rawKey = bytesFromHex(publicKeyHex);
    const sig = bytesFromBase64Url(parts[1]);
    const body = bytesFromBase64Url(parts[0]);
    if (!rawKey || !sig || !body) return false;
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(parts[0]));
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(body));
    if (!payload || payload.v !== 1 || !Array.isArray(payload.entitlements)) return false;
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) return false;
    return payload.entitlements.includes('developer');
  } catch (_) {
    return false;
  }
}
