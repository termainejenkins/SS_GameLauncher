// Read-only file access that stays inside one directory.
// Symlinks and Windows junctions are rejected. Only regular files are read,
// and only up to maxBytes, through an open handle so a pipe cannot block forever.
'use strict';

const fs = require('fs');
const path = require('path');

function promisesOf(fsImpl) {
  if (fsImpl && fsImpl.promises) return fsImpl.promises;
  return fs.promises;
}

function canonical(p) {
  let s = path.normalize(String(p));
  if (process.platform === 'win32') {
    if (s.startsWith('\\\\?\\UNC\\')) s = `\\\\${s.slice(8)}`;
    else if (s.startsWith('\\\\?\\')) s = s.slice(4);
    if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
    return s.toLowerCase();
  }
  return s;
}

function samePath(a, b) {
  return canonical(a) === canonical(b);
}

function isInside(rootReal, targetReal) {
  const rel = path.relative(canonical(rootReal), canonical(targetReal));
  return rel !== '' && rel !== '.' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function lexicalInside(rootDir, target) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { root, rel };
}

function openFlags() {
  return fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
}

/**
 * Read target only if every path component is a real directory or, for the
 * last component, a regular file under the real path of rootDir.
 * Returns { ok:true, data:Buffer } or { ok:false, reason }.
 */
async function readRootedFile(rootDir, target, options = {}) {
  const maxBytes = options.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) return { ok: false, reason: 'bad_limit' };
  const lexical = lexicalInside(rootDir, target);
  if (!lexical) return { ok: false, reason: 'escape' };
  const fsp = promisesOf(options.fsImpl);
  let rootReal;
  try {
    rootReal = await fsp.realpath(lexical.root);
  } catch (err) {
    return { ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  const parts = lexical.rel.split(path.sep).filter(Boolean);
  let current = rootReal;
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]);
    const last = i === parts.length - 1;
    let st;
    try {
      st = await fsp.lstat(next);
    } catch (err) {
      return { ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
      return { ok: false, reason: 'not_file' };
    }
    let real;
    try {
      real = await fsp.realpath(next);
    } catch (_) {
      return { ok: false, reason: 'unreadable' };
    }
    if (!isInside(rootReal, real) || !samePath(real, path.resolve(next))) {
      return { ok: false, reason: 'symlink' };
    }
    if (!last) {
      if (!st.isDirectory()) return { ok: false, reason: 'not_file' };
      current = next;
      continue;
    }
    if (!st.isFile()) return { ok: false, reason: 'not_file' };
    if (st.size > maxBytes) return { ok: false, reason: 'oversize' };
    return readHandle(fsp, next, rootReal, maxBytes, !!options.statOnly);
  }
  return { ok: false, reason: 'missing' };
}

function sameFile(opened, fresh) {
  if (!opened || !fresh) return false;
  if (typeof opened.dev !== 'bigint' || typeof fresh.dev !== 'bigint') return false;
  if (typeof opened.ino !== 'bigint' || typeof fresh.ino !== 'bigint') return false;
  return opened.dev === fresh.dev && opened.ino === fresh.ino;
}

async function readHandle(fsp, file, rootReal, maxBytes, statOnly) {
  let fh;
  try {
    fh = await fsp.open(file, openFlags());
  } catch (err) {
    if (err && (err.code === 'ELOOP' || err.code === 'ENOTSUP' || err.code === 'EPERM')) {
      return { ok: false, reason: 'symlink' };
    }
    // Some platforms reject O_NOFOLLOW or O_NONBLOCK. Retry a plain read only
    // after lstat already required a regular file.
    if (err && (err.code === 'EINVAL' || err.code === 'ENOSYS')) {
      try { fh = await fsp.open(file, fs.constants.O_RDONLY); }
      catch (_) { return { ok: false, reason: 'unreadable' }; }
    } else {
      return { ok: false, reason: 'unreadable' };
    }
  }
  try {
    const opened = await fh.stat({ bigint: true });
    if (!opened.isFile()) return { ok: false, reason: 'not_file' };
    if (opened.size > BigInt(maxBytes)) return { ok: false, reason: 'oversize' };
    // The path can be swapped for a junction between the pre-check and open.
    // The handle has to still be the file that path names, inside the base.
    let real;
    try { real = await fsp.realpath(file); }
    catch (_) { return { ok: false, reason: 'unreadable' }; }
    if (!isInside(rootReal, real) || !samePath(real, path.resolve(file))) {
      return { ok: false, reason: 'symlink' };
    }
    let fresh;
    try { fresh = await fsp.lstat(real, { bigint: true }); }
    catch (_) { return { ok: false, reason: 'unreadable' }; }
    if (fresh.isSymbolicLink() || !fresh.isFile() || !sameFile(opened, fresh)) {
      return { ok: false, reason: 'symlink' };
    }
    let again;
    try { again = await fsp.realpath(file); }
    catch (_) { return { ok: false, reason: 'unreadable' }; }
    if (!isInside(rootReal, again) || !samePath(again, real)) {
      return { ok: false, reason: 'symlink' };
    }
    if (statOnly) return { ok: true, size: Number(opened.size) };
    // Ask for cap+1 bytes even when the first fstat was smaller, so a file
    // that grows is not accepted as a short prefix of itself.
    const want = maxBytes + 1;
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const { bytesRead } = await fh.read(buf, off, want - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    if (off > maxBytes) return { ok: false, reason: 'oversize' };
    if (BigInt(off) !== opened.size) return { ok: false, reason: 'unreadable' };
    return { ok: true, data: buf.subarray(0, off), size: off };
  } finally {
    await fh.close();
  }
}

module.exports = { readRootedFile };
