// 飞书妙记转写拉取：给一个妙记链接，用本机已登录的 lark-cli 拉逐字稿文本。
// 命令（已在本机核实 v1.0.56 的 --help）：lark-cli vc +notes --minute-tokens <token> --format json --overwrite
// 产物默认落在 {cwd}/minutes/{token}/，逐字稿是 transcript.txt。
// 安全：token 严格 ^[A-Za-z0-9]+$ 白名单，杜绝拼进 shell 的注入；临时目录用完即删。
// 拉不动（没装/没登录/没权限）就抛人话错误，UI 引导改用粘贴——粘贴路径永远可用。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 从妙记链接里抠出 minute token（pathname 最后一段）。非法返回 null。
function extractMinuteToken(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const token = segments[segments.length - 1] || '';
  return /^[A-Za-z0-9]+$/.test(token) ? token : null;
}

// 默认执行器：走 /bin/zsh -lc（lark-cli 装在 fnm 的 multishell 路径下，Electron 子进程的
// 裸 PATH 里没有它，必须借登录 shell 的环境）。2 分钟超时。
function defaultRunCli({ command, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', ['-lc', command], { cwd, timeout: 120000, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// 拉一条妙记的逐字稿全文。options.runCli 可注入（测试用假执行器，不真起子进程）。
async function fetchMinutesTranscript(sourceUrl, options = {}) {
  const runCli = options.runCli || defaultRunCli;
  const token = extractMinuteToken(sourceUrl);
  if (!token) {
    throw new Error('这不像一个妙记链接（网址最后一段应是字母数字的编号）。核对链接，或直接把转写文本粘贴进来。');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-minutes-'));
  try {
    // token 已过白名单（纯字母数字），拼进命令是安全的。
    const command = `lark-cli vc +notes --minute-tokens ${token} --format json --overwrite`;
    const result = await runCli({ command, cwd: tmpDir });
    const transcriptPath = path.join(tmpDir, 'minutes', token, 'transcript.txt');
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().slice(0, 200);
      throw new Error(`妙记拉取失败（${detail || '命令返回非零'}）。可能是飞书命令行没登录或没有该妙记的权限，请打开妙记复制转写文本，粘贴进来。`);
    }
    if (!fs.existsSync(transcriptPath)) {
      throw new Error('妙记拉取命令跑完了，但没拿到逐字稿文件——这条妙记可能还没生成智能转写。请打开妙记复制转写文本，粘贴进来。');
    }
    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    if (!transcript.trim()) {
      throw new Error('妙记逐字稿是空的。请打开妙记确认有转写内容，或直接粘贴文本。');
    }
    return transcript;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { extractMinuteToken, fetchMinutesTranscript };
