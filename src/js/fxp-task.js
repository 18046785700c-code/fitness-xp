/* Fitness XP V1 — 任务引擎（今日优先处理模块：状态机 + 教练分配 + 风险任务生成；UMD）
 * 依据：产品任务书「首页今日优先处理模块 V1.0」第四、五、六节
 * 与既有数据模型的兼容策略（关键）：
 *   - 保留既有列 status（open / done / cancelled）= "是否关闭"维度；新增可选列 task_status 承载 6 态状态机。
 *     不变式：task_status ∈ {unassigned,pending,in_progress,review} ⇔ status=open；done ⇔ status=done；cancelled ⇔ status=cancelled。
 *   - 既有 (member_id, rule_code) 防重逻辑（fxp-engine.runRules）完全不受影响。
 *   - 待分配任务 coach_id 允许为空（validate 已放宽；loadModel 容忍空责任人）。
 * 原则：一切状态变更走 transition（禁止绕过必要步骤）；取消必填原因、不物理删除；完成必带执行结果。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./fxp-engine.js')); }
  else { root.FXP = root.FXP || {}; root.FXP.task = factory(root.FXP.engine); }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var STATES = ['unassigned', 'pending', 'in_progress', 'review', 'done', 'cancelled'];
  var ACTIVE_STATES = ['unassigned', 'pending', 'in_progress', 'review'];
  var STATE_LABEL = { unassigned: '待分配', pending: '待处理', in_progress: '处理中', review: '待复核', done: '已完成', cancelled: '已取消' };
  var TASK_TYPE_LABEL = { followup: '回访跟进', renewal: '续费沟通', first_session: '首次带练', review: '复核', other: '其他' };
  var PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };
  var PRIORITY_RANK = { high: 2, normal: 1, low: 0 };

  /* 合法状态转换表（禁止绕过必要步骤直接改状态） */
  var TRANSITIONS = {
    unassigned: ['pending', 'cancelled'],
    pending: ['in_progress', 'cancelled'],
    in_progress: ['review', 'done', 'pending', 'cancelled'],
    review: ['done', 'in_progress'],
    done: [],
    cancelled: []
  };

  /* ---------- 工具 ---------- */
  function parseD(s) { return new Date(s + 'T00:00:00Z').getTime(); }
  function diffDays(a, b) { return Math.round((parseD(a) - parseD(b)) / 86400000); }
  function byId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function compact(s) { return String(s).replace(/-/g, ''); }
  function mkCounter(model, T) {
    var prefix = 'T-' + compact(T) + '-', max = 0;
    model.tasks.forEach(function (t) {
      var m = /^T-(\d{8})-(\d+)$/.exec(t.task_id || '');
      if (m && m[1] === compact(T)) max = Math.max(max, parseInt(m[2], 10));
    });
    return function () { max += 1; return prefix + String(max).padStart(4, '0'); };
  }

  /* ---------- 状态读写 ---------- */
  function stateOf(t) {
    if (t.task_status && STATES.indexOf(t.task_status) >= 0) return t.task_status;
    if (t.status === 'done') return 'done';
    if (t.status === 'cancelled') return 'cancelled';
    return t.coach_id ? 'pending' : 'unassigned'; // legacy open
  }
  function syncStatus(t) {
    var s = stateOf(t);
    t.task_status = s;
    if (ACTIVE_STATES.indexOf(s) >= 0) t.status = 'open';
    else if (s === 'done') t.status = 'done';
    else t.status = 'cancelled';
  }
  function isActive(t) { return ACTIVE_STATES.indexOf(stateOf(t)) >= 0; }
  function isOverdue(t, T) { return isActive(t) && !!t.due_date && t.due_date < T; }
  function taskTypeOf(t) { return t.task_type || (t.source === 'system' ? 'followup' : 'other'); }
  function pushHistory(t, at, action, detail) {
    t._history = t._history || [];
    t._history.push({ at: at, action: action, detail: detail || '' });
  }

  /* ---------- 教练分配（第五节的 5 条规则） ---------- */
  function qualifiedCoaches(model) { return model.coaches.filter(function (c) { return c.active !== 'N'; }); }
  function activeTaskCount(model, coachId) {
    return model.tasks.filter(function (t) { return isActive(t) && t.coach_id === coachId; }).length;
  }
  /** 规则：① 有效主教练 ② 否则负载最少者（稳定排序：负载相同按 coach_id） ③ 无可用 → null（待分配） */
  function chooseCoach(model, member) {
    var primary = member && model.byId.coaches[member.coach_id];
    if (primary && primary.active !== 'N') return primary.coach_id;
    var cands = qualifiedCoaches(model).slice().sort(function (a, b) {
      var ca = activeTaskCount(model, a.coach_id), cb = activeTaskCount(model, b.coach_id);
      if (ca !== cb) return ca - cb;                 // 负载少的优先
      return byId(a.coach_id, b.coach_id);           // 稳定排序：相同数据刷新不换负责人
    });
    return cands.length ? cands[0].coach_id : null;
  }

  /** 执行分配 / 重新分配；记录分配人、时间、原负责人、重新分配原因 */
  function assign(model, task, coachId, opts) {
    opts = opts || {};
    var T = opts.today || model.today;
    var prev = task.coach_id || '';
    if (prev === coachId && stateOf(task) !== 'unassigned') return { ok: true, task: task, changed: false };
    task.prev_coach_id = prev;
    task.coach_id = coachId || '';
    task.assigned_at = T;
    if (opts.actor) task.assigned_by = opts.actor;
    if (opts.reason) task.reassign_reason = opts.reason;
    task.updated_at = T;
    if (!coachId) {
      task.task_status = 'unassigned';
    } else if (stateOf(task) === 'unassigned') {
      task.task_status = 'pending';
    }
    syncStatus(task);
    pushHistory(task, T, prev ? 'reassign' : 'assign', '责任人 ' + (prev || '（待分配）') + ' → ' + (coachId || '（待分配）') + (opts.reason ? '，原因：' + opts.reason : ''));
    return { ok: true, task: task, changed: true };
  }

  /** 按规则自动分配（主教练优先 → 负载均衡 → 待分配） */
  function autoAssign(model, task, opts) {
    opts = opts || {};
    var member = model.byId.members[task.member_id];
    var coachId = chooseCoach(model, member);
    var res = assign(model, task, coachId, { today: opts.today, actor: opts.actor || 'system', reason: opts.reason || '' });
    res.unassigned = !coachId;
    if (!coachId) res.reason = '无可用在职教练，进入待分配队列';
    return res;
  }

  /* ---------- 任务创建（含防重与原因合并） ---------- */
  function riskReasonText(r) {
    return r.reasons.filter(function (x) { return x.points > 0; })
      .map(function (x) { return x.label + '：' + x.detail; }).join('；').slice(0, 300);
  }
  function mergeRiskInfo(task, spec) {
    // risk_level 取较高；risk_reason 去重合并；priority 取较高；updated_at 刷新
    var rank = { normal: 0, watch: 1, medium: 2, high: 3 };
    if (spec.risk_level && (rank[spec.risk_level] || 0) > (rank[task.risk_level] || 0)) task.risk_level = spec.risk_level;
    if (spec.risk_reason) {
      var parts = String(task.risk_reason || '').split('；').filter(Boolean);
      String(spec.risk_reason).split('；').forEach(function (s) { if (s && parts.indexOf(s) < 0) parts.push(s); });
      task.risk_reason = parts.join('；').slice(0, 300);
    }
    if (spec.priority && (PRIORITY_RANK[spec.priority] || 0) > (PRIORITY_RANK[task.priority] || 0)) task.priority = spec.priority;
    task.updated_at = spec.today;
    syncStatus(task);   /* 补齐 legacy 任务缺失的 task_status（状态机与关闭维度保持一致） */
  }

  function findDuplicate(model, memberId, taskType, ruleCode) {
    return model.tasks.filter(function (t) {
      return t.member_id === memberId && isActive(t) && taskTypeOf(t) === taskType && (t.rule_code || '') === (ruleCode || '');
    })[0] || null;
  }

  /**
   * createTask(model, spec, opts)
   * spec: { member_id, task_type, rule_code, title, due_date, source, risk_level, risk_reason, priority, coach_id }
   * 防重键：(member_id, task_type, rule_code) 且未完成。命中 → 合并风险原因到现有任务并返回 merged。
   */
  function createTask(model, spec, opts) {
    opts = opts || {};
    var T = opts.today || model.today;
    var ruleCode = spec.rule_code || '';
    var dup = findDuplicate(model, spec.member_id, spec.task_type, ruleCode);
    if (dup) {
      mergeRiskInfo(dup, { risk_level: spec.risk_level, risk_reason: spec.risk_reason, priority: spec.priority, today: T });
      pushHistory(dup, T, 'merge', '同会员同类型同规则已有未完成任务，风险原因已合并（防重键 ' + spec.member_id + '/' + spec.task_type + '/' + (ruleCode || '—') + '）');
      return { ok: true, created: false, merged: true, task: dup };
    }
    var task = {
      task_id: mkCounter(model, T)(),
      member_id: spec.member_id,
      coach_id: spec.coach_id || '',
      title: spec.title || '会员回访',
      due_date: spec.due_date || T,
      status: 'open',
      source: spec.source || 'system',
      rule_code: ruleCode,
      created_date: T,
      done_date: '', cancelled_date: '', cancel_reason: '', notes: spec.notes || '',
      task_type: spec.task_type || 'followup',
      task_status: spec.coach_id ? 'pending' : 'unassigned',
      risk_level: spec.risk_level || '',
      risk_reason: spec.risk_reason || '',
      priority: spec.priority || 'normal',
      started_at: '', completed_by: '', result_code: '', next_followup_at: '',
      assigned_by: '', assigned_at: '', prev_coach_id: '', reassign_reason: '',
      updated_at: T, _row: 0
    };
    syncStatus(task);
    pushHistory(task, T, 'create', '创建任务（来源 ' + task.source + (ruleCode ? '，规则 ' + ruleCode : '') + '）');
    model.tasks.push(task);
    model.byId.tasks[task.task_id] = task;
    return { ok: true, created: true, task: task };
  }

  /* ---------- 状态转换 ---------- */
  function canTransition(from, to) { return (TRANSITIONS[from] || []).indexOf(to) >= 0; }

  function transition(model, task, to, opts) {
    opts = opts || {};
    var T = opts.today || model.today;
    if (!task) return { ok: false, error: 'task_not_found', message: '任务不存在' };
    if (STATES.indexOf(to) < 0) return { ok: false, error: 'invalid_state', message: '未知状态：' + to };
    var from = stateOf(task);
    if (from === to) return { ok: true, task: task, noop: true };
    if (!canTransition(from, to)) {
      return { ok: false, error: 'illegal_transition', message: '非法状态转换：' + STATE_LABEL[from] + ' → ' + STATE_LABEL[to] };
    }
    if (to === 'done' && !opts.date) return { ok: false, error: 'done_date_required', message: '完成任务必须填写完成日期' };
    if (to === 'cancelled' && !opts.reason) return { ok: false, error: 'cancel_reason_required', message: '取消任务必须填写取消原因' };

    task.task_status = to;
    if (to === 'in_progress') { task.started_at = task.started_at || T; task.updated_at = T; if (opts.actor) task.coach_id = opts.actor; }
    if (to === 'pending') { task.updated_at = T; if (opts.reason) task.notes = ((task.notes ? task.notes + '；' : '') + '暂缓/退回：' + opts.reason).slice(0, 200); }
    if (to === 'done') {
      task.done_date = opts.date; task.updated_at = opts.date;
      if (opts.actor) task.completed_by = opts.actor;
      if (opts.result_code) task.result_code = opts.result_code;
      if (opts.next_followup_at) task.next_followup_at = opts.next_followup_at;
    }
    if (to === 'cancelled') {
      task.cancelled_date = opts.date || T; task.cancel_reason = opts.reason; task.updated_at = T;
      if (opts.notes) task.notes = opts.notes;
    }
    syncStatus(task);
    pushHistory(task, T, to, (opts.reason ? '原因：' + opts.reason : '') + (opts.actor ? '，执行人：' + opts.actor : ''));
    return { ok: true, task: task, from: from, to: to };
  }

  /** 开始处理：pending → in_progress */
  function startTask(model, task, opts) { return transition(model, task, 'in_progress', opts); }
  /** 暂缓处理：in_progress → pending（必须给原因） */
  function holdTask(model, task, reason, opts) {
    if (!reason) return { ok: false, error: 'reason_required', message: '暂缓处理必须填写原因' };
    return transition(model, task, 'pending', Object.assign({}, opts, { reason: reason }));
  }
  /** 重新分配：pending/in_progress → 换责任人（记录原负责人与原因） */
  function reassign(model, task, coachId, opts) {
    opts = opts || {};
    var before = stateOf(task);
    var res = assign(model, task, coachId, opts);
    if (!res.ok) return res;
    pushHistory(task, opts.today || model.today, 'reassigned', '状态保持 ' + STATE_LABEL[before]);
    return res;
  }

  /**
   * completeTask(model, task, opts)
   * opts: { date, actor, result_code, next_action, next_followup_at, reviewEnabled, reason }
   * 规则：完成必须有执行结果（result_code）；有后续动作（next_action != none）必须给下次跟进时间。
   * reviewEnabled=true 时先进 待复核（review），由审核通过/退回补充决定最终状态。
   */
  function completeTask(model, task, opts) {
    opts = opts || {};
    if (!opts.result_code) return { ok: false, error: 'result_required', message: '任务完成必须填写执行结果（result_code）' };
    var action = opts.next_action || 'none';
    if (action !== 'none') {
      if (!opts.next_followup_at) return { ok: false, error: 'next_followup_required', message: '有后续动作时必须填写下次跟进时间' };
      if (opts.date && opts.next_followup_at < opts.date) return { ok: false, error: 'next_before_date', message: '下次跟进时间不能早于实际执行时间' };
    }
    if (opts.reviewEnabled) {
      task._pending_completion = { date: opts.date, actor: opts.actor, result_code: opts.result_code, next_followup_at: opts.next_followup_at || '', next_action: action };
      return transition(model, task, 'review', { today: opts.today || opts.date });
    }
    return transition(model, task, 'done', opts);
  }
  /** 审核通过：review → done（应用挂起的完成信息） */
  function approveReview(model, task, opts) {
    opts = opts || {};
    var p = task._pending_completion || {};
    var t = opts.today || model.today;
    return transition(model, task, 'done', {
      today: t,
      date: p.date || t,
      actor: p.actor || opts.actor,
      result_code: p.result_code || opts.result_code || 'other',
      next_followup_at: p.next_followup_at
    });
  }
  /** 退回补充：review → in_progress */
  function rejectReview(model, task, reason, opts) {
    if (!reason) return { ok: false, error: 'reason_required', message: '退回补充必须填写原因' };
    task._pending_completion = null;
    return transition(model, task, 'in_progress', Object.assign({}, opts, { reason: '退回补充：' + reason }));
  }

  /* ---------- 联系结果落库（第三节 6、第七节）：写跟进记录 + 推进任务 ---------- */
  function recordContact(model, task, data, opts) {
    opts = opts || {};
    var T = opts.today || model.today;
    var action = data.next_action || 'none';
    if (action !== 'none') {
      if (!data.next_followup_at) return { ok: false, error: 'next_followup_required', message: '有后续动作时必须填写下次跟进时间' };
      if (data.next_followup_at < data.date) return { ok: false, error: 'next_before_date', message: '下次跟进时间不能早于实际执行时间' };
    }
    /* 复用引擎的跟进记录构造（同规校验：会员/教练外键、日期、渠道、结果枚举） */
    var res = E.addFollowup(model, {
      member_id: data.member_id || task.member_id,
      coach_id: data.coach_id || task.coach_id,
      date: data.date,
      channel: data.channel,
      result: data.result,
      content: data.content || (data.member_feedback || ''),
      next_followup_date: action !== 'none' ? data.next_followup_at : '',
      task_id: task.task_id,
      member_feedback: data.member_feedback || '',
      next_action: action
    });
    if (!res.ok) return res;
    task.updated_at = T;
    pushHistory(task, T, 'contact', '记录联系结果 ' + data.channel + '/' + data.result + (action !== 'none' ? '，安排下次 ' + data.next_followup_at : ''));
    return { ok: true, followup: res.followup, warnings: res.warnings || [] };
  }

  /* ---------- 风险任务生成（第四节） ---------- */
  /**
   * generateRiskTasks(model, riskMap, opts)
   * opts: { today, config:{createTaskLevels}, actor }
   * 规则：仅对未排除且等级 ∈ createTaskLevels 的会员生成回访任务；
   *       若该会员已有任意"未完成的回访类任务"（含引擎生成的 R1A/R1B 等）→ 把风险等级与原因
   *       合并到最紧急的一条（第四节的"多个风险原因合并到同一任务"），不重复生成。
   */
  function generateRiskTasks(model, riskMap, opts) {
    opts = opts || {};
    var T = opts.today || model.today;
    var levels = (opts.config && opts.config.createTaskLevels) || ['medium', 'high'];
    var rep = { today: T, created: [], merged: [], skippedLow: [], skippedExcluded: [], unassigned: [] };
    model.members.slice().sort(function (a, b) { return byId(a.member_id, b.member_id); }).forEach(function (mem) {
      var r = riskMap[mem.member_id];
      if (!r) return;
      if (r.excluded) { rep.skippedExcluded.push(mem.member_id); return; }
      if (levels.indexOf(r.level) < 0) { rep.skippedLow.push(mem.member_id); return; }

      var riskFields = { risk_level: r.level, risk_reason: riskReasonText(r), priority: r.level === 'high' ? 'high' : 'normal', today: T };

      /* 合并目标：该会员任意未完成的回访类任务（最紧急者优先） */
      var existing = model.tasks.filter(function (t) {
        return t.member_id === mem.member_id && isActive(t) && taskTypeOf(t) === 'followup';
      }).sort(function (a, b) { return a.due_date < b.due_date ? -1 : (a.due_date > b.due_date ? 1 : byId(a.task_id, b.task_id)); })[0];
      if (existing) {
        mergeRiskInfo(existing, riskFields);
        pushHistory(existing, T, 'merge', '风险原因合并（等级 ' + r.level + '）');
        rep.merged.push({ task_id: existing.task_id, member_id: mem.member_id, level: r.level });
        return;
      }

      var ruleCode = 'RISK-' + (r.level === 'high' ? 'H' : 'M');
      var spec = {
        member_id: mem.member_id, task_type: 'followup', rule_code: ruleCode,
        title: (r.level === 'high' ? '高风险会员挽回跟进' : '中风险会员回访') + ' [' + mem.name + ']',
        due_date: T, source: 'system',
        risk_level: r.level, risk_reason: riskReasonText(r),
        priority: r.level === 'high' ? 'high' : 'normal'
      };
      var res = createTask(model, spec, { today: T });
      if (res.merged) { rep.merged.push({ task_id: res.task.task_id, member_id: mem.member_id, level: r.level }); return; }
      var a = autoAssign(model, res.task, { today: T, actor: opts.actor || 'system' });
      if (a.unassigned) rep.unassigned.push(res.task.task_id);
      rep.created.push(res.task);
    });
    rep.totals = {
      created: rep.created.length, merged: rep.merged.length,
      skippedLow: rep.skippedLow.length, skippedExcluded: rep.skippedExcluded.length, unassigned: rep.unassigned.length
    };
    return rep;
  }

  /** 已完成任务 → 创建后续任务（第七节"创建后续任务"） */
  function createFollowUpTask(model, sourceTask, opts) {
    opts = opts || {};
    var T = opts.today || model.today;
    var spec = {
      member_id: sourceTask.member_id, task_type: 'followup', rule_code: 'R-FN',
      title: '后续跟进 [' + (model.byId.members[sourceTask.member_id] ? model.byId.members[sourceTask.member_id].name : sourceTask.member_id) + ']',
      due_date: opts.due_date || T, source: 'system',
      risk_level: sourceTask.risk_level || '', risk_reason: sourceTask.risk_reason || '',
      priority: sourceTask.priority || 'normal', notes: opts.notes || ('由任务 ' + sourceTask.task_id + ' 创建后续任务')
    };
    var res = createTask(model, spec, { today: T });
    if (res.created) autoAssign(model, res.task, { today: T, actor: opts.actor || 'system' });
    return res;
  }

  /** 教练负载（第五节"查看教练负载"） */
  function coachLoad(model) {
    var map = {};
    model.coaches.forEach(function (c) { map[c.coach_id] = { coach_id: c.coach_id, name: c.name, active: c.active, active_tasks: 0, overdue: 0 }; });
    model.tasks.forEach(function (t) {
      if (!isActive(t) || !t.coach_id || !map[t.coach_id]) return;
      map[t.coach_id].active_tasks++;
      if (isOverdue(t, model.today)) map[t.coach_id].overdue++;
    });
    return Object.keys(map).sort(byId).map(function (k) { return map[k]; });
  }

  return {
    STATES: STATES, ACTIVE_STATES: ACTIVE_STATES,
    STATE_LABEL: STATE_LABEL, TASK_TYPE_LABEL: TASK_TYPE_LABEL, PRIORITY_LABEL: PRIORITY_LABEL, PRIORITY_RANK: PRIORITY_RANK,
    TRANSITIONS: TRANSITIONS,
    stateOf: stateOf, syncStatus: syncStatus, isActive: isActive, isOverdue: isOverdue, taskTypeOf: taskTypeOf,
    canTransition: canTransition, transition: transition,
    chooseCoach: chooseCoach, assign: assign, autoAssign: autoAssign, reassign: reassign,
    activeTaskCount: activeTaskCount, coachLoad: coachLoad, qualifiedCoaches: qualifiedCoaches,
    createTask: createTask, findDuplicate: findDuplicate, mergeRiskInfo: mergeRiskInfo, riskReasonText: riskReasonText,
    startTask: startTask, holdTask: holdTask, completeTask: completeTask,
    approveReview: approveReview, rejectReview: rejectReview, recordContact: recordContact,
    generateRiskTasks: generateRiskTasks, createFollowUpTask: createFollowUpTask
  };
});
