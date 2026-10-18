/* Fitness XP 会员端 V2 — 成长：高级计划调整 + 为什么慢 + 成长时间线（UMD 领域层）
 *
 * 依赖（**加载顺序必须按这个来**，浏览器端由工厂参数注入）：
 *   fxp-member-schema / fxp-member-plan / fxp-member-xp / fxp-member-explore
 * 不依赖：任何 UI、localStorage、fetch、console、document、alert
 *
 * 【本模块的边界 —— 接手的人先读这段】
 *   1) **系统绝不自动改计划**：`suggest()` 是纯函数，不写库、不改计划，可以在 render 里安全调用；
 *      只有用户点了接受 / 修改后接受，才走到 `decide()` 里的落地分支。
 *   2) **绝不改写已完成会话**：落地只碰 `m_plan_items`（还可能碰 `m_plans.week_target_count`），
 *      一行 `m_sessions` / `m_sets` 都不写。这是硬边界，不要为了"更聪明"破它。
 *   3) **不发 XP**：本模块不调 XP.grant，一次都不发。
 *   4) **不自己持久化**：只改内存 store，`store.save()` 由调用方统一负责。
 *   5) ** m_adjustments 没有唯一约束**（见 audit 15 §1.1），所以幂等只能靠**先查后插**，
 *      不能指望 store 替你挡住重复行。
 *   6) 时间线**只读派生**：探索解锁、计划调整都已经分别落在 `m_unlocks` / `m_adjustments` 上，
 *      这里只做合并与排序，**不重复造一份事实**——所以不需要给 `m_timeline` 加新的事件类型
 *      （这是相对最初设计的一处简化，理由见 15 §3.2）。
 *
 * 【幂等键】 `(member_id, target_type='week', target_id=周锚点, reason_code)`
 *   同一会员、同一周、同一条规则只会有一份建议；**拒绝也占位**，因此天然实现了
 *   「拒绝之后不再重复骚扰」。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./fxp-member-schema.js'),
      require('./fxp-member-plan.js'),
      require('./fxp-member-xp.js'),
      require('./fxp-member-explore.js')
    );
  } else {
    root.FXP = root.FXP || {};
    root.FXP.memberGrowth = factory(
      root.FXP.memberSchema, root.FXP.memberPlan, root.FXP.memberXp, root.FXP.memberExplore
    );
  }
})(typeof self !== 'undefined' ? self : this, function (MSCH, PLAN, XP, EXPLORE) {
  'use strict';

  /* ================================================================ 常量 */

  /** 调整规则版本：改任何阈值都必须改它，否则历史建议无法解释是哪版规则给的 */
  var ADJ_RULE_VERSION = 'adj-v1';

  /** 「为什么慢」与趋势的规则版本 */
  var WHY_RULE_VERSION = 'why-v1';

  /** 连续天数里程碑的门槛值：达到 best_days_streak 就派生一条里程碑事件 */
  var STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];

  /** 疼痛反馈的回溯天数 */
  var PAIN_WINDOW_DAYS = 7;

  /**
   * 建议优先级。数组顺序即输出顺序，`suggest()` 取前 N 条。
   * 疼痛第一（健康优先于进度），新手引导第二（先有东西可练），
   * 断档第三，最后才是「没达标」和「可提升」。
   */
  var ADJ_RULES = [
    { code: 'ADJ_PAIN_NOTE', adjust_type: 'rest', order: 1 },
    { code: 'ADJ_BEGINNER_START', adjust_type: 'frequency', order: 2 },
    { code: 'ADJ_STREAK_BREAK', adjust_type: 'rest', order: 3 },
    { code: 'ADJ_LOW_RATE', adjust_type: 'volume', order: 4 },
    { code: 'ADJ_READY_UP', adjust_type: 'intensity', order: 5 }
  ];

  /** 容量的上下限：降不能降到不能练，升不能一次加太多 */
  var SETS_MIN = 2;
  var SETS_MAX = 5;

  /* ================================================================ 小工具 */

  function intOr(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }
  function numOr(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
  function round1(n) { return Math.round(n * 10) / 10; }
  function fail(reason, msg) { return { ok: false, reason: reason, errors: [msg] }; }
  function isObj(o) { return !!o && typeof o === 'object'; }

  function badStore(store) {
    return !store || typeof store.all !== 'function' || typeof store.insert !== 'function';
  }
  function noSchema() { return !MSCH || !MSCH.SCHEMAS || !MSCH.SCHEMAS.m_adjustments; }

  /** 按千分位无关的最简日期差（b − a，单位天）；逐字段构造 Date，避开时区解析差异 */
  function dateParts(d) {
    var p = String(d).slice(0, 10).split('-');
    return { y: +p[0], m: +p[1] - 1, d: +p[2] };
  }
  function dayDiff(a, b) {
    var pa = dateParts(a), pb = dateParts(b);
    var ta = new Date(pa.y, pa.m, pa.d).getTime();
    var tb = new Date(pb.y, pb.m, pb.d).getTime();
    return Math.round((tb - ta) / 86400000);
  }
  /** 今天是本周第几天，周一=1 … 周日=7（与 m_plan_items.day_of_week 同口径） */
  function planDayOf(today, weekStart) {
    var d = dayDiff(weekStart, today);
    return d >= 0 && d <= 6 ? d + 1 : 7;
  }

  function todayOf(opt) { return (opt && opt.today) || (XP ? XP.todayStr() : ''); }
  function nowOf(opt) { return (opt && opt.now) || (XP ? XP.nowStr() : ''); }
  function monday(dateStr) { return XP ? XP.mondayOf(dateStr) : dateStr; }
  function addDays(dateStr, n) { return XP ? XP.dateAdd(dateStr, n) : dateStr; }

  /**
   * 按会员取行。**只用于除主键外还带 member_id 的表。**
   *
   * 这里栽过一次：`m_plan_items` 与 `m_sets` **都没有 member_id**，
   * 它们的归属要分别通过 `plan_id` / `session_id` 反查（见 planItemsOf / setsOfSessions）。
   * 对这两种表调用本函数会得到**空数组而不是报错**——规则会安静地一条都算不出来，
   * 页面看上去像「你很健康，没有建议」，其实是从没跑过。所以下面两个 helper 必须成对用。
   */
  function myRows(store, memberId, table) {
    return store.all(table).filter(function (r) { return r.member_id === memberId; });
  }
  function adjRows(store, memberId) { return myRows(store, memberId, 'm_adjustments'); }

  /** 某会员的计划下的计划项（m_plan_items 无 member_id，只能靠计划归属） */
  function planItemsOf(store, memberId, planIds) {
    var ids = {};
    (planIds || []).forEach(function (id) { ids[id] = 1; });
    return store.all('m_plan_items').filter(function (r) { return ids[r.plan_id]; });
  }

  /** 若干会话的组记录（m_sets 无 member_id，只能靠会话归属） */
  function setsOfSessions(store, memberId, sessions) {
    var ids = {};
    (sessions || []).forEach(function (s) { ids[s.session_id] = 1; });
    return store.all('m_sets').filter(function (r) { return ids[r.session_id]; });
  }

  /** 某会员所有已完成会话（按日期升序） */
  function completedSessions(store, memberId) {
    return myRows(store, memberId, 'm_sessions')
      .filter(function (s) { return s.status === 'completed'; })
      .sort(function (a, b) { return String(a.session_date).localeCompare(String(b.session_date)); });
  }

  /** 某周的 sessions（含未完成的），取不到 XP 时返回空 */
  function sessionsInWeek(store, memberId, weekStart) {
    var end = addDays(weekStart, 6);
    return myRows(store, memberId, 'm_sessions').filter(function (s) {
      var d = String(s.session_date).slice(0, 10);
      return d >= weekStart && d <= end;
    });
  }

  /** 某周训练数据的 RPE 均值：表里有 rpe 但业务从没读过，这里是第一处正式启用 */
  function weekRpe(store, memberId, weekStart) {
    var sum = 0, n = 0;
    var sess = sessionsInWeek(store, memberId, weekStart);
    setsOfSessions(store, memberId, sess).forEach(function (r) {
      var v = intOr(r.rpe, 0);
      if (v > 0) { sum += v; n++; }
    });
    return { avg: n ? round1(sum / n) : 0, count: n };
  }

  /** 某周的组数 */
  function weekSetCount(store, memberId, weekStart) {
    return setsOfSessions(store, memberId, sessionsInWeek(store, memberId, weekStart)).length;
  }

  /** 某周自己排的目标次数（取该周所有非教练锁定计划里的最大值） */
  function weekTargetCount(store, memberId, weekStart) {
    var max = 0;
    myRows(store, memberId, 'm_plans').forEach(function (p) {
      if (String(p.week_start) !== weekStart) return;
      if (p.coach_confirmed === 'Y') return;
      max = Math.max(max, intOr(p.week_target_count, 0));
    });
    return max;
  }

  /** 本周有疼痛反馈？只看会话级 feeling，没有部位数据 → 只提示，不诊断 */
  function recentPain(store, memberId, today, windowDays) {
    var from = addDays(today, -windowDays);
    var hits = completedSessions(store, memberId).filter(function (s) {
      return String(s.session_date) >= from && s.feeling === 'pain';
    });
    return hits;
  }

  /** 人群判定：唯一口径来自 XP.playerType，EXPLORE 只是包了一层，这里再包一层不新增语义 */
  function playerTypeOf(store, memberId, opt) {
    if (EXPLORE && typeof EXPLORE.playerTypeOf === 'function') {
      return EXPLORE.playerTypeOf(store, memberId, opt);
    }
    if (XP && typeof XP.playerType === 'function') return XP.playerType(store, memberId, opt);
    return 'beginner';
  }

  /* ================================================================ 建议 · 读数据阶段 */

  /**
   * 某周「还没练」的计划项。
   * 本周只算今天之后的日子（今天已经练过的部分不该被改写），未来的整周全部算。
   */
  function futureItems(store, memberId, weekStart, todayPlanDay, opt) {
    var today = todayOf(opt);
    var thisWeek = monday(today);
    var plans = myRows(store, memberId, 'm_plans').filter(function (p) {
      return String(p.week_start) === weekStart && p.coach_confirmed !== 'Y';
    });
    var items = planItemsOf(store, memberId, plans.map(function (p) { return p.plan_id; }));
    var out = [];
    plans.forEach(function (p) {
      var list = items.filter(function (it) {
        if (it.plan_id !== p.plan_id) return false;
        /* 本周：只保留还没到的日子，今天及以前的不动（那是已经发生过的事）。 */
        if (weekStart === thisWeek) return intOr(it.day_of_week, 0) > todayPlanDay;
        return true;
      });
      if (list.length) out.push({ plan: p, items: list });
    });
    return out;
  }

  /** 找一个「有地方可以落地」的周：优先下一周，其次本周剩余日子 */
  function pickCapacityWeek(store, memberId, thisWeek, nextWeek, todayPlanDay, opt) {
    var candidates = [nextWeek, thisWeek];
    for (var i = 0; i < candidates.length; i++) {
      if (futureItems(store, memberId, candidates[i], todayPlanDay, opt).length) return candidates[i];
    }
    return '';
  }

  /** 找一个「还没有任何计划」的未来周（给新手引导用） */
  function pickEmptyWeek(store, memberId, weeks) {
    for (var i = 0; i < weeks.length; i++) {
      var has = myRows(store, memberId, 'm_plans').some(function (p) {
        return String(p.week_start) === weeks[i];
      });
      if (!has) return weeks[i];
    }
    return '';
  }

  /* ================================================================ 建议 · 规则 */

  function rulePlain(code) {
    return {
      ADJ_PAIN_NOTE: '最近有疼痛反馈',
      ADJ_BEGINNER_START: '还没为本周排出计划',
      ADJ_STREAK_BREAK: '连续中断',
      ADJ_LOW_RATE: '上周完成率偏低',
      ADJ_READY_UP: '连续达标且强度不高'
    }[code] || code;
  }

  function sug(base) {
    return {
      code: base.code,
      adjust_type: base.adjust_type,
      target_type: 'week',
      target_id: base.week,
      week: base.week,
      title: base.title,
      reason: base.reason,
      evidence: base.evidence || [],
      effect: base.effect,
      plan: base.plan || null,
      rule_version: ADJ_RULE_VERSION,
      player_type: base.player_type || ''
    };
  }

  function evalRules(store, memberId, ctxData, opt) {
    var out = [];
    var today = ctxData.today;
    var thisWeek = ctxData.thisWeek;
    var nextWeek = ctxData.nextWeek;
    var prevWeek = ctxData.prevWeek;
    var prevPrev = ctxData.prevPrev;

    /* ---- 疼痛：只提示，永远不改计划 ---- */
    var pains = recentPain(store, memberId, today, PAIN_WINDOW_DAYS);
    if (pains.length) {
      out.push(sug({
        code: 'ADJ_PAIN_NOTE', adjust_type: 'rest', week: thisWeek,
        title: '先照顾恢复，这周别硬撑',
        reason: '近 ' + PAIN_WINDOW_DAYS + ' 天里有 ' + pains.length + ' 次训练你勾选了「有疼痛或不适」。'
          + '这不是成绩问题，身体先恢复好，比多练一次更重要。',
        evidence: [{ label: '疼痛反馈次数', value: pains.length + ' 次' },
          { label: '最近一次', value: String(pains[pains.length - 1].session_date).slice(0, 10) }],
        effect: '不改动任何计划。若疼痛持续或加重，请停止训练并咨询医生或教练。',
        plan: { type: 'none' }
      }));
    }

    /* ---- 新手引导：本周/下一周还是空的，给一条「一键排计划」---- */
    if (ctxData.playerType === 'beginner') {
      var emptyWeek = pickEmptyWeek(store, memberId, [thisWeek, nextWeek]);
      var hasPublished = myRows(store, memberId, 'm_plans').some(function (p) {
        return p.status === 'published';
      });
      if (emptyWeek && !hasPublished) {
        out.push(sug({
          code: 'ADJ_BEGINNER_START', adjust_type: 'frequency', week: emptyWeek,
          title: '帮你排一周的新手训练',
          reason: '你是刚开始练的阶段，而这一周目前还没有任何安排。'
            + '按档案里填的「每周可练几天 / 每次多少分钟 / 有什么器械」，可以直接生成一份能照着做的周计划。',
          evidence: [{ label: '目标周', value: emptyWeek + ' 起' },
            { label: '适用人群', value: '刚开始练' }],
          effect: '生成一份草稿计划。生成后随时可以改，也可以整周删掉重来。',
          plan: { type: 'newbie_plan', week: emptyWeek }
        }));
      }
    }

    /* ---- 断档：连续中断 ≥2 天 ---- */
    var st = store.find('m_streaks', memberId) || {};
    var last = String(st.last_train_date || '').slice(0, 10);
    if (last && dayDiff(last, today) >= 2) {
      var gap = dayDiff(last, today);
      out.push(sug({
        code: 'ADJ_STREAK_BREAK', adjust_type: 'rest', week: thisWeek,
        title: '断了 ' + gap + ' 天，这周目标降一点更容易接上',
        reason: '上次训练是 ' + last + '，到今天已经 ' + gap + ' 天。'
          + '中断后再开始，最难的其实是「重新开始那一下」——把目标调低一点，先接上节奏。',
        evidence: [{ label: '距上次训练', value: gap + ' 天' },
          { label: '当前连续', value: intOr(st.active_days_streak, 0) + ' 天' }],
        effect: '把目标周次数下调 1 次（不会低于 1 次）。你已经练过的部分完全不受影响。',
        plan: { type: 'shorten', delta: -1 }
      }));
    }

    /* ---- 完成率低：降容量 ---- */
    var pw = XP ? XP.weeklyStats(store, memberId, prevWeek, opt) : null;
    if (pw && pw.planRate > 0 && pw.planRate < 60) {
      var capWeek = pickCapacityWeek(store, memberId, thisWeek, nextWeek, ctxData.todayPlanDay, opt);
      if (capWeek) {
        out.push(sug({
          code: 'ADJ_LOW_RATE', adjust_type: 'volume', week: capWeek,
          title: '上一周没练满，把这一周的容量降一点',
          reason: '上一周（' + prevWeek + ' 起）计划的组数只完成了 ' + pw.planRate + '%。'
            + '与其每周排满却做不完，不如排得轻松些、按时完成。',
          evidence: [{ label: '上周完成率', value: pw.planRate + '%' },
            { label: '上周完成训练', value: pw.completedCount + ' 次' },
            { label: '作用周', value: capWeek + ' 起' }],
          effect: '把该周还没练的动作每组目标组数 −1（不会低于 ' + SETS_MIN + ' 组）。已练过的不改。',
          plan: { type: 'capacity', delta: -1, min: SETS_MIN, max: SETS_MAX, week: capWeek }
        }));
      }
    }

    /* ---- 连续达标且强度不高：小幅提升 ---- */
    var pw2 = XP ? XP.weeklyStats(store, memberId, prevPrev, opt) : null;
    var rpe1 = weekRpe(store, memberId, prevWeek);
    var goal1 = weekTargetCount(store, memberId, prevWeek) || (pw ? pw.frequencyGoal : 0);
    var goal0 = weekTargetCount(store, memberId, prevPrev) || (pw2 ? pw2.frequencyGoal : 0);
    var ok1 = pw && goal1 > 0 && pw.completedCount >= goal1;
    var ok0 = pw2 && goal0 > 0 && pw2.completedCount >= goal0;
    if (ok1 && ok0 && rpe1.count > 0 && rpe1.avg <= 7) {
      var upWeek = pickCapacityWeek(store, memberId, thisWeek, nextWeek, ctxData.todayPlanDay, opt);
      if (upWeek) {
        out.push(sug({
          code: 'ADJ_READY_UP', adjust_type: 'intensity', week: upWeek,
          title: '连续两周都练满了，可以小幅加一点',
          reason: '前两周都达成了各自的周目标，且上一周平均主观强度只有 ' + rpe1.avg + '/10'
            + '（' + rpe1.count + ' 组有记录），说明还有余量。小步加量比一次加满更容易保住节奏。',
          evidence: [{ label: '上周完成', value: pw.completedCount + ' / ' + goal1 + ' 次' },
            { label: '上上周完成', value: pw2.completedCount + ' / ' + goal0 + ' 次' },
            { label: '上周平均强度', value: rpe1.avg + '/10' }],
          effect: '把该周还没练的动作每组目标组数 +1（不会超过 ' + SETS_MAX + ' 组）。已练过的不改。',
          plan: { type: 'capacity', delta: 1, min: SETS_MIN, max: SETS_MAX, week: upWeek }
        }));
      }
    }

    return out;
  }

  /* ================================================================ 建议 · 出口 */

  /**
   * suggest(store, memberId, opt) —— 给成长中心 / 计划页用的可解释建议。
   *
   * **纯读，不写库**：你可以在 render() 里随便调，它不会留下任何痕迹。
   *
   * @returns {{ok:true, weekAnchor, thisWeek, nextWeek, playerType, suggestions:Array,
   *            insufficient:boolean, why:string}}
   */
  function suggest(store, memberId, opt) {
    opt = opt || {};
    if (badStore(store)) return fail('bad_store', 'store 无效：请传入 memberStore.createStore() 返回的实例');
    if (!memberId) return fail('no_actor', '缺少会员ID');
    if (noSchema()) return fail('no_schema', '契约层 memberSchema 未就绪');

    var today = todayOf(opt);
    var thisWeek = monday(today);
    var nextWeek = addDays(thisWeek, 7);
    var prevWeek = addDays(thisWeek, -7);
    var prevPrev = addDays(thisWeek, -14);
    var type = playerTypeOf(store, memberId, opt);

    var ctxData = {
      today: today, thisWeek: thisWeek, nextWeek: nextWeek,
      prevWeek: prevWeek, prevPrev: prevPrev,
      todayPlanDay: planDayOf(today, thisWeek),
      playerType: type
    };

    var all = evalRules(store, memberId, ctxData, opt);
    all.sort(function (a, b) {
      return orderOf(a.code) - orderOf(b.code);
    });

    /* 幂等：同一周同一规则已决的不重复提。先在已有行里查，绝不能靠库挡。 */
    var rows = adjRows(store, memberId);
    function decisionOf(s) {
      var hit = rows.filter(function (r) {
        return r.target_type === 'week' && String(r.target_id) === s.target_id
          && r.reason_code === s.code && r.decision;
      });
      return hit.length ? hit[hit.length - 1] : null;
    }
    function suggestedOf(s) {
      return rows.filter(function (r) {
        return r.target_type === 'week' && String(r.target_id) === s.target_id
          && r.reason_code === s.code && r.decision === 'suggested';
      })[0] || null;
    }

    var suggestions = all.filter(function (s) { return !decisionOf(s); })
      .slice(0, intOr(opt.max, 2));

    suggestions.forEach(function (s) {
      var exist = suggestedOf(s);
      s.adjustment_id = exist ? exist.adjustment_id : '';
      s.decided = null;
      s.has_suggest_row = !!exist;
    });

    /* 样本不足：一条都提不出来，且确实没什么可执行的数据时才这么说。
       注意：疼痛与新手引导不属于"需要先有数据"的建议，它们能出来就说明有依据。 */
    var insufficient = suggestions.length === 0;
    var why = '';
    if (insufficient) {
      var total = completedSessions(store, memberId).length;
      if (all.length && all.every(function (s) { return !!decisionOf(s); })) {
        why = '这一周的建议已经处理过了，下周再算新的。';
      } else if (total === 0) {
        why = '还没有训练记录。练过一两次之后，这里会根据你的完成情况给建议。';
      } else {
        why = '样本不足，暂不建议：数据还不够判断该怎么调（需要至少一周带计划的训练记录）。';
      }
    }

    return {
      ok: true,
      weekAnchor: thisWeek,
      thisWeek: thisWeek,
      nextWeek: nextWeek,
      prevWeek: prevWeek,
      playerType: type,
      suggestions: suggestions,
      insufficient: insufficient,
      why: why,
      rule_version: ADJ_RULE_VERSION
    };
  }

  function orderOf(code) {
    for (var i = 0; i < ADJ_RULES.length; i++) {
      if (ADJ_RULES[i].code === code) return ADJ_RULES[i].order;
    }
    return 99;
  }

  /* ================================================================ 写：建议行与决策行 */

  function insertRow(store, memberId, data, now) {
    var id = store.nextId('m_adjustments');
    if (!id) return { ok: false, reason: 'id_exhausted', errors: ['调整记录 ID 已用尽（AJ9999）'] };
    var res = store.insert('m_adjustments', {
      adjustment_id: id,
      member_id: memberId,
      target_type: data.target_type || 'week',
      target_id: String(data.target_id || '').slice(0, 20),
      adjust_type: data.adjust_type || 'volume',
      before_value: String(data.before_value == null ? '' : data.before_value).slice(0, 100),
      after_value: String(data.after_value == null ? '' : data.after_value).slice(0, 100),
      reason_code: String(data.reason_code || '').slice(0, 40),
      reason_text: String(data.reason_text || '').slice(0, 200),
      applied_by: data.applied_by || 'member',
      decision: data.decision || 'suggested',
      decided_at: data.decision && data.decision !== 'suggested' ? (data.decided_at || now) : '',
      rule_version: data.rule_version || ADJ_RULE_VERSION,
      created_at: now
    }, { actor: memberId });
    if (!res.ok) return { ok: false, reason: res.reason || 'insert_failed', errors: res.errors || [] };
    return { ok: true, row: res.row };
  }

  /** 找到（必要时补建）一条建议行 */
  function ensureSuggestRow(store, memberId, s, now) {
    if (s.adjustment_id) return store.find('m_adjustments', s.adjustment_id);
    var rows = adjRows(store, memberId).filter(function (r) {
      return r.target_type === 'week' && String(r.target_id) === s.target_id
        && r.reason_code === s.code && r.decision === 'suggested';
    });
    if (rows.length) return rows[0];
    var w = insertRow(store, memberId, {
      target_type: 'week', target_id: s.target_id, adjust_type: s.adjust_type,
      before_value: '', after_value: describe(s),
      reason_code: s.code, reason_text: (s.title || '') + ' —— ' + (s.reason || ''),
      applied_by: 'system', decision: 'suggested', rule_version: s.rule_version
    }, now);
    return w.ok ? w.row : null;
  }

  function describe(s) {
    if (!s.plan) return '';
    if (s.plan.type === 'capacity') return '目标组数 ' + (s.plan.delta > 0 ? '+' : '') + s.plan.delta;
    if (s.plan.type === 'shorten') return '周目标次数 ' + s.plan.delta;
    if (s.plan.type === 'newbie_plan') return '生成周计划草稿';
    return '仅提示，不改计划';
  }

  /* ================================================================ 落地：改未来计划 */

  /**
   * applyPlan(store, memberId, s, opt) —— 按建议改**未来的**计划项 / 周目标次数。
   *
   * 硬边界：
   *   - 只碰 `m_plan_items.target_sets` 与 `m_plans.week_target_count`；
   *   - `coach_confirmed='Y'` 的计划由 `PLAN.planGuard` 直接挡下，走进 skipped 而不是报错；
   *   - 一行 m_sessions / m_sets 都不写。
   *
   * @returns {{changed:Array, skipped:Array, blocked:boolean}}
   */
  function applyPlan(store, memberId, s, opt) {
    var changed = [], skipped = [];
    if (!s || !s.plan || s.plan.type === 'none') return { changed: changed, skipped: skipped, blocked: false };

    var today = todayOf(opt);
    var thisWeek = monday(today);
    var day = planDayOf(today, thisWeek);

    if (s.plan.type === 'newbie_plan') {
      var r = PLAN.createWeekPlan(store, memberId, null, null, {
        weekStart: s.plan.week || s.week, source: 'member', note: '新手引导：按档案自动生成'
      });
      if (!r.ok) {
        skipped.push({ target: 'm_plans', reason: r.reason || 'create_failed' });
        return { changed: changed, skipped: skipped, blocked: true };
      }
      changed.push({ plan_id: r.plan_id || '', kind: 'created', before: '', after: 'draft' });
      if (r.plan_id) {
        var pub = PLAN.publishPlan(store, memberId, r.plan_id, opt);
        if (!pub.ok) skipped.push({ target: r.plan_id, reason: pub.reason || 'publish_failed' });
      }
      return { changed: changed, skipped: skipped, blocked: false };
    }

    var targets = futureItems(store, memberId, s.week, day, opt);
    if (!targets.length) {
      skipped.push({ target: s.week, reason: 'no_future_items', message: '这一周没有可以改的未来计划项' });
      return { changed: changed, skipped: skipped, blocked: true };
    }

    if (s.plan.type === 'shorten') {
      targets.forEach(function (t) {
        var cur = intOr(t.plan.week_target_count, 0);
        if (!cur) return;
        var next = Math.max(1, cur + intOr(s.plan.delta, -1));
        if (next === cur) return;
        var res = store.update('m_plans', t.plan.plan_id,
          { week_target_count: next, updated_at: nowOf(opt) }, { actor: memberId });
        if (res.ok) changed.push({ plan_id: t.plan.plan_id, kind: 'week_target_count', before: cur, after: next });
        else skipped.push({ target: t.plan.plan_id, reason: res.reason || 'update_failed' });
      });
      return { changed: changed, skipped: skipped, blocked: changed.length === 0 };
    }

    /* capacity：逐项改目标组数。log:false 是为了避免再落一条 member_edit 流水——
       本条决策自己就是最完整的记录，同一件事写两行只会让复盘变难。 */
    targets.forEach(function (t) {
      t.items.forEach(function (it) {
        var cur = intOr(it.target_sets, 0);
        if (!cur) return;
        var next = Math.max(intOr(s.plan.min, SETS_MIN), Math.min(intOr(s.plan.max, SETS_MAX), cur + intOr(s.plan.delta, 0)));
        if (next === cur) return;
        var res = PLAN.updatePlanItem(store, memberId, it.plan_item_id, { target_sets: next }, { log: false });
        if (res.ok) {
          changed.push({ plan_item_id: it.plan_item_id, kind: 'target_sets', before: cur, after: next });
        } else {
          skipped.push({ target: it.plan_item_id, reason: res.reason || 'update_failed' });
        }
      });
    });

    return { changed: changed, skipped: skipped, blocked: changed.length === 0 && skipped.length > 0 };
  }

  /** 回滚：把 applyPlan 改过的东西改回原值 */
  function rollbackPlan(store, memberId, changed, opt) {
    (changed || []).forEach(function (c) {
      if (c.kind === 'week_target_count') {
        store.update('m_plans', c.plan_id,
          { week_target_count: c.before, updated_at: nowOf(opt) }, { actor: memberId });
      } else if (c.kind === 'target_sets') {
        PLAN.updatePlanItem(store, memberId, c.plan_item_id, { target_sets: c.before }, { log: false });
      }
      /* created 的计划回滚成本高于收益：草稿不会自动进今天的任务，留着无害且可解释 */
    });
  }

  /* ================================================================ 决策 · 出口 */

  /**
   * decide(store, memberId, code, decision, opt)
   *
   * decision ∈ accepted | rejected | modified。
   * - rejected：**只留痕，绝不动计划**；
   * - accepted：按建议原样落地；
   * - modified：按 `opt.override`（如 {field:'target_sets', value:4}）落地，并必须给原因。
   *
   * 失败口径沿用 goal.js 的严格版本：**决策行写不进去就把已改的计划改回去**，
   * 避免「计划变了但没人知道为什么」。
   *
   * @returns {{ok:true, decision, changed, skipped, blocked, adjustment_id}}
   */
  function decide(store, memberId, code, decision, opt) {
    opt = opt || {};
    if (badStore(store)) return fail('bad_store', 'store 无效：请传入 memberStore.createStore() 返回的实例');
    if (!memberId) return fail('no_actor', '缺少会员ID');
    if (noSchema()) return fail('no_schema', '契约层 memberSchema 未就绪');
    if (['accepted', 'rejected', 'modified'].indexOf(decision) < 0) {
      return fail('bad_decision', '决策只能是 accepted / rejected / modified');
    }

    var now = nowOf(opt);
    var sg = suggest(store, memberId, opt);
    if (!sg.ok) return sg;

    var target = sg.suggestions.filter(function (s) { return s.code === code; })[0];
    if (!target) {
      /* 建议已经被处理过（suggest 的返回里不会再有它）：允许把决策补写到既有建议行上，
         但**同样的决策不能提交两次**。
         坑：这里必须扫该 code 的**全部行**再去比对 decision——
         只在 decision==='suggested' 的子集里找，永远找不到已存在的决策，
         重复提交就会悄悄通过（幂等断言曾因此失败）。 */
      var rows = adjRows(store, memberId).filter(function (r) { return r.reason_code === code; });
      var sugRow = rows.filter(function (r) { return r.decision === 'suggested'; })[0];
      if (!sugRow) return fail('no_suggestion', '没有找到这条建议：' + code);
      if (rows.some(function (r) { return r.decision === decision; }) && opt.repeat !== true) {
        return fail('already_decided', '这条建议已经有同样的决策了：' + code + '/' + decision);
      }
      target = {
        code: code, adjust_type: rows[0].adjust_type, week: String(rows[0].target_id),
        target_id: String(rows[0].target_id), title: '', reason: '', plan: null,
        has_suggest_row: true, adjustment_id: rows[0].adjustment_id
      };
    }

    if (decision === 'modified') {
      if (!opt.reason) return fail('need_reason', '手动调整必须填写原因（opt.reason）');
      if (!isObj(opt.override)) return fail('need_override', '手动调整必须给出改成了什么（opt.override）');
      target.plan = copyPlanDef(target.plan);
      if (opt.override.target_sets !== undefined) {
        target.plan = {
          type: 'capacity', delta: 0, min: SETS_MIN, max: SETS_MAX,
          week: target.week, absolute: intOr(opt.override.target_sets, 0)
        };
      }
    }

    ensureSuggestRow(store, memberId, target, now);

    var changed = [], skipped = [], blocked = false;
    if (decision !== 'rejected') {
      var applied = applyPlan(store, memberId, target, opt);
      changed = applied.changed;
      skipped = applied.skipped;
      blocked = applied.blocked;
    }

    var after = describe(target);
    if (blocked) after = 'blocked:' + ((skipped[0] || {}).reason || 'unknown');
    if (decision === 'modified') after = '手动：' + (after || opt.reason || '');

    var row = insertRow(store, memberId, {
      target_type: 'week', target_id: target.target_id, adjust_type: target.adjust_type,
      before_value: '', after_value: after,
      reason_code: code,
      reason_text: decisionText(decision, target, opt),
      applied_by: decision === 'modified' ? 'member' : 'member',
      decision: decision, decided_at: now, rule_version: target.rule_version || ADJ_RULE_VERSION
    }, now);

    if (!row.ok) {
      rollbackPlan(store, memberId, changed, opt);
      return {
        ok: false, reason: 'adjust_log_failed',
        errors: ['计划已改回原值：调整留痕写入失败（' + (row.reason || '未知') + '）'].concat(row.errors || [])
      };
    }

    return {
      ok: true, decision: decision, code: code, week: target.week,
      adjustment_id: row.row.adjustment_id,
      changed: changed, skipped: skipped, blocked: blocked
    };
  }

  function copyPlanDef(p) { return p ? JSON.parse(JSON.stringify(p)) : null; }

  function decisionText(decision, target, opt) {
    var head = decision === 'accepted' ? '会员接受建议' : (decision === 'rejected' ? '会员拒绝建议' : '会员手动调整后接受');
    return head + '：' + (target.title || target.code)
      + (opt && opt.reason ? '（原因：' + String(opt.reason).slice(0, 120) + '）' : '');
  }

  /** decisionHistory(store, memberId, opt) —— 给时间线与复盘用，倒序 */
  function decisionHistory(store, memberId, opt) {
    opt = opt || {};
    if (badStore(store)) return [];
    return adjRows(store, memberId)
      .filter(function (r) { return !!r.decision && r.decision !== 'suggested'; })
      .sort(function (a, b) { return String(b.decided_at || b.created_at).localeCompare(String(a.decided_at || a.created_at)); })
      .slice(0, intOr(opt.limit, 50));
  }

  /* ================================================================ 「本周为什么慢」 */

  /**
   * whySlow(store, memberId, opt) —— 只在**真的落后**时才给结论，没依据就整卡不显示。
   *
   * 触发：本周有排计划（有依据判断"落后"） && 已过周三（周中有资格说话）
   *       && 完成次数 < 目标次数的一半。
   * 文案原则：描述事实，不评价人。**绝不做医疗诊断**。
   */
  function whySlow(store, memberId, opt) {
    opt = opt || {};
    if (badStore(store) || !memberId) return { ok: true, show: false, reasons: [], rule_version: WHY_RULE_VERSION };

    var today = todayOf(opt);
    var thisWeek = monday(today);
    var dayIdx = dayDiff(thisWeek, today);            /* 0=周一 … 6=周日 */
    var type = playerTypeOf(store, memberId, opt);
    var goal = weekTargetCount(store, memberId, thisWeek);
    var hasPlan = myRows(store, memberId, 'm_plans').some(function (p) {
      return String(p.week_start) === thisWeek;
    });
    var w = XP ? XP.weeklyStats(store, memberId, thisWeek, opt) : null;
    var done = w ? w.completedCount : 0;

    if (!hasPlan || goal <= 0 || dayIdx < 2) {
      return { ok: true, show: false, reasons: [], done: done, goal: goal, playerType: type, rule_version: WHY_RULE_VERSION };
    }
    if (done / goal >= 0.5) {
      return { ok: true, show: false, reasons: [], done: done, goal: goal, playerType: type, rule_version: WHY_RULE_VERSION };
    }

    /* 两个「还不配说话」的门槛。缺了它们，会出现这两种荒唐场面：
       (a) 会员今天刚注册、今天刚排好本周计划，立刻被指责「本周落后」；
       (b) 一次都没练过的人被说「进度慢」——那不是落后，那是还没开始。
       所以：得有历史训练记录，且本周计划至少排了两天了，才有资格谈"落后"。 */
    if (!completedSessions(store, memberId).length) {
      return { ok: true, show: false, reasons: [], done: done, goal: goal, playerType: type,
        rule_version: WHY_RULE_VERSION, silent: 'no_history' };
    }
    var oldest = '';
    myRows(store, memberId, 'm_plans').forEach(function (p) {
      if (String(p.week_start) !== thisWeek) return;
      var d = String(p.created_at || '').slice(0, 10);
      if (d && (!oldest || d < oldest)) oldest = d;
    });
    if (oldest && dayDiff(oldest, today) < 2) {
      return { ok: true, show: false, reasons: [], done: done, goal: goal, playerType: type,
        rule_version: WHY_RULE_VERSION, silent: 'plan_too_new' };
    }

    var reasons = [];

    reasons.push('本周排了 ' + goal + ' 次，目前完成 ' + done + ' 次'
      + '（已完成 ' + Math.round(done / goal * 100) + '%）。');

    /* 组数没做满：本周计划完成率不足 80% 时补一条说明 */
    var weakDays = 0;
    if (w && w.planRate > 0 && w.planRate < 80) {
      weakDays = Math.max(0, done);
      reasons.push('已完成的训练里，计划的组数平均只做到 ' + w.planRate + '%，说明每次都在「练到一半」上收尾。');
    }

    var st = store.find('m_streaks', memberId) || {};
    var last = String(st.last_train_date || '').slice(0, 10);
    if (last) {
      var gap = dayDiff(last, today);
      if (gap >= 2) reasons.push('最近一次训练是 ' + last + '，到今天已经断了 ' + gap + ' 天。');
    }

    /* 每日任务完成情况（m_challenges daily） */
    var days = [];
    for (var i = 0; i <= 6; i++) {
      var d = addDays(thisWeek, i);
      if (dayDiff(d, today) < 0) days.push(d);
    }
    if (days.length) {
      var ch = myRows(store, memberId, 'm_challenges').filter(function (c) {
        return c.period_type === 'daily' && days.indexOf(String(c.period_key)) >= 0;
      });
      if (ch.length) {
        var doneTasks = ch.filter(function (c) { return String(c.status) === 'done' || String(c.status) === 'completed'; }).length;
        reasons.push('本周每日任务完成 ' + doneTasks + ' / ' + ch.length + ' 个。');
      }
    }

    var action = type === 'beginner'
      ? { label: '今天做一次短一点的训练', href: '#quick' }
      : { label: '用灵感卡安排一次短训练', href: '#home' };

    return {
      ok: true, show: true, head: '本周进度落后一点，原因是这几条', done: done, goal: goal,
      playerType: type, week: thisWeek, reasons: reasons.slice(0, 3), action: action,
      rule_version: WHY_RULE_VERSION
    };
  }

  /* ================================================================ 成长时间线（只读合并） */

  /**
   * timeline(store, memberId, opt) —— 把已经落地的四类事实合并成一条时间线。
   *
   * **刻意不再往 m_timeline 里写一行**：探索解锁已经在 m_unlocks 里（带 biz_key、tier、时间），
   * 计划调整已经在 m_adjustments 里（带决策与规则版本），再写一份就是同一个事实存两处，
   * 将来必然对不上。这里只做读、合并、排序。
   *
   * opt.kinds 可筛选：['record','achv','level','explore','adjust','streak','week']
   */
  function timeline(store, memberId, opt) {
    opt = opt || {};
    if (badStore(store)) return [];
    var limit = intOr(opt.limit, 50);
    var kinds = opt.kinds || null;
    var out = [];

    /* 1. m_timeline：升级 / 成就 / 纪录 / 周目标 */
    myRows(store, memberId, 'm_timeline').forEach(function (t) {
      out.push({
        kind: ({
          level_up: 'level', achievement: 'achv', record: 'record',
          week_target: 'week', streak: 'streak', goal_milestone: 'goal'
        })[t.event_type] || 'other',
        at: String(t.occurred_at || ''),
        title: String(t.title || ''),
        detail: String(t.detail || ''),
        ref_id: String(t.ref_id || ''),
        ref_type: 'm_timeline'
      });
    });

    /* 2. m_unlocks：探索解锁（code 以 explore: 开头） */
    myRows(store, memberId, 'm_unlocks').forEach(function (u) {
      var code = String(u.achievement_code || '');
      if (code.indexOf('explore:') !== 0) return;
      out.push({
        kind: 'explore',
        at: String(u.unlocked_at || ''),
        title: '探索解锁：' + exploreLabel(code),
        detail: u.progress_snapshot ? String(u.progress_snapshot).slice(0, 120) : '',
        ref_id: String(u.unlock_id || ''),
        ref_type: 'm_unlocks'
      });
    });

    /* 3. m_adjustments：接受 / 拒绝 / 手动调整 */
    myRows(store, memberId, 'm_adjustments').forEach(function (a) {
      if (!a.decision || a.decision === 'suggested') return;
      out.push({
        kind: 'adjust',
        at: String(a.decided_at || a.created_at || ''),
        title: ({
          accepted: '接受调整建议', rejected: '跳过这条建议', modified: '手动调整'
        })[a.decision] || '调整',
        detail: String(a.reason_text || '').slice(0, 140),
        ref_id: String(a.adjustment_id || ''),
        ref_type: 'm_adjustments',
        decision: String(a.decision || ''),
        rule_version: String(a.rule_version || '')
      });
    });

    /* 4. m_streaks：连续里程碑（派生，不带created_at，用最后训练日期近似） */
    var st = store.find('m_streaks', memberId) || {};
    var best = intOr(st.best_days_streak, 0);
    if (best > 0) {
      STREAK_MILESTONES.filter(function (m) { return best >= m; }).forEach(function (m) {
        out.push({
          kind: 'streak',
          at: String(st.last_train_date || '').slice(0, 10),
          title: '连续训练达到 ' + m + ' 天',
          detail: '最长连续 ' + best + ' 天（里程碑日期按最后训练日近似）',
          ref_id: '', ref_type: 'm_streaks', approximate: true
        });
      });
    }

    out = out.filter(function (e) {
      if (e.kind === 'streak' && hasRealStreakRows(store, memberId)) return true;
      return !kinds || kinds.indexOf(e.kind) >= 0;
    });

    out.sort(function (a, b) {
      if (a.at === b.at) return a.title < b.title ? 1 : -1;
      return a.at < b.at ? 1 : -1;
    });
    return out.slice(0, limit);
  }

  /** m_timeline 里如果有真正的 streak 行，就用它们、别再派生一份 */
  function hasRealStreakRows(store, memberId) {
    return myRows(store, memberId, 'm_timeline').some(function (t) { return t.event_type === 'streak'; });
  }

  function exploreLabel(code) {
    var p = String(code).split(':');
    if (p.length < 3) return code;
    var dim = ({ muscle: '肌群', pattern: '动作模式', difficulty: '难度' })[p[1]] || p[1];
    if (EXPLORE && EXPLORE.PATTERN_LABEL && p[2]) {
      return dim + ' · ' + (EXPLORE.PATTERN_LABEL[p[2]] || p[2]);
    }
    return dim + ' · ' + p[2];
  }

  /* ================================================================ 趋势（老炮视角） */

  /**
   * trend(store, memberId, opt) —— 近 N 周的容量 / 强度趋势，全部由既有流水派生。
   * 不落成任何新事实，只给「读数」。
   */
  function trend(store, memberId, opt) {
    opt = opt || {};
    if (badStore(store) || !memberId || !XP) return [];
    var today = todayOf(opt);
    var thisWeek = monday(today);
    var weeks = intOr(opt.weeks, 8);
    var out = [];
    for (var i = weeks - 1; i >= 0; i--) {
      var ws = addDays(thisWeek, -7 * i);
      var s = XP.weeklyStats(store, memberId, ws, opt);
      var rpe = weekRpe(store, memberId, ws);
      out.push({
        week_start: ws,
        completed: s.completedCount,
        volume: s.volume,
        sets: weekSetCount(store, memberId, ws),
        plan_rate: s.planRate,
        rpe_avg: rpe.avg,
        rpe_count: rpe.count,
        pr_count: s.prCount
      });
    }
    return out;
  }

  /* ================================================================ 导出 */

  return {
    ADJ_RULE_VERSION: ADJ_RULE_VERSION,
    WHY_RULE_VERSION: WHY_RULE_VERSION,
    ADJ_RULES: ADJ_RULES,
    STREAK_MILESTONES: STREAK_MILESTONES,
    SETS_MIN: SETS_MIN,
    SETS_MAX: SETS_MAX,

    suggest: suggest,
    decide: decide,
    decisionHistory: decisionHistory,

    whySlow: whySlow,
    timeline: timeline,
    trend: trend,
    playerTypeOf: playerTypeOf,

    /* 这些本来是内部函数，导出来是为了让测试能直接验证「该改的改了、不该改的一个没碰」 */
    _utils: {
      futureItems: futureItems,
      weekRpe: weekRpe,
      weekTargetCount: weekTargetCount,
      dayDiff: dayDiff,
      planDayOf: planDayOf
    }
  };
});
