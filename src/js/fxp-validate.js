/* Fitness XP V1 — 字段校验模块（依据 docs/DATA_DICTIONARY.md；UMD） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.validate = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 基础校验工具 ---------- */

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isValidDate(s) {
    if (!DATE_RE.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  /* ---------- 表结构（与 DATA_DICTIONARY 一致） ---------- */

  var SCHEMAS = {
    coaches: {
      idField: 'coach_id',
      fields: [
        { name: 'coach_id', type: 'id', required: true, pattern: /^C\d{3,}$/, label: '教练ID' },
        { name: 'name', type: 'text', required: true, max: 20, label: '姓名' },
        /* 角色枚举统一为 coach/manager（与 fxp-engine.js addCoach 及页面 UI 一致）。
           历史 CSV 中的旧值 admin 在导入时自动归一为 manager（见 LEGACY_MAPS），不再因枚举非法被拒收。 */
        { name: 'role', type: 'enum', required: true, values: ['coach', 'manager'], label: '角色' },
        { name: 'active', type: 'bool', required: true, label: '在职' },
        { name: 'phone', type: 'phone', required: false, label: '手机号' }
      ]
    },
    members: {
      idField: 'member_id',
      fields: [
        { name: 'member_id', type: 'id', required: true, pattern: /^M\d{4,}$/, label: '会员ID' },
        { name: 'name', type: 'text', required: true, max: 20, label: '姓名' },
        { name: 'phone', type: 'phone', required: true, label: '手机号' },
        { name: 'coach_id', type: 'text', required: true, label: '责任教练ID' },
        { name: 'join_date', type: 'date', required: true, label: '入会日期' },
        { name: 'membership_end', type: 'date', required: true, label: '会籍到期日' },
        { name: 'status', type: 'enum', required: true, values: ['active', 'sleeping', 'expired'], label: '状态' },
        { name: 'contact_opt_out', type: 'bool', required: true, label: '拒绝联系' },
        { name: 'opt_out_date', type: 'date', required: false, label: '拒绝登记日' },
        { name: 'opt_out_reason', type: 'text', required: false, max: 100, label: '拒绝原因' },
        { name: 'goal', type: 'text', required: false, max: 50, label: '训练目标' },
        { name: 'notes', type: 'text', required: false, max: 200, label: '备注' },
        /* ---- V1.1 会员档案补充列（全部可选；未知值留空，不得默认视为 0） ---- */
        { name: 'planned_per_week', type: 'int', required: false, warnRange: [1, 14], label: '计划每周训练次数' },
        { name: 'next_appointment_date', type: 'date', required: false, label: '下次预约日期' },
        { name: 'no_show_count', type: 'int', required: false, warnRange: [0, 99], label: '累计预约未到次数' },
        { name: 'pt_sessions_left', type: 'int', required: false, warnRange: [0, 999], label: '剩余私教课时' },
        { name: 'package_end_date', type: 'date', required: false, label: '课包到期日' },
        { name: 'pause_start_date', type: 'date', required: false, label: '暂停开始日' },
        { name: 'pause_end_date', type: 'date', required: false, label: '暂停结束日' },
        { name: 'data_incomplete', type: 'bool', required: false, label: '数据不完整标记' }
      ]
    },
    sessions: {
      idField: 'session_id',
      fields: [
        { name: 'session_id', type: 'id', required: true, pattern: /^S-\d{8}-\d{4,}$/, label: '记录ID' },
        { name: 'member_id', type: 'text', required: true, label: '会员ID' },
        { name: 'coach_id', type: 'text', required: true, label: '教练ID' },
        { name: 'date', type: 'date', required: true, label: '训练日期' },
        { name: 'duration_min', type: 'int', required: false, warnRange: [15, 300], label: '时长(分钟)' },
        { name: 'content', type: 'text', required: true, max: 200, label: '训练内容' },
        { name: 'rating', type: 'enum', required: false, values: ['good', 'normal', 'poor'], label: '状态评级' },
        { name: 'next_plan', type: 'text', required: false, max: 200, label: '下次建议' },
        /* ---- V1.1 快捷训练记录补充列（全部可选；旧 CSV 缺列照常导入） ---- */
        { name: 'session_type', type: 'enum', required: false, values: ['strength', 'fat_loss', 'conditioning', 'rehab', 'other'], label: '训练类型' },
        { name: 'completion', type: 'enum', required: false, values: ['full', 'partial', 'none'], label: '完成情况' },
        { name: 'feeling', type: 'enum', required: false, values: ['good', 'normal', 'fatigue', 'pain', 'other'], label: '会员感受' },
        { name: 'next_focus', type: 'text', required: false, max: 120, label: '下次训练重点' },
        { name: 'exercises', type: 'text', required: false, max: 500, label: '动作记录' }
      ]
    },
    followups: {
      idField: 'followup_id',
      fields: [
        { name: 'followup_id', type: 'id', required: true, pattern: /^F-\d{8}-\d{4,}$/, label: '记录ID' },
        { name: 'member_id', type: 'text', required: true, label: '会员ID' },
        { name: 'coach_id', type: 'text', required: true, label: '教练ID' },
        { name: 'date', type: 'date', required: true, label: '跟进日期' },
        { name: 'channel', type: 'enum', required: true, values: ['wechat', 'phone', 'in_person'], label: '渠道' },
        { name: 'result', type: 'enum', required: true, values: ['reached', 'no_answer', 'promised', 'refused'], label: '结果' },
        { name: 'content', type: 'text', required: false, max: 200, label: '内容' },
        { name: 'next_followup_date', type: 'date', required: false, label: '下次跟进日' },
        /* 今日优先处理模块新增（全部可选，旧 CSV 缺列照常导入） */
        { name: 'task_id', type: 'text', required: false, max: 20, label: '关联任务ID' },
        { name: 'member_feedback', type: 'text', required: false, max: 200, label: '会员反馈' },
        { name: 'next_action', type: 'enum', required: false, values: ['none', 'follow_up', 'schedule'], label: '下一步动作' },
        /* ---- V1.1 跟进结果细分（result 仍是规则权威；outcome 为人工可读细分，不改变规则语义） ---- */
        { name: 'outcome', type: 'enum', required: false, values: ['resumed', 'need_more', 'temporarily_unable', 'unreachable', 'paused_or_quit', 'other'], label: '结果细分' }
      ]
    },
    tasks: {
      idField: 'task_id',
      fields: [
        { name: 'task_id', type: 'id', required: true, pattern: /^T-\d{8}-\d{4,}$/, label: '任务ID' },
        { name: 'member_id', type: 'text', required: true, label: '会员ID' },
        /* coach_id 放宽为可选：待分配任务允许留空（今日优先：无可用教练时进入待分配队列） */
        { name: 'coach_id', type: 'text', required: false, label: '责任人ID' },
        { name: 'title', type: 'text', required: true, max: 50, label: '标题' },
        { name: 'due_date', type: 'date', required: true, label: '截止日' },
        { name: 'status', type: 'enum', required: true, values: ['open', 'done', 'cancelled'], label: '状态' },
        { name: 'source', type: 'enum', required: true, values: ['manual', 'system'], label: '来源' },
        { name: 'rule_code', type: 'text', required: false, max: 20, label: '规则代码' },
        { name: 'created_date', type: 'date', required: true, label: '创建日' },
        { name: 'done_date', type: 'date', required: false, label: '完成日' },
        { name: 'cancelled_date', type: 'date', required: false, label: '取消日' },
        { name: 'cancel_reason', type: 'enum', required: false, values: ['duplicate', 'member_returned', 'escalated', 'opt_out', 'other'], label: '取消原因' },
        { name: 'notes', type: 'text', required: false, max: 200, label: '备注' },
        /* ---- 今日优先处理模块新增列（全部可选；task_status 承载 6 态状态机，status 保留关闭维度） ---- */
        { name: 'task_type', type: 'enum', required: false, values: ['followup', 'renewal', 'first_session', 'review', 'other'], label: '任务类型' },
        { name: 'task_status', type: 'enum', required: false, values: ['unassigned', 'pending', 'in_progress', 'review', 'done', 'cancelled'], label: '任务状态' },
        { name: 'risk_level', type: 'enum', required: false, values: ['normal', 'watch', 'medium', 'high'], label: '风险等级' },
        { name: 'risk_reason', type: 'text', required: false, max: 300, label: '风险原因' },
        { name: 'priority', type: 'enum', required: false, values: ['high', 'normal', 'low'], label: '优先级' },
        { name: 'started_at', type: 'date', required: false, label: '开始处理日' },
        { name: 'completed_by', type: 'text', required: false, max: 20, label: '完成人' },
        { name: 'result_code', type: 'enum', required: false, values: ['reached', 'no_answer', 'promised', 'refused', 'other', 'none'], label: '执行结果' },
        { name: 'next_followup_at', type: 'date', required: false, label: '下次跟进时间' },
        { name: 'assigned_by', type: 'text', required: false, max: 20, label: '分配人' },
        { name: 'assigned_at', type: 'date', required: false, label: '分配时间' },
        { name: 'prev_coach_id', type: 'text', required: false, max: 20, label: '原负责人ID' },
        { name: 'reassign_reason', type: 'text', required: false, max: 100, label: '重新分配原因' },
        { name: 'updated_at', type: 'date', required: false, label: '最近更新日' }
      ]
    },
    xp_events: {
      idField: 'event_id',
      fields: [
        { name: 'event_id', type: 'id', required: true, pattern: /^X-\d{8}-\d{4,}$/, label: '事件ID' },
        { name: 'member_id', type: 'text', required: true, label: '会员ID' },
        { name: 'event_type', type: 'enum', required: true, values: ['session', 'weekly_streak', 'referral', 'renewal', 'manual_adjust'], label: '事件类型' },
        { name: 'points', type: 'int', required: true, label: '积分' },
        { name: 'date', type: 'date', required: true, label: '日期' },
        { name: 'note', type: 'text', required: false, max: 200, label: '说明' }
      ]
    }
  };

  /* ---------- 旧值归一（历史数据兼容） ----------
   * 背景：coaches.role 的历史枚举含 admin，与引擎层（coach/manager）和页面 UI（教练/店长）不一致，
   *       导致「页面录入店长 → 导出 CSV → 再导入」被拒收。
   * 做法：枚举统一为 coach/manager（严格），导入时对旧值做确定性归一并留痕，避免旧 CSV 整行报废。
   * 注意：标准表头的 CSV 不经过 fxp-adapt，故归一必须在此处完成。
   */
  var LEGACY_MAPS = {
    coaches: {
      role: { admin: 'manager', 管理员: 'manager', 店长: 'manager', 教练: 'coach' }
    }
  };

  /** 就地归一一条记录；任何改写都追加一条警告留痕。 */
  function normalizeRow(tableName, rec, warns) {
    var map = LEGACY_MAPS[tableName];
    if (!map) return rec;
    Object.keys(map).forEach(function (field) {
      var raw = rec[field] === undefined || rec[field] === null ? '' : String(rec[field]).trim();
      if (!raw) return;
      var to = map[field][raw];
      if (to === undefined || to === raw) return;
      rec[field] = to;
      warns.push({
        row: rec._row, field: field,
        message: '角色旧值「' + raw + '」已归一为「' + to + '」（枚举统一为 coach/manager，建议后续直接写新值）'
      });
    });
    return rec;
  }

  /* ---------- 单字段校验器 ---------- */

  function makeChecker(f) {
    return function (rec, errs, warns) {
      var v = rec[f.name] !== undefined ? String(rec[f.name]).trim() : '';
      if (f.required && v === '') {
        errs.push({ row: rec._row, field: f.name, message: f.label + '为必填项，不能为空' });
        return;
      }
      if (v === '') return; // 可选字段留空合法
      switch (f.type) {
        case 'date':
          if (!isValidDate(v)) errs.push({ row: rec._row, field: f.name, message: f.label + '日期格式非法：' + v + '（要求 YYYY-MM-DD）' });
          break;
        case 'enum':
          if (f.values.indexOf(v) < 0) errs.push({ row: rec._row, field: f.name, message: f.label + '枚举值非法：' + v + '（允许 ' + f.values.join('/') + '）' });
          break;
        case 'bool':
          if (v !== 'Y' && v !== 'N') errs.push({ row: rec._row, field: f.name, message: f.label + '布尔值非法：' + v + '（允许 Y/N）' });
          break;
        case 'int':
          if (!/^-?\d+$/.test(v)) errs.push({ row: rec._row, field: f.name, message: f.label + '必须为整数：' + v });
          else {
            var n = parseInt(v, 10);
            if (f.warnRange && (n < f.warnRange[0] || n > f.warnRange[1]))
              warns.push({ row: rec._row, field: f.name, message: f.label + '超出建议范围 ' + f.warnRange[0] + '-' + f.warnRange[1] + '：' + v });
          }
          break;
        case 'text':
          if (f.max && v.length > f.max) warns.push({ row: rec._row, field: f.name, message: f.label + '长度超过 ' + f.max + ' 字符' });
          break;
        case 'id':
          if (f.pattern && !f.pattern.test(v)) warns.push({ row: rec._row, field: f.name, message: f.label + '格式与规范不符：' + v + '（行为保留，建议修正）' });
          break;
        case 'phone':
          if (!/^\d{11}$/.test(v)) warns.push({ row: rec._row, field: f.name, message: f.label + '格式异常：' + v });
          break;
      }
    };
  }

  /* ---------- 条件必填（依据 DATA_DICTIONARY 各表校验规则列） ---------- */

  var CONDITIONAL = {
    members: function (rec, errs) {
      if (rec.contact_opt_out === 'Y' && !rec.opt_out_date)
        errs.push({ row: rec._row, field: 'opt_out_date', message: '拒绝联系（contact_opt_out=Y）必须填写拒绝登记日 opt_out_date' });
      if (rec.join_date && rec.membership_end && isValidDate(rec.join_date) && isValidDate(rec.membership_end) && rec.join_date > rec.membership_end)
        errs.push({ row: rec._row, field: 'join_date', message: '入会日期晚于会籍到期日：' + rec.join_date + ' > ' + rec.membership_end });
    },
    followups: function (rec, errs, warns) {
      if (rec.date && rec.next_followup_date && isValidDate(rec.date) && isValidDate(rec.next_followup_date) && rec.next_followup_date < rec.date)
        warns.push({ row: rec._row, field: 'next_followup_date', message: '下次跟进日早于本次跟进日：' + rec.next_followup_date + ' < ' + rec.date });
    },
    tasks: function (rec, errs, warns) {
      if (rec.status === 'done' && !rec.done_date)
        errs.push({ row: rec._row, field: 'done_date', message: 'status=done 必须填写完成日期 done_date' });
      if (rec.status === 'cancelled') {
        if (!rec.cancelled_date) errs.push({ row: rec._row, field: 'cancelled_date', message: 'status=cancelled 必须填写取消日期 cancelled_date' });
        if (!rec.cancel_reason) errs.push({ row: rec._row, field: 'cancel_reason', message: 'status=cancelled 必须填写取消原因 cancel_reason' });
      }
      if (rec.cancel_reason === 'other' && !rec.notes)
        errs.push({ row: rec._row, field: 'notes', message: 'cancel_reason=other 必须在 notes 说明原因' });
      if (rec.source === 'system' && !rec.rule_code)
        errs.push({ row: rec._row, field: 'rule_code', message: 'source=system 必须填写生成规则代码 rule_code' });
      if (rec.status === 'done' && rec.done_date && rec.created_date && isValidDate(rec.done_date) && isValidDate(rec.created_date) && rec.done_date < rec.created_date)
        warns.push({ row: rec._row, field: 'done_date', message: '完成日期早于创建日期（疑似补录）：' + rec.done_date + ' < ' + rec.created_date });
      /* 今日优先处理模块：task_status 与 status 一致性（不拒收，仅警告，兼容历史数据） */
      if (rec.task_status) {
        var active = ['unassigned', 'pending', 'in_progress', 'review'];
        if (active.indexOf(rec.task_status) >= 0 && rec.status !== 'open')
          warns.push({ row: rec._row, field: 'task_status', message: 'task_status=' + rec.task_status + ' 为未完成态，但 status=' + rec.status + '，已按 status 关闭维度处理' });
        if (rec.task_status === 'done' && rec.status !== 'done')
          warns.push({ row: rec._row, field: 'task_status', message: 'task_status=done 与 status=' + rec.status + ' 不一致，建议核对' });
        if (rec.task_status === 'cancelled' && rec.status !== 'cancelled')
          warns.push({ row: rec._row, field: 'task_status', message: 'task_status=cancelled 与 status=' + rec.status + ' 不一致，建议核对' });
        if (rec.task_status === 'done' && !rec.done_date)
          errs.push({ row: rec._row, field: 'done_date', message: 'task_status=done 必须填写完成日期 done_date' });
        if (rec.task_status === 'cancelled' && !rec.cancel_reason)
          errs.push({ row: rec._row, field: 'cancel_reason', message: 'task_status=cancelled 必须填写取消原因 cancel_reason' });
      }
    }
  };

  /* ---------- 表级校验入口 ---------- */

  /** header 校验：必填列缺失 → 整文件不可用 */
  function validateHeader(tableName, header) {
    var schema = SCHEMAS[tableName];
    if (!schema) return { ok: false, missing: [], message: '未知表名：' + tableName };
    var missing = schema.fields.filter(function (f) { return f.required && header.indexOf(f.name) < 0; }).map(function (f) { return f.name; });
    return missing.length
      ? { ok: false, missing: missing, message: '缺少必填列：' + missing.join(', ') }
      : { ok: true, missing: [] };
  }

  /** 行级校验：错误行拒收（不进入后续分析），警告行保留。ID 重复：保留首行，后到行拒收。 */
  function validateTable(tableName, records) {
    var schema = SCHEMAS[tableName];
    if (!schema) return { accepted: [], errors: [{ row: 0, field: '', message: '未知表名：' + tableName }], warnings: [] };
    var errors = [], warnings = [], accepted = [], seen = {};
    var checkers = schema.fields.map(makeChecker);
    records.forEach(function (rec) {
      var errs = [], warns = [];
      normalizeRow(tableName, rec, warns);   /* 旧值归一必须在字段校验之前 */
      checkers.forEach(function (ch) { ch(rec, errs, warns); });
      if (CONDITIONAL[tableName]) CONDITIONAL[tableName](rec, errs, warns);
      if (errs.length === 0) {
        var idv = rec[schema.idField];
        if (seen[idv]) errs.push({ row: rec._row, field: schema.idField, message: 'ID 重复：' + idv + '（保留首行，本行拒收）' });
        else seen[idv] = true;
      }
      errs.forEach(function (e) { e.table = tableName; errors.push(e); });
      warns.forEach(function (w) { w.table = tableName; warnings.push(w); });
      if (errs.length === 0) accepted.push(rec);
    });
    return { accepted: accepted, errors: errors, warnings: warnings };
  }

  return {
    SCHEMAS: SCHEMAS,
    isValidDate: isValidDate,
    validateHeader: validateHeader,
    validateTable: validateTable,
    normalizeRow: normalizeRow,
    LEGACY_MAPS: LEGACY_MAPS
  };
});
