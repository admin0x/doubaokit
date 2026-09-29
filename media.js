// media.js · 素材模块：识别豆包 / Dola 生成的图片与视频，挂「复制链接 / 无水印下载」按钮
// 按钮挂在素材的定位祖先里，与页面原生按钮同一节奏（hover 显示）
// 大文件走扩展下载只显示「下载中」，小文件走页面流式下载显示百分比
// 顺带隐藏豆包原生下载按钮（按图标 path 反查）
// @author Li · https://github.com/admin0x/doubaokit

(function () {
  'use strict';

  const NativeResponse = window.Response || null;
  const NativeTransformStream = window.TransformStream || null;

  const SITE_ID_BY_HOST = { 'doubao.com': 'doubao', 'dola.com': 'dola' };

  const currentSiteId = () => {
    const h = String(location.hostname || '').replace(/^www\./, '').toLowerCase();
    for (const [host, id] of Object.entries(SITE_ID_BY_HOST)) {
      if (h === host || h.endsWith('.' + host)) return id;
    }
    return '';
  };

  // ── 常量 ─────────────────────────────────────────────────────────────────
  const QAAB_SALT_HEX =
    '4dd4c2e6b83162090e52b3c7a6733ba4' +
    '1cb2462b829ab58a196b39db57177524' +
    'f49baf7f08e8d68d26a72e37c1a95a2f' +
    '1f05a51892aef2949732b62a38aadd58';

  const GEN_CONTAINER_PREFIXES = [
    'block-video-',
    'video-hover-button-group-container',
    'image-box-grid',
    'image-wrapper',
    'hover-actions-slot',
  ];

  const GEN_VIDEO_MARKER = '/tos-cn-v-';
  const GEN_IMAGE_MARKERS = ['/rc_gen_image/'];
  const USER_MEDIA_MARKERS = ['/rc_upload/', '/rc_user/', '/user_upload/', '/rc_input/', '/upload/'];

  const VALID_EXT = new Set(['jpg','jpeg','png','webp','gif','avif','bmp','mp4','mov','webm','m4v']);
  const PAGE_DOWNLOAD_LIMIT = 300 * 1024 * 1024;

  const USER_SCOPE_HINTS = [
    'justify-end','items-end','message-user','user-message','msg-user','user-msg',
    'chat-user','user-chat','bubble-user','user-bubble','self-message','message-self',
    'sender-user','user-sender','user-content','content-user','my-message','message-mine',
    'user-item','item-user','user-row','row-user','query-item','user-query',
    'user-ask','ask-user','input-item','user-input','user-send','send-user',
  ];
  const BOT_SCOPE_HINTS = [
    'message-assistant','assistant-message','msg-assistant','message-bot','bot-message',
    'message-ai','ai-message','chat-assistant','assistant-chat','bubble-assistant',
    'assistant-bubble','message-reply','reply-message','message-flow','flow-message',
    'assistant-content','content-assistant','answer-item','item-answer','response-item',
    'item-response','ai-item','item-ai',
  ];
  const USER_ROLE_VALUES = ['user','self','mine','human','me'];
  const BOT_ROLE_VALUES = ['assistant','bot','ai','system','model','doubao','dola'];
  const ROLE_ATTR_KEYS = ['role','author','sender','sender_type','from','message_author_role'];

  // ── 状态 ─────────────────────────────────────────────────────────────────
  const imageOriByKey = new Map();
  const videoByPoster = new Map();
  const processedFallbackApis = new Set();
  const fallbackVideoPosterIndex = new Map();
  const mountedMap = new Map();
  const buttonMap = new WeakMap();
  const observedSize = new WeakSet();
  const sizedNodes = new WeakSet();
  let strictOnly = window.__PROMPTKIT_PREVIEW__ !== true;
  let hideNativeDownload = true;
  let resizeObserver = null;
  let updateQueued = false;
  let tickTimer = null;
  let tickFast = false;

  // ── 基础工具 ─────────────────────────────────────────────────────────────
  const isHttpUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);
  const normalizeImageUrl = (url) => (typeof url === 'string' ? url.replace(/&amp;/g, '&') : '');
  const hitsAny = (text, hints) => {
    if (!text) return false;
    for (const h of hints) if (text.includes(h)) return true;
    return false;
  };
  const isUserMediaUrl = (url) => Boolean(url && hitsAny(String(url), USER_MEDIA_MARKERS));
  const hasDszWatermark = (url) => Boolean(url && String(url).toLowerCase().includes('dsz_watermark'));

  const baseKey = (url) => {
    const raw = normalizeImageUrl(url);
    if (!raw) return '';
    try {
      return new URL(raw, location.href).pathname.replace(/~[^/]*$/, '').replace(/\/+$/, '');
    } catch {
      return raw.split('?')[0].split('#')[0];
    }
  };

  const safeJsonStringify = (v) => { try { return JSON.stringify(v) || ''; } catch { return ''; } };

  const parseJsonString = (text) => {
    const s = text.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  // ── DOM 遍历 ─────────────────────────────────────────────────────────────
  const SCOPE_MAX_DEPTH = 14;

  function walkAncestors(el, visit) {
    let node = el;
    for (
      let i = 0;
      i < SCOPE_MAX_DEPTH && node && node !== document.body && node !== document.documentElement;
      i++
    ) {
      const hit = visit(node);
      if (hit) return hit;
      node = node.parentElement;
    }
    return null;
  }

  const classOf = (el) => {
    let cls = el.className;
    if (cls && typeof cls === 'object' && 'baseVal' in cls) cls = cls.baseVal;
    return String(cls || '');
  };

  // ── 归属判定 ─────────────────────────────────────────────────────────────
  function roleValueOf(el) {
    try {
      for (const key of ROLE_ATTR_KEYS) {
        let value = el.getAttribute(key);
        if (value == null) value = el.getAttribute('data-' + key.replace(/_/g, '-'));
        if (value == null) value = el.getAttribute('data-' + key);
        if (value != null && String(value).trim()) return String(value).trim().toLowerCase();
      }
    } catch {}
    return '';
  }

  function scopeSignature(el) {
    const parts = [];
    try {
      const cls = classOf(el);
      if (cls) parts.push(cls.toLowerCase());
      for (const attr of el.attributes) {
        const name = String(attr.name || '').toLowerCase();
        if (
          name === 'role' || name.includes('role') || name.includes('author') ||
          name.includes('sender') || name.includes('from') || name.includes('user') ||
          name.includes('assistant') || name.includes('bot')
        ) {
          parts.push(name);
          parts.push(String(attr.value || '').toLowerCase());
        }
      }
    } catch {}
    return parts.join(' ');
  }

  const scopeOf = (el) =>
    walkAncestors(el, (node) => {
      const role = roleValueOf(node);
      if (USER_ROLE_VALUES.includes(role)) return 'user';
      if (BOT_ROLE_VALUES.includes(role)) return 'bot';
      const sig = scopeSignature(node);
      if (hitsAny(sig, USER_SCOPE_HINTS)) return 'user';
      if (hitsAny(sig, BOT_SCOPE_HINTS)) return 'bot';
      return null;
    }) || '';

  const isInsideUserBubble = (el) => scopeOf(el) === 'user';

  // ── 生成容器判定 ─────────────────────────────────────────────────────────
  function inGeneratedContainer(el) {
    if (isInsideUserBubble(el)) return false;
    return Boolean(walkAncestors(el, (node) => {
      const s = classOf(node);
      if (!s) return false;
      for (const prefix of GEN_CONTAINER_PREFIXES) if (s.includes(prefix)) return true;
      return false;
    }));
  }

  const isInsideVideoBlock = (el) =>
    Boolean(walkAncestors(el, (node) => classOf(node).includes('block-video-')));

  // ── JSON 遍历 ────────────────────────────────────────────────────────────
  // 收集指定 key 的所有值；顺带解析内嵌的 JSON 字符串
  function findValuesByKey(value, targetKey) {
    const out = [];
    const seen = new Set();
    const walk = (v) => {
      if (v == null) return;
      if (typeof v === 'string') {
        const parsed = parseJsonString(v);
        if (parsed !== null) walk(parsed);
        return;
      }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, targetKey)) {
        out.push(v[targetKey]);
      }
      const items = Array.isArray(v) ? v : Object.values(v);
      for (const item of items) walk(item);
    };
    walk(value);
    return out;
  }

  function findKeySeedDeep(value, depth = 0) {
    if (depth > 10 || value == null) return '';
    if (typeof value === 'string') {
      let m = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
      if (m) return decodeURIComponent(m[1]);
      m = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
      return m ? decodeURIComponent(m[1]) : '';
    }
    if (typeof value !== 'object') return '';
    if (typeof value.key_seed === 'string' && value.key_seed.trim()) return value.key_seed.trim();
    for (const item of Object.values(value)) {
      const hit = findKeySeedDeep(item, depth + 1);
      if (hit) return hit;
    }
    return '';
  }

  // ── 图片 / 视频登记 ──────────────────────────────────────────────────────
  const getUrlInfo = (value) => {
    if (typeof value === 'string') return { url: normalizeImageUrl(value), width: 0, height: 0 };
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) return value.map(getUrlInfo).find(Boolean) || null;
    const url = normalizeImageUrl(value.url || value.image_url || value.src || value.uri);
    return url ? { url, width: value.width || 0, height: value.height || 0 } : null;
  };

  const getCreationImageInfo = (creation) => {
    const image = creation?.image || {};
    const ori = image.image_ori_raw;
    const preview = [
      image.image_thumb, image.image_thumb_raw, image.image_thumbnail,
      image.image_thumb_url, image.thumbnail, image.thumb, image.thumb_url,
      image.preview_url, image.image_ori,
    ].map(getUrlInfo).find(Boolean);
    if (typeof ori === 'string') return { url: ori, previewUrl: preview?.url || '', width: 0, height: 0 };
    if (ori && typeof ori === 'object' && ori.url) {
      return { url: ori.url, previewUrl: preview?.url || '', width: ori.width || 0, height: ori.height || 0 };
    }
    return null;
  };

  const getCreationVideoPoster = (creation) => {
    const v = creation?.video || {};
    return [
      v.poster_url, v.poster, v.cover_url, v.cover, v.thumbnail, v.first_frame,
      creation?.poster_url, creation?.cover_url,
    ].map(getUrlInfo).find(Boolean)?.url || '';
  };

  function collectImageUrls(value, bucket, depth) {
    if (value == null || depth > 6) return;
    if (typeof value === 'string') {
      if (isHttpUrl(value)) bucket.push(normalizeImageUrl(value));
      return;
    }
    if (typeof value !== 'object') return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      collectImageUrls(item, bucket, depth + 1);
    }
  }

  function registerImage(ori, others) {
    const target = normalizeImageUrl(ori);
    if (!target || isUserMediaUrl(target)) return;
    let changed = false;
    const primary = baseKey(target);
    if (primary && !imageOriByKey.has(primary)) { imageOriByKey.set(primary, target); changed = true; }
    for (const other of others || []) {
      const key = baseKey(other);
      if (key && !imageOriByKey.has(key)) { imageOriByKey.set(key, target); changed = true; }
    }
    if (changed) scheduleOverlayUpdate();
  }

  function registerVideo(info) {
    if (!info?.url) return;
    const poster = normalizeImageUrl(info.poster_url);
    let changed = false;
    if (poster) {
      const key = baseKey(poster);
      if (key && !videoByPoster.has(key)) { videoByPoster.set(key, info); changed = true; }
    }
    if (changed) scheduleOverlayUpdate();
  }

  // ── 视频解密 ─────────────────────────────────────────────────────────────
  const padBase64 = (t) => t + '='.repeat((4 - (t.length % 4)) % 4);

  function base64DecodeLoose(text) {
    const input = String(text || '').trim();
    const variants = [
      input,
      input.replace(/[$@#]/g, (c) => ({ $: '_', '@': '/', '#': '.' })[c]),
      input.replace(/[$@#]/g, (c) => ({ $: '+', '@': '/', '#': '=' })[c]),
    ];
    const seen = new Set();
    for (const candidate of variants) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const binary = atob(padBase64(candidate).replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      } catch {}
    }
    return null;
  }

  function asciiUrlFromBytes(bytes) {
    if (!bytes?.length) return '';
    for (const b of bytes) {
      if (b !== 9 && b !== 10 && b !== 13 && (b < 32 || b > 126)) return '';
    }
    return new TextDecoder().decode(bytes);
  }

  const hexToBytes = (hex) => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  };

  const concatBytes = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  function stripPkcs7(bytes) {
    if (!bytes?.length) return new Uint8Array();
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
    for (let i = bytes.length - pad; i < bytes.length; i++) {
      if (bytes[i] !== pad) return bytes;
    }
    return bytes.slice(0, bytes.length - pad);
  }

  async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
    if (!payload.length || payload.length % 16 !== 0) return '';
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, payload),
      );
      const direct = asciiUrlFromBytes(plain);
      if (isHttpUrl(direct)) return direct;
      const url = asciiUrlFromBytes(stripPkcs7(plain));
      return isHttpUrl(url) ? url : '';
    } catch { return ''; }
  }

  async function decodeQaabToken(token, keySeed) {
    const data = base64DecodeLoose(token);
    const seed = base64DecodeLoose(keySeed);
    if (!data || !seed) return '';

    const digest1 = await crypto.subtle.digest('SHA-512', seed.slice(0, 32));
    const digest2 = new Uint8Array(await crypto.subtle.digest('SHA-512',
      concatBytes(new Uint8Array(digest1), hexToBytes(QAAB_SALT_HEX))));
    const key = digest2.slice(0, 16);
    const iv = digest2.slice(16, 32);
    const attempts = [];

    if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
      attempts.push({ payload: data.slice(4), key, iv });
      attempts.push({ payload: data.slice(4), key: iv, iv: key });
      if (data.length > 36) {
        attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
        attempts.push({ payload: data.slice(36), key, iv });
      }
    } else {
      attempts.push({ payload: data, key, iv });
    }

    for (const a of attempts) {
      const url = await decryptAesCbcUrl(a.payload, a.key, a.iv);
      if (url) return url;
    }
    return '';
  }

  async function decodeMainUrl(token, keySeed = '') {
    if (isHttpUrl(token)) return token;
    const bytes = base64DecodeLoose(token);
    if (bytes) {
      const text = asciiUrlFromBytes(bytes);
      if (isHttpUrl(text)) return text;
    }
    if (token.startsWith('qAAB') && keySeed) return await decodeQaabToken(token, keySeed);
    return '';
  }

  // ── 兜底接口 ─────────────────────────────────────────────────────────────
  function decodeJsonEscapedFragment(value) {
    let text = value;
    for (let i = 0; i < 3; i++) {
      try {
        const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
        if (decoded === text) break;
        text = decoded;
      } catch { break; }
    }
    return text.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  }

  const addFallbackApi = (apis, value) => {
    if (typeof value !== 'string' || !value) return;
    const url = decodeJsonEscapedFragment(value);
    if (isHttpUrl(url)) apis.add(url);
  };

  function findFallbackApis(json, rawBody = '') {
    const apis = new Set();
    for (const value of findValuesByKey(json, 'fallback_api')) addFallbackApi(apis, value);

    const body = typeof rawBody === 'string' ? rawBody : '';
    for (const pattern of [/fallback_api\\":\\"(.*?)\\"/g, /"fallback_api"\s*:\s*"([^"]+)"/g]) {
      let m = pattern.exec(body);
      while (m) { addFallbackApi(apis, decodeJsonEscapedFragment(m[1])); m = pattern.exec(body); }
    }
    return [...apis];
  }

  const replaceQueryParams = (url, params) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };

  const getVideoData = (payload) => {
    const info = payload?.video_info || payload?.data?.video_info || payload;
    const data = info?.data || info;
    return data && typeof data === 'object' ? data : {};
  };

  function pickMainUrlEntry(data) {
    const list = data?.video_list;
    const entries =
      list && typeof list === 'object' && Object.keys(list).length ? Object.values(list) : [data];
    let best = null;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const token = entry.main_url || entry.play_url || '';
      if (typeof token !== 'string' || !token.trim()) continue;
      const score = Number(entry.bitrate || entry.real_bitrate || 0) +
        Number(entry.vwidth || entry.width || 0) * Number(entry.vheight || entry.height || 0);
      if (!best || score > best.score) best = { token: token.trim(), score, entry };
    }
    return best;
  }

  const requestJson = (url) =>
    originalFetch.call(window, url, {
      method: 'GET', credentials: 'omit',
      headers: { accept: 'application/json,text/plain,*/*' },
    }).then((r) => r.json());

  async function getVideoInfoFromFallbackApi(fallbackApi) {
    const apiUrl = replaceQueryParams(fallbackApi, {
      channel: 'no', codec_type: '8', logo_type: 'unwatermarked',
    });
    const payload = await requestJson(apiUrl);
    const data = getVideoData(payload);
    const picked = pickMainUrlEntry(data);
    if (!picked?.token) return null;

    const videoUrl = await decodeMainUrl(picked.token, findKeySeedDeep(payload));
    if (!videoUrl) return null;

    const m = picked.entry || {};
    return {
      vid: data.vid || data.video_id || m.vid || m.video_id || apiUrl,
      source: 'fallback_api',
      width: Number(m.vwidth || m.width || data.vwidth || data.width || 0),
      height: Number(m.vheight || m.height || data.vheight || data.height || 0),
      definition: m.definition || data.definition || '',
      duration: Number(m.duration || data.duration || 0),
      codec_type: m.codec_type || data.codec_type || '',
      poster_url: data.poster_url || data.poster || '',
      url: videoUrl,
    };
  }

  function processFallbackVideos(json, rawBody, posterUrl) {
    const apis = findFallbackApis(json, rawBody || '');
    if (!apis.length) return;
    for (const api of apis) {
      if (posterUrl) fallbackVideoPosterIndex.set(api, posterUrl);
      if (processedFallbackApis.has(api)) continue;
      processedFallbackApis.add(api);
      getVideoInfoFromFallbackApi(api)
        .then((info) => {
          if (!info) return;
          if (!info.poster_url) info.poster_url = fallbackVideoPosterIndex.get(api) || '';
          registerVideo(info);
        })
        .catch(() => {});
    }
  }

  // ── 响应解析 ─────────────────────────────────────────────────────────────
  function handleCreation(creation) {
    if (!creation || typeof creation !== 'object') return;
    if (creation.video) {
      processFallbackVideos(creation, safeJsonStringify(creation), getCreationVideoPoster(creation));
      return;
    }
    const info = getCreationImageInfo(creation);
    if (!info) return;
    const others = [];
    collectImageUrls(creation.image, others, 0);
    if (info.previewUrl) others.push(info.previewUrl);
    registerImage(info.url, others);
  }

  const handleCreations = (list) => {
    if (!Array.isArray(list)) return;
    for (const c of list) handleCreation(c);
  };

  function parseStreamChunk(data) {
    try {
      if (!data.event_data && !data.patch_op) return;
      let creations = [];

      if (data.patch_op) {
        for (const op of data.patch_op) {
          if (!Array.isArray(op.patch_value?.content_block)) continue;
          for (const block of op.patch_value.content_block) {
            const found = block?.content?.creation_block?.creations;
            if (Array.isArray(found)) { creations = found; break; }
          }
          if (creations.length) break;
        }
        if (!creations.length) {
          for (const ext of data.patch_op) {
            const full = ext?.patch_value?.ext?.creation_full_content;
            if (!full) continue;
            try {
              for (const item of JSON.parse(full)) {
                const found = item?.BlockInfo?.BlockContent?.content?.creation_block?.creations;
                if (Array.isArray(found)) { creations = found; break; }
              }
            } catch {}
            if (creations.length) break;
          }
        }
      } else {
        const eventData = JSON.parse(data.event_data);
        if (!eventData.message?.content) return;
        const messageContent = JSON.parse(eventData.message.content);
        if (!Array.isArray(messageContent.creations)) return;
        creations = messageContent.creations;
      }

      handleCreations(creations);
    } catch {}
    scheduleOverlayUpdate();
  }

  function isUserMessage(item) {
    if (!item || typeof item !== 'object') return false;
    const holder = item.message && typeof item.message === 'object' ? item.message : item;
    const role = String(
      holder.role || holder.author || holder.sender || holder.sender_type || holder.from || '',
    ).toLowerCase();
    if (role && (role === 'user' || role === 'human' || role.includes('user'))) return true;
    return ['is_user', 'from_user', 'is_self', 'user_send']
      .some((f) => holder[f] === true || holder[f] === 1);
  }

  function parseChatHistory(messages) {
    if (!Array.isArray(messages)) return;
    for (const item of messages) {
      if (isUserMessage(item)) continue;
      const blocks = item?.content_block;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const cb = block?.content?.creation_block;
        if (cb && Array.isArray(cb.creations)) handleCreations(cb.creations);
      }
    }
    scheduleOverlayUpdate();
  }

  // ── 网络拦截 ─────────────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  const originalXHROpen = window.XMLHttpRequest.prototype.open;
  const originalXHRSend = window.XMLHttpRequest.prototype.send;

  window.XMLHttpRequest.prototype.open = function (method, url) {
    this._dbkUrl = url;
    return originalXHROpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function () {
    const url = this._dbkUrl;
    this.addEventListener('load', function () {
      if (!url || !url.includes('/im/chain/single')) return;
      try {
        const data = JSON.parse(this.responseText);
        const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
        if (Array.isArray(messages)) parseChatHistory(messages);
        processFallbackVideos(data, this.responseText);
      } catch {}
    });
    return originalXHRSend.apply(this, arguments);
  };

  window.fetch = async function () {
    const args = [...arguments];
    const first = args[0];
    const url = typeof first === 'string' ? first : first?.url || '';

    if (url && url.includes('/im/chain/single')) {
      const response = await originalFetch.apply(this, args);
      response.clone().text().then((text) => {
        try {
          const data = JSON.parse(text);
          const messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
          if (Array.isArray(messages)) parseChatHistory(messages);
          processFallbackVideos(data, text);
        } catch {}
      }).catch(() => {});
      return response;
    }

    if (url && url.includes('/chat/completion')) {
      const completion = await originalFetch.apply(this, args);
      if (!NativeTransformStream || !NativeResponse || !completion.body) return completion;

      const decoder = new TextDecoder();
      let buffer = '';
      const parser = new NativeTransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.indexOf('data: ') !== 0) continue;
            const jsonStr = line.substring(6);
            if (jsonStr.indexOf('image_ori') < 0 && jsonStr.indexOf('fallback_api') < 0) continue;
            try {
              const data = JSON.parse(jsonStr);
              if (jsonStr.includes('fallback_api')) processFallbackVideos(data, jsonStr);
              if (data.event_data || data.patch_op) parseStreamChunk(data);
            } catch {}
          }
        },
      });

      const patched = new NativeResponse(completion.body.pipeThrough(parser), {
        headers: completion.headers,
        status: completion.status,
        statusText: completion.statusText,
      });
      for (const key of ['url', 'type', 'redirected']) {
        try {
          Object.defineProperty(patched, key, {
            value: completion[key], configurable: true, enumerable: false,
          });
        } catch {}
      }
      return patched;
    }

    return originalFetch.apply(this, arguments);
  };

  // ── 全局样式 ─────────────────────────────────────────────────────────────
  const STYLE_ID = 'dbk-media-style';
  const HIDE_RULE = '[data-dbk-native-download]{display:none !important;}';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = HIDE_RULE;
    (document.head || document.documentElement).appendChild(style);
  }

  // ── 按钮：自定义元素 + Shadow DOM ────────────────────────────────────────
  const TAG = 'dbk-actions';

  const SHADOW_CSS = `
:host { position: absolute; right: 8px; bottom: 8px; z-index: 2;
  display: flex; align-items: center; gap: 6px; }
button { position: relative; box-sizing: border-box; width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid rgba(255,255,255,.18); border-radius: 10px;
  background: rgba(12,12,16,.42); color: #fff; cursor: pointer; opacity: .85;
  transition: opacity .16s cubic-bezier(.32,.72,0,1), background .16s cubic-bezier(.32,.72,0,1);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
button:hover { opacity: 1; background: rgba(12,12,16,.62); }
button:active { opacity: .7; }
button svg { width: 24px; height: 24px; display: block; flex: none; }
.tip { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
  display: flex; align-items: center; justify-content: center;
  min-width: 34px; height: 26px; padding: 0 6px; box-sizing: border-box;
  border-radius: 9px; background: rgba(12,12,16,.78); color: #fff;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; }
.tip.ok { color: #009efa; }
.tip.err { color: #ff453a; }
`;

  const DL_ICON =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20.375 14.8535C20.9273 14.8535 21.375 15.3012 21.375 15.8535V18.5059C21.375 20.1627 20.0319 21.5059 18.375 21.5059H5.625C3.96815 21.5059 2.625 20.1627 2.625 18.5059V15.8535C2.625 15.3012 3.07272 14.8535 3.625 14.8535C4.17728 14.8535 4.625 15.3012 4.625 15.8535V18.5059C4.625 19.0581 5.07272 19.5059 5.625 19.5059H18.375C18.9273 19.5059 19.375 19.0581 19.375 18.5059V15.8535C19.375 15.3012 19.8227 14.8535 20.375 14.8535ZM12.001 1.99219C12.5529 1.99264 13.001 2.44018 13.001 2.99219V13.5146L17.8027 8.71289C18.1932 8.32272 18.8263 8.32274 19.2168 8.71289C19.607 9.10335 19.607 9.73649 19.2168 10.127L12.708 16.6367C12.5207 16.8241 12.2659 16.9295 12.001 16.9297C11.736 16.9297 11.4814 16.824 11.2939 16.6367L4.78418 10.127C4.3938 9.73642 4.3937 9.10336 4.78418 8.71289C5.17469 8.32281 5.80784 8.32265 6.19824 8.71289L11.001 13.5156V2.99219C11.001 2.4399 11.4487 1.99219 12.001 1.99219Z"/></svg>';

  const COPY_ICON =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.59 13.41c.41.39.41 1.03 0 1.42-.39.39-1.03.39-1.42 0a5 5 0 1 1 7.07-7.07l3.54 3.54a5 5 0 0 1-7.07 7.07c-.39-.39-.39-1.03 0-1.42.39-.39 1.03-.39 1.42 0a3 3 0 0 0 4.24-4.24l-3.54-3.54a3 3 0 0 0-4.24 4.24z"/><path d="M13.41 10.59c-.41-.39-.41-1.03 0-1.42.39-.39 1.03-.39 1.42 0a5 5 0 1 1-7.07 7.07L4.22 12.7a5 5 0 0 1 7.07-7.07c.39.39.39 1.03 0 1.42-.39.39-1.03.39-1.42 0a3 3 0 0 0-4.24 4.24l3.54 3.54a3 3 0 0 0 4.24-4.24z"/></svg>';

  class DbkActions extends HTMLElement {
    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'closed' });
      shadow.innerHTML =
        `<style>${SHADOW_CSS}</style>` +
        `<button class="copy" type="button" title="复制链接" aria-label="复制链接">${COPY_ICON}</button>` +
        `<button class="main" type="button" title="无水印下载" aria-label="无水印下载">${DL_ICON}</button>`;
      this.copyBtn = shadow.querySelector('.copy');
      this.mainBtn = shadow.querySelector('.main');
    }

    setTip(text, tone) {
      let tip = this.mainBtn.querySelector('.tip');
      if (!text) { if (tip) tip.remove(); return; }
      if (!tip) {
        tip = document.createElement('span');
        tip.className = 'tip' + (tone ? ' ' + tone : '');
        this.mainBtn.appendChild(tip);
      } else {
        tip.className = 'tip' + (tone ? ' ' + tone : '');
      }
      tip.textContent = text;
    }

    flash(btn, text, tone) {
      let tip = btn.querySelector('.tip');
      if (!tip) {
        tip = document.createElement('span');
        tip.className = 'tip ' + (tone || '');
        btn.appendChild(tip);
      }
      tip.textContent = text;
      setTimeout(() => { if (tip.isConnected) tip.remove(); }, 1200);
    }
  }
  customElements.define(TAG, DbkActions);

  // ── 原生下载按钮隐藏 ─────────────────────────────────────────────────────
  const normD = (d) => String(d || '').replace(/\s+/g, '');
  const NATIVE_DL_PATHS = new Set([
    normD((DL_ICON.match(/<path d="([^"]+)"/) || [])[1]),
    normD('M11.9922 1.99221C12.5445 1.98895 12.9958 2.43407 12.999 2.98634L13.0762 16.1943L14.6387 14.6328L17.8926 11.3789C18.2831 10.9884 18.9171 10.9885 19.3076 11.3789C19.6977 11.7695 19.6979 12.4026 19.3076 12.793L16.0527 16.0479L12.7979 19.3018C12.7111 19.3884 12.6098 19.4566 12.5 19.5059H20.375C20.9271 19.5059 21.3748 19.9538 21.375 20.5059C21.375 21.0581 20.9273 21.5059 20.375 21.5059H3.625C3.07272 21.5059 2.625 21.0581 2.625 20.5059C2.62523 19.9538 3.07286 19.5059 3.625 19.5059H11.6816C11.572 19.4566 11.4704 19.3884 11.3838 19.3018L4.87402 12.793C4.48372 12.4026 4.4839 11.7694 4.87402 11.3789C5.26452 10.9884 5.89756 10.9885 6.28809 11.3789L11.0762 16.166L10.999 2.99806C10.9958 2.44603 11.4402 1.99582 11.9922 1.99221Z'),
  ]);

  const isNativeDlIcon = (svg) => {
    for (const path of svg.querySelectorAll('path')) {
      if (NATIVE_DL_PATHS.has(normD(path.getAttribute('d')))) return true;
    }
    return false;
  };

  const HIDE_ATTR = 'data-dbk-native-download';
  const APP_CHROME = 'header, nav, aside, [role="dialog"]';
  const UNIT_MAX_DEPTH = 4;

  function buttonUnitOf(svg) {
    let el = svg.parentElement;
    for (let d = 0; el && d < UNIT_MAX_DEPTH; d++, el = el.parentElement) {
      if (/(^|\s)action-/.test(classOf(el))) return el;
    }
    return null;
  }

  // 单节点打标：MutationObserver 回调是微任务，在 paint 之前执行，
  // 同步调用可在首帧前完成打标，消除 FOUC
  function hideNativeIn(root) {
    if (!root || root.nodeType !== 1) return;
    if (!hideNativeDownload) return;
    const svgs = root.localName === 'svg' ? [root] : root.querySelectorAll?.('svg') || [];
    for (const svg of svgs) {
      if (!isNativeDlIcon(svg)) continue;
      const unit = buttonUnitOf(svg);
      if (!unit || unit.hasAttribute(HIDE_ATTR)) continue;
      if (unit.closest(APP_CHROME)) continue;
      unit.setAttribute(HIDE_ATTR, '1');
    }
  }

  // 全量打标：首屏与开关切换时使用；复用单节点逻辑，避免重复维护
  function syncNativeDownloadButtons() {
    if (!hideNativeDownload) return;
    hideNativeIn(document.documentElement);
  }

  function clearNativeMarks() {
    for (const el of document.querySelectorAll('[' + HIDE_ATTR + ']')) el.removeAttribute(HIDE_ATTR);
  }

  // ── 可见性 / 宿主 ────────────────────────────────────────────────────────
  const isVisible = (el) => {
    if (!el?.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function findHost(el) {
    const host = el.parentElement;
    if (!host) return null;
    let node = host;
    for (let i = 0; i < 4 && node && node !== document.body; i++) {
      const pos = getComputedStyle(node).position;
      if (pos === 'relative' || pos === 'absolute' || pos === 'fixed') return node;
      node = node.parentElement;
    }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    return host;
  }

  function placeButton(wrap, el, host) {
    const elRect = el.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const s = getComputedStyle(host);
    const right = Math.max(0, Math.round(hostRect.right - elRect.right + (parseFloat(s.borderRightWidth) || 0) + 8));
    const bottom = Math.max(0, Math.round(hostRect.bottom - elRect.bottom + (parseFloat(s.borderBottomWidth) || 0) + 8));
    wrap.style.right = right + 'px';
    wrap.style.bottom = bottom + 'px';
    wrap.style.left = 'auto';
    wrap.style.top = 'auto';
  }

  // ── 素材地址解析 ─────────────────────────────────────────────────────────
  const isGeneratedVideoUrl = (url) =>
    Boolean(url && isHttpUrl(url) && url.includes(GEN_VIDEO_MARKER) && !isUserMediaUrl(url));
  const isGeneratedImageUrl = (url) =>
    Boolean(url && isHttpUrl(url) && hitsAny(url, GEN_IMAGE_MARKERS));
  const stripImageWatermark = (url) => normalizeImageUrl(url).replace(/~[^/?#]*/, '');

  function getImageSourceUrl(el) {
    if (!el) return '';
    for (const candidate of [el.currentSrc, el.src]) {
      if (candidate && candidate.indexOf('data:') !== 0 && candidate.indexOf('blob:') !== 0) {
        return normalizeImageUrl(candidate);
      }
    }
    try {
      let host = el.closest?.('picture');
      if (!host && el.parentElement?.tagName?.toLowerCase() === 'picture') host = el.parentElement;
      if (host) {
        for (const source of host.querySelectorAll('source')) {
          const ss = source.getAttribute('srcset') || source.getAttribute('src') || '';
          const m = String(ss).match(/https?:\/\/[^\s,]+/);
          if (m && isHttpUrl(m[0])) return normalizeImageUrl(m[0]);
        }
      }
    } catch {}
    return '';
  }

  function getVideoSourceUrl(el) {
    if (!el) return '';
    for (const candidate of [el.currentSrc, el.src]) {
      if (candidate && candidate.indexOf('blob:') !== 0) return normalizeImageUrl(candidate);
    }
    try {
      for (const source of el.querySelectorAll('source')) {
        const s = source.getAttribute('src') || source.src || '';
        if (s && isHttpUrl(s)) return normalizeImageUrl(s);
      }
    } catch {}
    return '';
  }

  function posterOf(el) {
    let poster = '';
    try { poster = el.getAttribute?.('poster') || ''; } catch {}
    if (poster) return poster;
    let host = el.parentElement;
    for (let i = 0; i < 2 && host && host !== document.body; i++) {
      const node = host.querySelector('xg-poster, .xgplayer-poster, [class*="poster"]');
      if (node) {
        const m = (getComputedStyle(node).backgroundImage || '').match(/url\("?([^")]+)"?\)/);
        if (m && m[1] && isHttpUrl(m[1])) return normalizeImageUrl(m[1]);
      }
      host = host.parentElement;
    }
    return '';
  }

  const resolveImageUrl = (el) => {
    const src = getImageSourceUrl(el);
    if (!src) return '';
    const hit = imageOriByKey.get(baseKey(src));
    if (hit) return hit;
    if (isGeneratedImageUrl(src)) return stripImageWatermark(src);
    return normalizeImageUrl(src);
  };

  const videoUrlByPoster = (el) => {
    const poster = posterOf(el);
    if (!poster) return '';
    return videoByPoster.get(baseKey(poster))?.url || '';
  };

  const resolveVideoUrl = (el) => {
    const byPoster = videoUrlByPoster(el);
    if (byPoster) return byPoster;
    const src = getVideoSourceUrl(el);
    return isGeneratedVideoUrl(src) ? src : '';
  };

  const resolveTargetUrl = (el, kind) => {
    if (kind === 'image') return resolveImageUrl(el);
    const byPoster = videoUrlByPoster(el);
    if (byPoster) return byPoster;
    if (el.tagName === 'IMG') return '';
    return resolveVideoUrl(el);
  };

  function isGeneratedMedia(el, kind) {
    if (!strictOnly) return true;
    if (inGeneratedContainer(el)) return true;
    if (isInsideUserBubble(el)) return false;
    if (kind === 'image') return isGeneratedImageUrl(getImageSourceUrl(el));
    return isGeneratedVideoUrl(getVideoSourceUrl(el));
  }

  // ── 扫描与挂载 ───────────────────────────────────────────────────────────
  function collectTargets() {
    const targets = [];
    const videoHosts = new Set();

    for (const video of document.querySelectorAll('video')) {
      const r = video.getBoundingClientRect();
      if (r.width < 96 || r.height < 96 || !isVisible(video)) continue;
      if (isInsideUserBubble(video)) continue;
      if (!isGeneratedMedia(video, 'video')) continue;
      if (!resolveTargetUrl(video, 'video')) continue;
      const host = findHost(video);
      if (host) videoHosts.add(host);
      targets.push({ el: video, kind: 'video', rect: r });
    }

    for (const img of document.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      if (r.width < 96 || r.height < 96 || !isVisible(img)) continue;
      const src = getImageSourceUrl(img);
      if (!src) continue;
      if (isInsideUserBubble(img)) continue;
      if (isInsideVideoBlock(img)) continue;
      const host = findHost(img);
      if (host && videoHosts.has(host)) continue;

      if (!isGeneratedMedia(img, 'image')) continue;
      targets.push({ el: img, kind: 'image', rect: r });
    }
    return targets;
  }

  const MISS_LIMIT = 3;

  function dropButton(el, wrap) {
    if (wrap.parentElement) wrap.remove();
    if (buttonMap.get(el)?.wrap === wrap) buttonMap.delete(el);
    mountedMap.delete(el);
  }

  const posFingerprint = (r) =>
    `${Math.round(r.right / 4)}:${Math.round(r.bottom / 4)}:${Math.round(r.width / 8)}x${Math.round(r.height / 8)}`;

  function watchSize(el) {
    if (typeof ResizeObserver !== 'function' || observedSize.has(el)) return;
    if (!resizeObserver) resizeObserver = new ResizeObserver(() => scheduleOverlayUpdate());
    resizeObserver.observe(el);
    observedSize.add(el);
  }

  function watchPendingMedia() {
    let watched = 0;
    for (const node of document.querySelectorAll('img, video')) {
      if (watched >= 40) break;
      if (sizedNodes.has(node)) continue;
      if (!node.isConnected) continue;
      if (node.getBoundingClientRect().width >= 96) {
        sizedNodes.add(node);
        continue;
      }
      if (!node.getAttribute('src') && !node.getAttribute('poster')) continue;
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      watchSize(node);
      watched++;
    }
  }

  // ── 下载 ─────────────────────────────────────────────────────────────────
  const guessExt = (url, fallback) => {
    const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url || '');
    const ext = m ? m[1].toLowerCase() : '';
    if (ext && VALID_EXT.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    return fallback;
  };

  const buildFilename = (kind, url) =>
    `${currentSiteId() || 'doubao'}-${kind}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.${guessExt(url, kind === 'video' ? 'mp4' : 'jpg')}`;

  function pageDownload(url, filename, onProgress) {
    return fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const total = Number(response.headers.get('content-length')) || 0;
        if (!response.body?.getReader) {
          return response.blob().then((blob) => {
            onProgress?.(blob.size, blob.size || total);
            return blob;
          });
        }
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        return (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            onProgress?.(loaded, total);
          }
          return new Blob(chunks);
        })();
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
        return blob.size || 0;
      });
  }

  const BRIDGE_ID = 'doubaokit-bridge';
  let bridgeSeq = 0;
  const bridgeCallbacks = new Map();

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.bridge !== BRIDGE_ID || data.type !== 'download-result') return;
    const cb = bridgeCallbacks.get(data.rid);
    if (!cb) return;
    bridgeCallbacks.delete(data.rid);
    cb(data.ok ? null : data.error || '下载失败');
  });

  function requestBridgeDownload(url, filename) {
    return new Promise((resolve, reject) => {
      const rid = 'dl-' + (bridgeSeq += 1);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bridgeCallbacks.delete(rid);
        error ? reject(new Error(error)) : resolve();
      };
      const timer = setTimeout(() => finish('下载桥无响应'), 8000);
      bridgeCallbacks.set(rid, finish);
      try {
        window.postMessage({ bridge: BRIDGE_ID, type: 'download', rid, url, filename }, '*');
      } catch (error) {
        finish(error?.message || '下载桥不可用');
      }
    });
  }

  async function extensionDownload(url, filename, host) {
    if (window.__PROMPTKIT_PREVIEW__ === true) throw new Error('预览模式不使用扩展下载');
    host.setTip('下载中');
    const startedAt = Date.now();
    try {
      await requestBridgeDownload(url, filename);
    } finally {
      const remain = 1200 - (Date.now() - startedAt);
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
    }
  }

  function runDownload(url, kind, host, hooks) {
    const filename = buildFilename(kind, url);
    fetch(url, { method: 'HEAD' })
      .then((r) => Number(r.headers.get('content-length')) || 0)
      .catch(() => 0)
      .then((size) => {
        if (size > PAGE_DOWNLOAD_LIMIT) {
          extensionDownload(url, filename, host).then(hooks.onDone, hooks.onFail);
          return;
        }
        pageDownload(url, filename, hooks.onProgress).then(
          (bytes) => hooks.onDone(bytes),
          (error) => hooks.onFail(error?.message || '未知错误'),
        );
      });
  }

  function downloadOne(url, kind, btn) {
    const host = btn.getRootNode().host;
    if (!host) return;
    host.setTip('0%');
    let lastPaint = 0;

    runDownload(url, kind, host, {
      onProgress: (loaded, size) => {
        const now = Date.now();
        if (size <= 0) {
          if (now - lastPaint < 400) return;
          lastPaint = now;
          host.setTip((loaded / 1024).toFixed(0) + ' KB');
          return;
        }
        if (now - lastPaint < 200) return;
        lastPaint = now;
        host.setTip(Math.min(99, Math.round((loaded / size) * 100)) + '%');
      },
      onDone: () => host.setTip(null),
      onFail: () => {
        host.setTip('下载失败', 'err');
        setTimeout(() => host.setTip(null), 1800);
      },
    });
  }

  function legacyCopy(text) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return Boolean(ok);
    } catch { return false; }
  }

  function copyText(text, btn) {
    const host = btn.getRootNode().host;
    const done = () => host?.flash(btn, '已复制', 'ok');
    const fail = () => host?.flash(btn, '复制失败', 'err');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => (legacyCopy(text) ? done() : fail()));
    } else {
      legacyCopy(text) ? done() : fail();
    }
  }

  // ── 主渲染 ───────────────────────────────────────────────────────────────
  function renderOverlay() {
    const targets = collectTargets();
    const alive = new Set();
    const posTaken = new Set();

    watchPendingMedia();

    for (const target of targets) {
      const el = target.el;
      const host = findHost(el);
      if (!host) continue;

      const posKey = posFingerprint(target.rect);
      if (posTaken.has(posKey)) continue;
      posTaken.add(posKey);
      alive.add(el);

      let entry = buttonMap.get(el);
      if (entry && entry.kind !== target.kind) {
        if (entry.wrap.parentElement) entry.wrap.remove();
        entry = null;
      }

      let fresh = false;
      if (!entry || !entry.wrap.isConnected) {
        if (entry?.wrap.parentElement) entry.wrap.remove();
        const wrap = document.createElement(TAG);
        wrap.className = 'dbk-dl';
        wrap.dataset.dbk = '1';
        entry = { wrap, copy: wrap.copyBtn, main: wrap.mainBtn, kind: target.kind };
        buttonMap.set(el, entry);
        host.appendChild(wrap);
        mountedMap.set(el, { wrap, misses: 0 });
        fresh = true;
      } else if (entry.wrap.parentElement !== host) {
        host.appendChild(entry.wrap);
      }

      if (fresh) {
        const { main, copy } = entry;
        main.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const url = resolveTargetUrl(el, target.kind);
          if (!url) return void main.getRootNode().host.setTip('未获取到地址', 'err');
          downloadOne(url, target.kind, main);
        });
        copy.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const url = resolveTargetUrl(el, target.kind);
          if (!url) return void copy.getRootNode().host.flash(copy, '未获取到地址', 'err');
          copyText(url, copy);
        });
        watchSize(el);
      }

      placeButton(entry.wrap, el, host);
    }

    mountedMap.forEach((record, el) => {
      const wrap = record.wrap;
      if (alive.has(el) && wrap.isConnected) { record.misses = 0; return; }
      if (!el.isConnected || !wrap.isConnected) return void dropButton(el, wrap);
      record.misses += 1;
      if (record.misses >= MISS_LIMIT) dropButton(el, wrap);
    });

    scheduleTick();
  }

  const TICK_FAST = 1000;
  const TICK_IDLE = 2000;

  function scheduleTick() {
    const wantFast = mountedMap.size > 0;
    if (tickTimer && wantFast === tickFast) return;
    tickFast = wantFast;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(scheduleOverlayUpdate, wantFast ? TICK_FAST : TICK_IDLE);
  }

  function scheduleOverlayUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(() => {
      updateQueued = false;
      try { renderOverlay(); } catch {}
    });
  }

  // ── 对外 API ─────────────────────────────────────────────────────────────
  const mediaApi = {
    setStrict: (v) => { strictOnly = Boolean(v); scheduleOverlayUpdate(); },
    setUserScopeHints: (list) => {
      if (!Array.isArray(list)) return;
      for (const hint of list) {
        if (hint && !USER_SCOPE_HINTS.includes(hint)) USER_SCOPE_HINTS.push(String(hint).toLowerCase());
      }
      scheduleOverlayUpdate();
    },
    setHideNativeDownload: (on) => {
      const next = Boolean(on);
      if (hideNativeDownload && !next) clearNativeMarks();
      hideNativeDownload = next;
      if (next) syncNativeDownloadButtons();
      scheduleOverlayUpdate();
    },
    setUserPatterns: (list) => {
      if (!Array.isArray(list)) return;
      for (const m of list) if (m && !USER_MEDIA_MARKERS.includes(m)) USER_MEDIA_MARKERS.push(m);
      scheduleOverlayUpdate();
    },
    isUserMedia: (url) => isUserMediaUrl(url),
    explain: (el) => {
      if (!el) return null;
      const chain = [];
      let node = el;
      for (let i = 0; i < 12 && node && node !== document.body; i++) {
        chain.push({
          tag: node.tagName,
          role: roleValueOf(node),
          cls: classOf(node).slice(0, 140),
          user: isInsideUserBubble(node),
        });
        node = node.parentElement;
      }
      const src = el.tagName === 'IMG' ? getImageSourceUrl(el) : getVideoSourceUrl(el);
      return { inUserBubble: isInsideUserBubble(el), src, isUserUrl: isUserMediaUrl(src), chain };
    },
  };
  window.DoubaoKitMedia = mediaApi;
  window.PromptKitMedia = mediaApi;

  // ── 初始化 ───────────────────────────────────────────────────────────────
  ensureStyle();

  let observerTimer = null;
  const scheduleScan = () => {
    if (observerTimer) return;
    observerTimer = setTimeout(() => {
      observerTimer = null;
      scheduleOverlayUpdate();
    }, 100);
  };

  const observer = new MutationObserver((records) => {
    let needsScan = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target?.dataset?.dbk !== '1') needsScan = true;
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || node.dataset?.dbk === '1') continue;
        needsScan = true;
        hideNativeIn(node);
      }
      for (const node of record.removedNodes) {
        if (node.nodeType === 1 && node.dataset?.dbk !== '1') needsScan = true;
      }
    }
    if (needsScan) scheduleScan();
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'poster', 'currentSrc'],
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(scheduleOverlayUpdate, 200);
  }, { passive: true });

  const isChatPage = () =>
    window.__PROMPTKIT_PREVIEW__ === true ||
    (window.location.pathname.includes('/chat/') && Boolean(currentSiteId()));

  function firstPass() {
    if (!isChatPage()) return;
    scheduleOverlayUpdate();
    try { syncNativeDownloadButtons(); } catch {}
    scheduleTick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', firstPass);
  } else {
    firstPass();
  }
})();