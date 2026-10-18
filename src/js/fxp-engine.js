/* Fitness XP V1 — 数据模型与规则引擎（依据 docs/BUSINESS_RULES.md；UMD）
 * 设计原则：拒收优于猜测；推导值不落库（overdue 仅展示）；一切自动行为可追踪（rule_code / cancel_reason）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./fxp-validate.js')); }
  else { root.FXP = root.FXP || {}; root.FXP.engine = factory(root.FXP.validate); }
})(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  /* ---------- 工具 ---------- */

  function parseD(s) { return new Date(s + 'T00:00:00Z').getTime(); }
  /** diffDays(a,b) = a - b 的天数 */
  function diffDays(a, b) { return Math.round((parseD(a) - parseD(b)) / 86400000); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function compact(s) { return s.replace(/-/g, ''); }

  /* ---------- 默认参数（BUSINESS_RULES 第 0 节；R2–R5 参数待业务方定稿） ---------- */

  var DEFAULT_PARAMS = { N1: 7, N2: 14, D1: 3, T1: 7, D5: 7, K: 14 };

  var CONTACT_RULES = ['R1A', 'R1B', 'R2', 'R3', 'R5', 'R-FN']; // 受"拒绝联系"约束的回访类规则
  var RULE_TITLES = {
    R1A: '7天未到店关怀回访', R1B: '14天未到店挽回跟进', R2: '未接通再次跟进',
    R3: '沉睡会员唤醒', R4: '会籍到期提醒', R5: '首次带练安排', 'R-FN': '按约定跟进'
  };

  /* ---------- 数据加载（行级校验 + 跨表校验） ---------- */

  /**
   * loadModel(raw, opts)
   * raw: { coaches:[records], members:[...], sessions:[...], followups:[...], tasks:[...] }（records 为 toRecords 产物）
   * opts: { today: 'YYYY-MM-DD' }（用于未来日期拒收）
   * 返回 model：{ tables, byId, report: { errors, warnings } }
   */
  function loadModel(raw, opts) {
    opts = opts || {};
    var T = opts.today || todayStr();
    var model = {
      today: T,
      coaches: [], members: [], sessions: [], followups: [], tasks: [],
      byId: { coaches: {}, members: {}, sessions: {}, followups: {}, tasks: {} },
      report: { errors: [], warnings: [] }
    };

    // 1) 行级校验（每表独立）
    var validated = {};
    ['coaches', 'members', 'sessions', 'followups', 'tasks'].forEach(function (t) {
      var res = V.validateTable(t, raw[t] || []);
      validated[t] = res;
      res.errors.forEach(function (e) { model.report.errors.push(e); });
      res.warnings.forEach(function (w) { model.report.warnings.push(w); });
    });

    // 2) 依次入模型：coaches → members → 子表；外键不存在 → 拒收该行
    function accept(table, rec) { model[table].push(rec); model.byId[table][rec[V.SCHEMAS[table].idField]] = rec; }
    function rejectFK(table, rec, field, target) {
      model[table] = model[table].filter(function (r) { return r !== rec; });
      delete model.byId[table][rec[V.SCHEMAS[table].idField]];
      model.report.errors.push({
        table: table, row: rec._row, field: field,
        message: '外键无效：' + field + '=' + rec[field] + ' 在 ' + target + ' 表中不存在，本行拒收'
      });
    }

    validated.coaches.accepted.forEach(function (r) { accept('coaches', r); });
    validated.members.accepted.forEach(function (r) {
      if (!model.byId.coaches[r.coach_id]) rejectFK('members', r, 'coach_id', 'coaches');
      else accept('members', r);
    });
    [['sessions', 'sessions'], ['followups', 'followups']].forEach(function (pair) {
      var t = pair[0];
      validated[t].accepted.forEach(function (r) {
        if (!model.byId.members[r.member_id]) rejectFK(t, r, 'member_id', 'members');
        else if (!model.byId.coaches[r.coach_id]) rejectFK(t, r, 'coach_id', 'coaches');
        else accept(t, r);
      });
    });
    /* tasks：责任人可空（今日优先模块的"待分配"任务）；仍校验会员外键与（非空时）教练外键 */
    validated.tasks.accepted.forEach(function (r) {
      if (!model.byId.members[r.member_id]) rejectFK('tasks', r, 'member_id', 'members');
      else if (r.coach_id && !model.byId.coaches[r.coach_id]) rejectFK('tasks', r, 'coach_id', 'coaches');
      else accept('tasks', r);
    });

    // 3) 未来日期拒收（V1 无预约场景）
    ['sessions', 'followups'].forEach(function (t) {
      var keep = [];
      model[t].forEach(function (r) {
        if (r.date > T) {
          model.report.errors.push({ table: t, row: r._row, field: 'date', message: '日期为未来日期：' + r.date + '（基准日 ' + T + '），本行拒收' });
        } else keep.push(r);
      });
      model[t] = keep;
      model.byId[t] = {};
      keep.forEach(function (r) { model.byId[t][r[V.SCHEMAS[t].idField]] = r; });
    });

    // 4) 内容级重复：同键完全一致 → 保留首行，后到行警告跳过
    var contentKeys = {
      sessions: function (r) { return [r.member_id, r.coach_id, r.date, r.content].join('|'); },
      followups: function (r) { return [r.member_id, r.coach_id, r.date, r.channel, r.result].join('|'); }
    };
    Object.keys(contentKeys).forEach(function (t) {
      var seen = {};
      var keep = [];
      model[t].forEach(function (r) {
        var k = contentKeys[t](r);
        if (seen[k]) {
          model.report.warnings.push({ table: t, row: r._row, field: '', message: '疑似重复录入（与第 ' + seen[k] + ' 行内容完全一致），本行跳过：' + r[V.SCHEMAS[t].idField] });
        } else { seen[k] = r._row; keep.push(r); }
      });
      model[t] = keep;
      model.byId[t] = {};
      keep.forEach(function (r) { model.byId[t][r[V.SCHEMAS[t].idField]] = r; });
    });

    // 5) 数据一致性警告：手机号重复 / 离职教练挂靠 / 离职教练待办 / 状态与到店不符
    var phoneMap = {};
    model.members.forEach(function (m) {
      (phoneMap[m.phone] = phoneMap[m.phone] || []).push(m.member_id);
    });
    Object.keys(phoneMap).forEach(function (p) {
      if (phoneMap[p].length > 1)
        model.report.warnings.push({ table: 'members', row: 0, field: 'phone', message: '手机号 ' + p + ' 同时属于 ' + phoneMap[p].join(', ') + '（疑似重复会员，请人工核对合并）' });
    });
    model.members.forEach(function (m) {
      var c = model.byId.coaches[m.coach_id];
      if (c && c.active === 'N')
        model.report.warnings.push({ table: 'members', row: m._row, field: 'coach_id', message: '会员 ' + m.member_id + ' 挂靠离职教练 ' + c.name + '（' + m.coach_id + '），请重新分配' });
    });
    model.tasks.forEach(function (t) {
      var c = model.byId.coaches[t.coach_id];
      if (t.status === 'open' && c && c.active === 'N')
        model.report.warnings.push({ table: 'tasks', row: t._row, field: 'coach_id', message: 'open 任务 ' + t.task_id + ' 责任人为离职教练 ' + t.coach_id + '，请转派' });
    });

    return model;
  }

  /* ---------- 状态一致性警告（在规则运行时计算，因需基准日） ---------- */

  function statusMismatchWarnings(model, T, P) {
    var out = [];
    model.members.forEach(function (m) {
      if (m.status === 'sleeping') {
        var last = lastSessionDate(model, m.member_id);
        if (last && diffDays(T, last) < P.N2)
          out.push({ table: 'members', row: m._row, field: 'status', message: '会员 ' + m.member_id + ' status=sleeping 但 ' + last + ' 有训练记录（距今 ' + diffDays(T, last) + ' 天），建议人工核对表格状态列' });
      }
    });
    return out;
  }

  /* ---------- 查询接口 ---------- */

  function lastSessionDate(model, memberId) {
    var max = null;
    model.sessions.forEach(function (s) {
      if (s.member_id === memberId && (!max || s.date > max)) max = s.date;
    });
    return max;
  }
  function latestFollowup(model, memberId) {
    var best = null;
    model.followups.forEach(function (f) {
      if (f.member_id === memberId && (!best || f.date > best.date)) best = f;
    });
    return best;
  }
  function latestFollowupWithNext(model, memberId) {
    var best = null;
    model.followups.forEach(function (f) {
      if (f.member_id === memberId && f.next_followup_date && (!best || f.date > best.date)) best = f;
    });
    return best;
  }

  /** 会员风险分级（BUSINESS_RULES 第 1、2 节；推导展示值，不落库） */
  function classify(model, m, T, P) {
    if (m.contact_opt_out === 'Y') return 'excluded_opt_out';        // 拒绝联系
    if (m.status === 'expired' || diffDays(m.membership_end, T) < 0) return 'excluded_expired'; // 已到期/退出
    if (!lastSessionDate(model, m.member_id)) return 'excluded_no_session';                    // 无训练记录
    if (m.status !== 'active') return 'excluded_sleeping';           // 暂停/沉睡
    var gap = diffDays(T, lastSessionDate(model, m.member_id));
    if (gap >= P.N2) return 'L2';
    if (gap >= P.N1) return 'L1';
    return 'none';
  }

  function computeRiskMap(model, opts) {
    opts = opts || {};
    var T = opts.today || model.today || todayStr();
    var P = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    var map = {};
    model.members.slice().sort(function (a, b) { return a.member_id < b.member_id ? -1 : 1; })
      .forEach(function (m) { map[m.member_id] = classify(model, m, T, P); });
    return map;
  }

  /* ---------- 任务 ID 生成（T-YYYYMMDD-NNNN，全局当日递增，不与既有 ID 冲突） ---------- */

  function makeTaskCounter(model, T) {
    var prefix = 'T-' + compact(T) + '-';
    var max = 0;
    model.tasks.forEach(function (t) {
      var m = /^T-(\d{8})-(\d+)$/.exec(t.task_id);
      if (m && m[1] === compact(T)) max = Math.max(max, parseInt(m[2], 10));
    });
    return function next() { max += 1; return prefix + String(max).padStart(4, '0'); };
  }
  function makeSessionCounter(model, d) {
    var prefix = 'S-' + compact(d) + '-';
    var max = 0;
    model.sessions.forEach(function (s) {
      var m = /^S-(\d{8})-(\d+)$/.exec(s.session_id);
      if (m && m[1] === compact(d)) max = Math.max(max, parseInt(m[2], 10));
    });
    return function next() { max += 1; return prefix + String(max).padStart(4, '0'); };
  }
  function makeFollowupCounter(model, d) {
    var prefix = 'F-' + compact(d) + '-';
    var max = 0;
    model.followups.forEach(function (f) {
      var m = /^F-(\d{8})-(\d+)$/.exec(f.followup_id);
      if (m && m[1] === compact(d)) max = Math.max(max, parseInt(m[2], 10));
    });
    return function next() { max += 1; return prefix + String(max).padStart(4, '0'); };
  }

  /* ---------- 规则引擎 ---------- */

  /**
   * runRules(model, opts) — 每次规则执行返回完整报告（rep），可追踪每一条生成/取消/跳过
   * opts: { today, params }
   */
  function runRules(model, opts) {
    opts = opts || {};
    var T = opts.today || model.today || todayStr();
    var P = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    var rep = {
      today: T, params: P,
      risk: {},                       // member_id → 分类
      created: [],                     // 本次新建任务
      cancelled: [],                   // 本次自动取消（含原因）
      skipped: [],                     // 防重跳过
      suggestCancel: [],               // 拒绝联系会员的存量 open 回访任务（建议人工取消）
      warnings: [],                    // 规则层警告
      totals: {}
    };

    // open 任务索引：member|rule → task
    var openIdx = {};
    function rebuildIndex() {
      openIdx = {};
      model.tasks.forEach(function (t) {
        if (t.status === 'open') {
          var key = t.member_id + '|' + (t.rule_code || '');
          var prev = openIdx[key];
          if (!prev || t.created_date > prev.created_date) openIdx[key] = t;
        }
      });
    }
    rebuildIndex();

    var nextTaskId = makeTaskCounter(model, T);

    function ensureTask(member, rule, dueDate, ownerCoachId, extraNote) {
      var key = member.member_id + '|' + rule;
      if (openIdx[key]) {
        rep.skipped.push({ member_id: member.member_id, rule_code: rule, existing_task_id: openIdx[key].task_id, reason: '同会员同规则已有 open 任务（防重键 member_id+rule_code）' });
        return null;
      }
      var task = {
        task_id: nextTaskId(), member_id: member.member_id, coach_id: ownerCoachId,
        title: RULE_TITLES[rule] + ' [' + member.name + ']', due_date: dueDate,
        status: 'open', source: 'system', rule_code: rule, created_date: T,
        done_date: '', cancelled_date: '', cancel_reason: '',
        notes: extraNote || ''
      };
      model.tasks.push(task);
      model.byId.tasks[task.task_id] = task;
      openIdx[key] = task;
      rep.created.push(task);
      if (dueDate < T) rep.warnings.push({ rule_code: rule, message: '任务 ' + task.task_id + ' 生成即逾期（截止日 ' + dueDate + ' 早于基准日 ' + T + '），请人工核对' });
      return task;
    }

    function cancelOpen(memberId, rule, reason) {
      var key = memberId + '|' + rule;
      var t = openIdx[key];
      if (!t) return null;
      t.status = 'cancelled';
      t.cancelled_date = T;
      t.cancel_reason = reason;
      delete openIdx[key];
      rep.cancelled.push({ task_id: t.task_id, member_id: memberId, rule_code: rule, cancel_reason: reason });
      return t;
    }

    var members = model.members.slice().sort(function (a, b) { return a.member_id < b.member_id ? -1 : 1; });

    members.forEach(function (m) {
      var cat = classify(model, m, T, P);
      rep.risk[m.member_id] = cat;
      var optOut = m.contact_opt_out === 'Y';
      var last = lastSessionDate(model, m.member_id);
      var gap = last ? diffDays(T, last) : null;

      /* --- 到店风险规则 R1A / R1B（唯一输入：sessions.date；拒绝联系/到期/暂停/无记录均排除） --- */
      if (cat === 'L1') {
        cancelOpen(m.member_id, 'R1B', 'member_returned'); // 升级后回落：残留 R1B 取消
        ensureTask(m, 'R1A', T, m.coach_id);
      } else if (cat === 'L2') {
        cancelOpen(m.member_id, 'R1A', 'escalated');       // L1 → L2 升级：R1A 自动取消
        ensureTask(m, 'R1B', T, m.coach_id);
      } else if (cat === 'none') {
        cancelOpen(m.member_id, 'R1A', 'member_returned'); // 到店平息（2.3 节）
        cancelOpen(m.member_id, 'R1B', 'member_returned');
      }

      /* --- R2 未接通再跟（参数 D1 待定稿） --- */
      if (!optOut) {
        var lf = latestFollowup(model, m.member_id);
        if (lf && lf.result === 'no_answer' && diffDays(T, lf.date) >= P.D1)
          ensureTask(m, 'R2', T, m.coach_id);
      }

      /* --- R3 沉睡唤醒（sleeping + K 周无跟进；参数 K 待定稿） --- */
      if (!optOut && m.status === 'sleeping') {
        var lf3 = latestFollowup(model, m.member_id);
        if (!lf3 || diffDays(T, lf3.date) >= P.K)
          ensureTask(m, 'R3', T, m.coach_id);
      }

      /* --- R4 会籍到期提醒（窗口 T1：到期前 7 天至到期后 7 天，对称默认值待业务方确认；
             表格 status=expired 视为已结案，不再提醒；拒绝联系会员仍生成，但标记提示） --- */
      var endGap = diffDays(m.membership_end, T);
      if (m.status !== 'expired' && endGap >= -P.T1 && endGap <= P.T1) {
        var note = optOut ? '会员拒绝联系，店长判断执行方式' : '';
        var t4 = ensureTask(m, 'R4', T, m.coach_id, note);
        if (t4 && optOut)
          rep.warnings.push({ rule_code: 'R4', message: '任务 ' + t4.task_id + ' 对应会员已拒绝联系，生成续费提醒但请店长判断执行方式' });
      }

      /* --- R5 首次带练（入会 D5 天无训练记录；拒绝联系不生成，见 BUSINESS_RULES 8.1） --- */
      if (!optOut && m.status === 'active' && !last && diffDays(T, m.join_date) >= P.D5 && endGap >= 0)
        ensureTask(m, 'R5', T, m.coach_id);

      /* --- R-FN 按约定跟进（由 followups.next_followup_date 派生，责任人=发起跟进教练） --- */
      if (!optOut) {
        var fn = latestFollowupWithNext(model, m.member_id);
        if (fn) ensureTask(m, 'R-FN', fn.next_followup_date, fn.coach_id);
      }
    });

    /* --- 拒绝联系会员的存量 open 回访任务 → 建议取消清单（不自动取消，7 节） --- */
    model.tasks.forEach(function (t) {
      if (t.status !== 'open') return;
      var m = model.byId.members[t.member_id];
      if (m && m.contact_opt_out === 'Y' && CONTACT_RULES.indexOf(t.rule_code) >= 0)
        rep.suggestCancel.push({ task_id: t.task_id, member_id: t.member_id, rule_code: t.rule_code, reason: 'opt_out' });
    });

    /* --- 状态一致性警告（需基准日，随规则执行输出；仅进入本次报告，不重复累积到导入校验报告） --- */
    statusMismatchWarnings(model, T, P).forEach(function (w) { rep.warnings.push(w); });

    /* --- 汇总（第 8 项要求：每次执行输出结果摘要） --- */
    var catCounts = {};
    Object.keys(rep.risk).forEach(function (id) { catCounts[rep.risk[id]] = (catCounts[rep.risk[id]] || 0) + 1; });
    var createdByRule = {};
    rep.created.forEach(function (t) { createdByRule[t.rule_code] = (createdByRule[t.rule_code] || 0) + 1; });
    var openCount = 0, overdueCount = 0;
    model.tasks.forEach(function (t) {
      if (t.status === 'open') {
        openCount++;
        if (t.due_date < T) overdueCount++;
      }
    });
    rep.totals = {
      members: model.members.length,
      risk: catCounts, created: rep.created.length, createdByRule: createdByRule,
      cancelled: rep.cancelled.length, skipped: rep.skipped.length,
      suggestCancel: rep.suggestCancel.length, openTasks: openCount, overdueOpenTasks: overdueCount
    };
    return rep;
  }

  /** 结果摘要文本（控制台/报告用） */
  function summaryText(rep) {
    var L = [];
    L.push('=== 规则执行摘要（基准日 ' + rep.today + '，参数 ' + JSON.stringify(rep.params) + '） ===');
    L.push('有效会员: ' + rep.totals.members + ' | 风险分布: ' + Object.keys(rep.totals.risk).sort().map(function (k) { return k + '=' + rep.totals.risk[k]; }).join(', '));
    L.push('新建任务: ' + rep.totals.created + '（' + Object.keys(rep.totals.createdByRule).sort().map(function (k) { return k + '=' + rep.totals.createdByRule[k]; }).join(', ') + '）');
    L.push('自动取消: ' + rep.totals.cancelled + ' | 防重跳过: ' + rep.totals.skipped + ' | 建议取消(拒绝联系): ' + rep.totals.suggestCancel);
    L.push('当前 open 任务: ' + rep.totals.openTasks + '（其中逾期 ' + rep.totals.overdueOpenTasks + '）');
    rep.created.forEach(function (t) { L.push('  + ' + t.task_id + ' [' + t.rule_code + '] ' + t.title + ' → 责任人 ' + t.coach_id + '，截止 ' + t.due_date); });
    rep.cancelled.forEach(function (c) { L.push('  - ' + c.task_id + ' [' + c.rule_code + '] 自动取消，原因: ' + c.cancel_reason); });
    rep.skipped.forEach(function (s) { L.push('  = ' + s.member_id + ' ' + s.rule_code + ' 已有 open 任务 ' + s.existing_task_id + '，跳过'); });
    if (rep.warnings.length) { L.push('规则层警告: ' + rep.warnings.length + ' 条'); rep.warnings.forEach(function (w) { L.push('  ! ' + w.message); }); }
    return L.join('\n');
  }

  /* ---------- 任务生命周期（BUSINESS_RULES 第 3 节） ---------- */

  function findTask(model, taskId) { return model.byId.tasks[taskId]; }

  /** 完成：open → done，done_date 必填；早于 created_date 仅警告（疑似补录） */
  function completeTask(model, taskId, doneDate) {
    var t = findTask(model, taskId);
    if (!t) return { ok: false, error: 'task_not_found', message: '任务不存在：' + taskId };
    if (t.status !== 'open') return { ok: false, error: 'task_not_open', message: '任务状态为 ' + t.status + '，只有 open 任务可完成' };
    if (!doneDate || !V.isValidDate(doneDate)) return { ok: false, error: 'invalid_done_date', message: '完成日期必填且须为 YYYY-MM-DD' };
    var warnings = [];
    if (doneDate < t.created_date) warnings.push('完成日期早于创建日期（疑似补录）：' + doneDate + ' < ' + t.created_date);
    t.status = 'done';
    t.done_date = doneDate;
    return { ok: true, task: t, warnings: warnings };
  }

  var CANCEL_REASONS = ['duplicate', 'member_returned', 'escalated', 'opt_out', 'other'];

  /** 取消：open → cancelled，原因必填（枚举），other 须在 notes 说明 */
  function cancelTask(model, taskId, reason, notes, cancelDate) {
    var t = findTask(model, taskId);
    if (!t) return { ok: false, error: 'task_not_found', message: '任务不存在：' + taskId };
    if (t.status !== 'open') return { ok: false, error: 'task_not_open', message: '任务状态为 ' + t.status + '，只有 open 任务可取消' };
    if (CANCEL_REASONS.indexOf(reason) < 0) return { ok: false, error: 'invalid_reason', message: '取消原因非法：' + reason + '（允许 ' + CANCEL_REASONS.join('/') + '）' };
    if (reason === 'other' && !notes) return { ok: false, error: 'notes_required', message: 'cancel_reason=other 必须填写 notes 说明' };
    t.status = 'cancelled';
    t.cancelled_date = cancelDate || model.today || todayStr();
    t.cancel_reason = reason;
    if (notes) t.notes = notes;
    return { ok: true, task: t };
  }

  /** 新增训练记录（录入入口，含外键与日期校验；到店平息由下次 runRules 触发） */
  function addSession(model, data) {
    var T = model.today || todayStr();
    if (!model.byId.members[data.member_id]) return { ok: false, error: 'invalid_member', message: '会员不存在：' + data.member_id };
    if (!model.byId.coaches[data.coach_id]) return { ok: false, error: 'invalid_coach', message: '教练不存在：' + data.coach_id };
    if (!V.isValidDate(data.date)) return { ok: false, error: 'invalid_date', message: '日期非法：' + data.date };
    if (data.date > T) return { ok: false, error: 'future_date', message: '不允许未来日期：' + data.date };
    if (!data.content) return { ok: false, error: 'content_required', message: '训练内容必填' };
    var s = {
      session_id: makeSessionCounter(model, data.date)(),
      member_id: data.member_id, coach_id: data.coach_id, date: data.date,
      duration_min: data.duration_min || '', content: data.content,
      rating: data.rating || '', next_plan: data.next_plan || '',
      /* V1.1 快捷训练记录（可选）：类型 / 完成情况 / 会员感受 / 下次重点 / 动作行 */
      session_type: data.session_type || '', completion: data.completion || '',
      feeling: data.feeling || '', next_focus: String(data.next_focus || '').trim(),
      exercises: data.exercises || '', _row: 0
    };
    model.sessions.push(s);
    model.byId.sessions[s.session_id] = s;
    return { ok: true, session: s };
  }

  /** 新增跟进记录（录入入口，含外键/日期/枚举校验；约定日早于当日仅警告，与 BUSINESS_RULES 3.5 一致） */
  function addFollowup(model, data) {
    var T = model.today || todayStr();
    var CHANNELS = ['wechat', 'phone', 'in_person'];
    var RESULTS = ['reached', 'no_answer', 'promised', 'refused'];
    if (!model.byId.members[data.member_id]) return { ok: false, error: 'invalid_member', message: '会员不存在：' + data.member_id };
    if (!model.byId.coaches[data.coach_id]) return { ok: false, error: 'invalid_coach', message: '教练不存在：' + data.coach_id };
    if (!V.isValidDate(data.date)) return { ok: false, error: 'invalid_date', message: '跟进日期非法：' + data.date };
    if (data.date > T) return { ok: false, error: 'future_date', message: '不允许未来日期：' + data.date };
    if (CHANNELS.indexOf(data.channel) < 0) return { ok: false, error: 'invalid_channel', message: '跟进渠道非法：' + data.channel + '（允许 ' + CHANNELS.join('/') + '）' };
    if (RESULTS.indexOf(data.result) < 0) return { ok: false, error: 'invalid_result', message: '跟进结果非法：' + data.result + '（允许 ' + RESULTS.join('/') + '）' };
    var warnings = [];
    if (data.next_followup_date) {
      if (!V.isValidDate(data.next_followup_date)) return { ok: false, error: 'invalid_next_date', message: '下次跟进日格式非法：' + data.next_followup_date };
      if (data.next_followup_date < data.date) warnings.push('下次跟进日早于本次跟进日，生成的 R-FN 任务将立即逾期（' + data.next_followup_date + ' < ' + data.date + '）');
    }
    var f = {
      followup_id: makeFollowupCounter(model, data.date)(),
      member_id: data.member_id, coach_id: data.coach_id, date: data.date,
      channel: data.channel, result: data.result,
      content: data.content || '', next_followup_date: data.next_followup_date || '',
      /* 今日优先处理模块（可选）：关联任务 / 会员反馈 / 下一步动作 */
      task_id: data.task_id || '', member_feedback: data.member_feedback || '',
      next_action: data.next_action || '',
      /* V1.1 结果细分（可选，人工可读；result 仍是规则权威） */
      outcome: data.outcome || '', _row: 0
    };
    model.followups.push(f);
    model.byId.followups[f.followup_id] = f;
    return { ok: true, followup: f, warnings: warnings };
  }

  /** 顺序 ID 生成器：取列表中 prefix+数字 的最大值 +1，按指定位数补零（只增不复用，与 ID 规则一致） */
  function nextSeqId(list, field, prefix, width) {
    var max = 0;
    list.forEach(function (r) {
      var m = new RegExp('^' + prefix + '(\\d+)$').exec(r[field] || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + String(max + 1).padStart(width, '0');
  }

  /** 新增会员（页面手工录入入口；校验与 CSV 导入同规：姓名/手机号/责任教练/日期/状态/opt_out 联动） */
  function addMember(model, data) {
    var T = model.today || todayStr();
    var name = String(data.name || '').trim();
    var phone = String(data.phone || '').trim();
    if (!name) return { ok: false, error: 'name_required', message: '会员姓名必填' };
    if (!/^1\d{10}$/.test(phone)) return { ok: false, error: 'invalid_phone', message: '手机号格式非法：' + phone + '（需 11 位数字）' };
    var coach = model.byId.coaches[data.coach_id];
    if (!coach) return { ok: false, error: 'invalid_coach', message: '责任教练不存在：' + data.coach_id };
    var status = data.status || 'active';
    if (['active', 'sleeping', 'expired'].indexOf(status) < 0) return { ok: false, error: 'invalid_status', message: '会员状态非法：' + status };
    if (!V.isValidDate(data.join_date)) return { ok: false, error: 'invalid_join_date', message: '入会日期格式非法：' + data.join_date };
    if (!V.isValidDate(data.membership_end)) return { ok: false, error: 'invalid_end_date', message: '会籍到期日格式非法：' + data.membership_end };
    if (data.membership_end < data.join_date) return { ok: false, error: 'end_before_join', message: '会籍到期日不能早于入会日期（' + data.membership_end + ' < ' + data.join_date + '）' };
    var optOut = data.contact_opt_out === 'Y' ? 'Y' : 'N';
    if (optOut === 'Y' && !V.isValidDate(data.opt_out_date)) return { ok: false, error: 'opt_out_date_required', message: '登记拒绝联系时必须填写登记日期' };
    var warnings = [];
    if (data.join_date > T) warnings.push('入会日期晚于基准日（预登记），在到店训练前不参与风险统计');
    if (coach.active === 'N') warnings.push('责任教练 ' + coach.name + ' 已离职，会员将出现在「离职教练挂靠」提醒中，请尽快安排接管教练');
    model.members.forEach(function (m) {
      if (m.phone === phone) warnings.push('手机号 ' + phone + ' 与已有会员 ' + m.member_id + '（' + m.name + '）重复，请核对是否重复建档');
    });
    var mem = {
      member_id: nextSeqId(model.members, 'member_id', 'M', 4),
      name: name, phone: phone, coach_id: data.coach_id,
      join_date: data.join_date, membership_end: data.membership_end, status: status,
      contact_opt_out: optOut, opt_out_date: optOut === 'Y' ? data.opt_out_date : '',
      opt_out_reason: optOut === 'Y' ? (String(data.opt_out_reason || '').trim()) : '',
      goal: String(data.goal || '').trim(), notes: String(data.notes || '').trim(),
      /* V1.1 会员档案补充（可选；未知留空，不得默认视为 0） */
      planned_per_week: data.planned_per_week || '',
      next_appointment_date: data.next_appointment_date || '',
      no_show_count: data.no_show_count || '',
      pt_sessions_left: data.pt_sessions_left || '',
      package_end_date: data.package_end_date || '',
      pause_start_date: data.pause_start_date || '',
      pause_end_date: data.pause_end_date || '',
      data_incomplete: data.data_incomplete === 'Y' ? 'Y' : 'N',
      _row: 0
    };
    model.members.push(mem);
    model.byId.members[mem.member_id] = mem;
    return { ok: true, member: mem, warnings: warnings };
  }

  /** 更新会员档案（人工维护入口；仅改传入了的字段，未传字段保持原值；不改 member_id/phone 唯一性规则） */
  function updateMember(model, memberId, patch) {
    var mem = model.byId.members[memberId];
    if (!mem) return { ok: false, error: 'member_not_found', message: '会员不存在：' + memberId };
    var warnings = [];
    if (patch.status !== undefined) {
      if (['active', 'sleeping', 'expired'].indexOf(patch.status) < 0) return { ok: false, error: 'invalid_status', message: '会员状态非法：' + patch.status };
      mem.status = patch.status;
    }
    if (patch.coach_id !== undefined) {
      if (!model.byId.coaches[patch.coach_id]) return { ok: false, error: 'invalid_coach', message: '责任教练不存在：' + patch.coach_id };
      if (model.byId.coaches[patch.coach_id].active === 'N') warnings.push('责任教练已离职，建议安排接管');
      mem.coach_id = patch.coach_id;
    }
    ['goal', 'notes'].forEach(function (k) { if (patch[k] !== undefined) mem[k] = String(patch[k] || '').trim(); });
    ['planned_per_week', 'no_show_count', 'pt_sessions_left'].forEach(function (k) {
      if (patch[k] === undefined) return;
      var v = String(patch[k] === null ? '' : patch[k]).trim();
      if (v === '') { mem[k] = ''; return; }           /* 清空 = 未收集，不视为 0 */
      if (!/^\d+$/.test(v)) { warnings.push(k + ' 只能填非负整数，已忽略：' + v); return; }
      mem[k] = v;
    });
    ['next_appointment_date', 'package_end_date', 'pause_start_date', 'pause_end_date'].forEach(function (k) {
      if (patch[k] === undefined) return;
      var v = String(patch[k] || '').trim();
      if (v === '') { mem[k] = ''; return; }
      if (!V.isValidDate(v)) { warnings.push(k + ' 日期格式非法，已忽略：' + v); return; }
      mem[k] = v;
    });
    if (patch.pause_start_date !== undefined || patch.pause_end_date !== undefined) {
      if (mem.pause_start_date && mem.pause_end_date && mem.pause_end_date < mem.pause_start_date) {
        warnings.push('暂停结束日早于暂停开始日，请核对');
      }
    }
    if (patch.package_end_date !== undefined && mem.package_end_date && mem.join_date && mem.package_end_date < mem.join_date) {
      warnings.push('课包到期日早于入会日期，请核对');
    }
    if (patch.data_incomplete !== undefined) mem.data_incomplete = patch.data_incomplete === 'Y' ? 'Y' : 'N';
    return { ok: true, member: mem, warnings: warnings };
  }

  /** 新增教练（页面手工录入入口；姓名必填，手机号可空但须合法，离职建档仅警告） */
  function addCoach(model, data) {
    var name = String(data.name || '').trim();
    var phone = String(data.phone || '').trim();
    if (!name) return { ok: false, error: 'name_required', message: '教练姓名必填' };
    if (phone && !/^1\d{10}$/.test(phone)) return { ok: false, error: 'invalid_phone', message: '手机号格式非法：' + phone + '（11 位数字，可留空）' };
    var role = data.role || 'coach';
    if (['coach', 'manager'].indexOf(role) < 0) return { ok: false, error: 'invalid_role', message: '角色非法：' + role + '（允许 coach/manager）' };
    var active = data.active === 'N' ? 'N' : 'Y';
    var warnings = [];
    if (active === 'N') warnings.push('新教练以离职状态建档，不会参与新任务分配');
    model.coaches.forEach(function (c) {
      if (c.name === name) warnings.push('姓名与已有教练 ' + c.coach_id + '（' + c.name + '）相同，请确认是否重复建档');
    });
    var c = {
      coach_id: nextSeqId(model.coaches, 'coach_id', 'C', 3),
      name: name, role: role, phone: phone, active: active, _row: 0
    };
    model.coaches.push(c);
    model.byId.coaches[c.coach_id] = c;
    return { ok: true, coach: c, warnings: warnings };
  }

  /** 会员聚合视图（总览页数据来源） */
  function memberOverview(model, memberId, opts) {
    opts = opts || {};
    var T = opts.today || model.today || todayStr();
    var P = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    var m = model.byId.members[memberId];
    if (!m) return null;
    return {
      member: m,
      last_session_date: lastSessionDate(model, memberId),
      risk: classify(model, m, T, P),
      session_count: model.sessions.filter(function (s) { return s.member_id === memberId; }).length,
      followup_count: model.followups.filter(function (f) { return f.member_id === memberId; }).length,
      open_tasks: model.tasks.filter(function (t) { return t.member_id === memberId && t.status === 'open'; }).length
    };
  }

  return {
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    loadModel: loadModel,
    computeRiskMap: computeRiskMap,
    classify: classify,
    runRules: runRules,
    summaryText: summaryText,
    completeTask: completeTask,
    cancelTask: cancelTask,
    addSession: addSession,
    addFollowup: addFollowup,
    addMember: addMember,
    updateMember: updateMember,
    addCoach: addCoach,
    nextSeqId: nextSeqId,
    memberOverview: memberOverview,
    lastSessionDate: lastSessionDate,
    latestFollowup: latestFollowup
  };
});
