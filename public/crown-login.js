const dialog = document.getElementById('crown-login-dialog');
const openButton = document.getElementById('crown-login-open');
const closeButton = document.getElementById('crown-login-close');
const startButton = document.getElementById('crown-login-window-start');
const verifyButton = document.getElementById('crown-login-verify');
const cancelButton = document.getElementById('crown-login-cancel');
const clearButton = document.getElementById('crown-login-clear');
const statusText = document.getElementById('crown-login-status');
const topLabel = document.getElementById('crown-session-label');
let polling = false;
let working = false;
let timer;

function timestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function render(state) {
  const hasSession = state.hasSession === true;
  const browserOpen = state.browserOpen === true;
  const health = state.sessionHealth || 'unknown';
  topLabel.textContent = !hasSession ? '皇冠会话未保存'
    : health === 'valid' ? '皇冠会话在线'
      : health === 'expired' ? '皇冠会话失效'
        : health === 'unavailable' ? '皇冠状态待确认' : '皇冠会话已保存';
  topLabel.dataset.state = health === 'expired' ? 'error' : health === 'valid' ? 'success' : health === 'unavailable' ? 'pending' : '';
  startButton.disabled = working || browserOpen;
  startButton.textContent = browserOpen ? state.automaticRecovery ? '恢复窗口已打开' : '登录窗口已打开' : health === 'expired' ? '重新登录皇冠' : '打开皇冠登录窗口';
  verifyButton.disabled = working || state.canVerify !== true;
  verifyButton.textContent = state.automaticRecovery ? '登录后验证并保存' : browserOpen || !hasSession ? '验证并保存会话' : '重新验证保存的会话';
  cancelButton.hidden = !browserOpen;
  cancelButton.disabled = working;
  clearButton.disabled = working || !hasSession;

  let message = state.message || '';
  if (state.stage === 'idle' && !hasSession) message = '打开登录窗口并完成皇冠登录，程序会自动验证、保存会话并开始采集。';
  if (state.stage === 'waiting' && !message) message = '请在新开的 Chrome 窗口中完成皇冠登录。';
  if (state.stage === 'waiting' && state.message && !state.canVerify) message = `${state.message} 登录后请等待会员页面完成在线校验。`;
  if (state.stage === 'recovering') message = state.message || '皇冠会话已失效。请在恢复窗口完成登录，程序会自动验证并保存。';
  if (state.stage === 'expired') message = state.message || '皇冠确认本机会话已失效。';
  if (state.stage === 'unavailable') message = state.message || '网络暂时无法确认会话状态，已保留本机会话并会稍后重试。';
  if (state.stage === 'saved' && health === 'valid') message = '皇冠在线验证通过，会话已加密保存，后台正在采集最新水位。';
  if (state.stage === 'idle' && hasSession) message = `本机已有保存会话${state.lastSavedAt ? `，保存时间：${timestamp(state.lastSavedAt)}` : ''}。可重新验证其有效性。`;
  if (state.networkErrorCode) message += `（网络错误码：${state.networkErrorCode}）`;
  if (hasSession && state.stage !== 'saved' && state.lastSavedAt && state.stage !== 'verifying') message += ` 最近保存：${timestamp(state.lastSavedAt)}。`;
  statusText.textContent = message;
  statusText.dataset.state = ['saved'].includes(state.stage) ? 'success' : state.stage === 'error' ? 'error' : '';
}

async function getStatus() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/api/crown/login/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    render(await response.json());
  } catch {
    topLabel.textContent = '皇冠状态不可用';
    statusText.textContent = '无法读取本机皇冠登录状态。';
    statusText.dataset.state = 'error';
  } finally { polling = false; }
}

async function post(action) {
  if (working) return;
  working = true;
  statusText.dataset.state = '';
  statusText.textContent = action === 'verify' ? '正在验证皇冠会话，请稍候。' : '正在处理。';
  renderControlsOnly();
  try {
    const response = await fetch(`/api/crown/login/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(action === 'verify' ? 20000 : 50000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作未完成。');
    render(result);
  } catch (error) {
    statusText.textContent = error.message || '操作未完成，请重试。';
    statusText.dataset.state = 'error';
  } finally {
    working = false;
    await getStatus();
  }
}

function renderControlsOnly() {
  startButton.disabled = true;
  verifyButton.disabled = true;
  cancelButton.disabled = true;
  clearButton.disabled = true;
}

openButton.addEventListener('click', async () => {
  dialog.showModal();
  await getStatus();
  timer = setInterval(() => void getStatus(), 1800);
});
closeButton.addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { clearInterval(timer); timer = undefined; });
startButton.addEventListener('click', () => void post('start'));
verifyButton.addEventListener('click', () => void post('verify'));
cancelButton.addEventListener('click', () => void post('cancel'));
clearButton.addEventListener('click', () => {
  if (window.confirm('删除本机保存的皇冠会话？')) void post('clear');
});

void getStatus();
// Keep the toolbar truthful when auto-login completes with the dialog closed.
setInterval(() => { if (!dialog.open && !document.hidden) void getStatus(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void getStatus(); });
