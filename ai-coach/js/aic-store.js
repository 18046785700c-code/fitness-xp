/* Fitness XP — AI 动作教练：独立数据持久化（UMD）
 *
 * 为什么不用现有 fxp-persist：
 *   fxp-persist.validateSnapshot 硬编码了 coaches/members/sessions/followups/tasks 五张表
 *   并对版本号做强相等（src/js/fxp-persist.js:42,46）。若把 AI 记录塞进去，
 *   要么改它的校验（触碰既有契约），要么伪造五表结构（更糟）。
 *   因此本模块使用**独立键 fxp-ai-coach**、独立版本号与独立校验：
 *   - 不读、不写、不迁移 fxp-workspace；
 *   - 两个键之间不存在任何自动同步能力，页面必须如实说明这一点。
 *
 * 落库策略（任务书第十节）：
 *   - 只保存训练统计摘要、各维度评分与依据；
 *   - 不保存原始视频、不保存逐帧关键点；
 *   - 不写入教练端 sessions.exercises。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.aicStore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY = 'fxp-ai-coach';
  var VERSION = 1;
  var MAX_RECORDS = 200;   // 本地兜底上限，超出提示先导出

  /* ---- 记录 schema：required=true 的字段缺失即整份拒收 ---- */
  var SCHEMA = [
    { name: 'ai_session_id', required: true, type: 'id', pattern: /^AIC-\d{4,}$/ },
    { name: 'member_ref', required: true, type: 'text' },
    { name: 'exercise_type', required: true, type: 'text' },
    { name: 'exercise_label', required: false, type: 'text' },
    { name: 'rule_version', required: true, type: 'text' },
    { name: 'start_ts', required: true, type: 'int' },
    { name: 'end_ts', required: true, type: 'int' },
    { name: 'duration_ms', required: false, type: 'int' },
    { name: 'reps_total', required: true, type: 'int' },
    { name: 'reps_valid', required: true, type: 'int' },
    { name: 'reps_low_confidence', required: true, type: 'int' },
    { name: 'partial_cycles', required: false, type: 'int' },
    { name: 'detection_rate', required: true, type: 'num' },
    { name: 'mean_landmark_visibility', required: false, type: 'num' },
    { name: 'view_mode', required: false, type: 'text' },
    { name: 'quality_score_avg', required: false, type: 'num_or_null' },
    { name: 'dimensions', required: true, type: 'array' },
    { name: 'limitations', required: false, type: 'array' },
    { name: 'feedback_summary', required: false, type: 'array' },
    { name: 'ai_status', required: true, type: 'enum', values: ['disabled', 'misconfigured', 'ready', 'done', 'failed', 'unavailable'] },
    { name: 'ai_text', required: false, type: 'text' },
    { name: 'ai_error', required: false, type: 'text' },
    { name: 'created_at', required: true, type: 'text' },
    { name: 'data_version', required: true, type: 'int' }
  ];

  function typeOk(v, t) {
    switch (t) {
      case 'id': return typeof v === 'string' && !!v;
      case 'text': return typeof v === 'string';
      case 'int': return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
      case 'num': return typeof v === 'number' && isFinite(v);
      case 'num_or_null': return v === null || (typeof v === 'number' && isFinite(v));
      case 'array': return Object.prototype.toString.call(v) === '[object Array]';
      default: return true;
    }
  }

  function validateRecord(r) {
    if (!r || typeof r !== 'object') return { ok: false, reason: 'not_object' };
    for (var i = 0; i < SCHEMA.length; i++) {
      var f = SCHEMA[i];
      var has = Object.prototype.hasOwnProperty.call(r, f.name);
      if (f.required && !has) return { ok: false, reason: 'missing:' + f.name };
      if (!has) continue;
      if (!typeOk(r[f.name], f.type)) return { ok: false, reason: 'bad_type:' + f.name };
      if (f.pattern && !f.pattern.test(r[f.name])) return { ok: false, reason: 'bad_pattern:' + f.name };
      if (f.values && f.values.indexOf(r[f.name]) < 0) return { ok: false, reason: 'bad_enum:' + f.name };
    }
    return { ok: true };
  }

  function validateSnapshot(s) {
    if (!s || typeof s !== 'object') return { ok: false, reason: 'bad_shape' };
    if (s.v !== VERSION) return { ok: false, reason: 'version_mismatch' };
    if (!s.savedAt || typeof s.savedAt !== 'string') return { ok: false, reason: 'bad_savedAt' };
    if (Object.prototype.toString.call(s.records) !== '[object Array]') return { ok: false, reason: 'bad_records' };
    for (var i = 0; i < s.records.length; i++) {
      var c = validateRecord(s.records[i]);
      if (!c.ok) return { ok: false, reason: 'record[' + i + ']:' + c.reason };
    }
    return { ok: true };
  }

  function createStore(opts) {
    opts = opts || {};
    var storage = opts.storage || null;
    var now = opts.now || function () { return Date.now(); };

    function read() {
      if (!storage) return { ok: false, reason: 'no_storage' };
      var text;
      try { text = storage.getItem(KEY); } catch (e) { return { ok: false, reason: 'storage_error' }; }
      if (!text) return { ok: true, snapshot: { v: VERSION, savedAt: new Date(now()).toISOString(), records: [] } };
      var s;
      try { s = JSON.parse(text); } catch (e) { return { ok: false, reason: 'corrupt_json' }; }
      var c = validateSnapshot(s);
      if (!c.ok) return { ok: false, reason: c.reason };
      return { ok: true, snapshot: s };
    }

    function write(snapshot) {
      var c = validateSnapshot(snapshot);
      if (!c.ok) return { ok: false, reason: c.reason, message: 'AI 训练记录未通过校验，拒绝保存：' + c.reason };
      if (!storage) return { ok: false, reason: 'no_storage' };
      try {
        storage.setItem(KEY, JSON.stringify(snapshot));
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'storage_error', message: '本地保存失败（' + (e && e.message ? e.message : '未知') + '），建议先导出 CSV 备份。' };
      }
    }

    function nextId(records) {
      var max = 0;
      records.forEach(function (r) {
        var m = /^AIC-(\d+)$/.exec(r.ai_session_id || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      return 'AIC-' + String(max + 1).padStart(4, '0');
    }

    /**
     * 保存一次训练记录。
     * @param review  aic-review.buildReview() 的结果
     * @param meta    { memberRef, aiStatus, aiText, aiError, startTs, endTs, feedbackSummary }
     */
    function saveSession(review, meta) {
      meta = meta || {};
      var rd = read();
      if (!rd.ok) return { ok: false, reason: rd.reason, message: '无法读取既有 AI 训练记录：' + rd.reason };
      var recs = rd.snapshot.records;
      if (recs.length >= MAX_RECORDS) {
        return { ok: false, reason: 'full', message: '本地 AI 训练记录已达上限（' + MAX_RECORDS + ' 条），请先导出 CSV 备份后再清理。' };
      }
      var rec = {
        ai_session_id: nextId(recs),
        member_ref: meta.memberRef || 'test:local',
        exercise_type: review.exerciseType,
        exercise_label: review.exerciseLabel,
        rule_version: review.ruleVersion,
        start_ts: typeof review.durationMs === 'number' ? (meta.startTs || 0) : (meta.startTs || 0),
        end_ts: meta.endTs || 0,
        duration_ms: review.durationMs,
        reps_total: review.counts.repsTotal,
        reps_valid: review.counts.repsValid,
        reps_low_confidence: review.counts.repsLowConfidence,
        partial_cycles: review.counts.partialCycles,
        detection_rate: review.detection.rate,
        mean_landmark_visibility: review.detection.meanLandmarkVisibility,
        view_mode: review.detection.viewMode,
        quality_score_avg: review.quality.scoreAvg,
        dimensions: review.dimensions,
        limitations: review.limitations,
        feedback_summary: meta.feedbackSummary || [],
        ai_status: meta.aiStatus || 'disabled',
        ai_text: meta.aiText || '',
        ai_error: meta.aiError || '',
        created_at: new Date(now()).toISOString(),
        data_version: review.dataVersion
      };
      var c = validateRecord(rec);
      if (!c.ok) return { ok: false, reason: c.reason, message: '本次记录未通过字段校验：' + c.reason };
      recs.push(rec);
      var w = write({ v: VERSION, savedAt: new Date(now()).toISOString(), records: recs });
      if (!w.ok) return w;
      return { ok: true, record: rec, count: recs.length };
    }

    function list() {
      var rd = read();
      if (!rd.ok) return { ok: false, reason: rd.reason, records: [] };
      return { ok: true, records: rd.snapshot.records.slice().reverse() };   // 最新在前
    }

    function clearAll() {
      if (!storage) return { ok: false, reason: 'no_storage' };
      try { storage.removeItem(KEY); return { ok: true }; }
      catch (e) { return { ok: false, reason: 'storage_error' }; }
    }

    /** 导出为 CSV：只包含摘要数字，不含任何逐帧数据 */
    function toCSV(records) {
      var cols = ['ai_session_id', 'created_at', 'member_ref', 'exercise_type', 'rule_version',
        'start_ts', 'end_ts', 'duration_ms', 'reps_total', 'reps_valid', 'reps_low_confidence',
        'partial_cycles', 'detection_rate', 'quality_score_avg', 'view_mode', 'ai_status', 'data_version'];
      function cell(v) {
        var s = v === null || v === undefined ? '' : String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      var lines = [cols.join(',')];
      (records || []).forEach(function (r) {
        lines.push(cols.map(function (c) { return cell(r[c]); }).join(','));
      });
      return '\uFEFF' + lines.join('\r\n') + '\r\n';
    }

    /**
     * 只读地读取教练端会员名单，用于给 AI 训练记录选择会员标识。
     * 严格只读：绝不写入、绝不校验干预、任何异常都返回空数组。
     */
    function readCoachMembers() {
      if (!storage) return [];
      try {
        var t = storage.getItem('fxp-workspace');
        if (!t) return [];
        var s = JSON.parse(t);
        var arr = s && s.tables && s.tables.members;
        if (!Array.isArray(arr)) return [];
        return arr.map(function (m) {
          return { member_id: m.member_id, name: m.name, goal: m.goal || '' };
        }).filter(function (m) { return !!m.member_id; });
      } catch (e) {
        return [];
      }
    }

    return {
      KEY: KEY, VERSION: VERSION,
      validateRecord: validateRecord,
      validateSnapshot: validateSnapshot,
      saveSession: saveSession,
      list: list,
      clearAll: clearAll,
      toCSV: toCSV,
      readCoachMembers: readCoachMembers
    };
  }

  return { createStore: createStore, validateRecord: validateRecord, validateSnapshot: validateSnapshot, KEY: KEY, VERSION: VERSION };
});
