/* Fitness XP — AI 动作教练：即时反馈模块（UMD，纯逻辑）
 *
 * 设计约束（任务书第七节）：
 *   1) 每个提示有冷却时间（perCode 可配），避免反复弹出；
 *   2) 关键点短暂抖动不触发：需连续 N 帧满足条件；
 *   3) 文案简短（≤ maxTextLen），训练时不要求阅读长句；
 *   4) 提示是"规则在当前观察条件下给出的待验证判断"，措辞禁止断言动作一定错误；
 *   5) 不参与任何 XP 计算——一次低评分不会扣减已获得经验；
 *   6) 某个维度无法评估时提示"暂时无法评估"，而不是给出低分结论。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.aicFeedback = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 提示字典：text 简短；level 用于页面配色 advisory<warn */
  var CATALOG = {
    NO_PERSON:            { level: 'warn',     text: '未检测到人体，请站回画面' },
    LOW_VISIBILITY:       { level: 'warn',     text: '关键点不稳定，暂时无法评估' },
    KEYPOINTS_HIDDEN:     { level: 'warn',     text: '部分关节不可见，请调整站位' },
    BODY_OUT_OF_FRAME:    { level: 'warn',     text: '请让全身进入画面' },
    VIEW_RECOMMEND:       { level: 'advisory', text: '建议侧对镜头，便于判断深度' },
    DEPTH_SHORT:          { level: 'advisory', text: '幅度未达设定范围' },
    TEMPO_UNSTABLE:       { level: 'advisory', text: '节奏变化较大，试着保持匀速' },
    TORSO_LEAN:           { level: 'advisory', text: '躯干前倾偏大，注意身体姿态' },
    SYMMETRY_DIFF:        { level: 'advisory', text: '左右表现有差异，注意均衡发力' },
    REP_COMPLETE:         { level: 'good',     text: '本次动作已完成，继续保持' },
    REP_LOW_CONFIDENCE:   { level: 'advisory', text: '本次画面质量不足，未给出评分' },
    TRACK_LOST:           { level: 'warn',     text: '识别中断，本次动作未计入' }
  };

  function createFeedbackEngine(opts) {
    opts = opts || {};
    var rules = opts.rules;
    if (!rules) throw new Error('rules_required');
    var now = opts.now || function () { return Date.now(); };
    var fb = rules.feedback || {};
    var COOLDOWN = fb.defaultCooldownMs || 6000;
    var PER = fb.perCode || {};
    var CONSEC = fb.consecutiveFrames || 8;

    var lastFired = {};   // code -> ts
    var streak = {};      // code -> 连续满足帧数

    function cooldownOf(code) {
      return Object.prototype.hasOwnProperty.call(PER, code) ? PER[code] : COOLDOWN;
    }

    function fire(code, extraText) {
      var c = CATALOG[code];
      if (!c) return null;
      lastFired[code] = now();
      streak[code] = 0;
      return {
        code: code, level: c.level,
        text: extraText || c.text,
        ts: lastFired[code]
      };
    }

    /** 条件满足计数；不足返回 false 表示"还不该说话" */
    function hold(code, cond) {
      if (!cond) { streak[code] = 0; return false; }
      streak[code] = (streak[code] || 0) + 1;
      return streak[code] >= CONSEC;
    }

    function cooledDown(code) {
      var last = lastFired[code];
      if (last == null) return true;
      return (now() - last) >= cooldownOf(code);
    }

    /**
     * @param ctx {reliable, reason, missing, view, inFrame, phase, completedRep, partialCycle, trackLost}
     * @returns {null | {code,level,text,ts}} —— 返回 null 表示本次不提示
     */
    function update(ctx) {
      ctx = ctx || {};

      /* 优先级 1：画面本身不可靠 —— 这时不能输出任何质量结论 */
      if (!ctx.reliable) {
        if (ctx.reason === 'no_person') {
          if (hold('NO_PERSON', true) && cooledDown('NO_PERSON')) return fire('NO_PERSON');
          return null;
        }
        if (hold('LOW_VISIBILITY', true) && cooledDown('LOW_VISIBILITY')) return fire('LOW_VISIBILITY');
        return null;
      }
      streak.NO_PERSON = 0; streak.LOW_VISIBILITY = 0;

      /* 优先级 2：身体未完整入框 */
      if (ctx.inFrame === false) {
        if (hold('BODY_OUT_OF_FRAME', true) && cooledDown('BODY_OUT_OF_FRAME')) return fire('BODY_OUT_OF_FRAME');
      } else {
        streak.BODY_OUT_OF_FRAME = 0;
      }

      /* 优先级 3：单侧关节不可见 */
      if (ctx.missing && ctx.missing.length) {
        if (hold('KEYPOINTS_HIDDEN', true) && cooledDown('KEYPOINTS_HIDDEN')) return fire('KEYPOINTS_HIDDEN');
      } else {
        streak.KEYPOINTS_HIDDEN = 0;
      }

      /* 优先级 4：完成一次动作 —— 最值得即时反馈的事件 */
      if (ctx.completedRep) {
        var rep = ctx.completedRep;
        if (!rep.canGrade || !rep.qualityReliable) {
          if (cooledDown('REP_LOW_CONFIDENCE')) return fire('REP_LOW_CONFIDENCE');
          return null;
        }
        // 低分不催促，按最弱维度给一条可操作建议
        var worst = worstDim(rep);
        var code = 'REP_COMPLETE';
        if (worst) {
          if (worst.code === 'depth') code = 'DEPTH_SHORT';
          else if (worst.code === 'torso') code = 'TORSO_LEAN';
          else if (worst.code === 'symmetry') code = 'SYMMETRY_DIFF';
        }
        if (cooledDown(code)) return fire(code);
        if (cooledDown('REP_COMPLETE')) return fire('REP_COMPLETE');
        return null;
      }

      /* 优先级 5：下去了但没到最低点就回来 —— 不计次，提示幅度 */
      if (ctx.partialCycle) {
        if (cooledDown('DEPTH_SHORT')) return fire('DEPTH_SHORT');
        return null;
      }

      /* 优先级 6：识别中断 */
      if (ctx.trackLost) {
        if (cooledDown('TRACK_LOST')) return fire('TRACK_LOST');
        return null;
      }

      /* 优先级 7：站位建议（长冷却，只在非侧面视角时提一次） */
      var wantView = rules.view && rules.view.recommended;
      var badView = wantView && ctx.view && ctx.view !== 'unknown' && ctx.view !== wantView;
      if (badView) {
        if (hold('VIEW_RECOMMEND', true) && cooledDown('VIEW_RECOMMEND')) return fire('VIEW_RECOMMEND');
      } else {
        streak.VIEW_RECOMMEND = 0;
      }

      return null;
    }

    /** 取最弱的可评估维度（无法评估的维度不参与——不得强行指出问题） */
    function worstDim(rep) {
      var worst = null;
      (rep.dims || []).forEach(function (d) {
        if (d.status === 'unavailable' || typeof d.score !== 'number') return;
        if (!worst || d.score < worst.score) worst = d;
      });
      // 80 分以上不额外提示
      return worst && worst.score < 80 ? worst : null;
    }

    return {
      update: update,
      catalog: CATALOG,
      cooldownOf: cooldownOf,
      consecutiveRequired: function () { return CONSEC; },
      reset: function () { lastFired = {}; streak = {}; }
    };
  }

  return { createFeedbackEngine: createFeedbackEngine, CATALOG: CATALOG };
});
