// background.js · Chrome 扩展后台服务：Cookie 读写、账号存储与页面重载
// @author Li · GPL-3.0 · https://github.com/admin0x/doubaokit

const SITES = [
  {
    id: 'doubao', label: '豆包',
    chatUrl: 'https://www.doubao.com/chat/',
    tabUrlPatterns: ['https://www.doubao.com/*', 'https://*.doubao.com/*'],
    origins: ['https://www.doubao.com', 'https://doubao.com'],
    cookieDomains: ['doubao.com'],
    hosts: ['doubao.com'],
  },
  {
    id: 'dola', label: 'Dola',
    chatUrl: 'https://www.dola.com/chat/',
    tabUrlPatterns: ['https://www.dola.com/*', 'https://*.dola.com/*'],
    origins: ['https://www.dola.com', 'https://dola.com'],
    cookieDomains: ['dola.com'],
    hosts: ['dola.com'],
  },
];

const DEFAULT_SITE = SITES[0];
const ALL_TAB_URL_PATTERNS = SITES.flatMap((s) => s.tabUrlPatterns);

// ── 站点识别 ──────────────────────────────────────────────────────────────
const normalizeHost = (host) =>
  String(host || '').replace(/^\.|^www\./, '').toLowerCase();

const getSiteByHost = (host) => {
  const h = normalizeHost(host);
  if (!h) return null;
  return SITES.find((s) => s.hosts.some((b) => h === b || h.endsWith(`.${b}`))) || null;
};

const getSiteByUrl = (url) => {
  try { return getSiteByHost(new URL(url).hostname); } catch { return null; }
};

const getSiteById = (id) => SITES.find((s) => s.id === id) || DEFAULT_SITE;
const isSupportedPageUrl = (url) => Boolean(getSiteByUrl(url));

const getAccountSiteId = (a) => getSiteById(a?.site).id;
const scopeAccounts = (list, id) => (list || []).filter((a) => getAccountSiteId(a) === id);

// ── 常量 ──────────────────────────────────────────────────────────────────
const STORAGE_KEYS = {
  accounts: 'accounts',
  pendingLogin: 'pendingLogin',
  currentAccountId: 'currentAccountId',
};

const LOGIN_COOKIE_MIN_COUNT = 2;
const LOGIN_DETECT_DELAY_MS = 1400;
const PROFILE_READY_DELAY_MS = 1800;
const LOGIN_DETECT_ALARM = 'doubaokit-login-detect';
const LOGIN_DETECT_ALARM_PERIOD_MINUTES = 1;
const BADGE_BUSY_COLOR = '#203b27';
const BADGE_SUCCESS_COLOR = '#166534';
const SAFE_FILENAME_PATTERN = /[^a-zA-Z0-9._\-\u4e00-\u9fa5()[\] ]/g;

const STORED_COOKIE_PATTERNS = [
  /^sessionid(_ss)?$/i, /^sid_tt(_ss)?$/i, /^uid_tt(_ss)?$/i, /^sid_guard$/i,
  /^passport_/i, /csrf/i, /session/i, /login/i, /oauth/i, /auth/i, /token/i,
];
const EXCLUDED_COOKIE_PATTERNS = [
  /^__tea_/i, /^_ga/i, /^_tea_/i, /^ttwid$/i, /^msToken$/i, /^ab_version/i, /cache/i,
];

const loginDetectTimers = new Map();
let saveChain = Promise.resolve();
const autoClosingLoginWindows = new Set();

// ── 基础工具 ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function withSaveLock(task) {
  const result = saveChain.then(task, task);
  saveChain = result.then(() => undefined, () => undefined);
  return result;
}

const getStored = async (key, fallback) =>
  (await chrome.storage.local.get(key))[key] ?? fallback;
const setStored = (values) => chrome.storage.local.set(values);

function setBadge(text, color = BADGE_BUSY_COLOR) {
  chrome.action.setBadgeText({ text }).catch(() => null);
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => null);
}

// ── Cookie 身份与匹配 ────────────────────────────────────────────────────
const getCookieIdentity = (c) =>
  [c.name || '', c.domain || '', c.path || '/', c.value || ''].join('\n');
const getCookieFingerprint = (cookies) =>
  (cookies || []).map(getCookieIdentity).sort().join('\n---\n');
const getCookieMatchKey = (c) =>
  `${c.name || ''}|${(c.domain || '').replace(/^\./, '')}|${c.path || '/'}`.toLowerCase();

function getAuthCookieWeight(name) {
  const n = String(name || '').toLowerCase();
  if (/^(sessionid|sessionid_ss|sid_tt|sid_tt_ss|uid_tt|uid_tt_ss)$/.test(n)) return 5;
  if (/session|passport_auth|login|oauth|auth_token|user_token|sid_guard/.test(n)) return 2;
  return 0;
}

function filterAuthCookies(cookies) {
  const list = cookies || [];
  const picked = list.filter((c) => {
    const name = String(c.name || '');
    if (EXCLUDED_COOKIE_PATTERNS.some((p) => p.test(name))) return false;
    return STORED_COOKIE_PATTERNS.some((p) => p.test(name));
  });
  if (picked.length) return picked;
  return list.filter(
    (c) => !EXCLUDED_COOKIE_PATTERNS.some((p) => p.test(String(c.name || ''))),
  );
}

function findSavedAccountByCookies(accounts, cookies) {
  const fingerprint = getCookieFingerprint(filterAuthCookies(cookies));
  if (!fingerprint) return null;

  const exact = (accounts || []).find(
    (a) => getCookieFingerprint(filterAuthCookies(a.cookies || [])) === fingerprint,
  );
  if (exact) return exact;

  const current = new Map(
    (cookies || [])
      .filter((c) => getAuthCookieWeight(c.name) > 0 && c.value)
      .map((c) => [getCookieMatchKey(c), c.value]),
  );
  if (!current.size) return null;

  let best = null;
  let bestScore = 0;
  for (const account of accounts || []) {
    let score = 0;
    let matched = 0;
    for (const cookie of account.cookies || []) {
      const weight = getAuthCookieWeight(cookie.name);
      if (!weight || !cookie.value) continue;
      if (current.get(getCookieMatchKey(cookie)) === cookie.value) {
        score += weight;
        matched += 1;
      }
    }
    if ((score >= 5 || matched >= 2) && score > bestScore) {
      best = account;
      bestScore = score;
    }
  }
  return best;
}

function findSavedAccountByProfile(accounts, profile) {
  if (!profile?.isLoggedIn) return null;
  if (profile.mobile) {
    const hits = (accounts || []).filter((a) => a.mobile === profile.mobile);
    if (hits.length === 1) return hits[0];
  }
  const name = String(profile.name || '').trim();
  if (!name) return null;
  const hits = (accounts || []).filter((a) => String(a.name || '').trim() === name);
  return hits.length === 1 ? hits[0] : null;
}

// ── Cookie 读写 ───────────────────────────────────────────────────────────
const isSameSiteCookie = (cookie, site) =>
  getSiteByHost(cookie.domain)?.id === getSiteById(site?.id).id;

function getCookieSetUrl(cookie, site) {
  const fallbackHost = `www.${getSiteById(site?.id).hosts[0]}`;
  const domain = String(cookie.domain || fallbackHost).replace(/^\./, '');
  return `${cookie.secure ? 'https:' : 'http:'}//${domain}${cookie.path || '/'}`;
}

async function queryCookieRecords(site) {
  const target = getSiteById(site?.id);
  const batches = await Promise.all(
    target.cookieDomains.map((d) => chrome.cookies.getAll({ domain: d }).catch(() => [])),
  );

  const seen = new Set();
  const cookies = [];
  for (const cookie of batches.flat()) {
    if (!isSameSiteCookie(cookie, target)) continue;
    const key = [cookie.name, cookie.domain, cookie.path, cookie.storeId].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    cookies.push(cookie);
  }
  return cookies;
}

async function getSiteCookies(site) {
  const cookies = await queryCookieRecords(site);
  return cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly,
    path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    expirationDate: c.expirationDate, storeId: c.storeId, partitionKey: c.partitionKey,
  }));
}

async function clearSiteCookies(site) {
  const target = getSiteById(site?.id);
  const cookies = await queryCookieRecords(target);
  await Promise.all(
    cookies.map((cookie) => {
      const details = {
        url: getCookieSetUrl(cookie, target),
        name: cookie.name,
        storeId: cookie.storeId,
      };
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      return chrome.cookies.remove(details).catch(() => null);
    }),
  );
}

async function clearSiteData(site) {
  const target = getSiteById(site?.id);
  await clearOpenTabStorage(target);
  await clearSiteCookies(target);
  await chrome.browsingData
    .remove(
      { origins: target.origins },
      {
        cacheStorage: true, cookies: true, fileSystems: true, indexedDB: true,
        localStorage: true, serviceWorkers: true, webSQL: true,
      },
    )
    .catch(() => null);
  await clearSiteCookies(target);
}

async function restoreCookies(cookies, site) {
  const target = getSiteById(site?.id);
  await clearSiteData(target);
  for (const cookie of cookies || []) {
    const details = {
      url: getCookieSetUrl(cookie, target),
      name: cookie.name, value: cookie.value, path: cookie.path || '/',
      secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite || 'unspecified',
    };
    if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    await chrome.cookies.set(details).catch(() => null);
  }
}

// ── 标签页管理 ────────────────────────────────────────────────────────────
const querySiteTabs = (site) =>
  chrome.tabs.query({ url: site ? site.tabUrlPatterns : ALL_TAB_URL_PATTERNS });

async function updateActionAvailability(tabId, url) {
  if (!Number.isInteger(tabId)) return;
  const site = getSiteByUrl(url);
  if (site) {
    await chrome.action.enable(tabId).catch(() => null);
    await chrome.action
      .setTitle({ tabId, title: `${site.label}助手 · 账号管理` })
      .catch(() => null);
  } else {
    await chrome.action.disable(tabId).catch(() => null);
    await chrome.action
      .setTitle({ tabId, title: `请先打开${SITES.map((s) => s.label).join(' / ')}页面` })
      .catch(() => null);
  }
}

async function syncActionAvailability() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => updateActionAvailability(t.id, t.url || '')));
}

async function clearOpenTabStorage(site) {
  const tabs = await querySiteTabs(site);
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
          try {
            if (indexedDB?.databases) {
              indexedDB.databases().then((dbs) =>
                dbs.forEach((db) => db?.name && indexedDB.deleteDatabase(db.name)),
              );
            }
          } catch {}
          try {
            if (caches?.keys) {
              caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
            }
          } catch {}
        },
      }).catch(() => null),
    ),
  );
}

async function reloadSiteTabs(site) {
  const tabs = await querySiteTabs(site);
  await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id).catch(() => null)));
}

async function getActiveSiteTab(site) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url) {
    const activeSite = getSiteByUrl(active.url);
    if (activeSite && (!site || activeSite.id === site.id)) return active;
  }
  const siteTabs = await querySiteTabs(site);
  return siteTabs[0] || null;
}

// ── 内容脚本通信 ──────────────────────────────────────────────────────────
async function askContentForAccountProfile(tabId) {
  const empty = { name: '', avatarUrl: '', mobile: '', source: '', site: '', isLoggedIn: false };
  if (!tabId) return empty;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_ACCOUNT_PROFILE' });
    return {
      name: response?.name || '',
      avatarUrl: response?.avatarUrl || '',
      mobile: response?.mobile || '',
      source: response?.source || '',
      site: response?.site || '',
      isLoggedIn: Boolean(response?.isLoggedIn),
    };
  } catch {
    return empty;
  }
}

// ── 账号保存 / 切换 / 删除 / 重命名 ────────────────────────────────────────
const fallbackAccountName = (site) =>
  `${getSiteById(site?.id).label}账号 ${new Date().toLocaleString()}`;

async function saveAccountFromTabUnlocked(
  tabId,
  { preferredName = '', notLoggedInError, throwOnDuplicate = false, site } = {},
) {
  const target = getSiteById(site?.id);
  const profile = await askContentForAccountProfile(tabId);
  if (!profile.isLoggedIn || profile.source !== 'router') {
    throw new Error(notLoggedInError);
  }
  const cookies = await getSiteCookies(target);
  if (!cookies.length) {
    throw new Error(`当前没有检测到${target.label}登录 Cookie，无法保存`);
  }

  const storableCookies = filterAuthCookies(cookies);
  const allAccounts = await getStored(STORAGE_KEYS.accounts, []);
  const accounts = scopeAccounts(allAccounts, target.id);

  const existing =
    findSavedAccountByCookies(accounts, cookies) || findSavedAccountByProfile(accounts, profile);
  if (existing) {
    await setStored({ [STORAGE_KEYS.currentAccountId]: existing.id });
    if (throwOnDuplicate) {
      throw new Error(`当前账号已保存：${existing.name || '未命名账号'}`);
    }
    return existing;
  }

  const account = {
    id: nowId(),
    site: target.id,
    name: preferredName || profile.name || fallbackAccountName(target),
    avatarUrl: profile.avatarUrl || '',
    mobile: profile.mobile || '',
    cookies: storableCookies,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  allAccounts.push(account);
  await setStored({
    [STORAGE_KEYS.accounts]: allAccounts,
    [STORAGE_KEYS.currentAccountId]: account.id,
  });
  return account;
}

const saveAccountFromTab = (tabId, options = {}) =>
  withSaveLock(() => saveAccountFromTabUnlocked(tabId, options));

async function saveCurrentAccount(site, preferredName = '') {
  const target = getSiteById(site?.id);
  const tab = await getActiveSiteTab(target);
  return saveAccountFromTab(tab?.id, {
    preferredName,
    site: target,
    notLoggedInError: `当前${target.label}账号未登录，无法保存`,
    throwOnDuplicate: true,
  });
}

async function switchAccount(accountId) {
  const account = await withSaveLock(async () => {
    const accounts = await getStored(STORAGE_KEYS.accounts, []);
    const found = accounts.find((a) => a.id === accountId);
    if (!found) throw new Error('账号不存在');
    await restoreCookies(found.cookies, getSiteById(found.site));
    await setStored({ [STORAGE_KEYS.currentAccountId]: found.id });
    return found;
  });
  await reloadSiteTabs(getSiteById(account.site));
  return account;
}

async function deleteAccount(accountId) {
  await withSaveLock(async () => {
    const accounts = await getStored(STORAGE_KEYS.accounts, []);
    await setStored({
      [STORAGE_KEYS.accounts]: accounts.filter((a) => a.id !== accountId),
    });
    if ((await getStored(STORAGE_KEYS.currentAccountId, '')) === accountId) {
      await chrome.storage.local.remove(STORAGE_KEYS.currentAccountId);
    }
  });
}

async function renameAccount(accountId, name) {
  return withSaveLock(async () => {
    const accounts = await getStored(STORAGE_KEYS.accounts, []);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new Error('账号不存在');
    account.name = name;
    account.updatedAt = new Date().toISOString();
    await setStored({ [STORAGE_KEYS.accounts]: accounts });
    return account;
  });
}

async function getCurrentAccount(accounts = null, profile = null, site = null) {
  const target = getSiteById(site?.id);
  const allAccounts = accounts || (await getStored(STORAGE_KEYS.accounts, []));
  if (!allAccounts.length) return null;
  const savedAccounts = scopeAccounts(allAccounts, target.id);
  if (!savedAccounts.length) return null;

  const currentCookies = await getSiteCookies(target);
  const matched =
    findSavedAccountByCookies(savedAccounts, currentCookies) ||
    findSavedAccountByProfile(savedAccounts, profile);
  if (!matched) return null;

  let dirty = false;
  if (profile?.source === 'router') {
    if (profile.mobile && matched.mobile !== profile.mobile) {
      matched.mobile = profile.mobile; dirty = true;
    }
    if (profile.avatarUrl && matched.avatarUrl !== profile.avatarUrl) {
      matched.avatarUrl = profile.avatarUrl; dirty = true;
    }
    if (profile.name && /^(豆包账号|Dola账号|未命名账号)/.test(matched.name || '')) {
      matched.name = profile.name; dirty = true;
    }
  }
  if (dirty) {
    matched.updatedAt = new Date().toISOString();
    await setStored({ [STORAGE_KEYS.accounts]: allAccounts });
  }
  await setStored({ [STORAGE_KEYS.currentAccountId]: matched.id });
  return matched;
}

// ── 登录检测流程 ──────────────────────────────────────────────────────────
async function clearPendingLogin() {
  await chrome.storage.local.remove(STORAGE_KEYS.pendingLogin);
  await chrome.alarms.clear(LOGIN_DETECT_ALARM).catch(() => null);
  clearAllLoginDetectTimers();
}

function clearAllLoginDetectTimers() {
  for (const timer of loginDetectTimers.values()) clearTimeout(timer);
  loginDetectTimers.clear();
}

async function ensureLoginDetectAlarm() {
  if (await chrome.alarms.get(LOGIN_DETECT_ALARM).catch(() => null)) return;
  await chrome.alarms
    .create(LOGIN_DETECT_ALARM, { periodInMinutes: LOGIN_DETECT_ALARM_PERIOD_MINUTES })
    .catch(() => null);
}

async function restoreBackupCookies(cookies, site) {
  if (!cookies?.length) return;
  const target = getSiteById(site?.id);
  await restoreCookies(cookies, target);
  await reloadSiteTabs(target);
}

async function startQrLogin(site) {
  const target = getSiteById(site?.id);
  const backupCookies = filterAuthCookies(await getSiteCookies(target));
  await clearSiteData(target);

  const popupWindow = await chrome.windows.create({
    url: target.chatUrl, type: 'popup',
    width: 520, height: 760, focused: true,
  });
  const tabId = popupWindow.tabs?.[0]?.id || null;
  await setStored({
    [STORAGE_KEYS.pendingLogin]: {
      siteId: target.id, backupCookies,
      windowId: popupWindow.id, tabId, status: 'waiting',
    },
  });
  setBadge('...');
  await ensureLoginDetectAlarm();
  if (tabId) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'AUTO_CLICK_LOGIN' }).catch(() => null);
    }, 1200);
    scheduleAutoFinishLogin(tabId, target);
  }
  return { windowId: popupWindow.id, tabId };
}

async function getCurrentPendingLogin(siteId) {
  const pending = await getStored(STORAGE_KEYS.pendingLogin, null);
  if (!pending) return null;
  return getSiteById(pending.siteId).id === getSiteById(siteId).id ? pending : null;
}

async function closeLoginWindow(windowId) {
  if (!windowId) return;
  autoClosingLoginWindows.add(windowId);
  await chrome.windows.remove(windowId).catch(() => null);
  setTimeout(() => autoClosingLoginWindows.delete(windowId), 5000);
}

const LOGIN_TAB_SAVE_OPTIONS = {
  notLoggedInError: '账号尚未完成登录，无法保存',
  throwOnDuplicate: false,
};

async function finishQrLogin({ restorePrevious = false, site } = {}) {
  const target = getSiteById(site?.id);
  const pending = await getCurrentPendingLogin(target.id);
  const tabId = pending?.tabId || null;
  let account = null;
  let saved = false;
  try {
    await sleep(PROFILE_READY_DELAY_MS);
    account = await saveAccountFromTab(tabId, { ...LOGIN_TAB_SAVE_OPTIONS, site: target });
    saved = true;
    return account;
  } finally {
    const cleanup = async (task) => {
      try { await task(); }
      catch {}
    };
    await cleanup(clearPendingLogin);
    if (saved) {
      setBadge('✓', BADGE_SUCCESS_COLOR);
      setTimeout(() => setBadge(''), 2500);
    } else {
      setBadge('');
    }
    await cleanup(() => closeLoginWindow(pending?.windowId));
    if (restorePrevious) {
      await cleanup(() => restoreBackupCookies(pending?.backupCookies, target));
    }
  }
}

async function cancelQrLogin(site) {
  const target = getSiteById(site?.id);
  const pending = await getCurrentPendingLogin(target.id);
  await clearPendingLogin();
  setBadge('');
  await closeLoginWindow(pending?.windowId);
  await restoreBackupCookies(pending?.backupCookies, target);
}

const hasEnoughLoginCookies = (cookies) => {
  const auth = filterAuthCookies(cookies);
  if (auth.length < LOGIN_COOKIE_MIN_COUNT) return false;
  return auth.some((c) => getAuthCookieWeight(c.name) >= 5);
};

function scheduleAutoFinishLogin(tabId, site) {
  if (!tabId) return;
  const siteId = getSiteById(site?.id).id;
  const existing = loginDetectTimers.get(siteId);
  if (existing) clearTimeout(existing);
  loginDetectTimers.set(
    siteId,
    setTimeout(() => {
      loginDetectTimers.delete(siteId);
      tryAutoFinishLogin(tabId, site).catch(() => {});
    }, LOGIN_DETECT_DELAY_MS),
  );
}

async function tryAutoFinishLogin(tabId, site) {
  const target = getSiteById(site?.id);
  const pending = await getStored(STORAGE_KEYS.pendingLogin, null);
  if (!pending || pending.tabId !== tabId || pending.status === 'saving') return;
  if (getSiteById(pending.siteId).id !== target.id) return;

  const cookies = await getSiteCookies(target);
  if (!hasEnoughLoginCookies(cookies)) return;

  const profile = await askContentForAccountProfile(tabId);
  if (!profile.isLoggedIn || profile.source !== 'router') return;

  await setStored({ [STORAGE_KEYS.pendingLogin]: { ...pending, status: 'saving' } });

  try {
    await sleep(PROFILE_READY_DELAY_MS);
    await saveAccountFromTab(tabId, {
      ...LOGIN_TAB_SAVE_OPTIONS, site: target, preferredName: profile.name,
    });
  } catch (error) {
    await setStored({ [STORAGE_KEYS.pendingLogin]: { ...pending, status: 'waiting' } });
    throw error;
  }

  await clearPendingLogin();
  setBadge('✓', BADGE_SUCCESS_COLOR);
  setTimeout(() => setBadge(''), 2500);
  await closeLoginWindow(pending.windowId);
}

// ── 下载 ──────────────────────────────────────────────────────────────────
async function startBrowserDownload(url, rawFilename, site) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('下载地址不合法');
  }
  const filename =
    String(rawFilename || '')
      .replace(SAFE_FILENAME_PATTERN, '')
      .replace(/^\.+/, '')
      .slice(0, 120) || `${getSiteById(site?.id).id}-media`;
  return chrome.downloads.download({
    url, filename, conflictAction: 'uniquify', saveAs: false,
  });
}

// ── 消息路由 ──────────────────────────────────────────────────────────────
async function resolveRequestSite(message, sender) {
  if (message?.siteId) return getSiteById(message.siteId);
  const fromSender = sender?.tab?.url ? getSiteByUrl(sender.tab.url) : null;
  if (fromSender) return fromSender;
  const activeTab = await getActiveSiteTab();
  return (activeTab?.url && getSiteByUrl(activeTab.url)) || DEFAULT_SITE;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const site = resolveRequestSite(message, sender).catch(() => DEFAULT_SITE);

  (async () => {
    const target = await site;
    switch (message?.type) {
      case 'LIST_ACCOUNTS': {
        const allAccounts = await getStored(STORAGE_KEYS.accounts, []);
        const activeTab = await getActiveSiteTab(target);
        const activeProfile = await askContentForAccountProfile(activeTab?.id);
        return {
          siteId: target.id,
          siteLabel: target.label,
          accounts: scopeAccounts(allAccounts, target.id),
          currentAccount: await getCurrentAccount(allAccounts, activeProfile, target),
          pendingLogin: await getCurrentPendingLogin(target.id),
          canSaveCurrentAccount: activeProfile.source === 'router' && activeProfile.isLoggedIn,
        };
      }
      case 'SAVE_CURRENT':
        return { account: await saveCurrentAccount(target, message.name || '') };
      case 'START_QR_LOGIN':
        return await startQrLogin(target);
      case 'FINISH_QR_LOGIN':
        return {
          account: await finishQrLogin({
            restorePrevious: Boolean(message.restorePrevious),
            site: target,
          }),
        };
      case 'CANCEL_QR_LOGIN':
        await cancelQrLogin(target);
        return { ok: true };
      case 'SWITCH_ACCOUNT':
        return { account: await switchAccount(message.accountId) };
      case 'DELETE_ACCOUNT':
        await deleteAccount(message.accountId);
        return { ok: true };
      case 'RENAME_ACCOUNT':
        return { account: await renameAccount(message.accountId, message.name || '') };
      case 'DOWNLOAD_MEDIA':
        return { downloadId: await startBrowserDownload(message.url, message.filename, target) };
      default:
        throw new Error('未知操作');
    }
  })()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      // 业务异常通过回执传给弹窗显示；不在 DevTools 里输出任何内容
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

// ── 事件订阅 ──────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateActionAvailability(tabId, changeInfo.url || tab.url || '').catch(() => null);
  }
  if (changeInfo.status !== 'complete' || !isSupportedPageUrl(tab.url)) return;
  const site = getSiteByUrl(tab.url);
  getStored(STORAGE_KEYS.pendingLogin, null)
    .then((pending) => {
      if (pending?.tabId !== tabId) return;
      chrome.tabs.sendMessage(tabId, { type: 'AUTO_CLICK_LOGIN' }).catch(() => null);
      scheduleAutoFinishLogin(tabId, site);
    })
    .catch(() => null);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => updateActionAvailability(tabId, tab.url || ''))
    .catch(() => null);
});

chrome.runtime.onInstalled.addListener(() => syncActionAvailability().catch(() => null));

chrome.runtime.onStartup.addListener(() => {
  syncActionAvailability().catch(() => null);
  getStored(STORAGE_KEYS.pendingLogin, null)
    .then((pending) => pending?.tabId && ensureLoginDetectAlarm())
    .catch(() => null);
});

syncActionAvailability().catch(() => null);

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!getSiteByHost(changeInfo.cookie.domain)) return;
  getStored(STORAGE_KEYS.pendingLogin, null)
    .then((pending) => {
      if (pending?.tabId) scheduleAutoFinishLogin(pending.tabId, getSiteById(pending.siteId));
    })
    .catch(() => null);
});

chrome.windows.onRemoved.addListener((windowId) => {
  getStored(STORAGE_KEYS.pendingLogin, null)
    .then(async (pending) => {
      if (pending?.windowId !== windowId) return;
      if (autoClosingLoginWindows.has(windowId)) {
        autoClosingLoginWindows.delete(windowId);
        return;
      }
      await clearPendingLogin();
      setBadge('');
      await restoreBackupCookies(pending?.backupCookies, getSiteById(pending?.siteId));
    })
    .catch(() => null);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LOGIN_DETECT_ALARM) return;
  getStored(STORAGE_KEYS.pendingLogin, null)
    .then((pending) => {
      if (!pending?.tabId) return chrome.alarms.clear(LOGIN_DETECT_ALARM).catch(() => null);
      scheduleAutoFinishLogin(pending.tabId, getSiteById(pending.siteId));
      chrome.tabs.sendMessage(pending.tabId, { type: 'AUTO_CLICK_LOGIN' }).catch(() => null);
      return null;
    })
    .catch(() => null);
});