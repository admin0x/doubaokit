// popup.js · 弹窗交互逻辑：账号列表渲染、添加与切换（豆包 / Dola 双站点）
// @author Li · GPL-3.0 · https://github.com/admin0x/doubaokit

const SITES = [
  { id: 'doubao', label: '豆包', hosts: ['doubao.com'] },
  { id: 'dola', label: 'Dola', hosts: ['dola.com'] },
];

const getSiteByHost = (host) => {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (!h) return null;
  return SITES.find((s) => s.hosts.some((b) => h === b || h.endsWith(`.${b}`))) || null;
};

// 元素 id 与变量名分开写：变量名不必等于 id，避免错配
const $ = (id) => document.getElementById(id);
const el = {
  accountList: $('accountList'),
  countText: $('countText'),
  statusText: $('statusText'),
  pendingPanel: $('pendingPanel'),
  startLoginBtn: $('startLoginBtn'),
  saveCurrentBtn: $('saveCurrentBtn'),
  finishLoginBtn: $('finishLoginBtn'),
  cancelLoginBtn: $('cancelLoginBtn'),
  currentAccountBody: $('currentAccountBody'),
  accountManager: $('accountManager'),
  dialogLayer: $('dialogLayer'),
  dialogIcon: $('dialogIcon'),
  dialogTitle: $('dialogTitle'),
  dialogText: $('dialogText'),
  dialogInput: $('dialogInput'),
  dialogActions: $('dialogActions'),
  dialogCancelBtn: $('dialogCancel'),
  dialogConfirmBtn: $('dialogConfirm'),
  siteTag: $('siteTag'),
  actionWarning: $('actionWarning'),
};
const {
  accountList, countText, statusText, pendingPanel, startLoginBtn,
  saveCurrentBtn, finishLoginBtn, cancelLoginBtn, currentAccountBody,
  accountManager, dialogLayer, dialogIcon, dialogTitle, dialogText,
  dialogInput, dialogActions, dialogCancelBtn, dialogConfirmBtn,
  siteTag, actionWarning,
} = el;

let currentAccountId = '';
let isCurrentLoggedIn = false;
let accountUiActive = false;
let currentSite = null;

function send(type, payload = {}) {
  return chrome.runtime
    .sendMessage({ type, siteId: currentSite?.id || '', ...payload })
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || '操作失败');
      return response;
    });
}

const DIALOG_ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  warning: '<path d="M12 3 2.7 19h18.6L12 3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  danger: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5h.01"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
};

const closeDialog = () => {
  dialogLayer.classList.remove('open');
  setTimeout(() => dialogLayer.classList.add('hidden'), 240);
};

function openDialog({
  title = '提示', message = '', tone = 'info',
  confirmText = '确定', cancelText = '', input = null,
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
        if (!value) return dialogInput.focus();
        return finish(value);
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
      if (hasInput) { dialogInput.focus(); dialogInput.select(); }
      else dialogConfirmBtn.focus();
    }, 60);
  });
}

const uiConfirm = (o = {}) =>
  openDialog({
    title: o.title || '请确认', message: o.message || '',
    tone: o.tone || 'warning',
    confirmText: o.confirmText || '确定', cancelText: o.cancelText || '取消',
  });

const uiPrompt = (o = {}) =>
  openDialog({
    title: o.title || '输入内容', message: o.message || '',
    tone: o.tone || 'info',
    confirmText: o.confirmText || '确定', cancelText: o.cancelText || '取消',
    input: {
      defaultValue: o.defaultValue || '',
      placeholder: o.placeholder || '',
      maxLength: o.maxLength || 40,
    },
  });

const setStatus = (text) => { statusText.textContent = text || ''; };

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const formatTime = (value) => {
  if (!value) return '';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
};

const getInitial = (name) =>
  (String(name || '豆').trim().slice(0, 1).toUpperCase() || '豆');

const renderAvatar = (account) =>
  account.avatarUrl
    ? `<img class="account-avatar" src="${escapeHtml(account.avatarUrl)}" alt="${escapeHtml(account.name || '账号头像')}" referrerpolicy="no-referrer">`
    : `<div class="account-avatar fallback">${escapeHtml(getInitial(account.name))}</div>`;

function renderCurrentAccount(account) {
  currentAccountBody.innerHTML = account
    ? `<div class="account-main">
        ${renderAvatar(account)}
        <div class="account-info">
          <div class="account-name">${escapeHtml(account.name || '未命名账号')}</div>
          <div class="account-meta">${account.mobile ? `${escapeHtml(account.mobile)} · ` : ''}${account.cookies?.length || 0} 个 Cookie</div>
        </div>
      </div>`
    : `<div class="current-empty">
        <strong>未记录当前账号</strong>
        <span>保存或切换账号后会在这里显示</span>
      </div>`;
}

function renderAccounts(accounts) {
  countText.textContent = `${accounts.length} 个`;
  if (!accounts.length) {
    accountList.innerHTML = '<div class="empty">还没有账号。点击“添加账号”开始。</div>';
    return;
  }
  accountList.innerHTML = accounts
    .map((account) => {
      const isCurrent = account.id === currentAccountId;
      return `
    <article class="account-card ${isCurrent ? 'current' : ''}" data-id="${escapeHtml(account.id)}">
      <div class="account-main">
        ${renderAvatar(account)}
        <div class="account-info">
          <div class="account-name">${escapeHtml(account.name || '未命名账号')}${isCurrent ? '<span class="current-badge">当前</span>' : ''}</div>
          <div class="account-meta">${account.mobile ? `${escapeHtml(account.mobile)} · ` : ''}${account.cookies?.length || 0} 个 Cookie · ${escapeHtml(formatTime(account.updatedAt || account.createdAt))}</div>
        </div>
      </div>
      <div class="card-actions">
        <button data-action="switch" type="button">切换</button>
        <button data-action="rename" type="button">改名</button>
        <button class="danger" data-action="delete" type="button">删除</button>
      </div>
    </article>`;
    })
    .join('');
}

async function refresh() {
  const r = await send('LIST_ACCOUNTS');
  currentAccountId = r.currentAccount?.id || '';
  isCurrentLoggedIn = Boolean(r.canSaveCurrentAccount);
  pendingPanel.classList.toggle('hidden', !r.pendingLogin);
  startLoginBtn.disabled = Boolean(r.pendingLogin);
  saveCurrentBtn.disabled = Boolean(r.pendingLogin || r.currentAccount || !r.canSaveCurrentAccount);
  saveCurrentBtn.textContent = r.currentAccount ? '当前已保存' : '保存当前账号';
  saveCurrentBtn.title = r.currentAccount
    ? '当前账号已经在账号列表中'
    : r.canSaveCurrentAccount ? '' : `当前${currentSite?.label || ''}账号未登录`;
  renderCurrentAccount(r.currentAccount || null);
  renderAccounts(r.accounts || []);
}

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

startLoginBtn.addEventListener('click', async () => {
  if (isCurrentLoggedIn) {
    const confirmed = await uiConfirm({
      title: '继续添加账号？',
      message: `添加账号会退出当前${currentSite?.label || ''}账号。\n如需保留当前账号，请先取消，再点击“保存当前账号”。`,
      tone: 'warning',
      confirmText: '继续添加', cancelText: '取消',
    });
    if (!confirmed) return;
  }
  runAction(async () => {
    await send('START_QR_LOGIN');
    setStatus('已打开账号登录窗口');
  });
});

saveCurrentBtn.addEventListener('click', () => runAction(() => send('SAVE_CURRENT')));
finishLoginBtn.addEventListener('click', () =>
  runAction(() => send('FINISH_QR_LOGIN', { restorePrevious: false })));
cancelLoginBtn.addEventListener('click', () => runAction(() => send('CANCEL_QR_LOGIN')));

let refreshTimer = null;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!accountUiActive || areaName !== 'local') return;
  if (!changes.accounts && !changes.pendingLogin && !changes.currentAccountId) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch((error) => setStatus(error.message || String(error)));
  }, 50);
});

accountList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('.account-card');
  if (!button || !card) return;

  const accountId = card.dataset.id;
  const action = button.dataset.action;
  runAction(async () => {
    if (action === 'switch') return send('SWITCH_ACCOUNT', { accountId });
    if (action === 'rename') {
      const name = await uiPrompt({
        title: '重命名账号', message: '输入新的账号名称',
        placeholder: '账号名称', confirmText: '保存',
      });
      if (name) await send('RENAME_ACCOUNT', { accountId, name });
      return;
    }
    if (action === 'delete') {
      const confirmed = await uiConfirm({
        title: '删除账号？',
        message: '删除后该账号的登录快照将无法恢复，需要重新添加。',
        tone: 'danger', confirmText: '删除', cancelText: '取消',
      });
      if (confirmed) await send('DELETE_ACCOUNT', { accountId });
    }
  });
});

function applySite(site) {
  currentSite = site;
  if (!site) return;
  siteTag.textContent = site.label;
  actionWarning.textContent = `添加账号会退出当前${site.label}账号。若需要保留当前账号，请先点击“保存当前账号”。`;
  document.title = `${site.label}助手 · 账号管理`;
}

async function initPopup() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = '';
  try {
    hostname = new URL(activeTab?.url || '').hostname.replace(/^www\./, '');
  } catch {}
  const site = getSiteByHost(hostname);
  accountUiActive = Boolean(site);
  accountManager.classList.toggle('hidden', !site);
  applySite(site);
  if (site) await refresh();
}

initPopup().catch((error) => setStatus(error.message || String(error)));