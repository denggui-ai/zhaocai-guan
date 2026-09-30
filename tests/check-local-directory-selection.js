
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveSelectedDirectory } = require("../src/local-directory-selection");

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-directory-selection-'));

try {
  const regular = path.join(root, 'regular');
  const exactTrailing = path.join(root, 'exact-trailing ');
  fs.mkdirSync(regular);
  fs.mkdirSync(exactTrailing);

  assert.deepEqual(resolveSelectedDirectory(regular, { label: '合成文件夹' }), {
    path: regular,
    recoveredTrailingSpaces: false,
  });
  assert.deepEqual(resolveSelectedDirectory(exactTrailing, { label: '合成文件夹' }), {
    path: exactTrailing,
    recoveredTrailingSpaces: false,
  }, 'an exact POSIX path ending in a space must never be trimmed');

  const recoveredTrailing = path.join(root, 'picker-normalized ');
  fs.mkdirSync(recoveredTrailing);
  assert.deepEqual(resolveSelectedDirectory(path.join(root, 'picker-normalized'), { label: '合成文件夹' }), {
    path: recoveredTrailing,
    recoveredTrailingSpaces: true,
  }, 'one unambiguous trailing-space directory should be recovered');

  fs.mkdirSync(path.join(root, 'ambiguous-exact'));
  fs.mkdirSync(path.join(root, 'ambiguous-exact '));
  assert.throws(
    () => resolveSelectedDirectory(path.join(root, 'ambiguous-exact'), { label: '合成文件夹' }),
    (error) => error.code === 'DIRECTORY_TRAILING_SPACE_AMBIGUOUS',
    'an exact name and its trailing-space sibling are ambiguous after picker normalization',
  );

  fs.mkdirSync(path.join(root, 'ambiguous '));
  fs.mkdirSync(path.join(root, 'ambiguous  '));
  assert.throws(
    () => resolveSelectedDirectory(path.join(root, 'ambiguous'), { label: '合成文件夹' }),
    (error) => error.code === 'DIRECTORY_TRAILING_SPACE_AMBIGUOUS' && /重命名/.test(error.message),
    'multiple trailing-space matches must fail closed with an actionable message',
  );

  const plainFile = path.join(root, 'plain-file');
  fs.writeFileSync(plainFile, 'synthetic');
  assert.throws(
    () => resolveSelectedDirectory(plainFile, { label: '合成文件夹' }),
    (error) => error.code === 'DIRECTORY_NOT_DIRECTORY',
  );
  assert.throws(
    () => resolveSelectedDirectory(path.join(root, 'missing'), { label: '合成文件夹' }),
    (error) => error.code === 'DIRECTORY_NOT_FOUND' && /末尾的空格/.test(error.message),
  );

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-directory-outside-'));
  const inferredSymlink = path.join(root, 'symlink-alias ');
  fs.symlinkSync(outside, inferredSymlink, 'dir');
  assert.throws(
    () => resolveSelectedDirectory(path.join(root, 'symlink-alias'), { label: '合成文件夹' }),
    (error) => error.code === 'DIRECTORY_NOT_FOUND',
    'inferred trailing-space recovery must reject directory symlinks',
  );
  assert.deepEqual(resolveSelectedDirectory(inferredSymlink, { label: '合成文件夹' }), {
    path: inferredSymlink,
    recoveredTrailingSpaces: false,
  }, 'an exact, explicitly selected directory symlink keeps the pre-existing behavior');
  fs.rmSync(outside, { recursive: true, force: true });

  const deniedFs = {
    ...fs,
    readdirSync() {
      const error = new Error('EACCES: SECRET_PATH must not escape');
      error.code = 'EACCES';
      throw error;
    },
  };
  assert.throws(
    () => resolveSelectedDirectory(path.join(root, 'access-denied'), { label: '合成文件夹', fsApi: deniedFs }),
    (error) => error.code === 'DIRECTORY_ACCESS_FAILED'
      && /检查访问权限/.test(error.message)
      && !/SECRET_PATH/.test(error.message)
      && !error.message.includes(root),
    'filesystem errors returned to the renderer must not expose absolute paths',
  );
  assert.throws(
    () => resolveSelectedDirectory('   ', { label: '合成文件夹' }),
    (error) => error.code === 'DIRECTORY_REQUIRED',
  );

  const actionServerSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
  const candidateMainSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
  assert.match(actionServerSource, /resolveSelectedDirectory\(body\.dir, \{ label: '截图文件夹' \}\)/);
  assert.doesNotMatch(actionServerSource, /(?:const|let)\s+dir\s*=.*body\.dir\.trim\(\)/, 'action server must not strip legal trailing spaces');
  assert.match(candidateMainSource, /resolveSelectedDirectory\(result\.filePaths\[0\], \{ label: '截图文件夹' \}\)/);

  console.log('PASS local directory selection contract');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
