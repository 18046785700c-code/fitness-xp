/* Fitness XP — AI 动作教练：DeepSeek Flash 服务适配器（UMD）
 *
 * 安全约束（任务书第九节）：
 *   1) 前端 JavaScript / HTML / 配置文件 / 浏览器存储中都不得写入真实 API Key；
 *   2) 不允许浏览器直连需要 Authorization 的供应商接口——那必然要把密钥暴露在前端；
 *      正确做法是自建一层服务端代理，本适配器只接受"自己的代理地址"；
 *   3) 未配置安全代理时 getStatus() 返回 misconfigured，页面显示"AI 复盘尚未启用"；
 *   4) 绝不每一帧调用：只在训练结束后、用户主动请求复盘时调用一次；
 *   5) 请求体只包含结构化训练摘要（本地已算好的数字），不上传视频、不上传逐帧关键点；
 *   6) 响应必须逐字段校验；不得 eval、不得把返回内容当作可执行代码或操作指令；
 *   7) AI 输出只用于"把本地数字讲成人话"，所有角度/次数/评分仍以本地渲染为准，
 *      从而从结构上杜绝模型凭空编造指标；
 *   8) 调用失败不影响本地评分与训练记录。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.aicAI = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 直接暴露密钥的高危端点：前端一律拒绝 */
  var BLOCKED_HOSTS = [
    'api.deepseek.com',
    'api.openai.com',
    'open.bigmodel.cn',
    'dashscope.aliyuncs.com',
    'generativelanguage.googleapis.com'
  ];

  /* 疑似代码/脚本注入的特征 */
  var DANGEROUS = [/<script/i, /javascript\s*:/i, /\beval\s*\(/i, /new\s+Function/i, /require\s*\(/i, /process\.env/i];

  var DEFAULT_MODEL = 'deepseek-chat';
  var MAX_TEXT = 2000;
  var MAX_SUGGESTIONS = 6;

  function isBlockedHost(url) {
    try {
      var u = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost/');
      var host = (u.hostname || '').toLowerCase();
      for (var i = 0; i < BLOCKED_HOSTS.length; i++) {
        if (host === BLOCKED_HOSTS[i] || host.indexOf('.' + BLOCKED_HOSTS[i]) >= 0) return true;
      }
      return false;
    } catch (e) {
      return true; // 解析不了的一律视为不安全
    }
  }

  /** 构建发给模型的结构化摘要：只有本地已算好的事实 */
  function buildPayload(review, opts) {
    opts = opts || {};
    var payload = {
      exercise_type: review.exerciseType,
      rule_version: review.ruleVersion,
      duration_ms: review.durationMs,
      counts: review.counts,
      detection: {
        rate: review.detection.rate,
        mean_landmark_visibility: review.detection.meanLandmarkVisibility,
        view_mode: review.detection.viewMode
      },
      quality: {
        score_avg: review.quality.scoreAvg,
        sample_count: review.quality.sampleCount
      },
      dimensions: review.dimensions.map(function (d) {
        return { code: d.code, label: d.label, avg_score: d.avgScore, sample_count: d.sampleCount, unavailable_count: d.unavailableCount };
      }),
      limitations: review.limitations,
      member_context: opts.memberContext || null,   // 仅限非敏感上下文（如训练目标），不得含手机号等身份信息
      instruction: [
        '你是健身训练复盘助手。只能依据上面给出的结构化数据组织语言。',
        '禁止新增、推算或补充任何上面没有出现的角度、次数、评分或生理判断。',
        '禁止给出医疗诊断、疼痛判断或受伤风险评估。',
        '输出中文，语气克制，不超过 200 字。'
      ].join('\n')
    };
    // 二次清理：确保没有任何疑似身份信息混入
    var json = JSON.stringify(payload);
    if (/1[3-9]\d{9}/.test(json)) payload.member_context = '[已过滤疑似手机号]';
    return payload;
  }

  /** 严格校验模型返回，只接受白名单形态的字符串 */
  function validateResponse(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad_shape' };

    var out = { ok: true, summary: '', suggestions: [], note: '', warnings: [] };

    if (raw.summary != null) {
      if (typeof raw.summary !== 'string') return { ok: false, reason: 'summary_not_string' };
      out.summary = sanitize(raw.summary);
    }
    if (raw.note != null) {
      if (typeof raw.note !== 'string') return { ok: false, reason: 'note_not_string' };
      out.note = sanitize(raw.note);
    }
    if (raw.suggestions != null) {
      if (!Array.isArray(raw.suggestions)) return { ok: false, reason: 'suggestions_not_array' };
      out.suggestions = raw.suggestions.slice(0, MAX_SUGGESTIONS).map(function (s) {
        if (typeof s !== 'string') { out.warnings.push('已丢弃非字符串建议项'); return ''; }
        return sanitize(s);
      }).filter(function (s) { return s; });
    }

    // 只要出现疑似脚本/代码内容，整份丢弃（不尝试清洗后使用）
    var scan = (out.summary || '') + ' ' + (out.note || '') + ' ' + out.suggestions.join(' ');
    for (var i = 0; i < DANGEROUS.length; i++) {
      if (DANGEROUS[i].test(scan)) return { ok: false, reason: 'unsafe_content' };
    }
    return out;
  }

  function sanitize(s) {
    return String(s).replace(/[\u0000-\u001f]/g, ' ').replace(/```/g, '').slice(0, MAX_TEXT).trim();
  }

  /**
   * 创建适配器
   * @param opts { storage, config, fetchImpl, now }
   *   config: { enabled:boolean, endpoint:string, model:string, timeoutMs:number }
   *   注意：config 中**没有也不允许有** apiKey 字段。
   */
  function createAdapter(opts) {
    opts = opts || {};
    var storage = opts.storage || null;
    /* ⚠ CONFIG_KEY 必须在使用 readConfig(storage) 之前完成赋值（2026-10-24 修）。
       原写法把它放在下面第 6 行 —— var 提升让它在那一刻只是 undefined，
       于是 readConfig 里 st.getItem(undefined) 永远取不到东西、返回 null，
       适配器每次新建（＝刷新页面）都退回默认禁用态：会员配好的代理地址写进去了却读不出来，
       界面显示「尚未启用」，而存储里明明躺着那份配置。 */
    var CONFIG_KEY = 'fxp-ai-coach.adapter';
    var cfg = opts.config || readConfig(storage) || defaultConfig();
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    var now = opts.now || function () { return Date.now(); };

    function defaultConfig() {
      return { enabled: false, endpoint: '', model: DEFAULT_MODEL, timeoutMs: 15000 };
    }

    function readConfig(st) {
      if (!st) return null;
      try {
        var t = st.getItem(CONFIG_KEY);
        if (!t) return null;
        var o = JSON.parse(t);
        return {
          enabled: !!o.enabled,
          endpoint: typeof o.endpoint === 'string' ? o.endpoint : '',
          model: typeof o.model === 'string' ? o.model : DEFAULT_MODEL,
          timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : 15000
        };
      } catch (e) { return null; }
    }

    function persist() {
      if (!storage) return { ok: false, reason: 'no_storage' };
      try {
        // 明确不写入任何密钥字段
        storage.setItem(CONFIG_KEY, JSON.stringify({ enabled: cfg.enabled, endpoint: cfg.endpoint, model: cfg.model, timeoutMs: cfg.timeoutMs }));
        return { ok: true };
      } catch (e) { return { ok: false, reason: 'storage_error' }; }
    }

    /** 四态：disabled / misconfigured / ready / error */
    function getStatus() {
      if (!cfg.enabled) {
        return { status: 'disabled', enabled: false, message: 'AI 复盘尚未启用：未配置服务端代理。' };
      }
      if (!cfg.endpoint) {
        return { status: 'misconfigured', enabled: true, message: 'AI 复盘尚未启用：缺少服务端代理地址。' };
      }
      if (!/^https?:\/\//i.test(cfg.endpoint)) {
        return { status: 'misconfigured', enabled: true, message: '代理地址必须是 http(s) 开头的完整 URL。' };
      }
      if (isBlockedHost(cfg.endpoint)) {
        return {
          status: 'misconfigured', enabled: true,
          message: '拒绝直连模型供应商接口：浏览器直连必须携带 API 密钥，会把密钥暴露给任何访问该页面的人。' +
            '请改为填写你自己搭建的服务端代理地址（密钥只保存在服务端）。'
        };
      }
      return { status: 'ready', enabled: true, message: '已配置服务端代理，可在训练结束后请求复盘。' };
    }

    function configure(patch) {
      patch = patch || {};
      if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) cfg.enabled = !!patch.enabled;
      if (Object.prototype.hasOwnProperty.call(patch, 'endpoint')) cfg.endpoint = String(patch.endpoint || '').trim();
      if (Object.prototype.hasOwnProperty.call(patch, 'model')) cfg.model = String(patch.model || DEFAULT_MODEL).trim();
      if (Object.prototype.hasOwnProperty.call(patch, 'timeoutMs')) cfg.timeoutMs = Number(patch.timeoutMs) || 15000;
      return persist();
    }

    /** 预览请求体（用于测试与"发给模型前先看一眼"，不含密钥） */
    function previewRequest(review, memberContext) {
      return {
        url: cfg.endpoint,
        body: {
          model: cfg.model,
          messages: [
            { role: 'system', content: '健身训练复盘助手' },
            { role: 'user', content: JSON.stringify(buildPayload(review, { memberContext: memberContext })) }
          ],
          stream: false
        }
      };
    }

    /**
     * 请求复盘。任何失败都不抛异常，统一返回结构化失败原因，
     * 由页面决定如何展示；本地评分与记录不受影响。
     */
    function review(reviewObj, memberContext) {
      var st = getStatus();
      if (st.status !== 'ready') {
        return Promise.resolve({ ok: false, status: st.status, reason: 'not_enabled', message: st.message });
      }
      if (!fetchImpl) {
        return Promise.resolve({ ok: false, status: 'ready', reason: 'no_fetch', message: '当前环境不支持网络请求。' });
      }

      var body = {
        model: cfg.model,
        review: buildPayload(reviewObj, { memberContext: memberContext })
      };

      var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timer = null;
      var req = fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      });
      if (ctrl && cfg.timeoutMs > 0) {
        timer = setTimeout(function () { ctrl.abort(); }, cfg.timeoutMs);
      }

      return Promise.resolve(req)
        .then(function (res) {
          if (!res || typeof res.ok === 'boolean' ? !res.ok : false) {
            throw new Error('http_' + (res && res.status ? res.status : 'unknown'));
          }
          return res.json ? res.json() : res;
        })
        .then(function (json) {
          var parsed = validateResponse(json);
          if (!parsed.ok) {
            return { ok: false, status: 'ready', reason: parsed.reason, message: 'AI 返回内容未通过校验，已忽略；本地复盘仍然可用。' };
          }
          return { ok: true, status: 'ready', text: parsed, at: now() };
        })
        .catch(function (e) {
          var name = e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? String(e.message) : 'unknown');
          return { ok: false, status: 'ready', reason: name, message: 'AI 复盘请求失败（' + name + '），本地评分与训练记录不受影响。' };
        })
        .then(function (r) {
          if (timer) clearTimeout(timer);
          return r;
        });
    }

    return {
      getStatus: getStatus,
      configure: configure,
      getConfig: function () { return { enabled: cfg.enabled, endpoint: cfg.endpoint, model: cfg.model, timeoutMs: cfg.timeoutMs }; },
      previewRequest: previewRequest,
      review: review,
      buildPayload: buildPayload,
      validateResponse: validateResponse,
      isBlockedHost: isBlockedHost
    };
  }

  return { createAdapter: createAdapter, buildPayload: buildPayload, validateResponse: validateResponse, isBlockedHost: isBlockedHost, BLOCKED_HOSTS: BLOCKED_HOSTS };
});
