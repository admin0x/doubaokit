// content.js · 页面内容脚本：读取当前登录账号信息，并中转页面与扩展的通信
// @author Li · GPL-3.0 · https://github.com/admin0x/doubaokit

const SITE_ID_BY_HOST = { 'doubao.com': 'doubao', 'dola.com': 'dola' };

function currentSiteId() {
  const hostname = String(location.hostname || '').replace(/^www\./, '').toLowerCase();
  for (const [host, siteId] of Object.entries(SITE_ID_BY_HOST)) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return siteId;
  }
  return '';
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
    return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
}

function normalizeName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 40) return '';
  if (/^(cn|zh|zh-cn|en|en-us|ja|ko|sg|us|gb)$/i.test(text)) return '';
  if (/^[a-z]{2}[-_][a-z]{2}$/i.test(text)) return '';
  if (/登录|登陆|注册|扫码|退出|设置|下载|豆包|Doubao|Dola/i.test(text)) return '';
  if (/^\s*(log\s?in|sign\s?in|log\s?out|sign\s?up)\s*$/i.test(text)) return '';
  return text;
}

function normalizeAvatarUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('//')) return `${location.protocol}${text}`;
  if (text.startsWith('/')) return new URL(text, location.origin).href;
  if (!/^https?:\/\//i.test(text)) return '';
  if (
    !/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(text) &&
    !/avatar|image|img|user|tos|byteimg/i.test(text)
  )
    return '';
  return text;
}

const NAME_KEYS = ['nickname', 'nick_name', 'screen_name', 'display_name', 'user_name', 'username', 'userName'];
const AVATAR_KEYS = ['avatar', 'avatar_url', 'avatarUrl', 'icon', 'icon_url', 'picture', 'photo', 'profile_image_url'];

function findInObject(value, keys, normalize, depth = 0, extraKey = false) {
  if (!value || depth > 4 || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInObject(item, keys, normalize, depth + 1, extraKey);
      if (found) return found;
    }
    return '';
  }
  for (const key of keys) {
    const found = normalize(value[key]);
    if (found) return found;
  }
  if (extraKey && /user|account|profile|author|owner/i.test(Object.keys(value).join(' '))) {
    const found = normalize(value.name);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findInObject(item, keys, normalize, depth + 1, extraKey);
    if (found) return found;
  }
  return '';
}

const tryJson = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

function inferFromStorage(keys, normalize, extraKey) {
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const raw = storage.getItem(key);
      if (!raw || raw.length > 200000) continue;

      const parsed = tryJson(raw);
      if (parsed !== null) {
        const found = findInObject(parsed, keys, normalize, 0, extraKey);
        if (found) return found;
        continue;
      }
      // 非 JSON 值：只对名字做键名兜底，头像不做
      if (extraKey && /nick|display.?name|user.?name|screen.?name|profile/i.test(key)) {
        const found = normalizeName(raw);
        if (found) return found;
      }
    }
  }
  return '';
}

const inferNameFromStorage = () => inferFromStorage(NAME_KEYS, normalizeName, true);
const inferAvatarFromStorage = () => inferFromStorage(AVATAR_KEYS, normalizeAvatarUrl, false);

function inferNameFromPage() {
  const selectors = [
    '[data-testid*="user" i]', '[class*="user" i]', '[class*="avatar" i]',
    '[aria-label*="用户"]', '[aria-label*="账号"]', 'button',
  ];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const found = normalizeName(
        el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent,
      );
      if (found) return found;
    }
  }
  return '';
}

function inferAvatarFromPage() {
  const scoped = document.querySelectorAll(
    '[class*="avatar" i] img, [data-testid*="avatar" i] img, img[alt*="头像"], img[aria-label*="头像"]',
  );
  for (const img of scoped) {
    if (!isVisible(img)) continue;
    const src = normalizeAvatarUrl(img.currentSrc || img.src);
    if (src) return src;
  }
  const candidates = Array.from(document.querySelectorAll('img')).filter((img) => {
    const rect = img.getBoundingClientRect();
    return rect.top < 180 && rect.width <= 96 && rect.height <= 96;
  });
  for (const img of candidates) {
    if (!isVisible(img)) continue;
    const src = normalizeAvatarUrl(img.currentSrc || img.src);
    if (src) return src;
  }
  for (const el of document.querySelectorAll(
    '[class*="avatar" i], [data-testid*="avatar" i], [style*="background-image"]',
  )) {
    if (!isVisible(el)) continue;
    const match = /url\(["']?(.+?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
    const found = normalizeAvatarUrl(match?.[1]);
    if (found) return found;
  }
  return '';
}

// ── 会话页账号资料 ────────────────────────────────────────────────────────
let accountInfoCache = null;
let accountInfoCacheTime = 0;

const getCurrentChatUrl = () => `${location.origin}/chat/`;

function parseRouterDataFromHtml(html) {
  const documentRoot = new DOMParser().parseFromString(html, 'text/html');
  for (const script of documentRoot.querySelectorAll('script')) {
    const source = script.textContent || '';
    if (!source.includes('window._ROUTER_DATA')) continue;
    const assignmentIndex = source.indexOf('window._ROUTER_DATA');
    const objectStart = source.indexOf('{', assignmentIndex);
    const objectEnd = source.lastIndexOf('}');
    if (objectStart < 0 || objectEnd <= objectStart) continue;
    try {
      return JSON.parse(source.slice(objectStart, objectEnd + 1));
    } catch {}
  }
  return null;
}

function deepFindAccountInfo(value, depth = 0) {
  if (!value || depth > 6 || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepFindAccountInfo(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of ['accountInfo', 'account_info', 'userInfo', 'user_info']) {
    const node = value[key];
    if (node && typeof node === 'object') {
      return node.data && typeof node.data === 'object' ? node.data : node;
    }
  }
  for (const item of Object.values(value)) {
    const hit = deepFindAccountInfo(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const findAccountInfoNode = (routerData) =>
  routerData?.loaderData?.chat_layout?.chat_layout?.accountInfo?.data ||
  deepFindAccountInfo(routerData?.loaderData);

function getAccountInfoFromRouterData(routerData) {
  const info = findAccountInfoNode(routerData);
  if (!info || typeof info !== 'object') return null;

  const name = normalizeName(info.screen_name) || normalizeName(info.name);
  const avatarUrl = normalizeAvatarUrl(info.avatar_url);
  const mobile = String(info.mobile || '').trim();
  if (!name && !avatarUrl && !mobile) return null;

  const hasIdentity = Boolean(
    mobile || info.phone_collected || info.email || info.email_collected ||
    Number(info.has_password) === 1,
  );
  const visitorFlag = info.is_visitor_account;
  const notVisitor = visitorFlag === false || visitorFlag === 0 || visitorFlag === undefined;
  return {
    name, avatarUrl, mobile,
    source: 'router',
    isLoggedIn: hasIdentity && notVisitor,
  };
}

async function fetchAccountInfoFromChatPage() {
  if (accountInfoCache && Date.now() - accountInfoCacheTime < 10000) {
    return accountInfoCache;
  }
  try {
    const response = await fetch(getCurrentChatUrl(), {
      method: 'GET', credentials: 'include', cache: 'no-store',
    });
    if (!response.ok) return null;
    const routerData = parseRouterDataFromHtml(await response.text());
    const profile = getAccountInfoFromRouterData(routerData);
    if (profile) {
      accountInfoCache = profile;
      accountInfoCacheTime = Date.now();
    }
    return profile;
  } catch {
    return null;
  }
}

// ── 兜底登录判定 ──────────────────────────────────────────────────────────
function hasVisibleLoginEntry() {
  return getClickableElements().some((el) => {
    const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    return (
      /扫码登录|二维码登录|登录|登陆|注册|使用其他账号|log\s?in|sign\s?in/i.test(text) &&
      !/退出登录|已登录|log\s?out|sign\s?out/i.test(text)
    );
  });
}

function hasVisibleQrCode() {
  return Array.from(document.querySelectorAll('canvas, img, svg')).some((el) => {
    if (!isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    const label = `${el.getAttribute('alt') || ''} ${el.getAttribute('aria-label') || ''} ${el.className || ''}`;
    if (/二维码|扫码|qr/i.test(label)) return true;
    const inPlayer = el.closest('video, [class*="video" i], [class*="player" i]');
    const square =
      Math.abs(rect.width - rect.height) / Math.max(rect.width, rect.height) < 0.15;
    return (
      !inPlayer && square &&
      rect.width >= 120 && rect.height >= 120 &&
      rect.width <= 360 && rect.height <= 360
    );
  });
}

function isLoggedIn() {
  const name = inferNameFromStorage() || inferNameFromPage();
  const avatarUrl = inferAvatarFromStorage() || inferAvatarFromPage();
  if (!name && !avatarUrl) return false;
  if (hasVisibleLoginEntry() || hasVisibleQrCode()) return false;
  return true;
}

async function getAccountProfile() {
  const site = currentSiteId();
  const routerProfile = await fetchAccountInfoFromChatPage();
  if (routerProfile) return { ...routerProfile, site };
  return {
    name: inferNameFromStorage() || inferNameFromPage(),
    avatarUrl: inferAvatarFromStorage() || inferAvatarFromPage(),
    mobile: '',
    source: 'fallback',
    site,
    isLoggedIn: isLoggedIn(),
  };
}

// ── 自动点击登录入口 ──────────────────────────────────────────────────────
const AUTO_LOGIN_ATTEMPT_LIMIT = 20;
const AUTO_LOGIN_INTERVAL_MS = 700;
const AUTO_LOGIN_EXCLUDE_PATTERN = /退出登录|退出当前账号|登出|已登录|log\s?out|sign\s?out/i;
const SELF_UI_SELECTOR = '#dbp-workspace, #dbp-launcher-host, .dbk-dl';

const isSelfUi = (el) => Boolean(el?.closest?.(SELF_UI_SELECTOR));

function getLoginScope() {
  const modal = document.querySelector(
    '[role="dialog"], [aria-modal="true"], [class*="login-modal" i], [class*="login-panel" i]',
  );
  if (modal && isVisible(modal)) return modal;
  const main = document.querySelector('main, [class*="login" i], [class*="content" i]');
  if (main && isVisible(main)) return main;
  return document.body;
}

function getClickableElements(scope) {
  return Array.from(
    (scope || document).querySelectorAll('button, a, [role="button"], [tabindex]'),
  ).filter((el) => el instanceof HTMLElement && isVisible(el) && !isSelfUi(el));
}

function clickByText(pattern, excludePattern = null, scope = null) {
  const target = getClickableElements(scope).find((el) => {
    const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    if (!pattern.test(text)) return false;
    return !excludePattern || !excludePattern.test(text);
  });
  if (!target) return false;
  target.click();
  return true;
}

function clickPossibleAccountMenu(scope) {
  const selectors = [
    '[class*="avatar" i]', '[data-testid*="avatar" i]',
    'button[aria-label*="账号"]', 'button[aria-label*="用户"]',
    'header [class*="user" i]', 'header [class*="account" i]',
  ];
  for (const selector of selectors) {
    const target = getClickableElements(scope).find((el) => el.matches?.(selector));
    if (target) {
      target.click();
      return true;
    }
  }
  return false;
}

let autoLoginTimer = null;

function autoClickLoginEntry() {
  if (autoLoginTimer) return;
  let attempts = 0;
  const stop = () => {
    clearInterval(autoLoginTimer);
    autoLoginTimer = null;
  };
  autoLoginTimer = setInterval(() => {
    attempts += 1;
    if (attempts > AUTO_LOGIN_ATTEMPT_LIMIT) return stop();
    if (hasVisibleQrCode()) return stop();

    const scope = getLoginScope();
    if (
      clickByText(/切换账号|使用其他账号|其他账号|换个账号|switch account|use another account/i, AUTO_LOGIN_EXCLUDE_PATTERN, scope) ||
      clickByText(/扫码登录|二维码登录|登录|登陆|log\s?in|sign\s?in/i, AUTO_LOGIN_EXCLUDE_PATTERN, scope)
    ) {
      return stop();
    }
    if (attempts % 4 === 0) clickPossibleAccountMenu(scope);
  }, AUTO_LOGIN_INTERVAL_MS);
}

// ── 桥接 ─────────────────────────────────────────────────────────────────
const BRIDGE_ID = 'doubaokit-bridge';
const BRIDGE_ALLOWED_KEY_PATTERN = /^dbp\./;

function postToPage(payload) {
  try {
    window.postMessage({ bridge: BRIDGE_ID, ...payload }, '*');
  } catch {}
}

function runStorageBridge(data, run) {
  const reply = (extra) =>
    postToPage({ type: data.type + '-result', rid: data.rid, ok: true, ...extra });
  const fail = (error) =>
    postToPage({
      type: data.type + '-result', rid: data.rid, ok: false,
      error: error.message || String(error),
    });

  if (!BRIDGE_ALLOWED_KEY_PATTERN.test(String(data.key || ''))) {
    postToPage({ type: data.type + '-result', rid: data.rid, ok: false, error: '键名不被允许' });
    return;
  }
  Promise.resolve()
    .then(() => run(String(data.key || '')))
    .then(reply)
    .catch(fail);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_ACCOUNT_PROFILE') {
    getAccountProfile().then(sendResponse);
    return true;
  }
  if (message?.type === 'AUTO_CLICK_LOGIN') {
    autoClickLoginEntry();
    sendResponse({ ok: true });
  }
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.bridge !== BRIDGE_ID) return;
  if (typeof data.type === 'string' && /-result$|^ready$|^storage-changed$/.test(data.type)) return;

  if (data.type === 'ping') {
    postToPage({ type: 'ready' });
    return;
  }

  if (data.type === 'storage-get') {
    runStorageBridge(data, (key) =>
      chrome.storage.local.get(key).then((result) => ({ value: result[key] ?? null })),
    );
    return;
  }
  if (data.type === 'storage-set') {
    runStorageBridge(data, (key) => chrome.storage.local.set({ [key]: data.value }));
    return;
  }
  if (data.type === 'storage-remove') {
    runStorageBridge(data, (key) => chrome.storage.local.remove(key));
    return;
  }
  if (data.type === 'download') {
    chrome.runtime
      .sendMessage({
        type: 'DOWNLOAD_MEDIA',
        url: String(data.url || ''),
        filename: String(data.filename || ''),
      })
      .then((response) => {
        if (!response?.ok) throw new Error(response?.error || '下载失败');
        postToPage({ type: 'download-result', rid: data.rid, ok: true });
      })
      .catch((error) => {
        postToPage({
          type: 'download-result', rid: data.rid, ok: false,
          error: (error && error.message) || String(error),
        });
      });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.prototype.hasOwnProperty.call(changes, 'dbp.prompt.groups')) return;
  postToPage({ type: 'storage-changed', key: 'dbp.prompt.groups' });
});

(function broadcastReady(attempt) {
  postToPage({ type: 'ready' });
  if (attempt < 5) setTimeout(() => broadcastReady(attempt + 1), 300);
})(1);