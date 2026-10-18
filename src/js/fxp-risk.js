/* Fitness XP V1 — 会员风险评分引擎（今日优先处理模块核心；UMD）
 * 依据：产品任务书「Fitness XP V1：首页今日优先处理模块 V1.0」第三节
 *       + 「Fitness XP V1.1 产品优化与增量开发任务书」第五节（风险判断优化）
 * 设计原则：
 *   1) 阈值集中：所有阈值/权重/等级均集中在 RISK_CONFIG，页面组件不得硬编码；
 *   2) 确定性规则：纯计算，不依赖任何外部付费 AI 服务；
 *   3) 可解释：每个命中信号产出 reason（代码 + 分值 + 说明），分数 = 各信号分值和（封顶 100）；
 *   4) 数据缺失 != 无训练：会员无任何训练记录 → insufficient，不参与"到店/频率"信号（避免误判）；
 *   5) 暂停/休假会员：状态排除（excludeStatuses）+ 暂停期（pause_start_date/pause_end_date）双重保护，
 *      期内不因长期无训练判高风险；
 *   6) 到店阈值个性化：有 planned_per_week 时按计划频率推导容忍天数，不再对所有会员用固定 7/14 天；
 *   7) 预约未到期不算缺席：next_appointment_date 在未来 → 明确标注"尚未到期"，绝不判缺席；
 *   8) 数据不完整可标记：data_incomplete=Y → 长期无训练等信号降级为提示，不误判；
 *   9) 恢复训练后重算：本模块为纯函数，每次调用都按当前训练记录重新计算。
 *
 * 术语约束（任务书第五节第 7 条）：本模块输出的是「关注等级 / 风险等级」，
 *   **不得命名为"流失概率"**，也不得对外宣称任何预测性概率。等级仅代表流程关注优先级。
 * 语义约束（任务书第五节第 8 条）：跟进完成或联系成功不代表风险必然解除，
 *   结果统一附带 caveat 文案说明这一点。
 *
 * 与既有 7/14 天规则的关系：engine.classify 的到店分级（R1A/R1B 触发门）保持原样；
 *   本模块 absence.n1/n2 与 BUSINESS_RULES §0 的 N1/N2 保持一致，是风险分数的"长期无训练"信号来源。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.risk = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 默认配置（唯一阈值定义处；调用方通过 opts.config 覆盖任意子项） ---------- */
  var RISK_CONFIG = {
    version: 2,
    /* 到店信号基准：与 BUSINESS_RULES §0 的 N1/N2 一致（无计划频率会员的兜底阈值） */
    absence: { n1: 7, n2: 14 },
    /* V1.1 个性化到店阈值：有 planned_per_week 时按计划频率推导容忍天数（2 个计划周期） */
    planAdaptiveAbsence: { enabled: true, toleranceFactor: 2, minN1: 7, minN2: 14 },
    /* 初始评分权重（分值和封顶 100） */
    weights: {
      long_absence: 35,
      freq_decline: 20,
      plan_decline: 15,
      package_expiring: 15,
      appointment_risk: 15,
      followup_overdue: 20,
      followup_no_result: 15,
      member_difficulty: 10
    },
    scoreCap: 100,
    /* 等级分段（关注等级，非"流失概率"） */
    levels: [
      { code: 'normal', label: '正常', min: 0, max: 19 },
      { code: 'watch', label: '观察', min: 20, max: 39 },
      { code: 'medium', label: '中风险', min: 40, max: 59 },
      { code: 'high', label: '高风险', min: 60, max: 100 }
    ],
    /* 到店缺席的等级下限（"连续 N 天无训练可直接触发对应等级"）；有计划频率时取推导阈值与它的较大值 */
    minLevelByAbsence: { medium: 7, high: 14 },
    /* 训练频率下降（自身环比）：最近 28 天 vs 前 28 天，下降 >= declineRatio 触发 */
    frequency: { windowDays: 28, declineRatio: 0.5, minBaseline: 2, minHistoryDays: 56, mode: 'distinct_day' },
    /* V1.1 计划 vs 实际：近 windowDays 实际到店 vs 计划应到店（达成率 < ratio 触发） */
    planDecline: { windowDays: 28, ratio: 0.6, minHistoryDays: 28, minExpected: 2 },
    /* V1.1 课包临近到期 */
    packageExpiring: { leadDays: 14 },
    /* V1.1 预约未到 / 频繁未到：预约日已过超过 graceDays 才算未到；未到期绝不判缺席 */
    appointment: { graceDays: 1, noShowWarn: 2, noShowHigh: 3, highFactor: 1.5 },
    /* V1.1 暂停期：期内不因长期无训练 / 计划达成不足判高风险 */
    pauseHandling: { suppressLongAbsence: true, suppressPlanDecline: true, resumeFromPauseEnd: true },
    /* V1.1 数据不完整：降级为提示，不叠加长期无训练分值 */
    incompleteData: { suppressLongAbsence: true, suppressPlanDecline: true },
    /* 跟进信号 */
    followup: { noResultValues: ['no_answer'], noResultStreak: 2 },
    /* 会员主动表达困难/暂停意向：确定性关键词（不使用 AI） */
    difficulty: {
      keywords: ['困难', '跟不上', '坚持不下去', '太忙', '没时间', '不想练', '放弃', '暂停', '受伤', '太累', '想停', '续不上'],
      includeMemberNotes: true,
      includeFollowupContent: true
    },
    /* 排除：暂停/休假/已退出会员；可选排除拒绝联系会员 */
    excludeStatuses: ['sleeping', 'expired'],
    excludeOptOut: true,
    /* 由风险生成任务时采纳的等级 */
    createTaskLevels: ['medium', 'high']
  };

  var LEVEL_RANK = { normal: 0, watch: 1, medium: 2, high: 3 };
  var LEVEL_LABEL = { normal: '正常', watch: '观察', medium: '中风险', high: '高风险', excluded: '已排除' };

  /* 统一说明：风险等级为流程提示，非预测概率；跟进完成 != 风险解除 */
  var CAVEAT = '风险等级为运营关注提示，不代表"流失概率"；跟进完成或联系成功也不等于风险解除，需结合后续到店情况复评。';

  var GROUP_KEYS = ['absence', 'planAdaptiveAbsence', 'weights', 'frequency', 'planDecline', 'packageExpiring',
    'appointment', 'pauseHandling', 'incompleteData', 'followup', 'difficulty'];
  var WHOLE_KEYS = ['levels', 'excludeStatuses', 'createTaskLevels'];
  var SCALAR_KEYS = ['scoreCap', 'minLevelByAbsence', 'excludeOptOut', 'version'];

  function mergeConfig(over) {
    var c = JSON.parse(JSON.stringify(RISK_CONFIG));
    if (!over) return c;
    GROUP_KEYS.forEach(function (k) { if (over[k]) c[k] = Object.assign({}, c[k], over[k]); });
    WHOLE_KEYS.forEach(function (k) { if (over[k]) c[k] = over[k]; });
    SCALAR_KEYS.forEach(function (k) { if (over[k] !== undefined) c[k] = over[k]; });
    return c;
  }

  function parseD(s) { return new Date(s + 'T00:00:00Z').getTime(); }
  function diffDays(a, b) { return Math.round((parseD(a) - parseD(b)) / 86400000); }
  function byId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function isY(v) { return v === 'Y' || v === true || v === 'y' || v === 1 || v === '1'; }
  function toNum(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }

  function lastSessionDate(model, memberId) {
    var max = null;
    model.sessions.forEach(function (s) { if (s.member_id === memberId && (!max || s.date > max)) max = s.date; });
    return max;
  }

  /** 窗口内有效训练计数（distinct_day 模式按不同日期计，避免同日多次虚增） */
  function countWindow(model, memberId, fromDate, toDate, mode) {
    var seen = {}, n = 0;
    model.sessions.forEach(function (s) {
      if (s.member_id !== memberId) return;
      if (fromDate && s.date < fromDate) return;
      if (toDate && s.date > toDate) return;
      var key = (mode === 'distinct_day') ? s.date : s.session_id;
      if (!seen[key]) { seen[key] = 1; n++; }
    });
    return n;
  }

  function shiftDate(d, days) {
    return new Date(parseD(d) + days * 86400000).toISOString().slice(0, 10);
  }

  function levelByScore(score, cfg) {
    for (var i = 0; i < cfg.levels.length; i++) {
      var L = cfg.levels[i];
      if (score >= L.min && score <= L.max) return L.code;
    }
    return 'high';
  }

  function taskIsActive(t) {
    var s = t.task_status || (t.status === 'open' ? 'pending' : t.status);
    return s === 'unassigned' || s === 'pending' || s === 'in_progress' || s === 'review';
  }
  function taskIsFollowup(t) {
    var ty = t.task_type || (t.source === 'system' ? 'followup' : 'other');
    return ty === 'followup';
  }

  /* ---------- V1.1 辅助：暂停期 / 个性化阈值 ---------- */

  /** 会员当前是否处于暂停期（pause_start_date 已开始且 pause_end_date 未过或未设） */
  function inPauseWindow(member, T) {
    if (!member.pause_start_date) return false;
    if (member.pause_start_date > T) return false;                       // 尚未开始
    if (member.pause_end_date && member.pause_end_date < T) return false; // 已结束
    return true;
  }

  /** 个性化到店阈值：有 planned_per_week 时按计划频率推导（2 个计划周期为容忍上限） */
  function effectiveAbsence(cfg, member) {
    var n1 = cfg.absence.n1, n2 = cfg.absence.n2, adaptive = false;
    var a = cfg.planAdaptiveAbsence;
    var p = member ? toNum(member.planned_per_week) : null;
    if (a && a.enabled && p && p > 0) {
      var gap = 7 / p;                                          // 计划中两次训练的平均间隔（天）
      n1 = Math.max(a.minN1, Math.ceil(gap * a.toleranceFactor));
      n2 = Math.max(a.minN2, Math.ceil(gap * (a.toleranceFactor + 1)));
      if (n2 <= n1) n2 = n1 + 7;
      adaptive = true;
    }
    return { n1: n1, n2: n2, adaptive: adaptive, planned: p };
  }

  /**
   * computeRisk(model, member, opts) → 风险评分结果（可解释）
   * opts: { today, config }
   */
  function computeRisk(model, member, opts) {
    opts = opts || {};
    var cfg = mergeConfig(opts.config);
    var T = opts.today || model.today;
    if (typeof member === 'string') member = model.byId.members[member];
    if (!member) return { ok: false, error: 'member_not_found' };

    var base = {
      ok: true, member_id: member.member_id, name: member.name,
      score: 0, level: 'normal', levelLabel: LEVEL_LABEL.normal,
      reasons: [], excluded: false, excludeReason: '',
      insufficient: false, dataIncomplete: false, pauseActive: false,
      absenceDays: null, absenceBaseline: null, last_session_date: null,
      window: { last: 0, prior: 0 }, planAdherence: null,
      packageDaysLeft: null, appointmentDays: null,
      absenceThresholds: null, caveat: CAVEAT, configVersion: cfg.version
    };

    /* 0) 排除项（暂停/休假/已退出 / 拒绝联系） */
    if (cfg.excludeStatuses.indexOf(member.status) >= 0) {
      base.excluded = true; base.excludeReason = 'status:' + member.status;
      base.level = 'excluded'; base.levelLabel = LEVEL_LABEL.excluded;
      base.reasons.push({ code: 'excluded_status', points: 0, label: '按配置排除', detail: '会员状态 ' + member.status + '（暂停/休假/已退出）不参与风险评分' });
      return base;
    }
    if (cfg.excludeOptOut && member.contact_opt_out === 'Y') {
      base.excluded = true; base.excludeReason = 'opt_out';
      base.level = 'excluded'; base.levelLabel = LEVEL_LABEL.excluded;
      base.reasons.push({ code: 'excluded_opt_out', points: 0, label: '按配置排除', detail: '会员登记拒绝联系（contact_opt_out=Y），不进入回访类风险任务' });
      return base;
    }

    var score = 0;
    var forced = null;
    function add(code, points, label, detail) {
      score += points;
      base.reasons.push({ code: code, points: points, label: label, detail: detail });
    }
    function note(code, label, detail) {
      base.reasons.push({ code: code, points: 0, label: label, detail: detail });
    }

    /* V1.1 状态判定：暂停期 / 数据不完整 */
    var paused = inPauseWindow(member, T);
    var dataIncomplete = isY(member.data_incomplete);
    base.pauseActive = paused;
    base.dataIncomplete = dataIncomplete;
    var suppressAbsence = (paused && cfg.pauseHandling.suppressLongAbsence) ||
      (dataIncomplete && cfg.incompleteData.suppressLongAbsence);
    var suppressPlan = (paused && cfg.pauseHandling.suppressPlanDecline) ||
      (dataIncomplete && cfg.incompleteData.suppressPlanDecline);

    if (paused) {
      note('pause_active', '暂停期内',
        '会员处于暂停期（' + member.pause_start_date + ' 起' + (member.pause_end_date ? ' 至 ' + member.pause_end_date : '，未设结束日') +
        '），期内不因长期无训练判高风险');
    }
    if (dataIncomplete) {
      note('data_incomplete', '数据不完整',
        '会员已标记数据不完整（训练记录可能缺失），长期无训练等信号已降级，建议先核对记录再作判断');
    }

    /* 1) 长期无训练（个性化阈值 + 暂停/数据不完整降级） */
    var last = lastSessionDate(model, member.member_id);
    base.last_session_date = last;
    var eff = effectiveAbsence(cfg, member);
    base.absenceThresholds = { n1: eff.n1, n2: eff.n2, adaptive: eff.adaptive };

    /* 基线：默认取最近一节课；若暂停已结束且无更近记录，则从暂停结束日起算 */
    var baseline = last, baselineFromPause = false;
    if (cfg.pauseHandling.resumeFromPauseEnd && member.pause_end_date && member.pause_end_date <= T) {
      if (!baseline || member.pause_end_date > baseline) { baseline = member.pause_end_date; baselineFromPause = true; }
    }
    base.absenceBaseline = baseline;

    if (!baseline) {
      if (!dataIncomplete) {
        base.insufficient = true;
        note('insufficient_history', '数据不足', '无任何训练记录，无法判断到店趋势（与"确无训练"区分，不计分）');
      }
    } else {
      var gap = diffDays(T, baseline);
      base.absenceDays = gap;
      if (baselineFromPause) {
        note('absence_from_pause_end', '暂停已结束',
          '会员暂停已于 ' + member.pause_end_date + ' 结束，缺席天数自暂停结束日起算（' + gap + ' 天）');
      }
      if (suppressAbsence) {
        /* 暂停期内 / 数据不完整 → 记录天数但不计分、不设等级下限 */
      } else if (gap >= eff.n2) {
        add('long_absence', cfg.weights.long_absence, '长期无训练',
          '连续 ' + gap + ' 天未训练（≥' + eff.n2 + ' 天' + (eff.adaptive ? '，按其计划每周 ' + eff.planned + ' 次推导' : '') + '）');
        forced = 'high';
      } else if (gap >= eff.n1) {
        add('long_absence', cfg.weights.long_absence, '长期无训练',
          '连续 ' + gap + ' 天未训练（' + eff.n1 + '-' + (eff.n2 - 1) + ' 天' + (eff.adaptive ? '，按其计划每周 ' + eff.planned + ' 次推导' : '') + '）');
        forced = 'medium';
      }
    }

    /* 2) 训练频率下降（自身环比；新会员/历史不足不计算） */
    var f = cfg.frequency;
    var lastFrom = shiftDate(T, -(f.windowDays - 1));
    var priorTo = shiftDate(T, -f.windowDays);
    var priorFrom = shiftDate(T, -(2 * f.windowDays - 1));
    var cntLast = countWindow(model, member.member_id, lastFrom, T, f.mode);
    var cntPrior = countWindow(model, member.member_id, priorFrom, priorTo, f.mode);
    base.window = { last: cntLast, prior: cntPrior };
    if (!last) {
      /* 无训练记录：不计算频率（已在 insufficient 说明） */
    } else if (dataIncomplete) {
      note('freq_insufficient_data', '数据不足', '会员标记数据不完整，环比频率下降信号已跳过');
    } else {
      var historyDays = member.join_date ? diffDays(T, member.join_date) : null;
      if (historyDays !== null && historyDays < f.minHistoryDays) {
        note('freq_insufficient_history', '数据不足', '入会仅 ' + historyDays + ' 天（<' + f.minHistoryDays + '），不足以判断训练频率下降');
      } else if (cntPrior < f.minBaseline) {
        note('freq_insufficient_baseline', '数据不足', '前 ' + f.windowDays + ' 天有效训练仅 ' + cntPrior + ' 次，基线不足，不判断频率下降');
      } else {
        var decline = (cntPrior - cntLast) / cntPrior;
        if (decline >= f.declineRatio) {
          add('freq_decline', cfg.weights.freq_decline, '训练频率下降',
            '近 ' + f.windowDays + ' 天有效训练 ' + cntLast + ' 次，较前 ' + f.windowDays + ' 天 ' + cntPrior + ' 次下降 ' + Math.round(decline * 100) + '%（≥' + Math.round(f.declineRatio * 100) + '%）');
        }
      }
    }

    /* 2b) V1.1 计划 vs 实际：实际到店次数对照计划应到店次数 */
    var pd = cfg.planDecline;
    var planned = toNum(member.planned_per_week);
    if (planned && planned > 0) {
      var planHistoryDays = member.join_date ? diffDays(T, member.join_date) : null;
      var winDays = pd.windowDays;
      if (planHistoryDays !== null && planHistoryDays < pd.windowDays) winDays = Math.max(1, planHistoryDays);
      var planFrom = shiftDate(T, -(winDays - 1));
      var planActual = countWindow(model, member.member_id, planFrom, T, f.mode);
      var expected = planned * (winDays / 7);
      base.planAdherence = { planned: planned, windowDays: winDays, expected: Math.round(expected * 10) / 10, actual: planActual };

      if (suppressPlan) {
        /* 暂停期内 / 数据不完整 → 跳过 */
      } else if (planHistoryDays !== null && planHistoryDays < pd.minHistoryDays) {
        note('plan_insufficient_history', '数据不足',
          '入会仅 ' + planHistoryDays + ' 天（<' + pd.minHistoryDays + '），不足以判断计划达成情况');
      } else if (expected >= pd.minExpected && planActual < expected * pd.ratio) {
        add('plan_decline', cfg.weights.plan_decline, '实际训练频率低于计划',
          '近 ' + winDays + ' 天实际到店 ' + planActual + ' 次，计划（每周 ' + planned + ' 次）应到 ' +
          (Math.round(expected * 10) / 10) + ' 次，达成率 ' + Math.round(planActual / expected * 100) + '%（<' + Math.round(pd.ratio * 100) + '%）');
      }
    }

    /* 2c) V1.1 课包临近到期 / 剩余课时为 0 */
    var pe = cfg.packageExpiring;
    if (member.package_end_date) {
      var dLeft = diffDays(member.package_end_date, T);
      base.packageDaysLeft = dLeft;
      if (dLeft >= 0 && dLeft <= pe.leadDays) {
        add('package_expiring', cfg.weights.package_expiring, '课包临近到期',
          '课包将于 ' + member.package_end_date + ' 到期（剩 ' + dLeft + ' 天，≤' + pe.leadDays + ' 天）');
      } else if (dLeft < 0) {
        note('package_expired', '课包已到期', '课包已于 ' + member.package_end_date + ' 到期（' + (-dLeft) + ' 天前），请核实续费情况');
      }
    }
    var leftN = toNum(member.pt_sessions_left);
    if (leftN !== null && leftN <= 0) {
      note('package_no_sessions', '剩余课时为 0', '剩余私教课时为 ' + leftN + '（已明确记录），请核实续课安排');
    }

    /* 2d) V1.1 预约未到 / 频繁未到（未到期绝不判缺席） */
    var ap = cfg.appointment;
    if (member.next_appointment_date) {
      var dToAppt = diffDays(member.next_appointment_date, T);   // >0 未来；<0 已过
      base.appointmentDays = dToAppt;
      if (dToAppt >= 0) {
        note('appointment_pending', '已预约未到期',
          '下次预约 ' + member.next_appointment_date + '（' + (dToAppt === 0 ? '今天' : dToAppt + ' 天后') + '）尚未到期，不视为缺席');
      } else if (-dToAppt > ap.graceDays) {
        add('appointment_no_show', cfg.weights.appointment_risk, '预约未到',
          '预约日 ' + member.next_appointment_date + ' 已过 ' + (-dToAppt) + ' 天仍未完成/更新，视为未到（宽限 ' + ap.graceDays + ' 天）');
      } else {
        note('appointment_grace', '预约刚过宽限内',
          '预约日 ' + member.next_appointment_date + ' 刚过 ' + (-dToAppt) + ' 天（≤宽限 ' + ap.graceDays + ' 天），暂不判缺席');
      }
    }
    var nsc = toNum(member.no_show_count);
    if (nsc !== null && nsc >= ap.noShowWarn) {
      var pts = cfg.weights.appointment_risk;
      if (nsc >= ap.noShowHigh) pts = Math.round(pts * ap.highFactor);
      add('frequent_no_show', pts, '频繁未到课/取消',
        '累计预约未到 ' + nsc + ' 次（≥' + ap.noShowWarn + '）' + (nsc >= ap.noShowHigh ? '，已达高频阈值 ≥' + ap.noShowHigh : ''));
    }

    /* 3) 存在已逾期的有效跟进任务 */
    var overdueTasks = model.tasks.filter(function (t) {
      return t.member_id === member.member_id && taskIsActive(t) && taskIsFollowup(t) && t.due_date < T;
    });
    if (overdueTasks.length) {
      add('followup_overdue', cfg.weights.followup_overdue, '跟进任务逾期', '存在 ' + overdueTasks.length + ' 条已逾期的有效跟进任务（如 ' + overdueTasks[0].task_id + '）');
    }

    /* 4) 连续多次跟进无有效结果（注意：联系成功 ≠ 风险解除） */
    var fus = model.followups.filter(function (x) { return x.member_id === member.member_id; })
      .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
    if (fus.length >= cfg.followup.noResultStreak) {
      var streak = true;
      for (var i = 0; i < cfg.followup.noResultStreak; i++) {
        if (cfg.followup.noResultValues.indexOf(fus[i].result) < 0) { streak = false; break; }
      }
      if (streak) {
        add('followup_no_result', cfg.weights.followup_no_result, '多次跟进无有效结果',
          '最近 ' + cfg.followup.noResultStreak + ' 次跟进均无有效结果（' + fus.slice(0, cfg.followup.noResultStreak).map(function (x) { return x.result; }).join('、') + '）');
      }
    }

    /* 5) 会员主动表达训练困难 / 暂停意向（确定性关键词） */
    var hits = [];
    if (cfg.difficulty.includeMemberNotes && member.notes) {
      cfg.difficulty.keywords.forEach(function (k) { if (String(member.notes).indexOf(k) >= 0) hits.push({ k: k, src: '会员备注' }); });
    }
    if (cfg.difficulty.includeFollowupContent && fus.length) {
      var latest = fus[0];
      var text = String(latest.content || '') + ' ' + String(latest.member_feedback || '');
      cfg.difficulty.keywords.forEach(function (k) { if (text.indexOf(k) >= 0) hits.push({ k: k, src: '最近跟进反馈' }); });
    }
    if (hits.length) {
      add('member_difficulty', cfg.weights.member_difficulty, '会员主动表达困难',
        '命中关键词「' + hits[0].k + '」（来源：' + hits[0].src + '）' + (hits.length > 1 ? ' 等 ' + hits.length + ' 处' : ''));
    }

    score = Math.min(cfg.scoreCap, score);
    var lvl = levelByScore(score, cfg);
    /* 到店等级下限（连续 N 天无训练直接触发对应等级；个性化阈值优先） */
    var floorLvl = null;
    if (base.absenceDays !== null && !suppressAbsence) {
      var fMed = cfg.minLevelByAbsence.medium, fHigh = cfg.minLevelByAbsence.high;
      if (eff.adaptive) { fMed = Math.max(fMed, eff.n1); fHigh = Math.max(fHigh, eff.n2); }
      if (base.absenceDays >= fHigh) floorLvl = 'high';
      else if (base.absenceDays >= fMed) floorLvl = 'medium';
    }
    if (floorLvl && LEVEL_RANK[lvl] < LEVEL_RANK[floorLvl]) lvl = floorLvl;
    if (forced && LEVEL_RANK[lvl] < LEVEL_RANK[forced]) lvl = forced;

    base.score = score;
    base.level = lvl;
    base.levelLabel = LEVEL_LABEL[lvl];
    base.levelFloor = floorLvl;
    return base;
  }

  /** 全量会员风险图 + 汇总（去重口径：按会员） */
  function computeRiskMap(model, opts) {
    opts = opts || {};
    var cfg = mergeConfig(opts.config);
    var T = opts.today || model.today;
    var map = {};
    model.members.slice().sort(function (a, b) { return byId(a.member_id, b.member_id); })
      .forEach(function (m) { map[m.member_id] = computeRisk(model, m, { today: T, config: cfg }); });
    return map;
  }

  /** 汇总：等级计数 / 排除计数 / 数据不足计数 / 数据不完整计数 / 需关注会员数（medium+high，去重） */
  function summarize(map) {
    var s = { normal: 0, watch: 0, medium: 0, high: 0, excluded: 0, insufficient: 0, dataIncomplete: 0, pauseActive: 0, attentionMembers: 0, total: 0 };
    Object.keys(map).forEach(function (id) {
      var r = map[id]; s.total++;
      s[r.level] = (s[r.level] || 0) + 1;
      if (r.insufficient) s.insufficient++;
      if (r.dataIncomplete) s.dataIncomplete++;
      if (r.pauseActive) s.pauseActive++;
      if (r.level === 'medium' || r.level === 'high') s.attentionMembers++;
    });
    return s;
  }

  return {
    RISK_CONFIG: RISK_CONFIG,
    LEVEL_LABEL: LEVEL_LABEL,
    LEVEL_RANK: LEVEL_RANK,
    CAVEAT: CAVEAT,
    mergeConfig: mergeConfig,
    computeRisk: computeRisk,
    computeRiskMap: computeRiskMap,
    summarize: summarize,
    levelByScore: levelByScore,
    inPauseWindow: inPauseWindow,
    effectiveAbsence: effectiveAbsence
  };
});
