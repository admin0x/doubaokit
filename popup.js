// popup.js · 弹窗交互逻辑：账号列表渲染、添加与切换（豆包 / Dola 双站点）
// @author Li · GPL-3.0 · https://github.com/admin0x/doubaokit

// 受支持站点（background 注册表的裁剪副本：弹窗只需 id / label / hosts）
const SITES = [
  { id: 'doubao', label: '豆包', hosts: ['doubao.com'] },
  { id: 'dola', label: 'Dola', hosts: ['dola.com'] },
];

// 按域名判定站点，非受支持站点返回 null
function getSiteByHost(host) {
  const hostname = String(host || '')
    .replace(/^www\./, '')
    .toLowerCase();
  if (!hostname) return null;
  return (
    SITES.find((site) =>
      site.hosts.some((base) => hostname === base || hostname.endsWith(`.${base}`)),
    ) || null
  );
}

const accountList = document.getElementById('accountList');
const countText = document.getElementById('countText');
const statusText = document.getElementById('statusText');
const pendingPanel = document.getElementById('pendingPanel');
const startLoginBtn = document.getElementById('startLoginBtn');
const saveCurrentBtn = document.getElementById('saveCurrentBtn');
const finishLoginBtn = document.getElementById('finishLoginBtn');
const cancelLoginBtn = document.getElementById('cancelLoginBtn');
const currentAccountBody = document.getElementById('currentAccountBody');
const accountManager = document.getElementById('accountManager');
const dialogLayer = document.getElementById('dialogLayer');
const dialogIcon = document.getElementById('dialogIcon');
const dialogTitle = document.getElementById('dialogTitle');
const dialogText = document.getElementById('dialogText');
const dialogInput = document.getElementById('dialogInput');
const dialogActions = document.getElementById('dialogActions');
const dialogCancelBtn = document.getElementById('dialogCancel');
const dialogConfirmBtn = document.getElementById('dialogConfirm');
const siteTag = document.getElementById('siteTag');
const actionWarning = document.getElementById('actionWarning');

// 当前生效账号的 id
let currentAccountId = '';
// 当前标签页是否已登录
let isCurrentLoggedIn = false;
// 弹窗是否处于受支持站点，非受支持站点不刷新数据
let accountUiActive = false;
// 当前标签页所属站点，所有请求都带上，避免后台猜错站点
let currentSite = null;

// 向后台发消息并带上当前站点 id
function send(type, payload = {}) {
  const message = { type, siteId: currentSite?.id || '', ...payload };
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || '操作失败');
    return response;
  });
}

// 统一 UI 提示窗，替代原生 alert / confirm / prompt
// 提示窗图标：按提示语气选择
const DIALOG_ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  warning: '<path d="M12 3 2.7 19h18.6L12 3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  danger: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5h.01"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
};

// 关闭提示窗，等动画结束再隐藏
function closeDialog() {
  dialogLayer.classList.remove('open');
  setTimeout(() => dialogLayer.classList.add('hidden'), 240);
}

// 打开提示窗，confirm 返回布尔、prompt 返回字符串
function openDialog({
  title = '提示',
  message = '',
  tone = 'info',
  confirmText = '确定',
  cancelText = '',
  input = null,
} = {}) {
  return new Promise((resolve) => {
    dialogIcon.className = `dialog-icon ${tone}`;
    dialogIcon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DIALOG_ICONS[tone] || DIALOG_ICONS.info}</svg>`;
    dialogTitle.textContent = title;
    dialogText.textContent = message || '';

    const hasInput = Boolean(input);
    dialogInput.classList.toggle('hidden', !hasInput);
    dialogInput.value = hasInput ? input.defaultValue || '' : '';
    dialogInput.placeholder = hasInput ? input.placeholder || '' : '';
    dialogInput.maxLength = hasInput && input.maxLength ? input.maxLength : 40;

    const hasCancel = Boolean(cancelText);
    dialogActions.classList.toggle('single', !hasCancel);
    dialogCancelBtn.classList.toggle('hidden', !hasCancel);
    dialogCancelBtn.textContent = cancelText || '取消';
    dialogConfirmBtn.textContent = confirmText;
    dialogConfirmBtn.classList.toggle('danger', tone === 'danger');

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialogConfirmBtn.removeEventListener('click', submit);
      dialogCancelBtn.removeEventListener('click', cancel);
      dialogLayer.querySelector('[data-role="backdrop"]').removeEventListener('click', cancel);
      document.removeEventListener('keydown', onKeyDown, true);
      closeDialog();
      resolve(value);
    };
    const submit = () => {
      if (hasInput) {
        const value = dialogInput.value.trim();
        if (!value) {
          dialogInput.focus();
          return;
        }
        finish(value);
        return;
      }
      finish(true);
    };
    const cancel = () => finish(hasInput ? null : false);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    };

    dialogConfirmBtn.addEventListener('click', submit);
    dialogCancelBtn.addEventListener('click', cancel);
    dialogLayer.querySelector('[data-role="backdrop"]').addEventListener('click', cancel);
    document.addEventListener('keydown', onKeyDown, true);

    dialogLayer.classList.remove('hidden');
    requestAnimationFrame(() => dialogLayer.classList.add('open'));
    setTimeout(() => {
      if (hasInput) {
        dialogInput.focus();
        dialogInput.select();
      } else {
        dialogConfirmBtn.focus();
      }
    }, 60);
  });
}

// 确认窗，返回布尔
const uiConfirm = (options = {}) =>
  openDialog({
    title: options.title || '请确认',
    message: options.message || '',
    tone: options.tone || 'warning',
    confirmText: options.confirmText || '确定',
    cancelText: options.cancelText || '取消',
  });

// 输入窗，返回字符串或 null
const uiPrompt = (options = {}) =>
  openDialog({
    title: options.title || '输入内容',
    message: options.message || '',
    tone: options.tone || 'info',
    confirmText: options.confirmText || '确定',
    cancelText: options.cancelText || '取消',
    input: {
      defaultValue: options.defaultValue || '',
      placeholder: options.placeholder || '',
      maxLength: options.maxLength || 40,
    },
  });

// 更新底部状态文案
function setStatus(text) {
  statusText.textContent = text || '';
}

// 时间格式化，非法值原样返回
function formatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

// HTML 转义，避免账号名破坏结构
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

// 取头像占位文字，缺省用「豆」
function getInitial(name) {
  return (
    String(name || '豆')
      .trim()
      .slice(0, 1)
      .toUpperCase() || '豆'
  );
}

// 渲染头像，无头像时显示占位字符
function renderAvatar(account) {
  if (account.avatarUrl) {
    return `<img class="account-avatar" src="${escapeHtml(account.avatarUrl)}" alt="${escapeHtml(account.name || '账号头像')}" referrerpolicy="no-referrer">`;
  }
  return `<div class="account-avatar fallback">${escapeHtml(getInitial(account.name))}</div>`;
}

// 渲染当前使用账号卡片
function renderCurrentAccount(account) {
  if (!account) {
    currentAccountBody.innerHTML = `
      <div class="current-empty">
        <strong>未记录当前账号</strong>
        <span>保存或切换账号后会在这里显示</span>
      </div>
    `;
    return;
  }
  currentAccountBody.innerHTML = `
    <div class="account-main">
      ${renderAvatar(account)}
      <div class="account-info">
        <div class="account-name">${escapeHtml(account.name || '未命名账号')}</div>
        <div class="account-meta">${account.mobile ? `${escapeHtml(account.mobile)} · ` : ''}${account.cookies?.length || 0} 个 Cookie</div>
      </div>
    </div>
  `;
}

// 渲染账号列表
function renderAccounts(accounts) {
  countText.textContent = `${accounts.length} 个`;
  if (accounts.length === 0) {
    accountList.innerHTML = '<div class="empty">还没有账号。点击“添加账号”开始。</div>';
    return;
  }
  accountList.innerHTML = accounts
    .map(
      (account) => `
    <article class="account-card ${account.id === currentAccountId ? 'current' : ''}" data-id="${escapeHtml(account.id)}">
      <div class="account-main">
        ${renderAvatar(account)}
        <div class="account-info">
          <div class="account-name">${escapeHtml(account.name || '未命名账号')}${account.id === currentAccountId ? '<span class="current-badge">当前</span>' : ''}</div>
          <div class="account-meta">${account.mobile ? `${escapeHtml(account.mobile)} · ` : ''}${account.cookies?.length || 0} 个 Cookie · ${escapeHtml(formatTime(account.updatedAt || account.createdAt))}</div>
        </div>
      </div>
      <div class="card-actions">
        <button data-action="switch" type="button">切换</button>
        <button data-action="rename" type="button">改名</button>
        <button class="danger" data-action="delete" type="button">删除</button>
      </div>
    </article>
  `,
    )
    .join('');
}

// 拉取后台数据并刷新整个弹窗
async function refresh() {
  const response = await send('LIST_ACCOUNTS');
  currentAccountId = response.currentAccount?.id || '';
  isCurrentLoggedIn = Boolean(response.canSaveCurrentAccount);
  pendingPanel.classList.toggle('hidden', !response.pendingLogin);
  startLoginBtn.disabled = Boolean(response.pendingLogin);
  saveCurrentBtn.disabled = Boolean(
    response.pendingLogin || response.currentAccount || !response.canSaveCurrentAccount,
  );
  saveCurrentBtn.textContent = response.currentAccount ? '当前已保存' : '保存当前账号';
  saveCurrentBtn.title = response.currentAccount
    ? '当前账号已经在账号列表中'
    : response.canSaveCurrentAccount
      ? ''
      : `当前${currentSite?.label || ''}账号未登录`;
  renderCurrentAccount(response.currentAccount || null);
  renderAccounts(response.accounts || []);
}

// 统一执行动作：处理中 → 刷新 → 提示结果
async function runAction(action) {
  try {
    setStatus('处理中...');
    await action();
    await refresh();
    setStatus('已完成');
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

// 添加账号：先清掉当前登录态，再打开登录窗口
startLoginBtn.addEventListener('click', async () => {
  if (isCurrentLoggedIn) {
    const confirmed = await uiConfirm({
      title: '继续添加账号？',
      message: `添加账号会退出当前${currentSite?.label || ''}账号。\n如需保留当前账号，请先取消，再点击“保存当前账号”。`,
      tone: 'warning',
      confirmText: '继续添加',
      cancelText: '取消',
    });
    if (!confirmed) return;
  }
  runAction(async () => {
    await send('START_QR_LOGIN');
    setStatus('已打开账号登录窗口');
  });
});

// 保存当前账号
saveCurrentBtn.addEventListener('click', () =>
  runAction(async () => {
    await send('SAVE_CURRENT');
  }),
);

// 兜底收尾：立即保存并关闭登录窗口
finishLoginBtn.addEventListener('click', () =>
  runAction(async () => {
    await send('FINISH_QR_LOGIN', { restorePrevious: false });
  }),
);

// 取消添加账号，恢复登录前的账号
cancelLoginBtn.addEventListener('click', () =>
  runAction(async () => {
    await send('CANCEL_QR_LOGIN');
  }),
);

// 后台数据变化时自动刷新，保持多窗口一致
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!accountUiActive) return;
  if (areaName !== 'local') return;
  if (!changes.accounts && !changes.pendingLogin && !changes.currentAccountId) return;
  refresh().catch((error) => setStatus(error.message || String(error)));
});

// 账号卡片操作：切换 / 改名 / 删除
accountList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('.account-card');
  if (!button || !card) return;

  const accountId = card.dataset.id;
  const action = button.dataset.action;
  runAction(async () => {
    if (action === 'switch') {
      await send('SWITCH_ACCOUNT', { accountId });
      return;
    }
    if (action === 'rename') {
      const name = await uiPrompt({
        title: '重命名账号',
        message: '输入新的账号名称',
        placeholder: '账号名称',
        confirmText: '保存',
      });
      if (!name) return;
      await send('RENAME_ACCOUNT', { accountId, name });
      return;
    }
    if (action === 'delete') {
      const confirmed = await uiConfirm({
        title: '删除账号？',
        message: '删除后该账号的登录快照将无法恢复，需要重新添加。',
        tone: 'danger',
        confirmText: '删除',
        cancelText: '取消',
      });
      if (!confirmed) return;
      await send('DELETE_ACCOUNT', { accountId });
    }
  });
});

// 按站点刷新界面文案
function applySite(site) {
  currentSite = site;
  if (!site) return;
  siteTag.textContent = site.label;
  actionWarning.textContent = `添加账号会退出当前${site.label}账号。若需要保留当前账号，请先点击“保存当前账号”。`;
  document.title = `${site.label}助手 · 账号管理`;
}

// 入口：识别当前标签页站点，受支持才加载账号数据
async function initPopup() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  let hostname = '';
  try {
    hostname = new URL(activeTab?.url || '').hostname.replace(/^www\./, '');
  } catch {
    // 无 URL 或非法地址时保持 hostname 为空
  }

  const site = getSiteByHost(hostname);
  accountUiActive = Boolean(site);
  accountManager.classList.toggle('hidden', !site);
  applySite(site);

  if (site) {
    await refresh();
  }
}

initPopup().catch((error) => setStatus(error.message || String(error)));
