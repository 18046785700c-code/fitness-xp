/* Fitness XP V1 — XP 积分流水模块（延后启用；与核心引擎完全隔离，UMD）
 * 隔离性（BUSINESS_RULES 第 10 节）：
 * 1) 不作为核心规则输入；2) 独立第六表；3) 损坏不影响核心功能；4) 单向依赖 members；5) 开关可逆。
 * 防重复记分：系统类事件自然键 (member_id + event_type + date)；手工调整必须携带原因。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.xp = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SYSTEM_TYPES = ['session', 'weekly_streak', 'referral', 'renewal'];
  var ALL_TYPES = SYSTEM_TYPES.concat(['manual_adjust']);
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isValidDate(s) {
    if (!DATE_RE.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  /**
   * createXpLedger(cfg)
   * cfg: { enabled:bool, memberExists:fn(memberId)->bool, today:'YYYY-MM-DD' }
   * 返回流水账对象；enabled=false 时所有写操作返回 xp_disabled，核心功能不受影响。
   */
  function createXpLedger(cfg) {
    cfg = cfg || {};
    var state = {
      enabled: !!cfg.enabled,
      today: cfg.today,
      events: [],           // 已接受事件（流水）
      errors: [],           // 拒收明细
      warnings: [],         // 防重/越界提示
      totals: {},           // member_id → 累计积分（缓存）
      naturalKeys: {},      // 'member|type|date' → event_id（系统类事件防重复记分）
      seenIds: {}           // event_id 唯一性
    };

    function nextEventId(date) {
      var prefix = 'X-' + date.replace(/-/g, '') + '-';
      var max = 0;
      state.events.forEach(function (e) {
        var m = /^X-(\d{8})-(\d+)$/.exec(e.event_id);
        if (m && m[1] === date.replace(/-/g, '')) max = Math.max(max, parseInt(m[2], 10));
      });
      return prefix + String(max + 1).padStart(4, '0');
    }

    function applyPoints(memberId, points) {
      state.totals[memberId] = (state.totals[memberId] || 0) + points;
    }

    /** 内部入账（已完成全部校验与防重） */
    function insert(rec, isLoad) {
      var id = rec.event_id || nextEventId(rec.date);
      if (state.seenIds[id]) {
        state.errors.push({ row: rec._row || 0, field: 'event_id', message: '事件ID重复：' + id + '（保留首条，本条拒收）' });
        return null;
      }
      var ev = {
        event_id: id, member_id: rec.member_id, event_type: rec.event_type,
        points: parseInt(rec.points, 10), date: rec.date,
        note: rec.note || '', _row: rec._row || 0
      };
      state.seenIds[id] = true;
      if (ev.event_type !== 'manual_adjust') state.naturalKeys[ev.member_id + '|' + ev.event_type + '|' + ev.date] = ev.event_id;
      state.events.push(ev);
      applyPoints(ev.member_id, ev.points);
      return ev;
    }

    /** 基础校验（类型/范围/会员存在性） */
    function baseValidate(rec, errs) {
      if (ALL_TYPES.indexOf(rec.event_type) < 0)
        errs.push({ field: 'event_type', message: '事件类型非法：' + rec.event_type + '（允许 ' + ALL_TYPES.join('/') + '）' });
      if (!/^-?\d+$/.test(String(rec.points))) errs.push({ field: 'points', message: '积分必须为整数：' + rec.points });
      else {
        var p = parseInt(rec.points, 10);
        if (rec.event_type === 'manual_adjust') {
          if (p < -100 || p > 100 || p === 0) errs.push({ field: 'points', message: '手工调整积分须在 -100..100 且不为 0：' + p });
        } else if (p < 1 || p > 100) errs.push({ field: 'points', message: '系统类事件积分须在 1..100：' + p });
      }
      if (!isValidDate(rec.date)) errs.push({ field: 'date', message: '日期格式非法：' + rec.date });
      if (cfg.memberExists && !cfg.memberExists(rec.member_id))
        errs.push({ field: 'member_id', message: '会员不存在：' + rec.member_id + '（核心表未收录，本条拒收）' });
    }

    return {
      /** 批量装载 CSV 记录；返回 {accepted, rejected, deduped} */
      loadEvents: function (records) {
        if (!state.enabled) return { ok: false, reason: 'xp_disabled', message: 'XP 模块未启用（xp_enabled=false），不装载任何数据' };
        var accepted = 0, rejected = 0, deduped = 0;
        (records || []).forEach(function (rec) {
          var errs = [];
          baseValidate(rec, errs);
          if (rec.event_type !== 'manual_adjust' && errs.length === 0) {
            var nk = rec.member_id + '|' + rec.event_type + '|' + rec.date;
            if (state.naturalKeys[nk]) {
              state.warnings.push({ row: rec._row, field: '', message: '阻止重复记分：' + rec.member_id + ' ' + rec.event_type + ' ' + rec.date + ' 已由 ' + state.naturalKeys[nk] + ' 记账，本条跳过' });
              deduped++;
              return;
            }
          }
          if (errs.length) {
            errs.forEach(function (e) { e.row = rec._row || 0; state.errors.push(e); });
            rejected++;
            return;
          }
          if (insert(rec, true)) accepted++;
        });
        return { ok: true, accepted: accepted, rejected: rejected, deduped: deduped };
      },

      /** 系统类事件入账（自动防重复记分） */
      recordEvent: function (memberId, eventType, points, date, note) {
        if (!state.enabled) return { ok: false, reason: 'xp_disabled', message: 'XP 模块未启用' };
        var rec = { member_id: memberId, event_type: eventType, points: points, date: date, note: note };
        var errs = [];
        baseValidate(rec, errs);
        if (errs.length) return { ok: false, reason: 'invalid', message: errs.map(function (e) { return e.message; }).join('; ') };
        var nk = memberId + '|' + eventType + '|' + date;
        if (state.naturalKeys[nk])
          return { ok: false, reason: 'duplicate_scoring', message: '阻止重复记分：同会员同类型同日期已由 ' + state.naturalKeys[nk] + ' 记账' };
        var ev = insert(rec);
        return { ok: true, event: ev };
      },

      /** 手工积分调整：必须携带调整原因（保留在 note 字段，可追溯） */
      adjust: function (memberId, delta, reason, date) {
        if (!state.enabled) return { ok: false, reason: 'xp_disabled', message: 'XP 模块未启用' };
        if (!reason || !String(reason).trim()) return { ok: false, reason: 'reason_required', message: '手工调整必须填写调整原因（可追溯要求）' };
        var rec = { member_id: memberId, event_type: 'manual_adjust', points: delta, date: date, note: String(reason).trim() };
        var errs = [];
        baseValidate(rec, errs);
        if (errs.length) return { ok: false, reason: 'invalid', message: errs.map(function (e) { return e.message; }).join('; ') };
        var ev = insert(rec);
        return { ok: true, event: ev };
      },

      total: function (memberId) { return state.totals[memberId] || 0; },
      listByMember: function (memberId) {
        return state.events.filter(function (e) { return e.member_id === memberId; });
      },
      isEnabled: function () { return state.enabled; },
      report: function () {
        return { events: state.events.length, errors: state.errors.slice(), warnings: state.warnings.slice(), totals: Object.assign({}, state.totals) };
      }
    };
  }

  return { createXpLedger: createXpLedger };
});
