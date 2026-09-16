// media-kit.js · 素材模块：识别豆包 / Dola 生成的图片与视频，挂「复制链接 / 无水印下载」按钮
// 只处理站点生成的内容，用户自己上传的图片 / 视频不加按钮
// 判据是 DOM 容器结构，不依赖 URL 后缀（同一张图会有不同 ~tplv 模板）
// 顺带隐藏豆包原生下载按钮（按图标 path 反查，保留「引用 / 重新生成」等同排按钮）
// @author Li · https://github.com/admin0x/doubaokit

(function () {
  'use strict';

  var NativeReadableStream = window.ReadableStream || null;
  var NativeResponse = window.Response || null;

  // 受支持站点主域 → 站点 id（background 注册表的裁剪副本）
  // 当前页面所属站点 id，非受支持站点返回空
  // 注：站点表在 content.js 有一份同款副本，两者运行在不同 world、无法共享，改一处要改两处
  var SITE_ID_BY_HOST = { 'doubao.com': 'doubao', 'dola.com': 'dola' };

  function currentSiteId() {
    var hostname = String(window.location.hostname || '')
      .replace(/^www\./, '')
      .toLowerCase();
    var hosts = Object.keys(SITE_ID_BY_HOST);
    for (var i = 0; i < hosts.length; i += 1) {
      if (hostname === hosts[i] || hostname.endsWith('.' + hosts[i]))
        return SITE_ID_BY_HOST[hosts[i]];
    }
    return '';
  }

  var QAAB_SALT_HEX =
    '4dd4c2e6b83162090e52b3c7a6733ba4' +
    '1cb2462b829ab58a196b39db57177524' +
    'f49baf7f08e8d68d26a72e37c1a95a2f' +
    '1f05a51892aef2949732b62a38aadd58';

  var processedFallbackApis = new Set();
  var fallbackVideoPosterIndex = new Map();

  // 无水印资源登记表：页面地址 → 无水印原文件地址
  var imageOriByKey = new Map(); // baseKey(任意图片地址) -> 无水印原图地址
  var videoByPoster = new Map(); // baseKey(封面地址)     -> 视频信息
  // 只给站点生成的素材加按钮
  var strictOnly = window.__PROMPTKIT_PREVIEW__ !== true;

  // 把图片地址归一成可比对的主键
  function baseKey(url) {
    var raw = normalizeImageUrl(url);
    if (!raw) return '';
    try {
      var parsed = new URL(raw, window.location.href);
      return parsed.pathname.replace(/~[^/]*$/, '').replace(/\/+$/, '');
    } catch (error) {
      return raw.split('?')[0].split('#')[0];
    }
  }

  // 登记无水印原图地址，页面地址与原图建立映射
  function registerImage(ori, others) {
    var target = normalizeImageUrl(ori);
    if (!target) return;
    // 用户上传的图不登记，避免污染判定
    if (isUserMediaUrl(target)) return;
    var changed = false;
    var primaryKey = baseKey(target);
    if (primaryKey && !imageOriByKey.has(primaryKey)) {
      imageOriByKey.set(primaryKey, target);
      changed = true;
    }
    for (var i = 0; i < (others || []).length; i += 1) {
      var key = baseKey(others[i]);
      if (key && !imageOriByKey.has(key)) {
        imageOriByKey.set(key, target);
        changed = true;
      }
    }
    if (changed) {
      // 地址拿到后立刻重扫
      scheduleOverlayUpdate();
    }
  }

  // 收集 creation.image 下所有地址
  function collectImageUrls(value, bucket, depth) {
    if (value == null || depth > 6) return;
    if (typeof value === 'string') {
      if (isHttpUrl(value)) bucket.push(normalizeImageUrl(value));
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) collectImageUrls(value[i], bucket, depth + 1);
      return;
    }
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key))
        collectImageUrls(value[key], bucket, depth + 1);
    }
  }

  // 登记无水印视频地址，同时用封面与 vid 建索引
  function registerVideo(info) {
    if (!info || !info.url) return;
    var poster = normalizeImageUrl(info.poster_url);
    var changed = false;
    if (poster) {
      var posterKey = baseKey(poster);
      if (posterKey && !videoByPoster.has(posterKey)) {
        videoByPoster.set(posterKey, info);
        changed = true;
      }
    }
    if (changed) {
      // 视频地址拿到后立刻重扫
      scheduleOverlayUpdate();
    }
  }

  // 复用 DoubaoKit 的素材地址解析算法
  function normalizeImageUrl(url) {
    return typeof url === 'string' ? url.replace(/&amp;/g, '&') : '';
  }

  // 从字符串或对象里取出图片地址与宽高
  function getUrlInfo(value) {
    if (typeof value === 'string') return { url: normalizeImageUrl(value), width: 0, height: 0 };
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) return value.map(getUrlInfo).find(Boolean) || null;
    const url = normalizeImageUrl(value.url || value.image_url || value.src || value.uri);
    return url ? { url, width: value.width || 0, height: value.height || 0 } : null;
  }

  // 从 creation 里提取生成图的原图与预览地址
  function getCreationImageInfo(creation) {
    const image = creation?.image || {};
    const imageData = image.image_ori_raw;
    const previewData = [
      image.image_thumb,
      image.image_thumb_raw,
      image.image_thumbnail,
      image.image_thumb_url,
      image.thumbnail,
      image.thumb,
      image.thumb_url,
      image.preview_url,
      image.image_ori,
    ]
      .map(getUrlInfo)
      .find(Boolean);
    if (typeof imageData === 'string') {
      return {
        url: imageData,
        previewUrl: previewData?.url || '',
        width: 0,
        height: 0,
      };
    }
    if (imageData && typeof imageData === 'object' && imageData.url) {
      return {
        url: imageData.url,
        previewUrl: previewData?.url || '',
        width: imageData.width || 0,
        height: imageData.height || 0,
      };
    }
    return null;
  }

  // 从 creation 里提取视频封面地址
  function getCreationVideoPoster(creation) {
    const video = creation?.video || {};
    const candidates = [
      video.poster_url,
      video.poster,
      video.cover_url,
      video.cover,
      video.thumbnail,
      video.first_frame,
      creation?.poster_url,
      creation?.cover_url,
    ];
    return candidates.map(getUrlInfo).find(Boolean)?.url || '';
  }

  // JSON 序列化，失败时返回空串
  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value) || '';
    } catch {
      return '';
    }
  }

  // 解析响应里的兜底接口，换出并登记无水印视频地址
  function processFallbackVideos(json, rawBody, posterUrl) {
    var fallbackApis = findFallbackApis(json, rawBody || '');
    if (!fallbackApis.length) return;
    for (var i = 0; i < fallbackApis.length; i += 1) {
      var fallbackApi = fallbackApis[i];
      if (posterUrl) fallbackVideoPosterIndex.set(fallbackApi, posterUrl);
      if (processedFallbackApis.has(fallbackApi)) continue;
      processedFallbackApis.add(fallbackApi);

      (function (api) {
        getVideoInfoFromFallbackApi(api)
          .then(function (info) {
            if (!info) return;
            if (!info.poster_url) info.poster_url = fallbackVideoPosterIndex.get(api) || '';
            registerVideo(info);
            scheduleOverlayUpdate();
          })
          .catch(function () {
            // 接口请求失败不影响已登记素材，静默跳过
          });
      })(fallbackApi);
    }
  }

  // 从兜底接口换取无水印视频地址
  async function getVideoInfoFromFallbackApi(fallbackApi) {
    const apiUrl = replaceQueryParams(fallbackApi, {
      channel: 'no',
      codec_type: '8',
      logo_type: 'unwatermarked',
    });

    const payload = await requestJson(apiUrl);
    const data = getVideoData(payload);
    const picked = pickMainUrlEntry(data);
    if (!picked?.token) {
      return null;
    }

    const videoUrl = await decodeMainUrl(picked.token, findKeySeedDeep(payload));
    if (!videoUrl) {
      return null;
    }

    const meta = picked.entry || {};
    return {
      vid: data.vid || data.video_id || meta.vid || meta.video_id || apiUrl,
      source: 'fallback_api',
      width: Number(meta.vwidth || meta.width || data.vwidth || data.width || 0),
      height: Number(meta.vheight || meta.height || data.vheight || data.height || 0),
      definition: meta.definition || data.definition || '',
      duration: Number(meta.duration || data.duration || 0),
      codec_type: meta.codec_type || data.codec_type || '',
      poster_url: data.poster_url || data.poster || '',
      url: videoUrl,
    };
  }

  // 取 JSON，必须用 originalFetch 避免递归
  function requestJson(url) {
    return new Promise((resolve, reject) => {
      originalFetch
        .call(window, url, {
          method: 'GET',
          credentials: 'omit',
          headers: { accept: 'application/json,text/plain,*/*' },
        })
        .then((response) => response.json())
        .then(resolve)
        .catch(reject);
    });
  }

  // 从响应体里找出所有兜底接口地址
  function findFallbackApis(json, rawBody = '') {
    const apis = new Set();

    for (const value of findValuesByKey(json, 'fallback_api')) {
      addFallbackApi(apis, value);
    }

    const body = typeof rawBody === 'string' ? rawBody : '';
    const patterns = [/fallback_api\\":\\"(.*?)\\"/g, /"fallback_api"\s*:\s*"([^"]+)"/g];

    for (const pattern of patterns) {
      let match = pattern.exec(body);
      while (match) {
        addFallbackApi(apis, decodeJsonEscapedFragment(match[1]));
        match = pattern.exec(body);
      }
    }

    return Array.from(apis);
  }

  // 校验并收集一个兜底接口地址
  function addFallbackApi(apis, value) {
    if (typeof value !== 'string' || !value) return;

    const url = decodeJsonEscapedFragment(value);
    if (isHttpUrl(url)) {
      apis.add(url);
    }
  }

  // 还原被多层转义的 JSON 片段
  function decodeJsonEscapedFragment(value) {
    let text = value;
    for (let index = 0; index < 3; index++) {
      try {
        const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
        if (decoded === text) break;
        text = decoded;
      } catch {
        break;
      }
    }
    return text.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  }

  // 替换 URL 上的查询参数
  function replaceQueryParams(url, params) {
    const parsedUrl = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      parsedUrl.searchParams.set(key, value);
    }
    return parsedUrl.toString();
  }

  // 从接口返回里取出视频数据节点
  function getVideoData(payload) {
    const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
    const data = videoInfo?.data || videoInfo;
    return data && typeof data === 'object' ? data : {};
  }

  // 按码率与分辨率挑最清晰的一条播放地址
  function pickMainUrlEntry(data) {
    const videoList = data?.video_list;
    const entries =
      videoList && typeof videoList === 'object' && Object.keys(videoList).length
        ? Object.values(videoList)
        : [data];
    let best = null;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const token = entry.main_url || entry.play_url || '';
      if (typeof token !== 'string' || !token.trim()) continue;
      const score =
        Number(entry.bitrate || entry.real_bitrate || 0) +
        Number(entry.vwidth || entry.width || 0) * Number(entry.vheight || entry.height || 0);
      if (!best || score > best.score) {
        best = { token: token.trim(), score, entry };
      }
    }

    return best;
  }

  // 深搜视频解密所需的 key_seed
  function findKeySeedDeep(value, depth = 0) {
    if (depth > 10 || value == null) return '';

    if (typeof value === 'string') {
      let match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
      if (match) return decodeURIComponent(match[1]);
      match = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
      return match ? decodeURIComponent(match[1]) : '';
    }

    if (typeof value !== 'object') return '';

    if (typeof value.key_seed === 'string' && value.key_seed.trim()) {
      return value.key_seed.trim();
    }

    for (const item of Object.values(value)) {
      const hit = findKeySeedDeep(item, depth + 1);
      if (hit) return hit;
    }

    return '';
  }

  // 把加密的播放地址还原成真实 URL
  async function decodeMainUrl(token, keySeed = '') {
    if (isHttpUrl(token)) return token;

    const plainUrl = tryDecodeBase64Url(token);
    if (plainUrl) return plainUrl;

    if (token.startsWith('qAAB') && keySeed) {
      return await decodeQaabToken(token, keySeed);
    }

    return '';
  }

  // 尝试把 base64 串解成 URL 文本
  function tryDecodeBase64Url(token) {
    const bytes = base64DecodeLoose(token);
    if (!bytes) return '';
    const text = asciiUrlFromBytes(bytes);
    return isHttpUrl(text) ? text : '';
  }

  // 宽松解析 base64，兼容 URL 安全变体
  function base64DecodeLoose(text) {
    const input = String(text || '').trim();
    const variants = [
      input,
      input.replace(/[$@#]/g, (char) => ({ $: '_', '@': '/', '#': '.' })[char]),
      input.replace(/[$@#]/g, (char) => ({ $: '+', '@': '/', '#': '=' })[char]),
    ];
    const seen = new Set();

    for (const candidate of variants) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const normalized = padBase64(candidate).replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(normalized);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      } catch {
        // 试下一个变体
      }
    }

    return null;
  }

  // 补齐 base64 末尾的等号填充
  function padBase64(text) {
    const pad = (4 - (text.length % 4)) % 4;
    return text + '='.repeat(pad);
  }

  // 字节流转纯 ASCII 文本，含非 ASCII 则返回空
  function asciiUrlFromBytes(bytes) {
    if (!bytes || !bytes.length) return '';
    for (const byte of bytes) {
      if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) {
        return '';
      }
    }
    return new TextDecoder().decode(bytes);
  }

  // 用 key_seed 解密 QAAB 加密的播放地址
  async function decodeQaabToken(token, keySeed) {
    const data = base64DecodeLoose(token);
    const seed = base64DecodeLoose(keySeed);
    if (!data || !seed) return '';

    const digest1 = await crypto.subtle.digest('SHA-512', seed.slice(0, 32));
    const salt = hexToBytes(QAAB_SALT_HEX);
    const digest2Input = concatBytes(new Uint8Array(digest1), salt);
    const digest2 = new Uint8Array(await crypto.subtle.digest('SHA-512', digest2Input));
    const key = digest2.slice(0, 16);
    const iv = digest2.slice(16, 32);
    const attempts = [];

    if (
      data.length >= 4 &&
      data[0] === 0xa8 &&
      data[1] === 0x00 &&
      data[2] === 0x01 &&
      data[3] === 0x00
    ) {
      attempts.push({ payload: data.slice(4), key, iv });
      attempts.push({ payload: data.slice(4), key: iv, iv: key });
      if (data.length > 36) {
        attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
        attempts.push({ payload: data.slice(36), key, iv });
      }
    } else {
      attempts.push({ payload: data, key, iv });
    }

    for (const attempt of attempts) {
      const url = await decryptAesCbcUrl(attempt.payload, attempt.key, attempt.iv);
      if (url) return url;
    }

    return '';
  }

  // AES-CBC 解密出 URL 文本
  async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
    if (!payload.length || payload.length % 16 !== 0) return '';

    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, payload),
      );
      const direct = asciiUrlFromBytes(plain);
      if (isHttpUrl(direct)) return direct;
      const stripped = stripPkcs7(plain);
      const url = asciiUrlFromBytes(stripped);
      return isHttpUrl(url) ? url : '';
    } catch {
      return '';
    }
  }

  // 去掉解密结果的 PKCS7 填充
  function stripPkcs7(bytes) {
    if (!bytes || !bytes.length) return new Uint8Array();
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
    for (let index = bytes.length - pad; index < bytes.length; index++) {
      if (bytes[index] !== pad) return bytes;
    }
    return bytes.slice(0, bytes.length - pad);
  }

  // 十六进制串转字节数组
  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  // 拼接两个字节数组
  function concatBytes(first, second) {
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first, 0);
    bytes.set(second, first.length);
    return bytes;
  }

  // 深搜 JSON，取指定键的所有取值
  function findValuesByKey(value, targetKey) {
    const values = [];
    walkJsonAndStrings(value, (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      if (Object.prototype.hasOwnProperty.call(node, targetKey)) {
        values.push(node[targetKey]);
      }
    });
    return values;
  }

  // 遍历 JSON，并顺带解析内嵌的 JSON 字符串
  function walkJsonAndStrings(value, visitor, seen = new Set()) {
    if (value == null) return;

    if (typeof value === 'string') {
      const parsed = parseJsonString(value);
      if (parsed !== null) {
        walkJsonAndStrings(parsed, visitor, seen);
      }
      return;
    }

    if (typeof value !== 'object' || seen.has(value)) return;

    seen.add(value);
    visitor(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walkJsonAndStrings(item, visitor, seen);
      }
      return;
    }

    for (const key of Object.keys(value)) {
      walkJsonAndStrings(value[key], visitor, seen);
    }
  }

  // 解析疑似 JSON 的字符串，失败返回 null
  function parseJsonString(text) {
    const trimmed = text.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  // 是否为 http(s) 地址
  function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  // 下载单个文件
  function createDownloadTask(url, filename, onProgress) {
    // 直接返回 Promise，状态机保证只 settle 一次
    return new Promise((resolve, reject) => {
      const finish = (size) => resolve({ size: Number(size) || 0 });
      const fail = (error) => reject(error);

      const controller = new AbortController();

      fetch(url, { signal: controller.signal })
        .then((response) => {
          // 不检查状态会把 403/404 的错误页当成媒体文件存下来
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const total = Number(response.headers && response.headers.get('content-length')) || 0;
          if (typeof onProgress !== 'function')
            return response.blob().then((blob) => ({ blob, total }));
          if (!response.body || typeof response.body.getReader !== 'function') {
            return response.blob().then((blob) => {
              onProgress(blob.size, blob.size || total);
              return { blob, total };
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
              onProgress(loaded, total);
            }
            return { blob: new Blob(chunks), total };
          })();
        })
        .then((result) => {
          const blobUrl = URL.createObjectURL(result.blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
          finish(result.total || result.blob.size || 0);
        })
        .catch(fail);
    });
  }

  // 响应解析：登记无水印资源

  // 处理单条 creation，登记其中的图片与视频
  function handleCreation(creation) {
    if (!creation || typeof creation !== 'object') return;
    if (creation.video) {
      processFallbackVideos(
        creation,
        safeJsonStringify(creation),
        getCreationVideoPoster(creation),
      );
      return;
    }
    var imageInfo = getCreationImageInfo(creation);
    if (!imageInfo) return;
    var others = [];
    collectImageUrls(creation.image, others, 0);
    if (imageInfo.previewUrl) others.push(imageInfo.previewUrl);
    registerImage(imageInfo.url, others);
  }

  // 批量处理 creation 列表
  function handleCreations(creations) {
    if (!Array.isArray(creations)) return;
    for (var i = 0; i < creations.length; i += 1) handleCreation(creations[i]);
  }

  // 流式响应（SSE）中解析出 creations
  function parseStreamChunk(data) {
    try {
      if (!data.event_data && !data.patch_op) return;

      var creations = [];

      if (data.patch_op) {
        for (var i = 0; i < data.patch_op.length; i += 1) {
          var op = data.patch_op[i];
          if (!op.patch_value || !Array.isArray(op.patch_value.content_block)) continue;
          for (var j = 0; j < op.patch_value.content_block.length; j += 1) {
            var block = op.patch_value.content_block[j];
            var found = block?.content?.creation_block?.creations;
            if (Array.isArray(found)) {
              creations = found;
              break;
            }
          }
          if (creations.length) break;
        }

        if (!creations.length) {
          for (var k = 0; k < data.patch_op.length; k += 1) {
            var extPatch = data.patch_op[k];
            var full = extPatch?.patch_value?.ext?.creation_full_content;
            if (!full) continue;
            try {
              var items = JSON.parse(full);
              for (var m = 0; m < items.length; m += 1) {
                var found = items[m]?.BlockInfo?.BlockContent?.content?.creation_block?.creations;
                if (Array.isArray(found)) {
                  creations = found;
                  break;
                }
              }
            } catch (error) {
              // 忽略
            }
            if (creations.length) break;
          }
        }
      } else {
        var eventData;
        try {
          eventData = JSON.parse(data.event_data);
        } catch (error) {
          return;
        }
        if (!eventData.message || !eventData.message.content) return;
        var messageContent;
        try {
          messageContent = JSON.parse(eventData.message.content);
        } catch (error) {
          return;
        }
        if (!messageContent.creations || !Array.isArray(messageContent.creations)) return;
        creations = messageContent.creations;
      }

      handleCreations(creations);
    } catch (error) {
      // 忽略
    }
    scheduleOverlayUpdate();
  }

  // 判断一条消息是否是用户发出，是则跳过
  function isUserMessage(item) {
    if (!item || typeof item !== 'object') return false;
    var holder = item.message && typeof item.message === 'object' ? item.message : item;
    var role = String(
      holder.role || holder.author || holder.sender || holder.sender_type || holder.from || '',
    ).toLowerCase();
    if (role) {
      if (role === 'user' || role === 'human' || role.includes('user')) return true;
    }
    var flags = ['is_user', 'from_user', 'is_self', 'user_send'];
    for (var i = 0; i < flags.length; i += 1) {
      if (holder[flags[i]] === true || holder[flags[i]] === 1) return true;
    }
    return false;
  }

  // 历史消息里的图片与视频
  function parseChatHistory(messages) {
    if (!Array.isArray(messages)) return;
    for (var i = 0; i < messages.length; i += 1) {
      var item = messages[i];

      // 用户发送的消息：完全不处理
      if (isUserMessage(item)) continue;
      var blocks = item && item.content_block;
      if (!Array.isArray(blocks)) continue;
      for (var j = 0; j < blocks.length; j += 1) {
        var creationBlock = blocks[j] && blocks[j].content && blocks[j].content.creation_block;
        if (!creationBlock || !Array.isArray(creationBlock.creations)) continue;
        handleCreations(creationBlock.creations);
      }
    }
    scheduleOverlayUpdate();
  }

  // 网络拦截

  var originalXHROpen = window.XMLHttpRequest.prototype.open;
  var originalXHRSend = window.XMLHttpRequest.prototype.send;

  window.XMLHttpRequest.prototype.open = function (method, url) {
    this._dbkUrl = url;
    return originalXHROpen.apply(this, arguments);
  };

  window.XMLHttpRequest.prototype.send = function () {
    var url = this._dbkUrl;
    // once：同一个 XHR 复用时不重复解析历史消息
    this.addEventListener('load', function () {
      if (!url || !url.includes('/im/chain/single')) return;
      try {
        var data = JSON.parse(this.responseText);
        var messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
        if (Array.isArray(messages)) parseChatHistory(messages);
        processFallbackVideos(data, this.responseText);
      } catch (error) {
        // 忽略
      }
    });
    return originalXHRSend.apply(this, arguments);
  };

  var originalFetch = window.fetch;

  window.fetch = async function () {
    var args = [...arguments];
    var first = args[0];
    var requestUrl = typeof first === 'string' ? first : first?.url || '';

    if (requestUrl && requestUrl.includes('/im/chain/single')) {
      var response = await originalFetch.apply(this, args);
      response
        .clone()
        .text()
        .then(function (text) {
          try {
            var data = JSON.parse(text);
            var messages = data?.downlink_body?.pull_singe_chain_downlink_body?.messages;
            if (Array.isArray(messages)) parseChatHistory(messages);
            processFallbackVideos(data, text);
          } catch (error) {
            // 历史消息格式多变，解析失败不影响主流程
          }
        })
        .catch(function () {
          // 读取响应体失败（如已被消费）时跳过登记
        });
      return response;
    }

    if (requestUrl && requestUrl.includes('/chat/completion')) {
      var completionResponse = await originalFetch.apply(this, args);
      if (
        !NativeReadableStream ||
        !NativeResponse ||
        !completionResponse.body ||
        typeof completionResponse.body.getReader !== 'function'
      ) {
        return completionResponse;
      }
      var reader = completionResponse.body.getReader();
      var decoder = new TextDecoder();

      var stream = new NativeReadableStream({
        async start(controller) {
          var buffer = '';
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i += 1) {
              var line = lines[i];
              if (line.indexOf('data: ') !== 0) continue;
              var jsonStr = line.substring(6);
              if (jsonStr.indexOf('image_ori') < 0 && jsonStr.indexOf('fallback_api') < 0) continue;
              try {
                var data = JSON.parse(jsonStr);
                if (jsonStr.includes('fallback_api')) processFallbackVideos(data, jsonStr);
                if (data.event_data || data.patch_op) parseStreamChunk(data);
              } catch (error) {
                // 忽略
              }
            }

            controller.enqueue(chunk.value);
          }
          controller.close();
        },
      });

      var patchedResponse = new NativeResponse(stream, {
        headers: completionResponse.headers,
        status: completionResponse.status,
        statusText: completionResponse.statusText,
      });

      // 补回 Response 的 url / type / redirected 原值
      var mirrored = {
        url: completionResponse.url,
        type: completionResponse.type,
        redirected: completionResponse.redirected,
      };
      Object.keys(mirrored).forEach(function (key) {
        try {
          Object.defineProperty(patchedResponse, key, {
            value: mirrored[key],
            configurable: true,
            enumerable: false,
          });
        } catch (error) {
          // 某些实现禁止改写，忽略即可，不影响主流程
        }
      });
      return patchedResponse;
    }

    return originalFetch.apply(this, args);
  };

  // 素材按钮组：与页面同风格的图标按钮（复制 + 无水印下载），逻辑为扩展自绘，不改页面原生 DOM

  var STYLE_ID = 'dbk-media-style';
  var buttonMap = new WeakMap();

  // el 到 wrap 的挂载记录，用 Map 便于覆盖
  var mountedMap = new Map();
  var updateQueued = false;

  // 注入按钮样式，只注入一次
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      // 按钮组挂进素材父容器并随页面滚动
      '.dbk-dl{position:absolute;z-index:2;display:flex;align-items:center;gap:6px;}',
      // 图标按钮：毛玻璃圆角，与页面 hover 操作区视觉一致
      '.dbk-dl-btn{position:relative;flex:none;box-sizing:border-box;width:34px;height:34px;display:flex;align-items:center;justify-content:center;padding:0;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(12,12,16,.42);color:#fff;cursor:pointer;opacity:.85;transition:opacity .16s cubic-bezier(.32,.72,0,1),background .16s cubic-bezier(.32,.72,0,1);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);}',
      '.dbk-dl-btn:hover{opacity:1;background:rgba(12,12,16,.62);}',
      '.dbk-dl-btn:active{opacity:.7;}',
      // 图标 24×24，与页面原生图标一致
      '.dbk-dl-btn svg{width:24px;height:24px;display:block;flex:none;}',
      // 下载中临时展开文字时的行高与禁态
      '.dbk-dl-btn span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      // 下载中进度浮层：以按钮中心对称展开，不撑大按钮、不挤压相邻按钮
      '.dbk-dl-progress{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;min-width:34px;height:26px;padding:0 6px;box-sizing:border-box;border-radius:9px;background:rgba(12,12,16,.78);color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none;}',
      // 反馈浮层文字色：ok 蓝 / err 红
      '.dbk-copy-progress{color:#009efa;}',
      '.dbk-err-progress{color:#ff453a;}',
      // 原生下载按钮：display:none 移除占位，同排的引用/重新生成自动紧凑排列
      '[data-dbk-native-download]{display:none !important;}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  // 找可作为定位上下文的宿主元素
  function findHost(el) {
    var host = el.parentElement;
    if (!host) return null;

    var node = host;
    for (var i = 0; i < 4 && node && node !== document.body; i += 1) {
      var pos = getComputedStyle(node).position;
      if (pos === 'relative' || pos === 'absolute' || pos === 'fixed') return node;
      node = node.parentElement;
    }

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    return host;
  }

  // 按钮定位到素材右下角内侧
  function placeButton(wrap, el, host) {
    var elRect = el.getBoundingClientRect();
    var hostRect = host.getBoundingClientRect();
    var style = getComputedStyle(host);
    var borderRight = parseFloat(style.borderRightWidth) || 0;
    var borderBottom = parseFloat(style.borderBottomWidth) || 0;

    wrap.style.right =
      Math.max(0, Math.round(hostRect.right - elRect.right + borderRight + 8)) + 'px';
    wrap.style.bottom =
      Math.max(0, Math.round(hostRect.bottom - elRect.bottom + borderBottom + 8)) + 'px';
    wrap.style.left = 'auto';
    wrap.style.top = 'auto';
  }

  // 只判断元素自身是否可见
  // 元素是否真实可见；素材滚出视口也要保留按钮，故只要求有尺寸
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 页面图片地址 → 无水印原图地址
  function resolveImageUrl(el) {
    var src = getImageSourceUrl(el);
    if (!src) return '';
    // 1) 接口登记的原图（质量最好）
    var hit = imageOriByKey.get(baseKey(src));
    if (hit) return hit;
    // 2) 去掉水印后缀还原原图
    if (isGeneratedImageUrl(src)) return stripImageWatermark(src);
    return normalizeImageUrl(src);
  }

  // 用封面反查已登记的无水印视频地址
  function videoUrlByPoster(el) {
    var poster = posterOf(el);
    if (!poster) return '';
    var hit = videoByPoster.get(baseKey(poster));
    return hit && hit.url ? hit.url : '';
  }

  // 页面视频到无水印地址的映射
  function resolveVideoUrl(el) {
    // 1) 已登记的无水印地址（质量最好）
    var byPoster = videoUrlByPoster(el);
    if (byPoster) return byPoster;
    // 2) 页面地址本身已是原画
    var src = getVideoSourceUrl(el);
    return isGeneratedVideoUrl(src) ? src : '';
  }

  // 取视频真实地址
  function getVideoSourceUrl(el) {
    if (!el) return '';
    var src = el.currentSrc || el.src || '';
    if (src && src.indexOf('blob:') !== 0) return normalizeImageUrl(src);
    try {
      var sources = el.querySelectorAll('source');
      for (var i = 0; i < sources.length; i += 1) {
        var s = sources[i].getAttribute('src') || sources[i].src || '';
        if (s && isHttpUrl(s)) return normalizeImageUrl(s);
      }
    } catch (error) {
      // 忽略
    }
    return '';
  }

  // 站点生成视频的独有特征：地址带 lr=unwatermarked
  function isGeneratedVideoUrl(url) {
    if (!url || !isHttpUrl(url)) return false;
    return url.includes('lr=unwatermarked');
  }

  // 取素材的封面地址
  function posterOf(el) {
    var poster = '';
    try {
      poster = el.getAttribute ? el.getAttribute('poster') || '' : '';
    } catch (error) {
      poster = '';
    }
    return poster || extractPosterFromHost(el);
  }

  // 从宿主容器里找封面背景图地址
  function extractPosterFromHost(el) {
    var host = el && el.parentElement;
    // 最多往上找 2 层且不越过 body
    for (var i = 0; i < 2 && host && host !== document.body; i += 1) {
      var node = host.querySelector('xg-poster, .xgplayer-poster, [class*="poster"]');
      if (node) {
        var bg = getComputedStyle(node).backgroundImage || '';
        var m = bg.match(/url\("?([^")]+)"?\)/);
        if (m && m[1] && isHttpUrl(m[1])) return normalizeImageUrl(m[1]);
      }
      host = host.parentElement;
    }
    return '';
  }

  // 用户自己上传的素材特征
  var USER_MEDIA_MARKERS = ['/rc_upload/', '/rc_user/', '/user_upload/', '/rc_input/', '/upload/'];

  // 是否为用户自己上传的素材
  function isUserMediaUrl(url) {
    if (!url) return false;
    return hitsAny(String(url), USER_MEDIA_MARKERS);
  }

  // 统一入口：先排除用户素材，再判生成标记
  function isGeneratedMediaUrl(url, kind) {
    if (!url || !isHttpUrl(url)) return false;
    if (isUserMediaUrl(url)) return false;
    return kind === 'video' ? isGeneratedVideoUrl(url) : isGeneratedImageUrl(url);
  }

  // 生成图的路径特征，仅作兜底判据；新站点若有别的标记往这里加
  var GEN_IMAGE_MARKERS = ['/rc_gen_image/'];

  // 地址是否为站点生成的图片
  function isGeneratedImageUrl(url) {
    if (!url || !isHttpUrl(url)) return false;
    return hitsAny(url, GEN_IMAGE_MARKERS);
  }

  // 去掉图片的处理模板后缀，还原原图地址
  function stripImageWatermark(url) {
    var raw = normalizeImageUrl(url);
    if (!raw) return '';
    return raw.replace(/~[^/?#]*/, '');
  }

  // 取图片地址，优先 <img> 自身
  function getImageSourceUrl(el) {
    if (!el) return '';
    var src = el.currentSrc || el.src || '';
    if (src && src.indexOf('data:') !== 0) return normalizeImageUrl(src);
    try {
      var host = el.closest ? el.closest('picture') : null;
      if (!host && el.parentElement) {
        var p = el.parentElement;
        if ((p.tagName || '').toLowerCase() === 'picture') host = p;
      }
      if (host) {
        var sources = host.querySelectorAll('source');
        for (var i = 0; i < sources.length; i += 1) {
          var ss = sources[i].getAttribute('srcset') || sources[i].getAttribute('src') || '';
          // srcset 可能是 "url 1x, url 2x"，取第一个 http 地址
          var m = String(ss).match(/https?:\/\/[^\s,]+/);
          if (m && isHttpUrl(m[0])) return normalizeImageUrl(m[0]);
        }
      }
    } catch (error) {
      // 忽略
    }
    return '';
  }

  // 消息归属判定，比 URL 特征更可靠

  // 用户消息容器特征
  var USER_SCOPE_HINTS = [
    // 聊天气泡布局约定：自己发的消息靠右
    'justify-end',
    'items-end',
    'message-user',
    'user-message',
    'msg-user',
    'user-msg',
    'chat-user',
    'user-chat',
    'bubble-user',
    'user-bubble',
    'self-message',
    'message-self',
    'sender-user',
    'user-sender',
    'user-content',
    'content-user',
    'my-message',
    'message-mine',
    'user-item',
    'item-user',
    'user-row',
    'row-user',
    'query-item',
    'user-query',
    'user-ask',
    'ask-user',
    'input-item',
    'user-input',
    'user-send',
    'send-user',
  ];

  // 生成视频的封面特征：路径含 dsz_watermark
  function hasDszWatermark(url) {
    return !!url && String(url).toLowerCase().includes('dsz_watermark');
  }

  // 重要：不能用 ~tplv- 后缀判断图片来源

  // 生成结果的容器特征（正向确认）
  var GEN_SCOPE_HINTS = [
    'image-box-grid', // 多图生成结果网格（grid-template-columns: repeat(N,1fr)）
    'image-wrapper', // 生成图包裹层
    'hover-actions-slot', // 生成结果的悬浮操作区（重生成/下载等）
  ];

  // 文本是否命中任一特征子串
  function hitsAny(text, hints) {
    if (!text) return false;
    for (var i = 0; i < hints.length; i += 1) {
      if (text.includes(hints[i])) return true;
    }
    return false;
  }

  // 逐级向上访问祖先，visitor 返回真值即停止并返回该值
  // 到 body / html 或超过层数上限即止，避免无谓地爬到根
  var SCOPE_MAX_DEPTH = 14;
  function walkAncestors(el, visit) {
    var node = el;
    for (
      var i = 0;
      i < SCOPE_MAX_DEPTH && node && node !== document.body && node !== document.documentElement;
      i += 1
    ) {
      var hit = visit(node);
      if (hit) return hit;
      node = node.parentElement;
    }
    return null;
  }

  // 素材是否落在生成结果容器内
  function hasGenScope(el) {
    return Boolean(
      walkAncestors(el, function (node) {
        return hitsAny(scopeSignature(node), GEN_SCOPE_HINTS);
      }),
    );
  }

  // 助手 / AI 回复容器特征
  var BOT_SCOPE_HINTS = [
    'message-assistant',
    'assistant-message',
    'msg-assistant',
    'message-bot',
    'bot-message',
    'message-ai',
    'ai-message',
    'chat-assistant',
    'assistant-chat',
    'bubble-assistant',
    'assistant-bubble',
    'message-reply',
    'reply-message',
    'message-flow',
    'flow-message',
    'assistant-content',
    'content-assistant',
    'answer-item',
    'item-answer',
    'response-item',
    'item-response',
    'ai-item',
    'item-ai',
  ];

  // 角色属性值：命中即直接定性
  var USER_ROLE_VALUES = ['user', 'self', 'mine', 'human', 'me'];
  var BOT_ROLE_VALUES = ['assistant', 'bot', 'ai', 'system', 'model', 'doubao', 'dola'];

  var ROLE_ATTR_KEYS = ['role', 'author', 'sender', 'sender_type', 'from', 'message_author_role'];

  // 读元素上表示角色的属性值
  function roleValueOf(el) {
    try {
      for (var i = 0; i < ROLE_ATTR_KEYS.length; i += 1) {
        var key = ROLE_ATTR_KEYS[i];
        var value = el.getAttribute(key);
        if (value == null) value = el.getAttribute('data-' + key.replace(/_/g, '-'));
        if (value == null) value = el.getAttribute('data-' + key);
        if (value != null && String(value).trim()) return String(value).trim().toLowerCase();
      }
    } catch (error) {
      // 忽略
    }
    return '';
  }

  // 收集元素上可用于判属的字符串
  function scopeSignature(el) {
    var parts = [];
    try {
      var cls = el.className;
      if (cls && typeof cls === 'object' && 'baseVal' in cls) cls = cls.baseVal;
      if (cls) parts.push(String(cls).toLowerCase());

      var attrs = el.attributes;
      for (var i = 0; i < attrs.length; i += 1) {
        var name = String(attrs[i].name || '').toLowerCase();

        // 只关心可能表示角色的属性
        if (
          name === 'role' ||
          name.includes('role') ||
          name.includes('author') ||
          name.includes('sender') ||
          name.includes('from') ||
          name.includes('user') ||
          name.includes('assistant') ||
          name.includes('bot')
        ) {
          parts.push(name);
          parts.push(String(attrs[i].value || '').toLowerCase());
        }
      }
    } catch (error) {
      // 忽略
    }
    return parts.join(' ');
  }

  // 判断素材归属：user / bot / 未能确定
  function scopeOf(el) {
    return (
      walkAncestors(el, function (node) {
        // 1) 角色属性值最可靠，优先判定
        var role = roleValueOf(node);
        if (USER_ROLE_VALUES.includes(role)) return 'user';
        if (BOT_ROLE_VALUES.includes(role)) return 'bot';

        // 2) 其次看 class / 属性名里的特征子串
        var sig = scopeSignature(node);
        if (hitsAny(sig, USER_SCOPE_HINTS)) return 'user';
        if (hitsAny(sig, BOT_SCOPE_HINTS)) return 'bot';
      }) || ''
    );
  }

  // 素材是否落在用户消息气泡内
  function isInsideUserBubble(el) {
    return scopeOf(el) === 'user';
  }

  // 只给「站点生成」的素材加按钮
  function isGeneratedImage(el) {
    if (!strictOnly) return true;

    // 1) 生成结果容器特征明确则直接放行
    if (hasGenScope(el)) return true;

    // 2) 用户消息一律不加
    if (isInsideUserBubble(el)) return false;

    // 3) 兜底：生成图都落在 rc_gen_image 路径下
    return isGeneratedImageUrl(getImageSourceUrl(el));
  }

  // 生成视频的 CDN 目录，与图片侧的 /rc_gen_image/ 对应
  var GEN_VIDEO_MARKER = '/tos-cn-v-';

  // 元素是否为站点生成的视频
  function isGeneratedVideo(el) {
    if (!strictOnly) return true;

    // 0) 容器特征明确则直接放行
    if (hasGenScope(el)) return true;

    var poster = posterOf(el);
    if (poster) {
      if (isUserMediaUrl(poster)) return false;
      // 1) 接口登记过的生成视频
      if (videoByPoster.has(baseKey(poster))) return true;
      // 2) 封面带 dsz_watermark 视为生成视频
      if (hasDszWatermark(poster)) return true;
    }

    // 3) 只剩地址可依据时从严
    var src = getVideoSourceUrl(el);
    if (!isGeneratedMediaUrl(src, 'video')) return false;
    return src.includes(GEN_VIDEO_MARKER);
  }

  // 按标签与来源取无水印地址（视频卡片常同时存在封面图与 video）
  function resolveTargetUrl(el, kind) {
    if (kind === 'video') {
      var byPoster = videoUrlByPoster(el);
      if (byPoster) return byPoster;
      if (el.tagName === 'IMG') return '';
      return resolveVideoUrl(el);
    }
    return resolveImageUrl(el);
  }

  // 收集当前页面需要挂按钮的素材
  function collectTargets() {
    var targets = [];

    // 先收视频，供后面排除同容器封面图
    var videoHosts = new Set();
    var videos = document.querySelectorAll('video');
    for (var j = 0; j < videos.length; j += 1) {
      var video = videos[j];
      var vRect = video.getBoundingClientRect();
      if (vRect.width < 96 || vRect.height < 96) continue;
      if (!isVisible(video)) continue;
      // 用户发送的消息：完全不处理
      if (isInsideUserBubble(video)) continue;
      if (!isGeneratedVideo(video)) continue;
      if (!resolveTargetUrl(video, 'video')) continue;
      var vHost = findHost(video);
      if (vHost) videoHosts.add(vHost);
      targets.push({ el: video, kind: 'video', rect: vRect });
    }

    var images = document.querySelectorAll('img');
    for (var i = 0; i < images.length; i += 1) {
      var img = images[i];

      // 先用尺寸过滤掉头像等小图
      var rect = img.getBoundingClientRect();
      if (rect.width < 96 || rect.height < 96) continue;
      if (!isVisible(img)) continue;
      var imgSrc = getImageSourceUrl(img);
      if (!imgSrc) continue;

      // 用户发送的消息：完全不处理
      if (isInsideUserBubble(img)) continue;

      // 与视频同容器则跳过，避免按钮重叠
      var iHost = findHost(img);
      if (iHost && videoHosts.has(iHost)) continue;

      // 视频封面也挂下载按钮
      var vidInfo = videoByPoster.get(baseKey(imgSrc));
      if (vidInfo && vidInfo.url) {
        targets.push({ el: img, kind: 'video', rect: rect });
        continue;
      }

      // 只处理站点生成的图片，用户上传的不加按钮
      if (!isGeneratedImage(img)) continue;
      targets.push({ el: img, kind: 'image', rect: rect });
    }

    return targets;
  }

  // 连续几次扫描没命中才认为素材已移除
  var MISS_LIMIT = 3;

  // 移除素材上的按钮组
  function dropButton(el, wrap) {
    if (wrap.parentElement) wrap.remove();

    // 仅当 buttonMap 里存的确实是这个 wrap 时才删，避免误删新挂载的按钮
    var current = buttonMap.get(el);
    if (current && current.wrap === wrap) buttonMap.delete(el);
    mountedMap.delete(el);
  }

  // 页面原生图标：下载原图（图片 hover 操作区第三个图标）
  var NATIVE_DOWNLOAD_ICON =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M20.375 14.8535C20.9273 14.8535 21.375 15.3012 21.375 15.8535V18.5059C21.375 20.1627 20.0319 21.5059 18.375 21.5059H5.625C3.96815 21.5059 2.625 20.1627 2.625 18.5059V15.8535C2.625 15.3012 3.07272 14.8535 3.625 14.8535C4.17728 14.8535 4.625 15.3012 4.625 15.8535V18.5059C4.625 19.0581 5.07272 19.5059 5.625 19.5059H18.375C18.9273 19.5059 19.375 19.0581 19.375 18.5059V15.8535C19.375 15.3012 19.8227 14.8535 20.375 14.8535ZM12.001 1.99219C12.5529 1.99264 13.001 2.44018 13.001 2.99219V13.5146L17.8027 8.71289C18.1932 8.32272 18.8263 8.32274 19.2168 8.71289C19.607 9.10335 19.607 9.73649 19.2168 10.127L12.708 16.6367C12.5207 16.8241 12.2659 16.9295 12.001 16.9297C11.736 16.9297 11.4814 16.824 11.2939 16.6367L4.78418 10.127C4.3938 9.73642 4.3937 9.10336 4.78418 8.71289C5.17469 8.32281 5.80784 8.32265 6.19824 8.71289L11.001 13.5156V2.99219C11.001 2.4399 11.4487 1.99219 12.001 1.99219Z" fill="currentColor"></path></svg>';

  // ===== 隐藏豆包原生下载按钮（引用 / 重新生成等同排按钮一律保留） =====

  // 判据只有图标 path。豆包按钮是 div 且 class 带哈希后缀，
  // 靠标签名或 class 都不可靠，但从图标反查既准又不受改版影响。
  // 图片与视频用的是两个不同图标，都要在列
  var NATIVE_DOWNLOAD_PATHS = [
    // 图片：下载原图（与插件自绘按钮同一个图标）
    (/<path d="([^"]+)"/.exec(NATIVE_DOWNLOAD_ICON) || [])[1],
    // 视频：下载视频
    'M11.9922 1.99221C12.5445 1.98895 12.9958 2.43407 12.999 2.98634L13.0762 16.1943L14.6387 14.6328L17.8926 11.3789C18.2831 10.9884 18.9171 10.9885 19.3076 11.3789C19.6977 11.7695 19.6979 12.4026 19.3076 12.793L16.0527 16.0479L12.7979 19.3018C12.7111 19.3884 12.6098 19.4566 12.5 19.5059H20.375C20.9271 19.5059 21.3748 19.9538 21.375 20.5059C21.375 21.0581 20.9273 21.5059 20.375 21.5059H3.625C3.07272 21.5059 2.625 21.0581 2.625 20.5059C2.62523 19.9538 3.07286 19.5059 3.625 19.5059H11.6816C11.572 19.4566 11.4704 19.3884 11.3838 19.3018L4.87402 12.793C4.48372 12.4026 4.4839 11.7694 4.87402 11.3789C5.26452 10.9884 5.89756 10.9885 6.28809 11.3789L11.0762 16.166L10.999 2.99806C10.9958 2.44603 11.4402 1.99582 11.9922 1.99221Z',
  ].filter(Boolean);

  // svg 是否命中任一原生下载图标：一个 svg 可能有多条 path，逐条比
  function isNativeDownloadIcon(svg) {
    var paths = svg.querySelectorAll('path');
    for (var i = 0; i < paths.length; i += 1) {
      var d = paths[i].getAttribute('d');
      if (d && NATIVE_DOWNLOAD_PATHS.indexOf(d) >= 0) return true;
    }
    return false;
  }
  // 打标即隐藏，去标即恢复
  var HIDE_ATTR = 'data-dbk-native-download';
  var hideNativeDownload = true;
  // 页面框架区的下载入口不碰（顶栏 / 侧栏 / 弹层）
  var APP_CHROME = 'header, nav, aside, [role="dialog"]';

  // 从图标向上找到它所属的那枚按钮。豆包的操作条结构一致：
  //   <div class="container-xxx"> > <div class="action-xxx"> > <div class="flex …"> > <svg>
  // 按钮单元恒以 action- 开头，认这个前缀最准。
  //
  // 不能按「有兄弟」判断：图片操作条有 3 枚按钮（引用 / 重新生成 / 下载）能撞对，
  // 视频操作条常常只有下载一枚、没有兄弟可参照，该法会一路爬到素材宿主，
  // 而插件的「复制链接 / 无水印下载」就挂在宿主里 —— 藏宿主等于把自己画的按钮一起藏掉。
  //
  // 认 class 还带来安全的失败方向：豆包若改了类名，这里匹配不上就返回 null，
  // 结果是「不隐藏」，而不是「藏错东西」
  var UNIT_MAX_DEPTH = 4;
  function buttonUnitOf(svg) {
    var el = svg.parentElement;
    for (var depth = 0; el && depth < UNIT_MAX_DEPTH; depth += 1, el = el.parentElement) {
      var cls = el.className;
      if (cls && typeof cls === 'object' && 'baseVal' in cls) cls = cls.baseVal;
      if (/(^|\s)action-/.test(String(cls || ''))) return el;
    }
    return null;
  }

  // 找出页面上的原生下载按钮，插件自绘的一律跳过（它复用了同一个图标）
  function nativeDownloadUnits() {
    var units = [];
    if (!NATIVE_DOWNLOAD_PATHS.length) return units;
    var svgs = document.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i += 1) {
      var svg = svgs[i];
      if (svg.closest('.dbk-dl')) continue;
      if (!isNativeDownloadIcon(svg)) continue;
      var unit = buttonUnitOf(svg);
      if (unit && !unit.closest(APP_CHROME)) units.push(unit);
    }
    return units;
  }

  // 全清后重打标：幂等，天然应对 React 重建与开关切换，无需维护状态
  function syncNativeDownloadButtons() {
    var stale = document.querySelectorAll('[' + HIDE_ATTR + ']');
    for (var i = 0; i < stale.length; i += 1) stale[i].removeAttribute(HIDE_ATTR);
    if (!hideNativeDownload) return;
    var units = nativeDownloadUnits();
    for (var j = 0; j < units.length; j += 1) units[j].setAttribute(HIDE_ATTR, '1');
  }

  // 复制链接图标，与页面原生图标同风格（24×24，fill=currentColor）
  var COPY_ICON_SVG =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.59 13.41c.41.39.41 1.03 0 1.42-.39.39-1.03.39-1.42 0a5 5 0 1 1 7.07-7.07l3.54 3.54a5 5 0 0 1-7.07 7.07c-.39-.39-.39-1.03 0-1.42.39-.39 1.03-.39 1.42 0a3 3 0 0 0 4.24-4.24l-3.54-3.54a3 3 0 0 0-4.24 4.24z"/><path d="M13.41 10.59c-.41-.39-.41-1.03 0-1.42.39-.39 1.03-.39 1.42 0a5 5 0 1 1-7.07 7.07L4.22 12.7a5 5 0 0 1 7.07-7.07c.39.39.39 1.03 0 1.42-.39.39-1.03.39-1.42 0a3 3 0 0 0-4.24 4.24l3.54 3.54a3 3 0 0 0 4.24-4.24z"/></svg>';

  // 图标按钮组：复制 + 无水印下载（逻辑与文字按钮版完全一致）
  function makeButton(kind) {
    var wrap = document.createElement('div');
    wrap.className = 'dbk-dl';
    wrap.dataset.dbk = '1';

    var copy = document.createElement('button');
    copy.className = 'dbk-dl-btn dbk-dl-copy';
    copy.type = 'button';
    copy.title = '复制链接';
    copy.dataset.label = '复制链接';
    copy.innerHTML = COPY_ICON_SVG;

    var main = document.createElement('button');
    main.className = 'dbk-dl-btn dbk-dl-main';
    main.type = 'button';
    // 图标沿用页面原生「下载原图」，逻辑为无水印下载
    main.title = '无水印下载';
    main.dataset.label = '无水印下载';
    main.innerHTML = NATIVE_DOWNLOAD_ICON;

    wrap.appendChild(copy);
    wrap.appendChild(main);
    return { wrap: wrap, copy: copy, main: main, kind: kind };
  }

  var VALID_EXT = new Set([
    'jpg',
    'jpeg',
    'png',
    'webp',
    'gif',
    'avif',
    'bmp',
    'mp4',
    'mov',
    'webm',
    'm4v',
  ]);

  // 从地址末尾猜扩展名
  function guessExt(url, fallback) {
    var match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url || '');
    var ext = match ? match[1].toLowerCase() : '';
    if (ext && VALID_EXT.has(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
    return fallback;
  }

  // 下载文件名按站点打头，两个站点的素材不会混在一起
  function sitePrefix() {
    return currentSiteId() || 'doubao';
  }

  // 生成下载文件名
  function buildFilename(kind, url) {
    var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    var ext = guessExt(url, kind === 'video' ? 'mp4' : 'jpg');
    return sitePrefix() + '-' + kind + '-' + stamp + '.' + ext;
  }

  // 复制反馈直接写在按钮上，不再弹底部 toast

  // 按钮浮层文字反馈：ok 蓝 / err 红，显示后自动消失（与下载进度同机制）
  function showBtnText(btn, text, tone) {
    var bar = btn.querySelector('.dbk-copy-progress, .dbk-err-progress');
    if (!bar) {
      bar = document.createElement('span');
      bar.className =
        'dbk-dl-progress' + (tone === 'ok' ? ' dbk-copy-progress' : ' dbk-err-progress');
      btn.appendChild(bar);
    }
    bar.textContent = text;
    setTimeout(function () {
      var span = btn.querySelector('.dbk-copy-progress, .dbk-err-progress');
      if (span) span.remove();
    }, 1200);
  }

  // 复制文本，并在按钮上给出反馈
  function copyText(text, btn) {
    var done = function () {
      showBtnText(btn, '已复制', 'ok');
    };
    var fail = function () {
      showBtnText(btn, '复制失败', 'err');
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (legacyCopy(text)) done();
        else fail();
      });
      return;
    }
    if (legacyCopy(text)) done();
    else fail();
  }

  // 兜底复制方案：execCommand
  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return Boolean(ok);
    } catch (error) {
      return false;
    }
  }

  var observed = new WeakSet();
  var resizeObserver = null;

  // 监听素材尺寸变化，便于重算按钮位置
  function watchSize(el) {
    if (typeof ResizeObserver !== 'function' || observed.has(el)) return;
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver(function () {
        scheduleOverlayUpdate();
      });
    }
    resizeObserver.observe(el);
    observed.add(el);
  }

  // 素材的视觉指纹，用于判断是否为同一素材
  function posFingerprint(rect) {
    var pg = 4;
    var sg = 8;
    return (
      Math.round(rect.right / pg) +
      ':' +
      Math.round(rect.bottom / pg) +
      ':' +
      Math.round(rect.width / sg) +
      'x' +
      Math.round(rect.height / sg)
    );
  }

  // 给未加载完成的素材挂尺寸监听
  function watchPendingMedia() {
    var pending = document.querySelectorAll('img, video');
    var watched = 0;
    for (var i = 0; i < pending.length; i += 1) {
      if (watched >= 40) break; /* 上限，避免长会话里大量小图拖慢渲染 */
      var node = pending[i];
      if (!node.isConnected) continue;
      if (node.getBoundingClientRect().width >= 96) continue;
      // 没有地址的占位元素无需监听
      if (!node.getAttribute('src') && !node.getAttribute('poster')) continue;
      var style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      watchSize(node);
      watched += 1;
    }
  }

  // 清理已失效素材的按钮
  function pruneStaleButtons(alive) {
    mountedMap.forEach(function (record, el) {
      var wrap = record.wrap;
      if (alive.has(el) && wrap.isConnected) {
        record.misses = 0;
        return;
      }

      // 已从 DOM 摘除（消息被删除等），无需等待
      if (!el.isConnected || !wrap.isConnected) {
        dropButton(el, wrap);
        return;
      }
      record.misses += 1;
      if (record.misses >= MISS_LIMIT) dropButton(el, wrap);
    });
  }

  // 扫描页面，挂载、更新与清理素材按钮
  function renderOverlay() {
    var targets = collectTargets();
    var alive = new Set();
    var posTaken = new Set();

    watchPendingMedia();

    for (var i = 0; i < targets.length; i += 1) {
      var target = targets[i];
      var el = target.el;

      var host = findHost(el);
      if (!host) continue;

      // 同一素材只允许一组按钮
      var posKey = posFingerprint(target.rect);
      if (posTaken.has(posKey)) continue;
      posTaken.add(posKey);

      // 确认保留这组按钮后，才标记存活
      alive.add(el);

      var entry = buttonMap.get(el);
      var fresh = false;
      // 素材类型可能随加载变化，文案要跟着更新
      if (entry && entry.kind !== target.kind) {
        if (entry.wrap.parentElement) entry.wrap.remove();
        entry = null;
      }

      if (!entry || !entry.wrap.isConnected) {
        // 确实需要重建：首次挂载或按钮已被清掉
        if (entry && entry.wrap.parentElement) entry.wrap.remove();
        entry = makeButton(target.kind);
        buttonMap.set(el, entry);
        host.appendChild(entry.wrap);

        // 同一个 el 只保留最新一条记录，旧记录不会堆积
        mountedMap.set(el, { wrap: entry.wrap, misses: 0 });
        fresh = true;
      } else if (entry.wrap.parentElement !== host) {
        // 只是挂载点变了则复用按钮，不重建
        host.appendChild(entry.wrap);
      }

      if (fresh) {
        (function (element, kind, parts) {
          parts.main.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var url = resolveTargetUrl(element, kind);
            if (!url) {
              showBtnText(parts.main, '未获取到地址', 'err');
              return;
            }
            downloadOne(url, kind, parts.main);
          });
          parts.copy.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var url = resolveTargetUrl(element, kind);
            if (!url) {
              showBtnText(parts.copy, '未获取到地址', 'err');
              return;
            }
            copyText(url, parts.copy);
          });
        })(el, target.kind, entry);
        watchSize(el);
      }

      placeButton(entry.wrap, el, host);
    }

    pruneStaleButtons(alive);
    // 原生下载按钮随 React 重渲染会重建，每次扫描都同步一次
    try {
      syncNativeDownloadButtons();
    } catch (error) {
      // 单次失败不能影响素材按钮
    }
    scheduleTick();
  }

  // 兜底扫描的频率自适应
  var TICK_FAST = 1000;
  var TICK_IDLE = 2000;
  var tickTimer = null;
  var tickFast = false;

  // 按是否有素材在页面上切换扫描频率
  function scheduleTick() {
    var wantFast = mountedMap.size > 0;
    if (tickTimer && wantFast === tickFast) return;
    tickFast = wantFast;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(scheduleOverlayUpdate, wantFast ? TICK_FAST : TICK_IDLE);
  }

  // 合并同一帧内的多次重绘请求
  function scheduleOverlayUpdate() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(function () {
      updateQueued = false;
      try {
        renderOverlay();
      } catch (error) {
        // 单次渲染失败不能让后续调度停摆
      }
    });
  }

  // 单文件下载：默认页面流式下载显示真实百分比；超大文件才交给浏览器下载栈
  // 阈值：超过该大小避免把文件读进页面内存（大视频会拖垮标签页）
  var PAGE_DOWNLOAD_LIMIT = 300 * 1024 * 1024;

  // HEAD 探测文件大小，CDN 不支持 HEAD 时按 0 处理（视为小文件走页面下载）
  function probeDownloadSize(url) {
    return fetch(url, { method: 'HEAD' })
      .then(function (response) {
        return Number(response.headers.get('content-length')) || 0;
      })
      .catch(function () {
        return 0;
      });
  }

  // 通用下载流程：小文件页面流式下载（真实进度），大文件走扩展下载桥
  // hooks: { onProgress(loaded, size), onDone(msg, viaBridge), onFail(msg) }
  function runDownload(url, kind, hooks) {
    probeDownloadSize(url).then(function (size) {
      if (size > PAGE_DOWNLOAD_LIMIT) {
        // 超大文件：交给浏览器下载栈（内存友好，拿不到百分比）
        downloadViaExtension(url, kind).then(
          function () {
            if (hooks.onDone) hooks.onDone('已开始下载，可在浏览器下载列表中查看', true);
          },
          function () {
            if (hooks.onFail) hooks.onFail('下载失败，请重试');
          },
        );
        return;
      }
      createDownloadTask(url, buildFilename(kind, url), function (loaded, total) {
        if (hooks.onProgress) hooks.onProgress(loaded, total);
      }).then(
        function (result) {
          var sizeText = result && result.size ? formatSize(result.size) : '';
          if (hooks.onDone) hooks.onDone(sizeText ? '已下载 ' + sizeText : '已开始下载', false);
        },
        function (error) {
          var reason = error && error.message ? error.message : '未知错误';
          if (hooks.onFail) hooks.onFail('下载失败：' + reason);
        },
      );
    });
  }

  // 下载单个素材并驱动按钮上的进度
  function downloadOne(url, kind, btn) {
    // 图标按钮：下载中展开文字进度浮层，完成后恢复图标
    var restoreHtml = btn.innerHTML;

    var setProgress = function (text) {
      var bar = btn.querySelector('.dbk-dl-progress');
      if (!bar) {
        bar = document.createElement('span');
        bar.className = 'dbk-dl-progress';
        btn.appendChild(bar);
      }
      bar.textContent = text;
    };
    var restore = function () {
      btn.innerHTML = restoreHtml;
    };

    // 立即反馈：点击生效，按钮进入进度态
    setProgress('0%');

    var lastPaint = 0;
    runDownload(url, kind, {
      // 进度高频触发，限频重绘；按钮直接显示百分比进度
      onProgress: function (loaded, size) {
        if (!btn) return;
        var now = Date.now();
        if (size <= 0) {
          // 无总长度时显示已下载大小
          if (now - lastPaint < 400) return;
          lastPaint = now;
          setProgress((loaded / 1024).toFixed(0) + ' KB');
          return;
        }
        if (now - lastPaint < 200) return;
        lastPaint = now;
        setProgress(Math.min(99, Math.round((loaded / size) * 100)) + '%');
      },
      onDone: function () {
        restore();
      },
      onFail: function () {
        showBtnText(btn, '下载失败', 'err');
        setTimeout(restore, 1800);
      },
    });
  }

  // 扩展下载桥，经 content.js 中转
  var DOWNLOAD_BRIDGE_ID = 'doubaokit-bridge';
  var downloadBridgeSeq = 0;
  var downloadBridgeCallbacks = new Map();

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.bridge !== DOWNLOAD_BRIDGE_ID || data.type !== 'download-result') return;
    var callback = downloadBridgeCallbacks.get(data.rid);
    if (!callback) return;
    downloadBridgeCallbacks.delete(data.rid);
    callback(data.ok ? null : data.error || '下载失败');
  });

  // 经内容脚本转交扩展下载
  function requestBridgeDownload(url, filename) {
    return new Promise(function (resolve, reject) {
      var rid = 'dl-' + (downloadBridgeSeq += 1);
      var settled = false;
      var finish = function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        downloadBridgeCallbacks.delete(rid);
        if (error) reject(new Error(error));
        else resolve();
      };
      var timer = setTimeout(function () {
        finish('下载桥无响应');
      }, 8000);
      downloadBridgeCallbacks.set(rid, finish);
      try {
        window.postMessage(
          {
            bridge: DOWNLOAD_BRIDGE_ID,
            type: 'download',
            rid: rid,
            url: url,
            filename: filename,
          },
          '*',
        );
      } catch (error) {
        finish((error && error.message) || '下载桥不可用');
      }
    });
  }

  // 大文件走扩展下载桥，避免占页面内存
  function downloadViaExtension(url, kind) {
    // 本地预览页无内容脚本，走页面内下载
    if (window.__PROMPTKIT_PREVIEW__ === true) {
      return Promise.reject(new Error('预览模式不使用扩展下载'));
    }
    return requestBridgeDownload(url, buildFilename(kind, url));
  }

  // 下载进度反馈，视频才真正需要

  // 字节数转可读大小
  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // 对外 API，供提示词面板调用
  var mediaApi = {
    // 严格模式只给站点生成的素材加按钮
    setStrict: function (value) {
      strictOnly = Boolean(value);
      scheduleOverlayUpdate();
    },
    // 追加用户消息容器特征，命中则不加按钮
    setUserScopeHints: function (list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && USER_SCOPE_HINTS.indexOf(list[i]) < 0)
          USER_SCOPE_HINTS.push(String(list[i]).toLowerCase());
      }
      scheduleOverlayUpdate();
    },
    // 隐藏 / 恢复豆包原生下载按钮
    setHideNativeDownload: function (on) {
      hideNativeDownload = Boolean(on);
      syncNativeDownloadButtons();
      scheduleOverlayUpdate();
    },
    // 追加用户上传素材特征，命中则不加按钮
    setUserPatterns: function (list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && USER_MEDIA_MARKERS.indexOf(list[i]) < 0) USER_MEDIA_MARKERS.push(list[i]);
      }
      scheduleOverlayUpdate();
    },
    // 诊断：某个地址会被判定为用户上传吗
    isUserMedia: function (url) {
      return isUserMediaUrl(url);
    },
    // 诊断：打印元素的归属特征
    explain: function (el) {
      if (!el) return null;
      var chain = [];
      var node = el;
      for (var i = 0; i < 12 && node && node !== document.body; i += 1) {
        chain.push({
          tag: node.tagName,
          role: roleValueOf(node),
          cls: String(
            node.className && node.className.baseVal !== undefined
              ? node.className.baseVal
              : node.className || '',
          ).slice(0, 140),
          user: isInsideUserBubble(node),
        });
        node = node.parentElement;
      }
      return {
        inUserBubble: isInsideUserBubble(el),
        src: el.tagName === 'IMG' ? getImageSourceUrl(el) : getVideoSourceUrl(el),
        isUserUrl: isUserMediaUrl(
          el.tagName === 'IMG' ? getImageSourceUrl(el) : getVideoSourceUrl(el),
        ),
        chain: chain,
      };
    },
  };
  window.DoubaoKitMedia = mediaApi;
  window.PromptKitMedia = mediaApi;

  // 初始化

  // 当前页面是否为受支持站点的会话页
  function isChatPage() {
    // 本地预览页通过标记启用
    if (window.__PROMPTKIT_PREVIEW__ === true) return true;
    if (!window.location.pathname.includes('/chat/')) return false;
    return Boolean(currentSiteId());
  }

  // 入口：注入样式、监听 DOM 与窗口变化
  function init() {
    if (!isChatPage()) return;

    ensureStyle();
    scheduleOverlayUpdate();
    // 首屏立即隐藏一次，不等首次扫描
    try {
      syncNativeDownloadButtons();
    } catch (error) {
      // 忽略
    }

    // 按钮挂在素材父容器里，随页面滚动
    var observer = new MutationObserver(function (records) {
      // 忽略插件自身引起的变化，避免自触发循环
      var external = records.some(function (record) {
        // 属性变化没有增删节点，也算外部变化
        if (record.type === 'attributes') {
          return record.target?.dataset?.dbk !== '1';
        }
        var nodes = [...record.addedNodes].concat([...record.removedNodes]);
        return nodes.some((node) => node.nodeType === 1 && node.dataset?.dbk !== '1');
      });
      if (!external) return;
      scheduleOverlayUpdate();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'poster', 'currentSrc'],
    });

    // 窗口尺寸变化会改变素材位置，需要重算
    var resizeTimer = null;
    window.addEventListener(
      'resize',
      function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(scheduleOverlayUpdate, 200);
      },
      { passive: true },
    );

    scheduleTick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
