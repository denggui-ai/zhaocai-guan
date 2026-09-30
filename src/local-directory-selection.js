const fs = require('fs');
const path = require('path');

function selectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function directoryAccessError(label) {
  return selectionError('DIRECTORY_ACCESS_FAILED', `无法读取${label}。请检查访问权限后重试。`);
}

function isDirectory(fsApi, targetPath, label, options = {}) {
  const followSymlinks = options.followSymlinks !== false;
  try {
    const stat = followSymlinks ? fsApi.statSync(targetPath) : fsApi.lstatSync(targetPath);
    return stat.isDirectory();
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw directoryAccessError(label);
  }
}

function listTrailingSpaceCandidates(fsApi, pathApi, parent, selectedName, label) {
  let entries;
  try {
    entries = fsApi.readdirSync(parent, { withFileTypes: true });
  } catch {
    throw directoryAccessError(label);
  }
  return entries
    .filter((entry) => entry.isDirectory()
      && / +$/.test(entry.name)
      && entry.name.replace(/ +$/, '') === selectedName)
    .map((entry) => pathApi.join(parent, entry.name))
    // Recheck without following symlinks. Inferred recovery must never turn a
    // normalized picker result into an alias for a directory outside `parent`.
    .filter((candidate) => isDirectory(fsApi, candidate, label, { followSymlinks: false }));
}

function resolveSelectedDirectory(input, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const label = String(options.label || '文件夹');
  if (typeof input !== 'string' || !input.trim()) {
    throw selectionError('DIRECTORY_REQUIRED', `请选择${label}。`);
  }
  if (input.includes('\0')) {
    throw selectionError('DIRECTORY_PATH_INVALID', `${label}路径格式无效。`);
  }

  // Preserve the native path verbatim. POSIX filesystems allow directory names
  // ending in spaces, so trimming here changes which directory was selected.
  const resolved = pathApi.resolve(input);
  const parent = pathApi.dirname(resolved);
  const selectedName = pathApi.basename(resolved);
  const parentExists = selectedName && isDirectory(fsApi, parent, label);
  const candidates = parentExists && !/ +$/.test(selectedName)
    ? listTrailingSpaceCandidates(fsApi, pathApi, parent, selectedName, label)
    : [];

  if (isDirectory(fsApi, resolved, label)) {
    // If both `name` and `name ` exist, a normalized picker result cannot prove
    // which one the user chose. Reject instead of silently importing the sibling.
    if (candidates.length) {
      throw selectionError(
        'DIRECTORY_TRAILING_SPACE_AMBIGUOUS',
        `${label}路径存在系统可能无法区分的同名目录。请将目录重命名为不以空格结尾后重试。`,
      );
    }
    return { path: resolved, recoveredTrailingSpaces: false };
  }
  if (fsApi.existsSync(resolved)) {
    throw selectionError('DIRECTORY_NOT_DIRECTORY', `请选择存在的${label}，不要选择单个文件。`);
  }
  if (!parentExists) {
    throw selectionError('DIRECTORY_NOT_FOUND', `未找到${label}。请重新选择，或将目录名末尾的空格移除后重试。`);
  }

  // Some native pickers can return a path with trailing ASCII spaces removed.
  // Recover only within the selected parent and only when there is one exact,
  // directory-only match. Never guess when two names collapse to the same text.

  if (candidates.length === 1) {
    return { path: candidates[0], recoveredTrailingSpaces: true };
  }
  if (candidates.length > 1) {
    throw selectionError(
      'DIRECTORY_TRAILING_SPACE_AMBIGUOUS',
      `${label}路径的末尾空格被系统省略，且存在多个同名目录。请将目录重命名为不以空格结尾后重试。`,
    );
  }
  throw selectionError('DIRECTORY_NOT_FOUND', `未找到${label}。请重新选择，或将目录名末尾的空格移除后重试。`);
}

module.exports = { resolveSelectedDirectory };
