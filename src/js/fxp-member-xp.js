/* Fitness XP 会员端 V2 — XP、等级、成就、连续训练与纪录（阶段 5：游戏化成长系统）
 *
 * 加载顺序（见 04_会员端/index.html）：
 *   ... → member-plan → member-session → 本文件
 *
 * 规则的**权威定义**在 `docs/member-v2/05-XP等级任务连续成就规则.md`，本文件是它的代码化。
 * 改任何数值前先改 MBR_CONFIG 再改文档，两边必须一致；每次发放都会把
 * `rule_version = MBR_CONFIG.version` 写进流水，便于日后解释「当时为什么给了这么多」。
 *
 * 三条硬约束（违反即视为缺陷）：
 *   1. 任何页面都不得直接写 XP 数值，必须走 grant() 并带 rule_code。
 *   2. 发放以 (member_id, biz_key) 幂等：重复调用返回 duplicate，不报错也不重复加分。
 *   3. 一次会话结算内的全部发放是**同一事务**：任一步失败整笔回滚，
 *      绝不允许出现「XP 到了但成就没解锁」这种半完成状态（05 §2 / §12）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.FXP = root.FXP || {}; root.FXP.memberXp = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================ 配置（唯一数值来源） */

  var MBR_CONFIG = {
    version: 'v2.0',

    /* ---- 训练相关 ---- */
    xp: {
      XP_SESSION_BASE: { points: 20, event: 'session_base' },
      XP_SET_DONE: { points: 2, event: 'session_set', maxSets: 15, maxPoints: 30 },
      XP_SESSION_FULL_PLAN: { points: 15, event: 'session_base' },
      XP_SESSION_PARTIAL: { points: 5, event: 'session_base' },
      XP_EXPLORE_NEW: { points: 15, event: 'explore' },
      XP_PR: { points: 25, event: 'pr' },

      XP_DAILY_TASK: { points: 10, event: 'daily_task' },
      XP_WEEKLY_CHALLENGE: { points: 50, event: 'weekly_challenge' },
      XP_ALL_DAILY: { points: 15, event: 'daily_task' },

      XP_STREAK_DAY: { points: 5, event: 'streak_day', perDay: 5, maxDays: 7, maxPoints: 35 },
      XP_WEEK_TARGET: { points: 40, event: 'streak_week' },
      XP_WEEK_STREAK: { points: 10, event: 'streak_week', perWeek: 10, maxWeeks: 8, maxPoints: 80 },

      XP_ACHIEVEMENT: { points: 0, event: 'achievement' },   /* 分值由各成就自带 */
      XP_MILESTONE: { points: 100, event: 'milestone' },
      XP_GOAL_DONE: { points: 300, event: 'milestone' },

      XP_REVERSAL: { points: 0, event: 'adjustment_reversal' },
      XP_MANUAL_ADJUST: { points: 0, event: 'manual_adjust' }
    },

    /* ---- 等级表（05 §4）---- */
    levels: [
      { level: 1, title: '起步者', min: 0 },
      { level: 2, title: '习惯养成', min: 100 },
      { level: 3, title: '稳定训练者', min: 250 },
      { level: 4, title: '力量新秀', min: 500 },
      { level: 5, title: '进阶者', min: 900 },
      { level: 6, title: '熟练者', min: 1500 },
      { level: 7, title: '突破者', min: 2400 },
      { level: 8, title: '专注者', min: 3600 },
      { level: 9, title: '精进者', min: 5200 },
      { level: 10, title: '长期主义者', min: 7500 }
    ],

    /* ---- 连续训练（05 §7）---- */
    streak: {
      /* 允许 1 天空窗：只有连续两天没有任何 completed 会话才判定中断 */
      allowGapDays: 1
    },

    /* ---- 每日 / 每周（05 §5 / §6）---- */
    daily: { count: 3 },
    weekly: { count: 2 },

    /* ---- 上限（05 §11）---- */
    limits: {
      perSession: 150,
      perDay: 300,
      setXpMaxSets: 15,
      setXpMaxPoints: 30,
      dailyTaskXp: 10,
      weeklyChallengeXp: 50
    }
  };

  /* ---- 每日任务池（05 §5.3）：pool 决定谁能抽到，eval 决定判不判得成 ---- */
  var DAILY_POOL = [
    /* 通用 */
    { code: 'daily_finish_one', pool: 'all', title: '完成 1 次训练', target: 1, unit: '次' },
    { code: 'daily_log_sets', pool: 'all', title: '记录至少 12 组', target: 12, unit: '组' },
    { code: 'daily_two_muscles', pool: 'all', title: '练到 2 个不同肌群', target: 2, unit: '个' },
    { code: 'daily_log_feeling', pool: 'all', title: '训练后记录一次感受', target: 1, unit: '次' },
    /* 初学者档 */
    { code: 'beginner_start_any', pool: 'beginner', title: '今天开始任意一次训练', target: 1, unit: '次' },
    { code: 'beginner_read_exercise', pool: 'beginner', title: '查看 1 个动作详情', target: 1, unit: '次' },
    { code: 'beginner_short_session', pool: 'beginner', title: '完成一次至少 15 分钟的训练', target: 15, unit: '分钟' },
    /* 执行不稳定档 */
    { code: 'unstable_any_activity', pool: 'unstable', title: '今天有训练记录即可', target: 1, unit: '次' },
    { code: 'unstable_resume', pool: 'unstable', title: '完成上次未结束的训练', target: 1, unit: '次' },
    { code: 'unstable_two_days', pool: 'unstable', title: '连续两天都有训练', target: 2, unit: '天' },
    { code: 'unstable_plan_60', pool: 'unstable', title: '今日计划完成 60% 以上', target: 60, unit: '%' },
    /* 长期训练者档 */
    { code: 'veteran_volume', pool: 'veteran', title: '今日总容量达到 3000', target: 3000, unit: 'kg' },
    { code: 'veteran_new_pr', pool: 'veteran', title: '刷新任意一项个人纪录', target: 1, unit: '项' },
    { code: 'veteran_eight_actions', pool: 'veteran', title: '完成一次至少 8 个动作的训练', target: 8, unit: '个' },
    { code: 'veteran_high_intensity', pool: 'veteran', title: '至少有一组强度自评达到 8', target: 1, unit: '组' }
  ];

  /* ---- 每周挑战池（05 §6）---- */
  var WEEKLY_POOL = [
    { code: 'weekly_count', title: '本周完成目标次数训练', unit: '次', base: 'frequency_goal' },
    { code: 'weekly_volume', title: '本周总容量目标', unit: 'kg', base: 'frequency_goal', mul: 2500 },
    { code: 'weekly_muscles', title: '本周练到 4 个以上肌群', unit: '个', base: 'const', const: 4 },
    { code: 'weekly_days', title: '本周有 3 天以上训练记录', unit: '天', base: 'min_frequency', const: 3 },
    { code: 'weekly_pr', title: '本周刷新 1 项以上纪录', unit: '项', base: 'const', const: 1 },
    { code: 'weekly_plan_rate', title: '本周计划完成率 80% 以上', unit: '%', base: 'const', const: 80 }
  ];

  /* ---- 成就（05 §8）。hidden 成就在解锁前只暴露占位，不暴露条件 ---- */
  var ACHIEVEMENTS = [
    { code: 'first_workout', name: '第一次训练', desc: '完成第 1 次训练', xp: 30, hidden: false },
    { code: 'workout_10', name: '十次约定', desc: '累计完成 10 次训练', xp: 60, hidden: false,
      tiers: [{ t: 1, at: 10, xp: 60 }, { t: 2, at: 50, xp: 150 }, { t: 3, at: 100, xp: 300 }] },
    { code: 'streak_3', name: '三天成习惯', desc: '连续训练 3 天', xp: 40, hidden: false },
    { code: 'streak_7', name: '一周不断', desc: '连续训练 7 天', xp: 100, hidden: false },
    { code: 'week_goal_4', name: '连续四周达标', desc: '连续 4 周达成周目标次数', xp: 200, hidden: false },
    { code: 'explorer_20', name: '动作探索者', desc: '练过 20 个不同动作', xp: 80, hidden: false,
      tiers: [{ t: 1, at: 20, xp: 80 }, { t: 2, at: 50, xp: 150 }, { t: 3, at: 100, xp: 250 }] },
    { code: 'all_muscles', name: '全面覆盖', desc: '7 个主要肌群各练过至少 1 次', xp: 150, hidden: false },
    { code: 'first_pr', name: '第一次破纪录', desc: '刷新任意一项个人纪录', xp: 50, hidden: false },
    { code: 'volume_10k', name: '万钧之力', desc: '单次训练总容量达到 10000', xp: 120, hidden: false },
    { code: 'planner_own', name: '自己的计划', desc: '会员自主创建并发布过 1 份周计划', xp: 40, hidden: false },
    { code: 'comeback', name: '回来了', desc: '中断 7 天以上后重新开始并完成一次训练', xp: 80, hidden: false },
    { code: 'goal_first', name: '第一个目标', desc: '达成 1 个长期目标', xp: 200, hidden: false },

    { code: 'hidden_early_bird', name: '早起的人', desc: '累计 5 次在 08:00 前开始训练', xp: 60, hidden: true },
    { code: 'hidden_night_owl', name: '夜猫子', desc: '累计 5 次在 21:00 后开始训练', xp: 60, hidden: true },
    { code: 'hidden_perfectionist', name: '完美主义', desc: '单次训练计划完成度 100% 且动作数不少于 6', xp: 100, hidden: true },
    { code: 'hidden_steady', name: '稳如磐石', desc: '连续 4 周计划完成率都在 80%–110%', xp: 200, hidden: true },
    { code: 'hidden_explorer_bad_case', name: '器械通吃', desc: '用过 5 种以上不同器械', xp: 90, hidden: true },
    { code: 'hidden_pain_reporter', name: '会照顾自己', desc: '记录过一次不适并在下一周主动降低训练量', xp: 50, hidden: true }
  ];

  /* 主肌群全集（用于 all_muscles 成就） */
  var MUSCLE_GROUPS = ['chest', 'back', 'shoulder', 'arm', 'leg_glute', 'core', 'cardio'];

  var FEELINGS = ['great', 'good', 'normal', 'tired', 'pain'];

  /* ================================================================ 小工具 */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }
  function nowStr(d) {
    var x = d || new Date();
    return todayStr(x) + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes()) + ':' + pad(x.getSeconds());
  }
  function toMs(s) {
    if (!s) return NaN;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  }
  function dateAdd(dateStr, n) {
    var ms = toMs(dateStr);
    if (!isFinite(ms)) return dateStr;
    var d = new Date(ms + n * 86400000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function diffDays(a, b) {  /* b - a，单位天 */
    var ma = toMs(a), mb = toMs(b);
    if (!isFinite(ma) || !isFinite(mb)) return NaN;
    return Math.round((mb - ma) / 86400000);
  }
  /** ISO 周：周一为一周之始 */
  function mondayOf(dateStr) {
    var ms = toMs(dateStr || todayStr());
    if (!isFinite(ms)) return dateStr;
    var d = new Date(ms);
    var w = d.getDay();            /* 0=周日 */
    var back = (w === 0 ? 6 : w - 1);
    return dateAdd(dateStr, -back);
  }
  function intOr(v, def) { var n = parseInt(v, 10); return isFinite(n) ? n : (def || 0); }
  function numOr(v, def) { var n = parseFloat(v); return isFinite(n) ? n : (def || 0); }
  function round1(n) { return Math.round(n * 10) / 10; }

  /** 字符串多项式哈希（05 §5.2：不用随机数，保证同一输入必同一输出，测试可断言） */
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; }
    return h;
  }

  function fail(reason, message) { return { ok: false, reason: reason, message: message }; }

  /* ================================================================ 事务（整笔回滚） */

  /**
   * 事务快照 / 回滚。
   * 之所以用「reset + 重新 insert」而不是直接 splice 数组：store 内部还维护了 byId 索引，
   * 直接改数组会让索引失效，之后 find() 找得到实数组但找不到行，属于极难排查的脏状态。
   */
  function snapshot(store) {
    var o = {};
    store.TABLES.forEach(function (t) {
      o[t] = store.all(t).map(function (r) { return JSON.parse(JSON.stringify(r)); });
    });
    return o;
  }
  function restore(store, snap) {
    store.reset();
    Object.keys(snap).forEach(function (t) {
      snap[t].forEach(function (r) {
        store.insert(t, r, { skipValidate: true });
      });
    });
  }

  /* ================================================================ 发放入口 */

  /**
   * grant(store, memberId, entry, opt) —— 唯一的 XP 出口（05 §2）。
   *
   * entry: {biz_key, event_type, rule_code, points, source_ref, note, occurred_at}
   *
   * 返回 {ok, reason, ledgerId, points}
   *   duplicate              —— (member_id, biz_key) 已存在，静默跳过
   *   invalid_rule           —— rule_code 不在配置里，属于必须修的缺陷，会中断结算
   *   negative_not_allowed   —— 非冲抵类规则给了负分
   *   capped                 —— 被单次/单日上限截断后**一点都不发**（points=0）
   */
  function grant(store, memberId, entry, opt) {
    opt = opt || {};
    entry = entry || {};

    var code = entry.rule_code;
    if (!code || !MBR_CONFIG.xp[code]) {
      return fail('invalid_rule', 'XP 规则码未在配置中登记：' + code);
    }
    var rule = MBR_CONFIG.xp[code];
    var points = intOr(entry.points, rule.points);

    var negativeAllowed = (code === 'XP_REVERSAL' || code === 'XP_MANUAL_ADJUST');
    if (points < 0 && !negativeAllowed) return fail('negative_not_allowed', '该规则不允许负分：' + code);
    if (points === 0 && negativeAllowed) return fail('invalid_rule', '冲抵类规则的分数不能为 0');

    if (!entry.biz_key) return fail('invalid_rule', '缺少 biz_key，无法保证幂等');

    /* 上限截断：先算「还能发多少」，发不下就整条不发（不半发） */
    var budget = opt.budget;   /* undefined 表示不限制 */
    if (budget != null) {
      if (budget <= 0) return { ok: true, reason: 'capped', capped: true, points: 0, ledgerId: '' };
      if (points > budget) points = budget;
    }

    var res = store.insert('m_xp_ledger', {
      ledger_id: store.nextId('m_xp_ledger'),
      member_id: memberId,
      biz_key: String(entry.biz_key),
      event_type: entry.event_type || rule.event,
      rule_code: code,
      points: points,
      source_ref: entry.source_ref || '',
      note: entry.note || '',
      rule_version: MBR_CONFIG.version,
      occurred_at: entry.occurred_at || nowStr()
    }, { actor: memberId });

    if (!res.ok) {
      if (res.reason === 'unique_violation') {
        return { ok: true, reason: 'duplicate', duplicate: true, points: 0, ledgerId: '' };
      }
      return { ok: false, reason: res.reason || 'insert_failed', message: res.message || '', errors: res.errors };
    }
    return { ok: true, ledgerId: res.row.ledger_id, points: points, capped: budget != null && points < intOr(entry.points, rule.points) };
  }

  /* ================================================================ 等级与账户 */

  /** 由累计 XP 查等级表。等级只升不降（降级在 UI 说明，不在这里实现） */
  function levelOf(lifetimeXp) {
    var lv = MBR_CONFIG.levels[0];
    for (var i = 0; i < MBR_CONFIG.levels.length; i++) {
      if (lifetimeXp >= MBR_CONFIG.levels[i].min) lv = MBR_CONFIG.levels[i];
    }
    return lv;
  }

  function nextLevel(lifetimeXp) {
    for (var i = 0; i < MBR_CONFIG.levels.length; i++) {
      if (lifetimeXp < MBR_CONFIG.levels[i].min) return MBR_CONFIG.levels[i];
    }
    return null;
  }

  /**
   * recalcFromLedger(store, memberId, opt) —— 从流水重算账户（05 §F.1）。
   * m_xp_account 只是缓存，任何时候都能用这个函数重建，因此缓存错了不会污染事实。
   */
  function recalcFromLedger(store, memberId, opt) {
    opt = opt || {};
    var rows = store.all('m_xp_ledger').filter(function (r) { return r.member_id === memberId; });
    var lifetime = rows.reduce(function (a, r) { return a + intOr(r.points, 0); }, 0);
    var lv = levelOf(lifetime);
    var nx = nextLevel(lifetime);
    var into = lifetime - lv.min;
    var need = nx ? nx.min - lv.min : 0;

    var acc = store.find('m_xp_account', memberId);
    var patch = {
      member_id: memberId,
      lifetime_xp: lifetime,
      level: lv.level,
      level_title: lv.title,
      xp_into_level: into,
      xp_for_level: need,
      recalculated_at: opt.now || nowStr()
    };
    var before = acc ? acc.level : 0;
    if (acc) store.update('m_xp_account', memberId, patch, { actor: memberId });
    else store.insert('m_xp_account', patch, { actor: memberId });

    return { ok: true, lifetime_xp: lifetime, level: lv.level, level_title: lv.title,
      xp_into_level: into, xp_for_level: need, levelBefore: intOr(before, 0) };
  }

  /** 某会员某天已发放的 XP（用于单日上限） */
  function dayXp(store, memberId, date) {
    return store.all('m_xp_ledger').filter(function (r) {
      return r.member_id === memberId && String(r.occurred_at).slice(0, 10) === date;
    }).reduce(function (a, r) { return a + intOr(r.points, 0); }, 0);
  }

  /* ================================================================ 统计派生 */

  function sessionsOf(store, memberId) {
    return store.all('m_sessions').filter(function (s) { return s.member_id === memberId; });
  }
  /**
   * 已完成会话。**opt.today 必须能注入**：单元测试要用「假今天」构造跨天的连续训练，
   * 若这里写死系统日期，未来的会话会被当脏数据过滤掉，测试就只能靠改系统时钟来跑。
   */
  function completedSessions(store, memberId, opt) {
    var today = (opt && opt.today) || todayStr();
    return sessionsOf(store, memberId).filter(function (s) {
      return s.status === 'completed' && String(s.session_date) <= today;
    });
  }
  function setsOfSession(store, sessionId) {
    return store.all('m_sets')
      .filter(function (r) { return r.session_id === sessionId; })
      .sort(function (a, b) { return intOr(a.sequence) - intOr(b.sequence); });
  }

  /** Epley 估算 1RM；仅当 reps ≤ 12 参与（05 §9） */
  function epley(weight, reps) {
    var w = numOr(weight, 0), r = intOr(reps, 0);
    if (w <= 0 || r <= 0 || r > 12) return null;
    return round1(w * (1 + r / 30));
  }

  /**
   * 连续训练天数重算（05 §7.2）。
   * 规则：把训练日期升序排列，相邻两次间隔 > 2 天（即中间≥2 个空日）视为中断；
   * 最后一段若最后一天早于昨天，说明「今天和昨天都没练」，当前连续归 0。
   */
  function recomputeDayStreak(store, memberId, opt) {
    opt = opt || {};
    var today = opt.today || todayStr();
    var dates = {};
    completedSessions(store, memberId, opt).forEach(function (s) {
      var d = String(s.session_date);
      if (d <= today) dates[d] = 1;          /* 未来日期的脏数据直接忽略（05 §7.4） */
    });
    var list = Object.keys(dates).sort();
    if (!list.length) return { streak: 0, best: 0, lastTrainDate: '' };

    var runs = [[list[0]]];
    for (var i = 1; i < list.length; i++) {
      if (diffDays(list[i - 1], list[i]) > MBR_CONFIG.streak.allowGapDays + 1) runs.push([]);
      runs[runs.length - 1].push(list[i]);
    }
    var best = runs.reduce(function (a, r) { return Math.max(a, r.length); }, 0);
    var last = runs[runs.length - 1];
    var lastDate = last[last.length - 1];
    var gap = diffDays(lastDate, today);
    /* 今天没练、昨天也没练 → 已经断了 */
    var current = gap > MBR_CONFIG.streak.allowGapDays ? 0 : last.length;
    return { streak: current, best: best, lastTrainDate: lastDate };
  }

  /** 写入或更新 m_streaks 缓存行 */
  function syncStreak(store, memberId, opt) {
    opt = opt || {};
    var r = recomputeDayStreak(store, memberId, opt);
    var row = store.find('m_streaks', memberId);
    var patch = {
      member_id: memberId,
      active_days_streak: r.streak,
      best_days_streak: Math.max(intOr(row && row.best_days_streak, 0), r.best),
      last_train_date: r.lastTrainDate,
      updated_at: opt.now || nowStr()
    };
    if (row) {
      store.update('m_streaks', memberId, patch, { actor: memberId });
      patch.weekly_goal_streak = intOr(row.weekly_goal_streak, 0);
      patch.best_weekly_streak = intOr(row.best_weekly_streak, 0);
      patch.last_settled_week = row.last_settled_week || '';
    } else {
      patch.weekly_goal_streak = 0;
      patch.best_weekly_streak = 0;
      patch.last_settled_week = '';
      store.insert('m_streaks', patch, { actor: memberId });
    }
    return r;
  }

  /** 单日派生统计（供每日任务判定） */
  function dailyStats(store, memberId, date, opt) {
    opt = opt || {};
    var day = date || todayStr();
    var sess = sessionsOf(store, memberId).filter(function (s) { return String(s.session_date) === day; });
    var completed = sess.filter(function (s) { return s.status === 'completed'; });
    var setRows = [];
    var muscles = {};
    var volume = 0;
    var maxExInSession = 0;
    var hasRpe8 = false;
    var hasFeeling = false;
    var longestMin = 0;
    var resumed = false;

    sess.forEach(function (s) {
      var rows = setsOfSession(store, s.session_id);
      var exIds = {};
      rows.forEach(function (r) {
        setRows.push(r);
        exIds[r.exercise_id] = 1;
        volume += numOr(r.weight) * intOr(r.reps);
        if (intOr(r.rpe) >= 8) hasRpe8 = true;
        var ex = store.find('m_exercises', r.exercise_id);
        if (ex) muscles[ex.primary_muscles] = 1;
      });
      maxExInSession = Math.max(maxExInSession, Object.keys(exIds).length);
      if (s.status === 'completed') {
        if (String(s.feeling)) hasFeeling = true;
        longestMin = Math.max(longestMin, Math.floor(intOr(s.duration_sec) / 60));
        if (String(s.session_date) !== String(s.started_at).slice(0, 10)) resumed = true;
      }
    });
    var prs = store.all('m_records').filter(function (r) {
      return r.member_id === memberId && String(r.achieved_at).slice(0, 10) === day;
    });

    return {
      date: day,
      sessionCount: sess.length,
      completedCount: completed.length,
      setCount: setRows.length,
      muscleCount: Object.keys(muscles).length,
      volume: round1(volume),
      maxExerciseInSession: maxExInSession,
      hasRpe8: hasRpe8,
      hasFeeling: hasFeeling,
      longestMinutes: longestMin,
      prCount: prs.length,
      resumed: resumed,
      browseCount: intOr(opt.browseCount, 0),
      planRate: opt.planRate == null ? 0 : opt.planRate,
      dayStreak: intOr((store.find('m_streaks', memberId) || {}).active_days_streak, 0)
    };
  }

  /** 单周派生统计（供周挑战判定） */
  function weeklyStats(store, memberId, weekStart, opt) {
    opt = opt || {};
    var start = weekStart || mondayOf(todayStr());
    var end = dateAdd(start, 6);
    var sess = sessionsOf(store, memberId).filter(function (s) {
      return String(s.session_date) >= start && String(s.session_date) <= end;
    });
    var completed = sess.filter(function (s) { return s.status === 'completed'; });
    var volume = 0, muscles = {}, days = {}, rateSum = 0, rateN = 0;
    completed.forEach(function (s) {
      var rows = setsOfSession(store, s.session_id);
      rows.forEach(function (r) {
        volume += numOr(r.weight) * intOr(r.reps);
        var ex = store.find('m_exercises', r.exercise_id);
        if (ex) muscles[ex.primary_muscles] = 1;
      });
      days[String(s.session_date)] = 1;
      var snap = {};
      try { snap = JSON.parse(s.plan_snapshot || '{}'); } catch (e) { snap = { items: [] }; }
      var planned = (snap.items || []).reduce(function (a, p) { return a + intOr(p.target_sets, 0); }, 0);
      if (planned > 0) {
        rateSum += Math.min(100, rows.length / planned * 100);
        rateN++;
      }
    });
    var prs = store.all('m_records').filter(function (r) {
      return r.member_id === memberId && String(r.achieved_at).slice(0, 10) >= start
        && String(r.achieved_at).slice(0, 10) <= end;
    });
    var prof = store.find('m_profiles', memberId) || {};
    return {
      weekStart: start,
      completedCount: completed.length,
      volume: round1(volume),
      muscleCount: Object.keys(muscles).length,
      dayCount: Object.keys(days).length,
      prCount: prs.length,
      planRate: rateN ? Math.round(rateSum / rateN * 10) / 10 : 0,
      frequencyGoal: intOr(prof.frequency_goal, 3)
    };
  }

  /* ================================================================ 人群分档 */

  /**
   * playerType(store, memberId, opt) —— 05 §F.7。
   * 判定：newbie 或历史 <8 次 → beginner；近 4 周完成率 40%–75% → unstable；
   * 近 4 周 >75% 且历史 ≥20 → veteran；其余落在 unstable 与 veteran 之间时取 unstable。
   */
  function playerType(store, memberId, opt) {
    opt = opt || {};
    var prof = store.find('m_profiles', memberId) || {};
    if (prof.player_type) return prof.player_type;

    var total = completedSessions(store, memberId, opt).length;
    if (prof.experience_level === 'newbie' || total < 8) return 'beginner';

    var today = opt.today || todayStr();
    var start = dateAdd(mondayOf(today), -28);
    var end = dateAdd(mondayOf(today), 6);
    var planned = 0, done = 0;
    store.all('m_plans').forEach(function (p) {
      if (p.member_id !== memberId) return;
      if (String(p.week_start) < start || String(p.week_start) > end) return;
      planned += intOr(p.week_target_count, 0);
    });
    done = completedSessions(store, memberId, opt).filter(function (s) {
      return String(s.session_date) >= start && String(s.session_date) <= today;
    }).length;
    var rate = planned > 0 ? done / planned : 0;

    if (rate > 0.75 && total >= 20) return 'veteran';
    if (rate >= 0.4) return 'unstable';
    return 'unstable';
  }

  /* ================================================================ 每日任务 / 每周挑战 */

  /**
   * ensureDaily(store, memberId, date, opt) —— 生成当日任务（05 §5）。
   * 幂等：(member_id, period_key, challenge_code) 唯一，重复调用不重建。
   */
  function ensureDaily(store, memberId, date, opt) {
    opt = opt || {};
    var day = date || todayStr();
    var type = playerType(store, memberId, opt);
    var pool = DAILY_POOL.filter(function (t) { return t.pool === 'all' || t.pool === type; });

    /* 确定性排序：hash(member_id + period_key + code) 升序取前 3 */
    var scored = pool.map(function (t) {
      return { t: t, s: hashStr(memberId + day + t.code) % 1000 };
    }).sort(function (a, b) { return a.s - b.s || (a.t.code < b.t.code ? -1 : 1); });
    var picked = scored.slice(0, MBR_CONFIG.daily.count).map(function (x) { return x.t; });

    var created = 0, now = opt.now || nowStr();
    for (var i = 0; i < picked.length; i++) {
      var t = picked[i];
      var exists = store.all('m_challenges').some(function (c) {
        return c.member_id === memberId && c.period_key === day
          && c.challenge_code === t.code && c.period_type === 'daily';
      });
      if (exists) continue;
      var r = store.insert('m_challenges', {
        challenge_id: store.nextId('m_challenges'),
        member_id: memberId,
        period_type: 'daily',
        period_key: day,
        challenge_code: t.code,
        title: t.title,
        target_value: t.target,
        current_value: 0,
        unit: t.unit,
        status: 'open',
        reward_xp: MBR_CONFIG.limits.dailyTaskXp,
        biz_key: 'task:' + day + ':' + t.code,
        completed_at: '',
        created_at: now
      }, { actor: memberId });
      if (r.ok) created++;
    }
    return { ok: true, date: day, created: created, total: picked.length, playerType: type };
  }

  /** 单条每日任务的当前值（按 code 判定，不靠前端自称完成） */
  function dailyValue(code, st) {
    switch (code) {
      case 'daily_finish_one': return st.completedCount;
      case 'daily_log_sets': return st.setCount;
      case 'daily_two_muscles': return st.muscleCount;
      case 'daily_log_feeling': return st.hasFeeling ? 1 : 0;
      case 'beginner_start_any': return st.sessionCount;
      case 'beginner_read_exercise': return st.browseCount;
      case 'beginner_short_session': return st.longestMinutes;
      case 'unstable_any_activity': return st.sessionCount;
      case 'unstable_resume': return st.resumed ? 1 : 0;
      case 'unstable_two_days': return st.dayStreak;
      case 'unstable_plan_60': return Math.round(st.planRate);
      case 'veteran_volume': return st.volume;
      case 'veteran_new_pr': return st.prCount;
      case 'veteran_eight_actions': return st.maxExerciseInSession;
      case 'veteran_high_intensity': return st.hasRpe8 ? 1 : 0;
      default: return 0;
    }
  }

  /**
   * evaluateDaily(store, memberId, date, opt)
   * 只由这一处写 current_value 与 status（05 §5.4）。命中即发奖，靠 biz_key 防重。
   */
  function evaluateDaily(store, memberId, date, opt) {
    opt = opt || {};
    var day = date || todayStr();
    var st = dailyStats(store, memberId, day, opt);
    var rows = store.all('m_challenges').filter(function (c) {
      return c.member_id === memberId && c.period_type === 'daily' && c.period_key === day;
    });
    if (!rows.length) return { ok: true, evaluated: 0, date: day, note: 'no_task' };

    var now = opt.now || nowStr();
    var budget = MBR_CONFIG.limits.perDay - dayXp(store, memberId, day);
    if (budget < 0) budget = 0;
    var done = 0, newly = 0, gained = 0;

    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      var v = dailyValue(c.challenge_code, st);
      var hit = v >= numOr(c.target_value, 1);
      var patch = { current_value: v };
      if (hit && c.status === 'open') {
        patch.status = 'done';
        patch.completed_at = now;
        done++;
        var g = grant(store, memberId, {
          biz_key: 'task:' + day + ':' + c.challenge_code,
          event_type: 'daily_task',
          rule_code: 'XP_DAILY_TASK',
          source_ref: c.challenge_id,
          note: c.title,
          occurred_at: now
        }, { budget: budget });
        if (!g.ok && g.reason !== 'invalid_rule') return g;
        budget -= g.points || 0;
        gained += g.points || 0;
        if (!g.duplicate) newly++;
      }
      store.update('m_challenges', c.challenge_id, patch, { actor: memberId });
    }

    /* 三条全部完成 → 额外 15（05 §3.2） */
    var allDone = rows.length > 0 && rows.every(function (c) {
      return c.status === 'done' || dailyValue(c.challenge_code, st) >= numOr(c.target_value, 1);
    });
    if (allDone) {
      var ga = grant(store, memberId, {
        biz_key: 'task:' + day + ':all_done',
        event_type: 'daily_task',
        rule_code: 'XP_ALL_DAILY',
        source_ref: day,
        note: '今日任务全部完成',
        occurred_at: now
      }, { budget: budget });
      if (!ga.ok && ga.reason !== 'invalid_rule') return ga;
      gained += ga.points || 0;
    }

    return { ok: true, evaluated: rows.length, done: done, newlyDone: newly, allDone: allDone, gained: gained, date: day };
  }

  /** 次日结算：把昨日未完成的每日任务置 expired（05 §5.3） */
  function expireDaily(store, memberId, date, opt) {
    var day = date || todayStr();
    var n = 0;
    store.all('m_challenges').forEach(function (c) {
      if (c.member_id !== memberId || c.period_type !== 'daily') return;
      if (String(c.period_key) >= day || c.status !== 'open') return;
      store.update('m_challenges', c.challenge_id, { status: 'expired' }, { actor: memberId });
      n++;
    });
    return { ok: true, expired: n };
  }

  function ensureWeekly(store, memberId, weekStart, opt) {
    opt = opt || {};
    var ws = weekStart || mondayOf(todayStr());
    var prof = store.find('m_profiles', memberId) || {};
    var freq = intOr(prof.frequency_goal, 3);

    var scored = WEEKLY_POOL.map(function (t) {
      return { t: t, s: hashStr(memberId + ws + t.code) % 1000 };
    }).sort(function (a, b) { return a.s - b.s || (a.t.code < b.t.code ? -1 : 1); });
    var picked = scored.slice(0, MBR_CONFIG.weekly.count).map(function (x) { return x.t; });

    var created = 0, now = opt.now || nowStr();
    for (var i = 0; i < picked.length; i++) {
      var t = picked[i];
      var target;
      if (t.base === 'frequency_goal') target = t.mul ? freq * t.mul : freq;
      else if (t.base === 'min_frequency') target = Math.min(freq, t.const);
      else target = t.const;
      var exists = store.all('m_challenges').some(function (c) {
        return c.member_id === memberId && c.period_key === ws
          && c.challenge_code === t.code && c.period_type === 'weekly';
      });
      if (exists) continue;
      var r = store.insert('m_challenges', {
        challenge_id: store.nextId('m_challenges'),
        member_id: memberId,
        period_type: 'weekly',
        period_key: ws,
        challenge_code: t.code,
        title: t.title,
        target_value: target,
        current_value: 0,
        unit: t.unit,
        status: 'open',
        reward_xp: MBR_CONFIG.limits.weeklyChallengeXp,
        biz_key: 'chal:' + ws + ':' + t.code,
        completed_at: '',
        created_at: now
      }, { actor: memberId });
      if (r.ok) created++;
    }
    return { ok: true, weekStart: ws, created: created, total: picked.length };
  }

  function weeklyValue(code, w) {
    switch (code) {
      case 'weekly_count': return w.completedCount;
      case 'weekly_volume': return w.volume;
      case 'weekly_muscles': return w.muscleCount;
      case 'weekly_days': return w.dayCount;
      case 'weekly_pr': return w.prCount;
      case 'weekly_plan_rate': return Math.round(w.planRate);
      default: return 0;
    }
  }

  /**
   * evaluateWeekly —— 判定本周挑战。
   * 补做窗口：本周日 23:59 前完成都算，所以只要 period_key 是本周就能反复调用判定。
   */
  function evaluateWeekly(store, memberId, weekStart, opt) {
    opt = opt || {};
    var ws = weekStart || mondayOf(todayStr());
    var w = weeklyStats(store, memberId, ws, opt);
    var rows = store.all('m_challenges').filter(function (c) {
      return c.member_id === memberId && c.period_type === 'weekly' && c.period_key === ws;
    });
    if (!rows.length) return { ok: true, evaluated: 0, note: 'no_challenge' };

    var now = opt.now || nowStr();
    var gained = 0, done = 0;
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      var v = weeklyValue(c.challenge_code, w);
      var hit = v >= numOr(c.target_value, 1);
      var patch = { current_value: v };
      if (hit && c.status === 'open') {
        patch.status = 'done';
        patch.completed_at = now;
        done++;
        var g = grant(store, memberId, {
          biz_key: 'chal:' + ws + ':' + c.challenge_code,
          event_type: 'weekly_challenge',
          rule_code: 'XP_WEEKLY_CHALLENGE',
          source_ref: c.challenge_id,
          note: c.title,
          occurred_at: now
        });
        if (!g.ok && g.reason !== 'invalid_rule') return g;
        gained += g.points || 0;
      }
      store.update('m_challenges', c.challenge_id, patch, { actor: memberId });
    }
    return { ok: true, evaluated: rows.length, done: done, gained: gained, weekStart: ws };
  }

  /**
   * settleWeek —— 周结算（05 §7.5）：周目标达成的连续周数、XP_WEEK_TARGET、XP_WEEK_STREAK。
   * 幂等：last_settled_week 已覆盖则直接返回，不重复发奖。
   */
  function settleWeek(store, memberId, weekStart, opt) {
    opt = opt || {};
    var ws = weekStart || mondayOf(todayStr());
    var row = store.find('m_streaks', memberId);
    if (row && row.last_settled_week && String(row.last_settled_week) >= ws) {
      return { ok: true, skipped: true, reason: 'already_settled', weekStart: ws };
    }

    var w = weeklyStats(store, memberId, ws, opt);
    var hit = w.completedCount >= w.frequencyGoal;
    var now = opt.now || nowStr();
    var prev = intOr(row && row.weekly_goal_streak, 0);
    var streak = hit ? prev + 1 : 0;
    var best = Math.max(intOr(row && row.best_weekly_streak, 0), streak);

    var gained = 0;
    if (hit) {
      var g1 = grant(store, memberId, {
        biz_key: 'streak:week:' + ws,
        event_type: 'streak_week',
        rule_code: 'XP_WEEK_TARGET',
        source_ref: ws,
        note: '本周达成目标 ' + w.frequencyGoal + ' 次训练',
        occurred_at: now
      });
      if (!g1.ok && g1.reason !== 'invalid_rule') return g1;
      gained += g1.points || 0;

      if (streak >= 1) {
        var cfg = MBR_CONFIG.xp.XP_WEEK_STREAK;
        var pts = Math.min(streak, cfg.maxWeeks) * cfg.perWeek;
        if (pts > cfg.maxPoints) pts = cfg.maxPoints;
        var g2 = grant(store, memberId, {
          biz_key: 'streak:weekcont:' + ws,
          event_type: 'streak_week',
          rule_code: 'XP_WEEK_STREAK',
          points: pts,
          source_ref: ws,
          note: '连续第 ' + streak + ' 周达成周目标',
          occurred_at: now
        });
        if (!g2.ok && g2.reason !== 'invalid_rule') return g2;
        gained += g2.points || 0;
      }
    }

    var patch = {
      member_id: memberId,
      weekly_goal_streak: streak,
      best_weekly_streak: best,
      last_settled_week: ws,
      updated_at: now
    };
    if (row) store.update('m_streaks', memberId, patch, { actor: memberId });
    else {
      store.insert('m_streaks', Object.assign({
        active_days_streak: 0, best_days_streak: 0, last_train_date: ''
      }, patch), { actor: memberId });
    }

    if (hit) {
      store.insert('m_timeline', {
        timeline_id: store.nextId('m_timeline'),
        member_id: memberId,
        event_type: 'week_target',
        ref_id: ws,
        title: '本周目标达成',
        detail: '完成 ' + w.completedCount + ' / ' + w.frequencyGoal + ' 次训练',
        occurred_at: now
      }, { actor: memberId });
    }
    return { ok: true, weekStart: ws, hit: hit, weeklyStreak: streak, gained: gained };
  }

  /* ================================================================ 个人纪录 */

  /**
   * updateRecords(store, memberId, session, opt)
   * 只在会话 completed 时调用一次（05 §9）。刷新 → 更新 value、旧值进 previous_value、
   * 追加 timeline、发 XP_PR（biz_key 绑 record_id，重复刷新不会重复发奖）。
   */
  function updateRecords(store, memberId, session, opt) {
    opt = opt || {};
    var now = opt.now || nowStr();
    var rows = setsOfSession(store, session.session_id);
    var grants = [];

    /* 先按动作聚合出本次会话的候选值 */
    var byEx = {};
    rows.forEach(function (r) {
      var k = r.exercise_id;
      if (!byEx[k]) byEx[k] = { maxWeight: 0, maxReps: 0, best1rm: 0, volume: 0, topSet: null };
      var w = numOr(r.weight), reps = intOr(r.reps);
      if (w > byEx[k].maxWeight) { byEx[k].maxWeight = w; byEx[k].topSet = r; }
      if (reps > byEx[k].maxReps) byEx[k].maxReps = reps;
      var e = epley(w, reps);
      if (e != null && e > byEx[k].best1rm) byEx[k].best1rm = e;
      byEx[k].volume += w * reps;
    });

    Object.keys(byEx).forEach(function (exId) {
      var agg = byEx[exId];
      var cands = [
        { type: 'max_weight', value: agg.maxWeight },
        { type: 'max_reps', value: agg.maxReps },
        { type: 'max_volume', value: round1(agg.volume) },
        { type: 'one_rm', value: agg.best1rm }
      ];
      cands.forEach(function (c) {
        if (!(c.value > 0)) return;               /* 无重量/无次数不参与 */
        var row = store.all('m_records').filter(function (r) {
          return r.member_id === memberId && r.exercise_id === exId && r.record_type === c.type;
        })[0];

        if (!row) {
          /*
           * 首次练这个动作：建档但**不发 XP_PR**。
           * 一个动作有 4 种纪录类型（最大重量/最多次数/最大容量/估算 1RM），
           * 若首次就发，一次「第一次做卧推」会拿 4×25=100 分，
           * 直接顶满单次会话 150 的上限，把后面真正的努力全部吃掉。
           * 「刷新纪录」的语义就是打破自己过去的成绩——没有过去，就谈不上刷新。
           */
          store.insert('m_records', {
            record_id: store.nextId('m_records'),
            member_id: memberId,
            exercise_id: exId,
            record_type: c.type,
            value: c.value,
            set_id: agg.topSet ? agg.topSet.set_id : '',
            session_id: session.session_id,
            previous_value: '',
            achieved_at: now
          }, { actor: memberId });
          return;
        }
        if (c.value > numOr(row.value, 0)) {
          var old = numOr(row.value, 0);
          store.update('m_records', row.record_id, {
            value: c.value,
            previous_value: old,
            set_id: agg.topSet ? agg.topSet.set_id : row.set_id,
            session_id: session.session_id,
            achieved_at: now
          }, { actor: memberId });
          store.insert('m_timeline', {
            timeline_id: store.nextId('m_timeline'),
            member_id: memberId,
            event_type: 'record',
            ref_id: row.record_id,
            title: '刷新个人纪录',
            detail: (store.find('m_exercises', exId) || {}).name + ' · ' + c.type
              + '：' + old + ' → ' + c.value,
            occurred_at: now
          }, { actor: memberId });
          grants.push({ recordId: row.record_id, exerciseId: exId, type: c.type, value: c.value });
        }
      });
    });
    return { ok: true, updated: grants };
  }

  /* ================================================================ 成就 */

  /**
   * achievementList(store, memberId) —— 供 UI 展示。
   * **隐藏成就在解锁前不含任何条件字段**（05 §8.3），防止从 DOM 反查。
   */
  function achievementList(store, memberId) {
    var unlocked = {};
    store.all('m_unlocks').forEach(function (u) {
      if (u.member_id !== memberId) return;
      unlocked[u.achievement_code] = intOr(u.tier, 0);
    });
    return ACHIEVEMENTS.map(function (a) {
      /*
       * 「有没有解锁」必须看 m_unlocks 里有没有这条记录，不能看 tier > 0。
       * 一次性成就（第一次训练、第一个目标……）只有一档，解锁时 tier 写的就是 0；
       * 用 tier 判断会让这些成就明明已经解锁、XP 也已经发了，
       * 成就页却永远显示「未解锁」——会员看到的是自己白练了。
       * tier 只用来表示分层成就到了第几档。
       */
      var got = Object.prototype.hasOwnProperty.call(unlocked, a.code);
      var tier = unlocked[a.code] || 0;
      if (a.hidden && !got) {
        return { code: a.code, name: '???', desc: '', hidden: true, unlocked: false, xp: 0, tiers: 0 };
      }
      return {
        code: a.code, name: a.name, desc: a.desc, hidden: !!a.hidden,
        unlocked: got, tier: tier, xp: a.xp, tiers: a.tiers ? a.tiers.length : 0,
        unlocked_at: got ? (store.all('m_unlocks').filter(function (u) {
          return u.member_id === memberId && u.achievement_code === a.code;
        })[0] || {}).unlocked_at : ''
      };
    });
  }

  /**
   * evaluateAchievements(store, memberId, ctx, budget)
   * 在会话结算的同一事务里调用。ctx 带上本次会话刚算出来的派生量，避免重复扫全表。
   * 分层成就只升不降（已有 tier ≥ 新 tier 时不发）。
   */
  function evaluateAchievements(store, memberId, ctx, budget, opt) {
    opt = opt || {};
    var now = ctx.now || nowStr();
    var unlocked = [];
    var gained = 0;

    function has(code) {
      return store.all('m_unlocks').some(function (u) {
        return u.member_id === memberId && u.achievement_code === code;
      });
    }
    function maxTier(code) {
      var t = 0;
      store.all('m_unlocks').forEach(function (u) {
        if (u.member_id === memberId && u.achievement_code === code) t = Math.max(t, intOr(u.tier, 0));
      });
      return t;
    }
    function unlock(a, tier, note) {
      var ins = store.insert('m_unlocks', {
        unlock_id: store.nextId('m_unlocks'),
        member_id: memberId,
        achievement_code: a.code,
        tier: tier || 0,
        unlocked_at: now,
        biz_key: 'achv:' + a.code + (tier ? ':t' + tier : ''),
        progress_snapshot: note || ''
      }, { actor: memberId });
      if (!ins.ok) return ins;
      var pts = tier && a.tiers ? (a.tiers.filter(function (x) { return x.t === tier; })[0] || {}).xp || a.xp : a.xp;
      var g = grant(store, memberId, {
        biz_key: 'achv:' + a.code + (tier ? ':t' + tier : ''),
        event_type: 'achievement',
        rule_code: 'XP_ACHIEVEMENT',
        points: pts,
        source_ref: opt.sourceRef || ins.row.unlock_id,
        note: a.name,
        occurred_at: now
      }, { budget: budget });
      if (!g.ok) return g;
      budget -= g.points || 0;
      gained += g.points || 0;
      store.insert('m_timeline', {
        timeline_id: store.nextId('m_timeline'),
        member_id: memberId,
        event_type: 'achievement',
        ref_id: ins.row.unlock_id,
        title: '解锁成就：' + a.name,
        detail: note || a.desc,
        occurred_at: now
      }, { actor: memberId });
      unlocked.push({ code: a.code, name: a.name, tier: tier || 0, xp: g.points || 0 });
      return { ok: true };
    }

    function find(code) {
      return ACHIEVEMENTS.filter(function (a) { return a.code === code; })[0];
    }

    var total = ctx.completedSessions || 0;
    var streak = ctx.dayStreak || 0;
    var weekStreak = ctx.weeklyGoalStreak || 0;

    /* ---- 一次性成就 ---- */
    var ones = [
      { code: 'first_workout', hit: total === 1 },
      { code: 'streak_3', hit: streak >= 3 },
      { code: 'streak_7', hit: streak >= 7 },
      { code: 'week_goal_4', hit: weekStreak >= 4 },
      { code: 'all_muscles', hit: (ctx.muscleGroups || 0) >= MUSCLE_GROUPS.length },
      { code: 'first_pr', hit: (ctx.newRecords || 0) >= 1 },
      { code: 'volume_10k', hit: (ctx.sessionVolume || 0) >= 10000 },
      { code: 'planner_own', hit: !!ctx.hasOwnPlan },
      { code: 'comeback', hit: !!ctx.comeback },
      { code: 'goal_first', hit: !!ctx.goalAchieved }
    ];
    for (var i = 0; i < ones.length; i++) {
      var a = find(ones[i].code);
      if (!a || !ones[i].hit || has(a.code)) continue;
      var r = unlock(a, 0, a.desc);
      if (!r.ok) return r;
    }

    /* ---- 分层成就：只升不降 ---- */
    var tiers = [
      { code: 'workout_10', value: total },
      { code: 'explorer_20', value: (ctx.triedExercises || 0) }
    ];
    for (var j = 0; j < tiers.length; j++) {
      var ta = find(tiers[j].code);
      if (!ta || !ta.tiers) continue;
      var cur = maxTier(ta.code);
      for (var k = 0; k < ta.tiers.length; k++) {
        var tier = ta.tiers[k];
        if (tiers[j].value >= tier.at && tier.t > cur) {
          var rt = unlock(ta, tier.t, ta.desc + '（第 ' + tier.t + ' 档）');
          if (!rt.ok) return rt;
        }
      }
    }

    /* ---- 隐藏成就 ---- */
    var hiddens = [
      { code: 'hidden_early_bird', hit: (ctx.earlyBirdCount || 0) >= 5 },
      { code: 'hidden_night_owl', hit: (ctx.nightOwlCount || 0) >= 5 },
      { code: 'hidden_perfectionist', hit: (ctx.sessionRate === 100 && (ctx.sessionExerciseCount || 0) >= 6) },
      { code: 'hidden_steady', hit: !!ctx.steadyFourWeeks },
      { code: 'hidden_explorer_bad_case', hit: (ctx.equipmentKinds || 0) >= 5 },
      { code: 'hidden_pain_reporter', hit: !!ctx.painThenLighter }
    ];
    for (var h = 0; h < hiddens.length; h++) {
      var ha = find(hiddens[h].code);
      if (!ha || !hiddens[h].hit || has(ha.code)) continue;
      var rh = unlock(ha, 0, ha.desc);
      if (!rh.ok) return rh;
    }

    return { ok: true, unlocked: unlocked, gained: gained };
  }

  /* ================================================================ 会话结算（主入口） */

  /**
   * settleSession(store, memberId, sessionId, opt) —— 一次训练的全部结算（05 §2 / §3）。
   *
   * 发放顺序（顺序本身不影响分数，只影响上限截断时谁先被砍）：
   *   会话基础 → 每组 → 计划完成度 → 首次尝试 → 连续天数 → 个人纪录 → 成就
   *
   * 任一步失败 → 整笔回滚到调用前的状态，返回 {ok:false, reason:'settle_failed'}，
   * 调用方应当提示「上次结算未完成，点击重试」（重试天然幂等，因为 biz_key 已存在）。
   */
  function settleSession(store, memberId, sessionId, opt) {
    opt = opt || {};
    var now = opt.now || nowStr();
    var session = store.find('m_sessions', sessionId);
    if (!session || session.member_id !== memberId) return fail('not_found', '未找到该训练会话');
    if (session.status !== 'completed') return fail('not_completed', '只有已完成的训练才能结算');

    /* 幂等：已经结算过就直接返回，重复点击不会重复发奖 */
    var already = store.all('m_xp_ledger').some(function (r) {
      return r.member_id === memberId && r.biz_key === 'session:' + sessionId + ':base';
    });
    if (already) {
      return { ok: true, duplicate: true, granted: [], gained: 0, note: '本次训练已经结算过了' };
    }

    var snap = snapshot(store);
    var budget = MBR_CONFIG.limits.perSession;
    var dayBudget = MBR_CONFIG.limits.perDay - dayXp(store, memberId, String(session.session_date));
    if (dayBudget < budget) budget = dayBudget < 0 ? 0 : dayBudget;

    var granted = [];
    var gained = 0;
    var capped = false;

    function give(entry) {
      var g = grant(store, memberId, entry, { budget: budget });
      if (!g.ok) return g;
      budget -= g.points || 0;
      gained += g.points || 0;
      if (g.capped) capped = true;
      if (g.reason === 'capped') return { ok: true, skipped: true };
      if (!g.duplicate) granted.push({ rule: entry.rule_code, points: g.points, note: entry.note || '' });
      else granted.push({ rule: entry.rule_code, points: 0, note: (entry.note || '') + '（已发放过）' });
      return { ok: true };
    }

    function abort(reason, detail) {
      restore(store, snap);
      return { ok: false, reason: reason, message: detail || '', settleFailed: true };
    }

    var rows = setsOfSession(store, sessionId);
    var snapPlan = {};
    try { snapPlan = JSON.parse(session.plan_snapshot || '{}'); } catch (e) { snapPlan = { items: [] }; }
    var plannedSets = (snapPlan.items || []).reduce(function (a, p) { return a + intOr(p.target_sets, 0); }, 0);
    var rate = plannedSets > 0 ? Math.min(100, Math.round(rows.length / plannedSets * 1000) / 10) : 0;

    /* 本次结算产生的每一条流水，source_ref 一律写 sessionId。
       早期版本按「最贴切的那个实体」写（组分写 set_id、纪录写 recordId、
       连续写日期），结果结算卡按 sessionId 查流水时只能查到基础分一条：
       会员看到「本次 +20」，账户却涨了 76 分，对不上账。
       具体实体仍完整保留在 biz_key 里，可追溯性没有损失。 */

    /* 1. 会话基础分 */
    var g1 = give({
      biz_key: 'session:' + sessionId + ':base',
      rule_code: 'XP_SESSION_BASE',
      source_ref: sessionId,
      note: '完成一次训练',
      occurred_at: now
    });
    if (!g1.ok) return abort('settle_failed', g1.message || g1.reason);

    /* 2. 每组分（05 §11：超过 15 组不再给） */
    var setLimit = MBR_CONFIG.limits.setXpMaxSets;
    for (var i = 0; i < rows.length && i < setLimit; i++) {
      var gs = give({
        biz_key: 'session:' + sessionId + ':set:' + rows[i].set_id,
        rule_code: 'XP_SET_DONE',
        source_ref: sessionId,
        note: '完成第 ' + (i + 1) + ' 组',
        occurred_at: now
      });
      if (!gs.ok) return abort('settle_failed', gs.message || gs.reason);
    }

    /* 3. 计划完成度（FULL 与 PARTIAL 互斥） */
    if (session.source_type !== 'quick' && plannedSets > 0) {
      if (rows.length >= plannedSets) {
        var gf = give({
          biz_key: 'session:' + sessionId + ':fullplan',
          rule_code: 'XP_SESSION_FULL_PLAN',
          source_ref: sessionId,
          note: '计划 100% 完成',
          occurred_at: now
        });
        if (!gf.ok) return abort('settle_failed', gf.message || gf.reason);
      } else if (rate >= 60) {
        var gp = give({
          biz_key: 'session:' + sessionId + ':partial',
          rule_code: 'XP_SESSION_PARTIAL',
          source_ref: sessionId,
          note: '计划完成 ' + rate + '%',
          occurred_at: now
        });
        if (!gp.ok) return abort('settle_failed', gp.message || gp.reason);
      }
    }

    /* 4. 首次尝试某个动作 */
    var tried = {};
    rows.forEach(function (r) { tried[r.exercise_id] = 1; });
    var exIds = Object.keys(tried);
    for (var e4 = 0; e4 < exIds.length; e4++) {
      var exId = exIds[e4];
      var seenBefore = store.all('m_sets').some(function (r) {
        return r.exercise_id === exId && r.session_id !== sessionId;
      });
      if (seenBefore) continue;
      var exName = (store.find('m_exercises', exId) || {}).name || exId;
      var ge = give({
        biz_key: 'explore:' + memberId + ':' + exId,
        rule_code: 'XP_EXPLORE_NEW',
        source_ref: sessionId,
        note: '首次尝试：' + exName,
        occurred_at: now
      });
      if (!ge.ok) return abort('settle_failed', ge.message || ge.reason);
    }

    /* 5. 连续训练天数 */
    var stInfo = syncStreak(store, memberId, { today: opt.today || todayStr(), now: now });
    if (stInfo.streak > 0) {
      var cfg = MBR_CONFIG.xp.XP_STREAK_DAY;
      var pts = Math.min(stInfo.streak, cfg.maxDays) * cfg.perDay;
      if (pts > cfg.maxPoints) pts = cfg.maxPoints;
      var gsd = give({
        biz_key: 'streak:day:' + String(session.session_date),
        rule_code: 'XP_STREAK_DAY',
        points: pts,
        source_ref: sessionId,
        note: '连续训练第 ' + stInfo.streak + ' 天',
        occurred_at: now
      });
      if (!gsd.ok) return abort('settle_failed', gsd.message || gsd.reason);
    }

    /* 6. 个人纪录 */
    var rec = updateRecords(store, memberId, session, { now: now });
    if (!rec.ok) return abort('settle_failed', rec.message || '纪录更新失败');
    for (var r2 = 0; r2 < rec.updated.length; r2++) {
      var gr = give({
        biz_key: 'pr:' + rec.updated[r2].recordId,
        rule_code: 'XP_PR',
        source_ref: sessionId,
        note: '刷新纪录：' + (store.find('m_exercises', rec.updated[r2].exerciseId) || {}).name,
        occurred_at: now
      });
      if (!gr.ok) return abort('settle_failed', gr.message || gr.reason);
    }

    /* 7. 成就（与 XP 同一事务） */
    var ctx = buildAchievementCtx(store, memberId, session, {
      now: now, newRecords: rec.updated.length, sessionRate: rate,
      sessionVolume: numOr(session.total_volume, 0),
      sessionExerciseCount: intOr(session.actual_exercise_count, 0),
      today: opt.today || todayStr()
    });
    var ach = evaluateAchievements(store, memberId, ctx, budget, { sourceRef: sessionId });
    if (!ach.ok) return abort('settle_failed', ach.message || ach.reason);
    budget -= ach.gained || 0;
    gained += ach.gained || 0;

    /* 8. 等级缓存重算（等级只升不降） */
    var before = store.find('m_xp_account', memberId);
    var beforeLevel = before ? intOr(before.level, 1) : 0;
    var acc = recalcFromLedger(store, memberId, { now: now });
    var levelsGained = [];
    for (var lv = beforeLevel + 1; lv <= acc.level; lv++) {
      var lrow = MBR_CONFIG.levels.filter(function (x) { return x.level === lv; })[0];
      /* 每级各写一条 0 分的 ledger 与一条 timeline（05 §4）。
         rule_code 用 XP_LEVEL_UP 而不是 XP_ACHIEVEMENT：升级不发经验，
         混在成就里会让会员导出流水后算不清「成就到底发了多少分」。
         source_ref 仍写 sessionId，保持「本次结算的流水都指向这次会话」的约定。 */
      grant(store, memberId, {
        biz_key: 'level:' + memberId + ':' + lv,
        event_type: 'milestone',
        rule_code: 'XP_LEVEL_UP',
        points: 0,
        source_ref: sessionId,
        note: '升到 Lv.' + lv + ' ' + (lrow ? lrow.title : ''),
        occurred_at: now
      });
      store.insert('m_timeline', {
        timeline_id: store.nextId('m_timeline'),
        member_id: memberId,
        event_type: 'level_up',
        ref_id: String(lv),
        title: '升到 Lv.' + lv,
        detail: lrow ? lrow.title : '',
        occurred_at: now
      }, { actor: memberId });
      levelsGained.push(lv);
    }

    return {
      ok: true,
      sessionId: sessionId,
      gained: gained,
      capped: capped,
      granted: granted,
      newRecords: rec.updated,
      unlocked: ach.unlocked || [],
      level: acc.level,
      levelTitle: acc.level_title,
      levelsGained: levelsGained,
      dayStreak: stInfo.streak
    };
  }

  /**
   * 成就判定需要的派生量。单独抽出来：这些量在结算之外（比如首页刷新）也要用到，
   * 写两遍一定会出现两版口径。
   */
  function buildAchievementCtx(store, memberId, session, opt) {
    opt = opt || {};
    var completed = completedSessions(store, memberId, opt);
    var tried = {};
    var muscles = {};
    var equip = {};
    store.all('m_sets').forEach(function (r) {
      var sess = store.find('m_sessions', r.session_id);
      if (!sess || sess.member_id !== memberId || sess.status !== 'completed') return;
      tried[r.exercise_id] = 1;
      var ex = store.find('m_exercises', r.exercise_id);
      if (ex) { muscles[ex.primary_muscles] = 1; equip[ex.equipment] = 1; }
    });

    var earlyBird = 0, nightOwl = 0;
    completed.forEach(function (s) {
      var m = String(s.started_at).match(/\s(\d{2}):/);
      if (!m) return;
      var h = intOr(m[1], 12);
      if (h < 8) earlyBird++;
      if (h >= 21) nightOwl++;
    });

    var streakRow = store.find('m_streaks', memberId) || {};
    var hasOwnPlan = store.all('m_plans').some(function (p) {
      return p.member_id === memberId && p.source === 'member' && p.status === 'published';
    });

    /* 回来了：中断 ≥7 天后重新开始。用「上次训练日期与本次相差天数」判定 */
    var comeback = false;
    if (session) {
      var prev = completed.filter(function (s) { return s.session_id !== session.session_id; })
        .sort(function (a, b) { return String(b.session_date).localeCompare(String(a.session_date)); })[0];
      if (prev) {
        var gap = diffDays(String(prev.session_date), String(session.session_date));
        if (isFinite(gap) && gap >= 7) comeback = true;
      }
    }

    return {
      now: opt.now || nowStr(),
      completedSessions: completed.length,
      triedExercises: Object.keys(tried).length,
      muscleGroups: Object.keys(muscles).length,
      equipmentKinds: Object.keys(equip).length,
      earlyBirdCount: earlyBird,
      nightOwlCount: nightOwl,
      dayStreak: intOr(streakRow.active_days_streak, 0),
      weeklyGoalStreak: intOr(streakRow.weekly_goal_streak, 0),
      newRecords: intOr(opt.newRecords, 0),
      sessionRate: opt.sessionRate,
      sessionVolume: opt.sessionVolume,
      sessionExerciseCount: opt.sessionExerciseCount,
      hasOwnPlan: hasOwnPlan,
      comeback: comeback,
      goalAchieved: !!opt.goalAchieved,
      steadyFourWeeks: !!opt.steadyFourWeeks,
      painThenLighter: !!opt.painThenLighter
    };
  }

  /* ================================================================ 查询出口 */

  /**
   * 账户概览（给首页 / 成长中心用）。
   *
   * **刻意不读 m_xp_account 缓存**，而是从 m_xp_ledger 现算：
   * 每日任务、周挑战的发分发生在会话结算之后，缓存会滞后于流水，
   * 读缓存会让首页的 XP 数字比流水少一截——而流水才是会员能对账的东西。
   * m_xp_account 退化成「上次结算时的快照」，展示口径一律以流水为准。
   */
  function overview(store, memberId, opt) {
    opt = opt || {};
    var lifetime = store.all('m_xp_ledger')
      .filter(function (r) { return r.member_id === memberId; })
      .reduce(function (a, r) { return a + intOr(r.points, 0); }, 0);
    var lv = levelOf(lifetime);
    var nx = nextLevel(lifetime);
    var streak = store.find('m_streaks', memberId) || {};
    return {
      lifetime_xp: lifetime,
      level: lv.level,
      level_title: lv.title,
      xp_into_level: lifetime - lv.min,
      xp_for_level: nx ? nx.min - lv.min : 0,
      active_days_streak: intOr(streak.active_days_streak, 0),
      best_days_streak: intOr(streak.best_days_streak, 0),
      weekly_goal_streak: intOr(streak.weekly_goal_streak, 0)
    };
  }

  /** 最近 N 条 XP 流水（结算卡要「逐条对应到 ledger 的具体行」） */
  function ledgerOf(store, memberId, ref, opt) {
    opt = opt || {};
    return store.all('m_xp_ledger')
      .filter(function (r) { return r.member_id === memberId && (!ref || String(r.source_ref).indexOf(ref) >= 0); })
      .sort(function (a, b) { return String(a.occurred_at).localeCompare(String(b.occurred_at)); });
  }

  /** 成长时间线 */
  function timeline(store, memberId, opt) {
    opt = opt || {};
    return store.all('m_timeline')
      .filter(function (t) { return t.member_id === memberId; })
      .sort(function (a, b) { return String(b.occurred_at).localeCompare(String(a.occurred_at)); })
      .slice(0, intOr(opt.limit, 50));
  }

  /**
   * 冲抵：修正导致已发奖励失效时写一条负数流水（05 §3.5）。
   * **原记录永不删除**，只追加反向条目，这样历史始终可解释。
   */
  function reversal(store, memberId, originLedgerId, reason, opt) {
    opt = opt || {};
    var origin = store.find('m_xp_ledger', originLedgerId);
    if (!origin || origin.member_id !== memberId) return fail('not_found', '未找到原 XP 记录');
    var g = grant(store, memberId, {
      biz_key: 'reversal:' + originLedgerId,
      event_type: 'adjustment_reversal',
      rule_code: 'XP_REVERSAL',
      points: -intOr(origin.points, 0),
      source_ref: originLedgerId,
      note: reason || '数据修正导致奖励失效',
      occurred_at: opt.now || nowStr()
    });
    if (!g.ok) return g;
    var acc = recalcFromLedger(store, memberId, { now: opt.now || nowStr() });
    return { ok: true, ledgerId: g.ledgerId, points: g.points, level: acc.level };
  }

  /* ================================================================ 导出 */

  return {
    CONFIG: MBR_CONFIG,
    DAILY_POOL: DAILY_POOL,
    WEEKLY_POOL: WEEKLY_POOL,
    ACHIEVEMENTS: ACHIEVEMENTS,
    MUSCLE_GROUPS: MUSCLE_GROUPS,

    grant: grant,
    recalcFromLedger: recalcFromLedger,
    levelOf: levelOf,
    nextLevel: nextLevel,
    dayXp: dayXp,
    overview: overview,
    ledgerOf: ledgerOf,
    timeline: timeline,
    reversal: reversal,

    settleSession: settleSession,
    updateRecords: updateRecords,
    evaluateAchievements: evaluateAchievements,
    achievementList: achievementList,

    ensureDaily: ensureDaily,
    evaluateDaily: evaluateDaily,
    expireDaily: expireDaily,
    ensureWeekly: ensureWeekly,
    evaluateWeekly: evaluateWeekly,
    settleWeek: settleWeek,

    dailyStats: dailyStats,
    weeklyStats: weeklyStats,
    recomputeDayStreak: recomputeDayStreak,
    syncStreak: syncStreak,
    playerType: playerType,

    /* 只读：暴露给 UI 用于「今日已达上限」类提示等场景。
       任何发放逻辑请继续走 settleSession / evaluateDaily / evaluateWeekly，
       不要因为能直接读 CONFIG 就绕过算法。 */
    CONFIG: MBR_CONFIG,

    snapshot: snapshot,
    restore: restore,
    hashStr: hashStr,
    epley: epley,
    mondayOf: mondayOf,
    dateAdd: dateAdd,
    todayStr: todayStr,
    nowStr: nowStr
  };
});
