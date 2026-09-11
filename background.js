// background.js · Chrome 扩展后台服务：Cookie 读写、账号存储与页面重载
// @author Li · GPL-3.0 · https://github.com/admin0x/doubaokit

// 受支持站点注册表：新增站点只改这里；popup / content / media-kit 各有一份裁剪副本需同步
const SITES = [
  {
    id: 'doubao',
    label: '豆包',
    chatUrl: 'https://www.doubao.com/chat/',
    tabUrlPatterns: ['https://www.doubao.com/*', 'https://*.doubao.com/*'],
    origins: ['https://www.doubao.com', 'https://doubao.com'],
    cookieDomains: ['doubao.com', 'www.doubao.com'],
    hosts: ['doubao.com'],
  },
  {
    id: 'dola',
    label: 'Dola',
    chatUrl: 'https://www.dola.com/chat/',
    tabUrlPatterns: ['https://www.dola.com/*', 'https://*.dola.com/*'],
    origins: ['https://www.dola.com', 'https://dola.com'],
    cookieDomains: ['dola.com', 'www.dola.com'],
    hosts: ['dola.com'],
  },
];
const DEFAULT_SITE = SITES[0];
const ALL_TAB_URL_PATTERNS = SITES.flatMap((site) => site.tabUrlPatterns);

// 站点识别：页面 URL 与 Cookie 共用同一口径
function normalizeHost(host) {
  return String(host || '')
    .replace(/^\.|^www\./, '')
    .toLowerCase();
}

// 按域名判定站点，非受支持站点返回 null
function getSiteByHost(host) {
  const hostname = normalizeHost(host);
  if (!hostname) return null;
  return (
    SITES.find((site) =>
      site.hosts.some((base) => hostname === base || hostname.endsWith(`.${base}`)),
    ) || null
  );
}

// 按页面地址判定站点，非法地址返回 null
function getSiteByUrl(url) {
  try {
    return getSiteByHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

// 按 id 取站点配置，取不到时回退默认站点
function getSiteById(siteId) {
  return SITES.find((site) => site.id === siteId) || DEFAULT_SITE;
}

// 判断页面地址是否属于受支持站点
function isSupportedPageUrl(url) {
  return Boolean(getSiteByUrl(url));
}

// 老快照没有 site 字段，统一归到默认站点
function getAccountSiteId(account) {
  return getSiteById(account?.site).id;
}

// 只取某站点的账号，豆包与 Dola 的快照互不干扰
function scopeAccounts(accounts, siteId) {
  return (accounts || []).filter((account) => getAccountSiteId(account) === siteId);
}

// 本地存储键名
const STORAGE_KEYS = {
  accounts: 'accounts',
  pendingLogin: 'pendingLogin',
  currentAccountId: 'currentAccountId',
};

// 认定登录成功所需的最少鉴权 Cookie 数
const LOGIN_COOKIE_MIN_COUNT = 2;
// Cookie 变化后延迟多久再检测登录
const LOGIN_DETECT_DELAY_MS = 1400;
// 保存前留给页面拉取账号资料的等待时间
const PROFILE_READY_DELAY_MS = 1800;
// 登录检测：事件驱动 + 告警兜底，不用递归 setTimeout 链
const LOGIN_DETECT_ALARM = 'doubaokit-login-detect';
const LOGIN_DETECT_ALARM_PERIOD_MINUTES = 1;
// 角标颜色：进行中
const BADGE_BUSY_COLOR = '#203b27';
// 角标颜色：成功
const BADGE_SUCCESS_COLOR = '#166534';
// 下载文件名允许的字符，其余一律剔除
const SAFE_FILENAME_PATTERN = /[^a-zA-Z0-9._\-\u4e00-\u9fa5()[\] ]/g;

// 登录检测定时器按站点分存，两个站点同时添加账号互不干扰
const loginDetectTimers = new Map();
// 保存流程互斥锁，避免并发产生重复快照
let saveChain = Promise.resolve();
const autoClosingLoginWindows = new Set();

// 允许落入账号快照的鉴权 Cookie 名特征
const STORED_COOKIE_PATTERNS = [
  /^sessionid(_ss)?$/i,
  /^sid_tt(_ss)?$/i,
  /^uid_tt(_ss)?$/i,
  /^sid_guard$/i,
  /^passport_/i,
  /csrf/i,
  /session/i,
  /login/i,
  /oauth/i,
  /auth/i,
  /token/i,
];

// 排除缓存与埋点类 Cookie，它们不是登录凭据
const EXCLUDED_COOKIE_PATTERNS = [
  /^__tea_/i,
  /^_ga/i,
  /^_tea_/i,
  /^ttwid$/i,
  /^msToken$/i,
  /^ab_version/i,
  /cache/i,
];

// 延时等待
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 串行执行器，前一个任务无论成败都不影响后一个
function withSaveLock(task) {
  const result = saveChain.then(task, task);
  saveChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// 读取本地存储，取不到则返回兜底值
async function getStored(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

// 写入本地存储
async function setStored(values) {
  await chrome.storage.local.set(values);
}

// 更新扩展图标角标文案与颜色
function setBadge(text, color = BADGE_BUSY_COLOR) {
  chrome.action.setBadgeText({ text }).catch(() => null);
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => null);
}

// 生成账号唯一 id
function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// 单条 Cookie 的身份串
function getCookieIdentity(cookie) {
  return [cookie.name || '', cookie.domain || '', cookie.path || '/', cookie.value || ''].join(
    '\n',
  );
}

// 一组 Cookie 的整体指纹，用于精确比对
function getCookieFingerprint(cookies) {
  return (cookies || []).map(getCookieIdentity).sort().join('\n---\n');
}

// Cookie 名的鉴权权重，0 表示与登录无关
function getAuthCookieWeight(name) {
  const normalizedName = String(name || '').toLowerCase();
  if (/^(sessionid|sessionid_ss|sid_tt|sid_tt_ss|uid_tt|uid_tt_ss)$/.test(normalizedName)) return 5;
  if (/session|passport_auth|login|oauth|auth_token|user_token|sid_guard/.test(normalizedName))
    return 2;
  return 0;
}

// Cookie 的匹配键：名称 + 域 + 路径
function getCookieMatchKey(cookie) {
  return [
    String(cookie.name || '').toLowerCase(),
    String(cookie.domain || '')
      .replace(/^\./, '')
      .toLowerCase(),
    cookie.path || '/',
  ].join('|');
}

// 挑出鉴权 Cookie，落盘与比对共用同一口径
function filterAuthCookies(cookies) {
  const picked = (cookies || []).filter((cookie) => {
    const name = String(cookie.name || '');
    if (EXCLUDED_COOKIE_PATTERNS.some((pattern) => pattern.test(name))) return false;
    return STORED_COOKIE_PATTERNS.some((pattern) => pattern.test(name));
  });

  // 白名单全落空说明规则失效，退回全量避免存下空快照
  if (!picked.length) return cookies || [];
  return picked;
}

// 按 Cookie 找已保存账号：先比整体指纹，再按权重打分
function findSavedAccountByCookies(accounts, cookies) {
  const fingerprint = getCookieFingerprint(filterAuthCookies(cookies));
  if (!fingerprint) return null;
  const exactMatch = (accounts || []).find(
    (account) => getCookieFingerprint(filterAuthCookies(account.cookies || [])) === fingerprint,
  );
  if (exactMatch) return exactMatch;

  const currentAuthCookies = new Map(
    (cookies || [])
      .filter((cookie) => getAuthCookieWeight(cookie.name) > 0 && cookie.value)
      .map((cookie) => [getCookieMatchKey(cookie), cookie.value]),
  );
  if (!currentAuthCookies.size) return null;

  let bestMatch = null;
  let bestScore = 0;
  for (const account of accounts || []) {
    let score = 0;
    let matchedCount = 0;
    for (const cookie of account.cookies || []) {
      const weight = getAuthCookieWeight(cookie.name);
      if (!weight || !cookie.value) continue;
      if (currentAuthCookies.get(getCookieMatchKey(cookie)) === cookie.value) {
        score += weight;
        matchedCount += 1;
      }
    }
    if ((score >= 5 || matchedCount >= 2) && score > bestScore) {
      bestMatch = account;
      bestScore = score;
    }
  }
  return bestMatch;
}

// 按手机号或昵称唯一定位已保存账号
function findSavedAccountByProfile(accounts, profile) {
  if (!profile?.isLoggedIn) return null;
  if (profile.mobile) {
    const mobileMatches = (accounts || []).filter(
      (account) => account.mobile && account.mobile === profile.mobile,
    );
    if (mobileMatches.length === 1) return mobileMatches[0];
  }
  const name = String(profile.name || '').trim();
  if (!name) return null;
  const nameMatches = (accounts || []).filter(
    (account) => String(account.name || '').trim() === name,
  );
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

// 按站点自己的域查询并去重，绝不 getAll({}) 把其他站点的 Cookie 也读进内存
async function queryCookieRecords(site) {
  const target = getSiteById(site?.id);
  const batches = await Promise.all(
    target.cookieDomains.map((domain) => chrome.cookies.getAll({ domain }).catch(() => [])),
  );

  // 多次查询会重叠，按名称域路径去重
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

// 读取当前站点的 Cookie 快照
async function getSiteCookies(site) {
  const cookies = await queryCookieRecords(site);
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
    storeId: cookie.storeId,
    partitionKey: cookie.partitionKey,
  }));
}

// Cookie 必须属于当前站点，杜绝跨站写入
function isSameSiteCookie(cookie, site) {
  const owner = getSiteByHost(cookie.domain);
  return Boolean(owner && site && owner.id === getSiteById(site?.id).id);
}

// 由 Cookie 反推出可用于写入的 URL
function getCookieSetUrl(cookie, site) {
  const fallbackHost = `www.${getSiteById(site?.id).hosts[0]}`;
  const domain = String(cookie.domain || fallbackHost).replace(/^\./, '');
  const protocol = cookie.secure ? 'https:' : 'http:';
  return `${protocol}//${domain}${cookie.path || '/'}`;
}

// 清空当前站点的 Cookie
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

// 清空站点数据：页面存储 + Cookie + 缓存
async function clearSiteData(site) {
  const target = getSiteById(site?.id);
  await clearOpenTabStorage(target);
  await clearSiteCookies(target);
  await chrome.browsingData
    .remove(
      {
        origins: target.origins,
      },
      {
        cacheStorage: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true,
        webSQL: true,
      },
    )
    .catch((error) => {
      console.warn(`[${target.label}账号切换器] 清理站点数据失败:`, error);
    });
  await clearSiteCookies(target);
}

// 写回账号快照的 Cookie，恢复登录态
async function restoreCookies(cookies, site) {
  const target = getSiteById(site?.id);
  await clearSiteData(target);
  for (const cookie of cookies || []) {
    const details = {
      url: getCookieSetUrl(cookie, target),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || '/',
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite || 'unspecified',
    };
    if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    await chrome.cookies.set(details).catch((error) => {
      console.warn(`[${target.label}账号切换器] 写入 Cookie 失败:`, cookie.name, error);
    });
  }
}

// site 为空时查所有受支持站点的标签页
async function querySiteTabs(site) {
  return chrome.tabs.query({
    url: site ? site.tabUrlPatterns : ALL_TAB_URL_PATTERNS,
  });
}

// 按页面地址更新扩展按钮的可用性与提示文案
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
      .setTitle({ tabId, title: `请先打开${SITES.map((item) => item.label).join(' / ')}页面` })
      .catch(() => null);
  }
}

// 逐个标签页同步扩展按钮的可用性
async function syncActionAvailability() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => updateActionAvailability(tab.id, tab.url || '')));
}

// 清掉已打开标签页里的站点存储
async function clearOpenTabStorage(site) {
  const tabs = await querySiteTabs(site);
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: () => {
            // 只清当前站点的登录痕迹，与提示词库无关（提示词存在扩展存储里）
            try {
              localStorage.clear();
            } catch {}
            try {
              sessionStorage.clear();
            } catch {}
            try {
              if (indexedDB?.databases) {
                indexedDB.databases().then((databases) => {
                  databases.forEach((database) => {
                    if (database?.name) indexedDB.deleteDatabase(database.name);
                  });
                });
              }
            } catch {}
            try {
              if (caches?.keys) {
                caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
              }
            } catch {}
          },
        })
        .catch(() => null),
    ),
  );
}

// 重载当前站点的标签页
async function reloadSiteTabs(site) {
  const tabs = await querySiteTabs(site);
  await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id).catch(() => null)));
}

// 取目标站点的标签页：优先当前窗口活动标签，其次任意同站点标签
async function getActiveSiteTab(site) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = tabs[0];
  if (active?.url) {
    const activeSite = getSiteByUrl(active.url);
    if (activeSite && (!site || activeSite.id === site.id)) return active;
  }
  const siteTabs = await querySiteTabs(site);
  return siteTabs[0] || null;
}

// 向内容脚本询问当前登录账号的资料
async function askContentForAccountProfile(tabId) {
  if (!tabId) return { name: '', avatarUrl: '', mobile: '', source: '', site: '' };
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_ACCOUNT_PROFILE',
    });
    return {
      name: response?.name || '',
      avatarUrl: response?.avatarUrl || '',
      mobile: response?.mobile || '',
      source: response?.source || '',
      site: response?.site || '',
      isLoggedIn: Boolean(response?.isLoggedIn),
    };
  } catch {
    return {
      name: '',
      avatarUrl: '',
      mobile: '',
      source: '',
      site: '',
      isLoggedIn: false,
    };
  }
}

// 取不到昵称时的默认账号名
function fallbackAccountName(site) {
  return `${getSiteById(site?.id).label}账号 ${new Date().toLocaleString()}`;
}

// 保存账号快照：只在同站点内比对，命中已有账号则直接复用
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

  // 只落盘鉴权 Cookie
  const storableCookies = filterAuthCookies(cookies);
  const allAccounts = await getStored(STORAGE_KEYS.accounts, []);

  // 只在同站点内比对，豆包与 Dola 的快照互不相认
  const accounts = scopeAccounts(allAccounts, target.id);
  const existingAccount =
    findSavedAccountByCookies(accounts, cookies) || findSavedAccountByProfile(accounts, profile);
  if (existingAccount) {
    await setStored({ [STORAGE_KEYS.currentAccountId]: existingAccount.id });
    if (throwOnDuplicate) {
      throw new Error(`当前账号已保存：${existingAccount.name || '未命名账号'}`);
    }
    return existingAccount;
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

// 保存账号快照的对外入口，串行化避免写入重复快照
function saveAccountFromTab(tabId, options = {}) {
  return withSaveLock(() => saveAccountFromTabUnlocked(tabId, options));
}

// 保存当前标签页已登录的账号
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

// 登录窗口保存账号时使用的参数
const LOGIN_TAB_SAVE_OPTIONS = {
  notLoggedInError: '账号尚未完成登录，无法保存',
  throwOnDuplicate: false,
};

// 切换账号：写回快照 Cookie 并重载页面
async function switchAccount(accountId) {
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw new Error('账号不存在');
  const target = getSiteById(account.site);
  await restoreCookies(account.cookies, target);
  await setStored({ [STORAGE_KEYS.currentAccountId]: account.id });
  await reloadSiteTabs(target);
  return account;
}

// 删除指定账号快照
async function deleteAccount(accountId) {
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  await setStored({
    [STORAGE_KEYS.accounts]: accounts.filter((account) => account.id !== accountId),
  });
  const currentAccountId = await getStored(STORAGE_KEYS.currentAccountId, '');
  if (currentAccountId === accountId) {
    await chrome.storage.local.remove(STORAGE_KEYS.currentAccountId);
  }
}

// 重命名指定账号
async function renameAccount(accountId, name) {
  const accounts = await getStored(STORAGE_KEYS.accounts, []);
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw new Error('账号不存在');
  account.name = name;
  account.updatedAt = new Date().toISOString();
  await setStored({ [STORAGE_KEYS.accounts]: accounts });
  return account;
}

// 识别当前登录的是哪个已保存账号，顺带补全手机号与头像
async function getCurrentAccount(accounts = null, profile = null, site = null) {
  const target = getSiteById(site?.id);
  const allAccounts = accounts || (await getStored(STORAGE_KEYS.accounts, []));
  if (!allAccounts.length) return null;
  const savedAccounts = scopeAccounts(allAccounts, target.id);
  if (!savedAccounts.length) return null;
  const currentCookies = await getSiteCookies(target);
  const matchedAccount =
    findSavedAccountByCookies(savedAccounts, currentCookies) ||
    findSavedAccountByProfile(savedAccounts, profile);
  if (!matchedAccount) return null;
  let profileUpdated = false;
  if (profile?.source === 'router') {
    if (profile.mobile && matchedAccount.mobile !== profile.mobile) {
      matchedAccount.mobile = profile.mobile;
      profileUpdated = true;
    }
    if (profile.avatarUrl && matchedAccount.avatarUrl !== profile.avatarUrl) {
      matchedAccount.avatarUrl = profile.avatarUrl;
      profileUpdated = true;
    }
    if (profile.name && /^(豆包账号|Dola账号|未命名账号)/.test(matchedAccount.name || '')) {
      matchedAccount.name = profile.name;
      profileUpdated = true;
    }
  }
  if (profileUpdated) {
    matchedAccount.updatedAt = new Date().toISOString();
    await setStored({ [STORAGE_KEYS.accounts]: allAccounts });
  }
  await setStored({ [STORAGE_KEYS.currentAccountId]: matchedAccount.id });
  return matchedAccount;
}

// 统一收尾：清 pending、撤告警与定时器
async function clearPendingLogin() {
  await chrome.storage.local.remove(STORAGE_KEYS.pendingLogin);
  await chrome.alarms.clear(LOGIN_DETECT_ALARM).catch(() => null);
  clearAllLoginDetectTimers();
}

// 清掉全部待触发的登录检测
function clearAllLoginDetectTimers() {
  for (const timer of loginDetectTimers.values()) clearTimeout(timer);
  loginDetectTimers.clear();
}

// 兜底心跳，SW 被回收后仍能唤醒
async function ensureLoginDetectAlarm() {
  const existing = await chrome.alarms.get(LOGIN_DETECT_ALARM).catch(() => null);
  if (existing) return;
  await chrome.alarms
    .create(LOGIN_DETECT_ALARM, { periodInMinutes: LOGIN_DETECT_ALARM_PERIOD_MINUTES })
    .catch(() => null);
}

// 恢复备份 Cookie 并重载页面
async function restoreBackupCookies(cookies, site) {
  if (!cookies || !cookies.length) return;
  const target = getSiteById(site?.id);
  await restoreCookies(cookies, target);
  await reloadSiteTabs(target);
}

// 打开登录窗口，进入添加账号流程
async function startQrLogin(site) {
  const target = getSiteById(site?.id);

  // 备份同样只留鉴权 Cookie
  const backupCookies = filterAuthCookies(await getSiteCookies(target));
  await clearSiteData(target);

  const popupWindow = await chrome.windows.create({
    url: target.chatUrl,
    type: 'popup',
    width: 520,
    height: 760,
    focused: true,
  });
  const tabId = popupWindow.tabs?.[0]?.id || null;
  await setStored({
    [STORAGE_KEYS.pendingLogin]: {
      siteId: target.id,
      backupCookies,
      windowId: popupWindow.id,
      tabId,
      status: 'waiting',
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

// 取当前站点的进行中流程，没有则返回 null
async function getCurrentPendingLogin(siteId) {
  const pending = await getStored(STORAGE_KEYS.pendingLogin, null);
  if (!pending) return null;
  return getSiteById(pending.siteId).id === getSiteById(siteId).id ? pending : null;
}

// 关闭扫码登录窗口，登记后避免被误判为异常关闭
async function closeLoginWindow(windowId) {
  if (!windowId) return;
  autoClosingLoginWindows.add(windowId);
  await chrome.windows.remove(windowId).catch(() => null);
  setTimeout(() => autoClosingLoginWindows.delete(windowId), 5000);
}

// 手动收尾：保存新账号并关闭登录窗口
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
    // 必须 finally，否则保存失败会让弹窗卡死在「添加账号进行中」
    // 每步独立容错：任何一步抛错都不能中断后续清理（关窗与还原 Cookie 更不能漏）
    const cleanup = async (task) => {
      try {
        await task();
      } catch (error) {
        console.warn(`[${target.label}账号切换器] 登录收尾失败:`, error);
      }
    };
    await cleanup(() => clearPendingLogin());
    if (saved) {
      setBadge('✓', BADGE_SUCCESS_COLOR);
      setTimeout(() => setBadge(''), 2500);
    } else {
      setBadge('');
    }
    await cleanup(() => closeLoginWindow(pending?.windowId));
    if (restorePrevious) await cleanup(() => restoreBackupCookies(pending?.backupCookies, target));
  }
}

// 取消添加账号，恢复登录前的账号
async function cancelQrLogin(site) {
  const target = getSiteById(site?.id);
  const pending = await getCurrentPendingLogin(target.id);
  await clearPendingLogin();
  setBadge('');
  await closeLoginWindow(pending?.windowId);
  await restoreBackupCookies(pending?.backupCookies, target);
}

// 判断 Cookie 是否已足以认定登录成功
function hasEnoughLoginCookies(cookies) {
  return (
    cookies.length >= LOGIN_COOKIE_MIN_COUNT &&
    cookies.some((cookie) => {
      const name = String(cookie.name || '').toLowerCase();
      return /session|sid|token|passport|auth|login|sso|uid|user/.test(name);
    })
  );
}

// 去抖后排一次登录检测，不递归续期（SW 会被回收）
function scheduleAutoFinishLogin(tabId, site) {
  if (!tabId) return;
  const siteId = getSiteById(site?.id).id;
  const existing = loginDetectTimers.get(siteId);
  if (existing) clearTimeout(existing);
  loginDetectTimers.set(
    siteId,
    setTimeout(() => {
      loginDetectTimers.delete(siteId);
      tryAutoFinishLogin(tabId, site).catch((error) => {
        console.warn('[账号切换器] 自动保存扫码账号失败:', error);
      });
    }, LOGIN_DETECT_DELAY_MS),
  );
}

// 检测到登录成功后自动保存并关闭窗口
async function tryAutoFinishLogin(tabId, site) {
  const target = getSiteById(site?.id);
  const pending = await getStored(STORAGE_KEYS.pendingLogin, null);
  if (!pending || pending.tabId !== tabId || pending.status === 'saving') return;

  const cookies = await getSiteCookies(target);
  if (!hasEnoughLoginCookies(cookies)) return;

  const profile = await askContentForAccountProfile(tabId);
  if (!profile.isLoggedIn || profile.source !== 'router') return;

  await setStored({
    [STORAGE_KEYS.pendingLogin]: {
      ...pending,
      status: 'saving',
    },
  });

  try {
    await sleep(PROFILE_READY_DELAY_MS);
    await saveAccountFromTab(tabId, {
      ...LOGIN_TAB_SAVE_OPTIONS,
      site: target,
      preferredName: profile.name,
    });
  } catch (error) {
    // 保存失败要放回状态，否则 pending 会永远卡在 saving
    await setStored({
      [STORAGE_KEYS.pendingLogin]: { ...pending, status: 'waiting' },
    });
    throw error;
  }

  await clearPendingLogin();
  setBadge('✓', BADGE_SUCCESS_COLOR);
  setTimeout(() => setBadge(''), 2500);
  await closeLoginWindow(pending.windowId);
}

// 交给浏览器下载队列，避免把大文件读进页面内存
async function startBrowserDownload(url, rawFilename, site) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('下载地址不合法');
  }

  // 文件名只允许安全字符
  const filename =
    String(rawFilename || '')
      .replace(SAFE_FILENAME_PATTERN, '')
      .replace(/^\.+/, '')
      .slice(0, 120) || `${getSiteById(site?.id).id}-media`;

  return chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
}

// 站点判定优先级：消息显式指定 > 发送方标签页 URL > 当前活动标签页 > 默认站点
async function resolveRequestSite(message, sender) {
  if (message?.siteId) return getSiteById(message.siteId);
  const fromSender = sender?.tab?.url ? getSiteByUrl(sender.tab.url) : null;
  if (fromSender) return fromSender;
  const activeTab = await getActiveSiteTab();
  return (activeTab?.url && getSiteByUrl(activeTab.url)) || DEFAULT_SITE;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // site 必须在 IIFE 外声明：catch 回调拿不到 IIFE 内部变量，否则报错时无法回执
  const site = resolveRequestSite(message, sender).catch(() => DEFAULT_SITE);
  (async () => {
    const target = await site;
    switch (message?.type) {
      case 'LIST_ACCOUNTS': {
        const allAccounts = await getStored(STORAGE_KEYS.accounts, []);
        const accounts = scopeAccounts(allAccounts, target.id);
        const activeTab = await getActiveSiteTab(target);
        const activeProfile = await askContentForAccountProfile(activeTab?.id);
        return {
          siteId: target.id,
          siteLabel: target.label,
          accounts,
          currentAccount: await getCurrentAccount(allAccounts, activeProfile, target),
          // 只认本站点的进行中流程，别站在添加账号不该影响本站点的按钮
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
        return {
          account: await renameAccount(message.accountId, message.name || ''),
        };
      case 'DOWNLOAD_MEDIA': {
        // 走浏览器下载栈
        const downloadId = await startBrowserDownload(message.url, message.filename, target);
        return { downloadId };
      }
      default:
        throw new Error('未知操作');
    }
  })()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      // 回执必须保留：抛错也要告诉弹窗，否则界面会一直停在「处理中...」
      console.error('[账号切换器]', error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateActionAvailability(tabId, changeInfo.url || tab.url || '').catch(() => null);
  }
  if (changeInfo.status !== 'complete' || !isSupportedPageUrl(tab.url)) return;
  const site = getSiteByUrl(tab.url);
  getStored(STORAGE_KEYS.pendingLogin, null).then((pending) => {
    if (pending?.tabId !== tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'AUTO_CLICK_LOGIN' }).catch(() => null);
    scheduleAutoFinishLogin(tabId, site);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => updateActionAvailability(tabId, tab.url || ''))
    .catch(() => null);
});

chrome.runtime.onInstalled.addListener(() => {
  syncActionAvailability().catch(() => null);
});

// 浏览器启动：同步按钮可用性，并重挂未完成登录流程的心跳
chrome.runtime.onStartup.addListener(() => {
  syncActionAvailability().catch(() => null);
  getStored(STORAGE_KEYS.pendingLogin, null)
    .then(async (pending) => {
      if (!pending?.tabId) return;
      await ensureLoginDetectAlarm();
    })
    .catch(() => null);
});

syncActionAvailability().catch(() => null);

chrome.cookies.onChanged.addListener((changeInfo) => {
  const site = getSiteByHost(changeInfo.cookie.domain);
  if (!site) return;
  getStored(STORAGE_KEYS.pendingLogin, null).then((pending) => {
    if (!pending?.tabId) return;
    scheduleAutoFinishLogin(pending.tabId, site);
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  getStored(STORAGE_KEYS.pendingLogin, null).then(async (pending) => {
    if (pending?.windowId !== windowId) return;
    if (autoClosingLoginWindows.has(windowId)) {
      autoClosingLoginWindows.delete(windowId);
      return;
    }

    // 手动关闭登录窗口时也要恢复备份 Cookie，不能只清状态
    await clearPendingLogin();
    setBadge('');
    await restoreBackupCookies(pending?.backupCookies, getSiteById(pending?.siteId));
  });
});

// 兜底心跳：SW 被回收后仍能唤醒继续检测登录
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LOGIN_DETECT_ALARM) return;
  getStored(STORAGE_KEYS.pendingLogin, null)
    .then((pending) => {
      if (!pending?.tabId) {
        return chrome.alarms.clear(LOGIN_DETECT_ALARM).catch(() => null);
      }
      scheduleAutoFinishLogin(pending.tabId, getSiteById(pending.siteId));

      // 补一次自动点击，供内容脚本未注入时使用
      chrome.tabs.sendMessage(pending.tabId, { type: 'AUTO_CLICK_LOGIN' }).catch(() => null);
      return null;
    })
    .catch(() => null);
});
