// content.js · 页面内容脚本：读取当前登录账号信息
// @author Li · GPL-3.0 · https://github.com/admin8384/doubaokit

// 受支持站点主域 → 站点 id（background 注册表的裁剪副本）
const SITE_ID_BY_HOST = { 'doubao.com': 'doubao', 'dola.com': 'dola' };

// 当前页面所属站点 id，非受支持站点返回空
function currentSiteId() {
  const hostname = String(location.hostname || '')
    .replace(/^www\./, '')
    .toLowerCase();
  for (const [host, siteId] of Object.entries(SITE_ID_BY_HOST)) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return siteId;
  }
  return '';
}

// 元素是否真实可见：在 DOM 内、有尺寸且在视口内
function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
    return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
}

// 规范化昵称，过滤语言标记与登录注册等无关文案
function normalizeName(value) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > 40) return '';
  if (/^(cn|zh|zh-cn|en|en-us|ja|ko|sg|us|gb)$/i.test(text)) return '';
  if (/^[a-z]{2}[-_][a-z]{2}$/i.test(text)) return '';
  if (/登录|登陆|注册|扫码|退出|设置|下载|豆包|Doubao/i.test(text)) return '';
  return text;
}

// 昵称候选键
const NAME_KEYS = [
  'nickname',
  'nick_name',
  'screen_name',
  'display_name',
  'user_name',
  'username',
  'userName',
];

// 在对象里递归按候选键找昵称
function findNameInObject(value, depth = 0) {
  if (!value || depth > 4 || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNameInObject(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  for (const key of NAME_KEYS) {
    const found = normalizeName(value[key]);
    if (found) return found;
  }
  if (/user|account|profile|author|owner/i.test(Object.keys(value).join(' '))) {
    const found = normalizeName(value.name);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findNameInObject(item, depth + 1);
    if (found) return found;
  }
  return '';
}

// 规范化头像地址，非图片地址返回空
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

// 头像候选键
const AVATAR_KEYS = [
  'avatar',
  'avatar_url',
  'avatarUrl',
  'icon',
  'icon_url',
  'picture',
  'photo',
  'profile_image_url',
];

// 在对象里递归按候选键找头像
function findAvatarInObject(value, depth = 0) {
  if (!value || depth > 4 || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAvatarInObject(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  for (const key of AVATAR_KEYS) {
    const found = normalizeAvatarUrl(value[key]);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findAvatarInObject(item, depth + 1);
    if (found) return found;
  }
  return '';
}

// 从本地存储推断昵称
function inferNameFromStorage() {
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const raw = storage.getItem(key);
      if (!raw || raw.length > 200000) continue;
      try {
        const found = findNameInObject(JSON.parse(raw));
        if (found) return found;
      } catch {
        if (/nick|display.?name|user.?name|screen.?name|profile/i.test(key)) {
          const found = normalizeName(raw);
          if (found) return found;
        }
      }
    }
  }
  return '';
}

// 从本地存储推断头像
function inferAvatarFromStorage() {
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const raw = storage.getItem(storage.key(i));
      if (!raw || raw.length > 200000) continue;
      try {
        const found = findAvatarInObject(JSON.parse(raw));
        if (found) return found;
      } catch {}
    }
  }
  return '';
}

// 从页面可见元素推断昵称
function inferNameFromPage() {
  const selectors = [
    '[data-testid*="user" i]',
    '[class*="user" i]',
    '[class*="avatar" i]',
    '[aria-label*="用户"]',
    '[aria-label*="账号"]',
    'button',
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

// 从页面图片或背景图推断头像
function inferAvatarFromPage() {
  const scopedCandidates = [
    ...document.querySelectorAll(
      '[class*="avatar" i] img, [data-testid*="avatar" i] img, img[alt*="头像"], img[aria-label*="头像"]',
    ),
  ];
  for (const img of scopedCandidates) {
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
    const style = getComputedStyle(el);
    const match = /url\(["']?(.+?)["']?\)/.exec(style.backgroundImage || '');
    const found = normalizeAvatarUrl(match?.[1]);
    if (found) return found;
  }
  return '';
}

// 账号资料缓存，10 秒内不重复请求会话页
let accountInfoCache = null;
let accountInfoCacheTime = 0;

// 站点自适应：抓当前站点的会话页
function getCurrentChatUrl() {
  return `${location.origin}/chat/`;
}

// 从页面 HTML 中解析 window._ROUTER_DATA
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
    } catch {
      // 片段不是完整 JSON，换下一个候选
    }
  }
  return null;
}

// 在 loaderData 里深搜账号节点，兼容不同站点的字段层级
function findAccountInfoNode(routerData) {
  const loaderData = routerData?.loaderData;
  if (!loaderData || typeof loaderData !== 'object') return null;
  return deepFindAccountInfo(loaderData);
}

// 递归查找含账号信息的节点
function deepFindAccountInfo(value, depth = 0) {
  if (!value || depth > 6 || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindAccountInfo(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ['accountInfo', 'account_info', 'userInfo', 'user_info']) {
    const node = value[key];
    const data = node?.data ?? node;
    if (data && typeof data === 'object') return data;
  }
  for (const item of Object.values(value)) {
    const found = deepFindAccountInfo(item, depth + 1);
    if (found) return found;
  }
  return null;
}

// 从路由数据中提取账号资料
function getAccountInfoFromRouterData(routerData) {
  // 优先取豆包的固定路径，取不到再深搜兜底
  const fixedPath = routerData?.loaderData?.chat_layout?.chat_layout?.accountInfo?.data;
  const accountInfo =
    fixedPath && typeof fixedPath === 'object' ? fixedPath : findAccountInfoNode(routerData);
  if (!accountInfo || typeof accountInfo !== 'object') return null;

  const name = normalizeName(accountInfo.screen_name) || normalizeName(accountInfo.name);
  const avatarUrl = normalizeAvatarUrl(accountInfo.avatar_url);
  const mobile = String(accountInfo.mobile || '').trim();
  if (!name && !avatarUrl && !mobile) return null;
  const hasAuthenticatedIdentity = Boolean(
    mobile ||
    accountInfo.phone_collected ||
    accountInfo.email ||
    accountInfo.email_collected ||
    Number(accountInfo.has_password) === 1,
  );
  return {
    name,
    avatarUrl,
    mobile,
    source: 'router',
    // 访客标记缺失时（部分站点不下发该字段）只按实名要素判定
    isLoggedIn: accountInfo.is_visitor_account !== true && hasAuthenticatedIdentity,
  };
}

// 拉取会话页解析账号资料，命中缓存则直接返回
async function fetchAccountInfoFromChatPage() {
  const siteId = currentSiteId();
  if (!siteId) return null;
  if (accountInfoCache && Date.now() - accountInfoCacheTime < 10000) {
    return accountInfoCache;
  }
  try {
    const response = await fetch(getCurrentChatUrl(), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
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

// 综合本地存储与页面元素推断昵称
function getAccountName() {
  return inferNameFromStorage() || inferNameFromPage();
}

// 对外入口：优先取路由数据，取不到再走兜底推断
async function getAccountProfile() {
  const routerProfile = await fetchAccountInfoFromChatPage();
  if (routerProfile) return { ...routerProfile, site: currentSiteId() };
  return {
    name: getAccountName(),
    avatarUrl: inferAvatarFromStorage() || inferAvatarFromPage(),
    mobile: '',
    source: 'fallback',
    site: currentSiteId(),
    isLoggedIn: isLoggedIn(),
  };
}

// 取页面里可点击元素，排除插件自身 UI
function getClickableElements() {
  return Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]')).filter(
    (el) => el instanceof HTMLElement && isVisible(el),
  );
}

// 页面是否显示登录入口，显示即说明未登录
function hasVisibleLoginEntry() {
  return getClickableElements().some((el) => {
    const text =
      `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    // 中英文界面都要覆盖，Dola 为英文
    return (
      /扫码登录|二维码登录|登录|登陆|注册|使用其他账号|log\s?in|sign\s?in|sign\s?up/i.test(text) &&
      !/退出登录|已登录|log\s?out|sign\s?out/i.test(text)
    );
  });
}

// 页面是否显示登录二维码
function hasVisibleQrCode() {
  return Array.from(document.querySelectorAll('canvas, img, svg')).some((el) => {
    if (!isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    const label = `${el.getAttribute('alt') || ''} ${el.getAttribute('aria-label') || ''} ${el.className || ''}`;
    return (
      /二维码|扫码|qr/i.test(label) ||
      (rect.width >= 120 && rect.height >= 120 && rect.width <= 360 && rect.height <= 360)
    );
  });
}

// 兜底登录判断：有身份信息且页面没有登录入口
function isLoggedIn() {
  const name = getAccountName();
  const avatarUrl = inferAvatarFromStorage() || inferAvatarFromPage();
  if (!name && !avatarUrl) return false;
  if (hasVisibleLoginEntry() || hasVisibleQrCode()) return false;
  return true;
}

// 自动点击登录入口的安全约束：不点退出登录、只查登录容器、排除插件 UI、点到即停
// 最大尝试次数，超过则放弃
const AUTO_LOGIN_ATTEMPT_LIMIT = 20;
// 自动点击的轮询间隔
const AUTO_LOGIN_INTERVAL_MS = 700;
// 排除退出登录类入口，避免把已登录账号登出
const AUTO_LOGIN_EXCLUDE_PATTERN = /退出登录|退出当前账号|登出|已登录|log\s?out|sign\s?out/i;
// 插件自身 UI，绝不能被自动点击命中
const SELF_UI_SELECTOR = '#dba-workspace, #dba-panel, #dba-launcher-host, #doubaokit-btn';

// 是否插件自身 UI，自动点击必须绕开
function isSelfUi(el) {
  return Boolean(el && el.closest && el.closest(SELF_UI_SELECTOR));
}

// 取范围内可点击元素，排除插件自身 UI
function getScopedClickableElements(scope) {
  return Array.from(
    (scope || document).querySelectorAll('button, a, [role="button"], [tabindex]'),
  ).filter((el) => el instanceof HTMLElement && isVisible(el) && !isSelfUi(el));
}

// 登录入口的查找范围：登录弹层 → 主内容区 → 整个页面
function getLoginScope() {
  const modal = document.querySelector(
    '[role="dialog"], [aria-modal="true"], [class*="login-modal" i], [class*="login-panel" i]',
  );
  if (modal && isVisible(modal)) return modal;
  const main = document.querySelector('main, [class*="login" i], [class*="content" i]');
  if (main && isVisible(main)) return main;
  return document.body;
}

// 按文案点击第一个匹配元素
function clickByText(pattern, excludePattern = null, scope = null) {
  const target = getScopedClickableElements(scope).find((el) => {
    const text =
      `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
    if (!pattern.test(text)) return false;
    return !excludePattern || !excludePattern.test(text);
  });
  if (!target) return false;
  target.click();
  return true;
}

// 只点明确的账号或头像入口
function clickPossibleAccountMenu(scope) {
  const target = getScopedClickableElements(scope).find((el) => {
    const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`;
    return /账号|用户|个人|头像|profile|user|avatar|account/i.test(label);
  });
  if (!target) return false;
  target.click();
  return true;
}

// 自动点击只跑一个实例：启动、页面导航、Cookie 变化都会触发它
let autoLoginTimer = null;

// 自动点击登录入口，直到点中登录按钮或出现二维码
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

    // 二维码已出现则停止点击
    if (hasVisibleQrCode()) return stop();

    const scope = getLoginScope();
    if (
      clickByText(
        /切换账号|使用其他账号|其他账号|换个账号|switch account|use another account/i,
        AUTO_LOGIN_EXCLUDE_PATTERN,
        scope,
      ) ||
      clickByText(
        /扫码登录|二维码登录|登录|登陆|log\s?in|sign\s?in/i,
        AUTO_LOGIN_EXCLUDE_PATTERN,
        scope,
      )
    ) {
      return stop();
    }

    // 找不到入口时低频尝试展开账号菜单
    if (attempts % 3 === 0) clickPossibleAccountMenu(scope);
  }, AUTO_LOGIN_INTERVAL_MS);
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
