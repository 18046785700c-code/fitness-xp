/*
 * Fitness XP 会员端 — 发布合并包
 *
 * 由 tools/build-dist.sh 按 04_会员端/index.html 的 script 顺序拼接生成。
 * 不要手改这个文件：改源模块后重新执行 bash tools/build-dist.sh。
 */

/* ===== ../src/js/fxp-csv.js ===== */
/* Fitness XP V1 — CSV 解析模块（无依赖，UMD：Node 可 require，浏览器可 script 引入） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; Object.assign(root.FXP, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 去除 UTF-8 BOM */
  function stripBOM(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

  /** 缓冲区解码：UTF-8（含 BOM）优先，出现替换符时回退尝试 GBK（兼容 Excel 另存格式） */
  function decodeBuffer(buf) {
    var utf8 = new TextDecoder('utf-8').decode(buf);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return utf8; // 带 BOM
    if (utf8.indexOf('\uFFFD') === -1) return utf8; // 合法 UTF-8
    try { return new TextDecoder('gbk').decode(buf); } catch (e) { return utf8; }
  }

  /** 标准 CSV 解析（支持引号包裹、转义引号、CRLF）；返回二维数组，剔除全空行 */
  function parseCSV(text) {
    text = stripBOM(String(text));
    var rows = [], row = [], field = '', i = 0, inQ = false;
    while (i < text.length) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; } else { inQ = false; i++; } }
        else { field += c; i++; }
      } else {
        if (c === '"') { inQ = true; i++; }
        else if (c === ',') { row.push(field); field = ''; i++; }
        else if (c === '\r') {
          if (text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; }
          else { field += c; i++; }
        }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
        else { field += c; i++; }
      }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return !(r.length === 1 && String(r[0]).trim() === ''); });
  }

  /** 首行为表头 → 记录数组。每条记录附加 _row（Excel 行号，表头=1，数据从 2 开始） */
  function toRecords(rows) {
    if (!rows || !rows.length) return { header: [], records: [] };
    var header = rows[0].map(function (h) { return String(h).trim(); });
    var records = [];
    for (var i = 1; i < rows.length; i++) {
      var rec = { _row: i + 1 };
      for (var j = 0; j < header.length; j++) rec[header[j]] = rows[i][j] !== undefined ? String(rows[i][j]).trim() : '';
      records.push(rec);
    }
    return { header: header, records: records };
  }

  /** 记录数组 → CSV 文本（UTF-8 BOM），列顺序按 fields；字段含逗号/引号/换行时自动加引号 */
  function toCSV(records, fields) {
    var esc = function (v) {
      v = (v === undefined || v === null) ? '' : String(v);
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [fields.join(',')];
    records.forEach(function (r) {
      lines.push(fields.map(function (f) { return esc(r[f]); }).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  return { stripBOM: stripBOM, decodeBuffer: decodeBuffer, parseCSV: parseCSV, toRecords: toRecords, toCSV: toCSV };
});


/* ===== ../src/js/fxp-validate.js ===== */
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


/* ===== ../src/js/fxp-engine.js ===== */
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


/* ===== ../src/js/fxp-member-schema.js ===== */
/* Fitness XP 会员端 V2 — 契约层（19 表字段定义 / 强校验 / 快照校验 / 注册注入；UMD）
 *
 * 设计约束（依据 docs/member-v2/06 依赖图）：
 *   1. 本模块不引用规则层/领域层/页面层。
 *   2. 字段结构与既有 fxp-validate.js 的 SCHEMAS 保持一致（idField + fields[]），
 *      以便 register(V) 后可直接复用 V.validateHeader 的「必填列缺失」检查。
 *   3. 行级强校验由本模块自己实现，原因有二：
 *      a) 既有校验器的类型分支只有 date/enum/bool/int/text/id/phone，
 *         会员端需要的 num / json / datetime 在 switch 中无匹配会被**静默跳过**；
 *      b) 既有 text 超长只是 warning，而会员端要求部分条件（如 reps≥1）必须**强拒收**。
 *   4. 本模块不修改 fxp-validate.js 一行 —— register 是运行期注入，且幂等。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.memberSchema = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MEMBER_VERSION = 1;

  /* ---------- 字段构造（紧凑写法） ---------- */
  function F(name, type, required, o) {
    o = o || {};
    var f = { name: name, type: type, required: !!required, label: o.label || name };
    if (o.max) f.max = o.max;
    if (o.values) f.values = o.values;
    if (o.pattern) f.pattern = o.pattern;
    if (o.warnRange) f.warnRange = o.warnRange;
    if (o.min !== undefined) f.min = o.min;
    if (o.maxv !== undefined) f.maxv = o.maxv;
    return f;
  }
  function T(name, max, required, label) { return F(name, 'text', required, { max: max, label: label }); }
  function I(name, required, range, label) { return F(name, 'int', required, { warnRange: range, label: label }); }
  function N(name, required, label) { return F(name, 'num', required, { label: label }); }
  function E(name, values, required, label) { return F(name, 'enum', required, { values: values, label: label }); }
  function B(name, required, label) { return F(name, 'bool', required, { label: label }); }
  function D(name, required, label) { return F(name, 'date', required, { label: label }); }
  function DT(name, required, label) { return F(name, 'datetime', required, { label: label }); }
  function ID(name, pattern, label) { return F(name, 'id', 1, { pattern: pattern, label: label }); }
  function JS(name, required, label) { return F(name, 'json', required, { label: label }); }
  function REF(name, label) { return T(name, 20, 1, label); }          /* 外键：非空引用 */
  function AT(name) { return F(name, 'datetime', 1, { label: '创建时间' }); }
  function UP(name) { return F(name, 'datetime', 0, { label: '更新时间' }); }

  /* 常用时间戳对 */
  function AN(name, type, label) { return F(name, type, 1, { label: label }); }

  /* ---------- 19 张表 ---------- */

  var SCHEMAS = {

    m_profiles: {
      idField: 'member_id',
      fields: [
        /* M = 教练端在册会员；S = 会员端自助注册（Q15=A，两者永不相撞） */
        ID('member_id', /^[MS]\d{4,}$/, '会员ID'),
        T('name', 30, 1, '姓名或昵称'),
        T('phone', 11, 1, '手机号'),
        T('pin_hash', 64, 0, '本地口令哈希'),
        E('member_source', ['self', 'coach'], 1, '会员来源'),
        T('coach_member_id', 20, 0, '教练端会员号'),
        E('experience_level', ['newbie', 'novice', 'intermediate', 'advanced'], 1, '训练基础'),
        E('primary_goal', ['fat_loss', 'muscle_gain', 'strength', 'health', 'posture', 'rehab'], 1, '主要目标'),
        T('available_equipment', 200, 1, '可用器械'),
        I('available_days_per_week', 1, [1, 7], '每周可训练天数'),
        I('session_minutes', 1, [15, 180], '单次时长上限'),
        T('limitations', 300, 0, '伤病禁忌标签'),
        T('limitation_note', 300, 0, '限制备注'),
        E('preferred_intensity', ['low', 'medium', 'high'], 0, '强度偏好'),
        E('player_type', ['beginner', 'unstable', 'veteran'], 0, '玩家类型'),
        D('player_type_at', 0, '上次归类日期'),
        I('frequency_goal', 1, [1, 7], '每周目标次数'),
        D('pause_until', 0, '暂停期结束日'),
        B('remind_enabled', 0, '训练提醒'),
        T('remind_time', 5, 0, '提醒时间'),
        B('onboarding_done', 1, '是否完成引导'),
        AT('created_at'), UP('updated_at')
      ]
    },

    m_exercises: {
      idField: 'exercise_id',
      prefix: 'EX',
      fields: [
        ID('exercise_id', /^EX\d{4}$/, '动作ID'),
        T('name', 30, 1, '动作名称'),
        T('alias', 60, 0, '别名'),
        E('category', ['strength', 'cardio', 'mobility', 'posture', 'rehab'], 1, '训练目的'),
        E('movement_pattern', ['squat', 'hinge', 'push_horizontal', 'push_vertical', 'pull_horizontal',
          'pull_vertical', 'carry', 'core', 'locomotion', 'isolation'], 1, '动作模式'),
        T('primary_muscles', 100, 1, '目标肌群'),
        T('secondary_muscles', 100, 0, '辅助肌群'),
        B('unilateral', 1, '是否单侧'),
        E('equipment', ['bodyweight', 'dumbbell', 'barbell', 'machine', 'cable', 'band',
          'kettlebell', 'cardio_machine', 'other'], 1, '器械'),
        T('equipment_alt', 100, 0, '可替代器械'),
        E('difficulty', ['beginner', 'novice', 'intermediate', 'advanced'], 1, '难度'),
        T('steps', 800, 1, '执行步骤'),
        T('common_mistakes', 500, 0, '常见错误'),
        T('reference_sets_reps', 300, 0, '参考组数次数'),
        T('suitable_for', 300, 0, '适用人群'),
        T('contraindications', 300, 0, '适用限制'),
        T('caution_note', 200, 0, '安全提示'),
        /* self_authored = 内置预置动作；custom = 会员自建（Q4=A 要求开放自建） */
        E('source', ['gym_owned', 'self_authored', 'custom', 'cc_licensed', 'public_domain'], 1, '内容来源'),
        T('source_note', 200, 0, '出处与授权说明'),
        T('media_ref', 200, 0, '媒体引用'),
        /* ai_monitor_type（追加列，选填）：
         * 只存"AI 教练统一配置里的动作键"（如 bodyweight_squat / bench_press），
         * **不存等级**。等级 A/B/C 一律由 AI 配置的 getMonitor() 现算，
         * 这样"等级"只有一处真值（03_AI教练/js/aic-config.js），动作库页面不得自行硬编码。
         * 空字符串 = 该动作未接入摄像头监测（页面按 C 级展示）。
         * 为什么是选填：既有存量快照里的 m_exercises 行没有这一列，
         * 设为必填会让全部老记录在读取时校验失败，属于破坏性升级。 */
        T('ai_monitor_type', 40, 0, 'AI监测动作键'),
        I('version', 1, [1, 999], '内容版本'),
        T('content_hash', 64, 1, '内容哈希'),
        B('deprecated', 0, '停用标记'),
        F('created_at', 'date', 1, { label: '创建日期' }),
        F('updated_at', 'date', 0, { label: '更新日期' })
      ]
    },

    m_favorites: {
      idField: 'favorite_id', prefix: 'FV',
      fields: [
        ID('favorite_id', /^FV\d{4}$/, '收藏ID'),
        REF('member_id', '会员ID'),
        E('kind', ['exercise', 'template', 'card'], 1, '收藏类型'),
        REF('ref_id', '被收藏对象ID'),
        AT('created_at')
      ]
    },

    m_goals: {
      idField: 'goal_id', prefix: 'GO',
      fields: [
        ID('goal_id', /^GO\d{4}$/, '目标ID'),
        REF('member_id', '会员ID'),
        T('parent_goal_id', 20, 0, '上级目标ID'),
        E('kind', ['long_term', 'stage'], 1, '目标层级'),
        E('goal_type', ['weight', 'waist', 'strength_pr', 'frequency', 'custom'], 1, '目标类型'),
        T('title', 50, 1, '目标标题'),
        N('target_value', 1, '目标值'),
        N('start_value', 0, '起始值'),
        T('unit', 10, 1, '单位'),
        E('direction', ['decrease', 'increase'], 1, '目标方向'),
        D('start_date', 1, '开始日期'),
        D('target_date', 1, '目标日期'),
        E('status', ['active', 'achieved', 'abandoned'], 1, '目标状态'),
        D('achieved_at', 0, '达成日期'),
        AT('created_at'), UP('updated_at')
      ]
    },

    m_plans: {
      idField: 'plan_id', prefix: 'WP',
      fields: [
        ID('plan_id', /^WP\d{4}$/, '计划ID'),
        REF('member_id', '会员ID'),
        D('week_start', 1, '周起始日'),
        I('week_target_count', 1, [1, 7], '本周目标次数'),
        E('source', ['member', 'coach', 'system'], 1, '计划来源'),
        B('coach_confirmed', 1, '教练已确认'),
        DT('coach_confirmed_at', 0, '确认时间'),
        T('coach_confirmed_by', 20, 0, '确认人'),
        B('member_edited', 0, '会员是否改动过'),
        E('status', ['draft', 'published', 'archived'], 1, '计划状态'),
        T('note', 300, 0, '备注'),
        AT('created_at'), UP('updated_at')
      ]
    },

    m_plan_items: {
      idField: 'plan_item_id', prefix: 'PI',
      fields: [
        ID('plan_item_id', /^PI\d{4}$/, '计划项ID'),
        REF('plan_id', '计划ID'),
        I('day_of_week', 1, [1, 7], '星期几'),
        I('order_index', 1, [0, 99], '同日排序'),
        REF('exercise_id', '动作ID'),
        T('exercise_name_snapshot', 30, 1, '动作名称快照'),
        I('exercise_version', 1, [1, 999], '动作版本'),
        I('target_sets', 1, [1, 20], '目标组数'),
        I('target_reps', 1, [1, 999], '目标次数'),
        N('target_weight', 0, '目标重量'),
        I('target_rest_sec', 0, [0, 600], '目标休息秒数'),
        T('note', 200, 0, '备注')
      ]
    },

    m_bags: {
      idField: 'bag_id', prefix: 'BG',
      fields: [
        ID('bag_id', /^BG\d{4}$/, '背包ID'),
        REF('member_id', '会员ID'),
        E('kind', ['today', 'template'], 1, '类型'),
        T('name', 30, 0, '模板名称'),
        D('plan_date', 0, '背包日期'),
        T('source_plan_id', 20, 0, '来源计划'),
        T('source_session_id', 20, 0, '来源训练'),
        E('status', ['draft', 'confirmed', 'discarded'], 0, '状态'),
        DT('last_used_at', 0, '上次使用'),
        AT('created_at'), UP('updated_at')
      ]
    },

    m_bag_items: {
      idField: 'bag_item_id', prefix: 'BI',
      fields: [
        ID('bag_item_id', /^BI\d{4}$/, '背包项ID'),
        REF('bag_id', '背包ID'),
        I('order_index', 1, [0, 99], '排序'),
        REF('exercise_id', '动作ID'),
        T('exercise_name_snapshot', 30, 1, '动作名称快照'),
        I('exercise_version', 1, [1, 999], '动作版本'),
        E('source', ['library', 'plan', 'template', 'history'], 1, '来源'),
        T('replaced_from_id', 20, 0, '替换前动作'),
        I('target_sets', 0, [1, 20], '目标组数'),
        I('target_reps', 1, [1, 999], '目标次数'),
        N('target_weight', 0, '目标重量'),
        I('target_rest_sec', 0, [0, 600], '目标休息秒数'),
        T('note', 200, 0, '备注')
      ]
    },

    m_sessions: {
      idField: 'session_id', prefix: 'WS',
      fields: [
        ID('session_id', /^WS\d{4}$/, '训练ID'),
        REF('member_id', '会员ID'),
        D('session_date', 1, '训练日期'),
        DT('started_at', 1, '开始时间'),
        DT('ended_at', 0, '结束时间'),
        I('duration_sec', 0, [0, 86400], '净训练秒数'),
        I('paused_ms', 0, [0, 86400000], '累计暂停毫秒'),
        E('status', ['in_progress', 'paused', 'completed', 'abandoned'], 1, '状态'),
        E('source_type', ['bag', 'plan', 'quick'], 1, '来源类型'),
        T('source_id', 20, 0, '来源ID'),
        JS('plan_snapshot', 1, '计划快照'),
        I('planned_exercise_count', 1, [0, 99], '计划动作数'),
        I('actual_exercise_count', 1, [0, 99], '实际动作数'),
        I('total_sets', 1, [0, 999], '总组数'),
        N('total_volume', 0, '总容量'),
        E('feeling', ['great', 'good', 'normal', 'tired', 'pain'], 0, '会员感受'),
        T('coach_session_id', 20, 0, '教练端训练ID'),
        T('rule_version', 20, 1, '规则版本'),
        /* 阶段7 追加（14 §2）：AI 动作教练摘要回写。
           只存文字摘要（有效次数 / 评分维度 / 复盘），不存关键点与视频，
           也不碰 plan_snapshot 与 m_sets 的既有格式。必填=0，存量会话不受影响。 */
        T('ai_summary', 500, 0, 'AI教练摘要'),
        AT('created_at'), UP('updated_at')
      ]
    },

    m_sets: {
      idField: 'set_id', prefix: 'ST',
      fields: [
        ID('set_id', /^ST\d{4}$/, '组ID'),
        REF('session_id', '训练ID'),
        REF('exercise_id', '动作ID'),
        T('exercise_name_snapshot', 30, 1, '动作名称快照'),
        I('exercise_version', 1, [1, 999], '动作版本'),
        I('set_index', 1, [1, 99], '动作内组序号'),
        I('sequence', 1, [1, 9999], '会话内全局顺序'),
        N('weight', 0, '重量'),
        I('reps', 1, [1, 999], '次数'),
        I('rpe', 0, [1, 10], '主观强度'),
        I('rest_sec', 0, [0, 600], '休息秒数'),
        T('note', 200, 0, '备注'),
        B('is_pr', 0, '是否破纪录'),
        AT('logged_at')
      ]
    },

    m_set_corrections: {
      idField: 'correction_id', prefix: 'SC',
      fields: [
        ID('correction_id', /^SC\d{4}$/, '修正ID'),
        REF('set_id', '组ID'),
        REF('member_id', '会员ID'),
        E('field_name', ['weight', 'reps', 'rpe', 'rest_sec', 'note'], 1, '修正字段'),
        T('old_value', 50, 1, '原值'),
        T('new_value', 50, 1, '新值'),
        T('reason', 200, 1, '修正原因'),
        E('kind', ['undo', 'correction', 'system'], 1, '修正类型'),
        AT('corrected_at')
      ]
    },

    m_xp_ledger: {
      idField: 'ledger_id', prefix: 'XL',
      fields: [
        ID('ledger_id', /^XL\d{4}$/, '流水ID'),
        REF('member_id', '会员ID'),
        T('biz_key', 120, 1, '防重业务键'),
        E('event_type', ['session_base', 'session_set', 'explore', 'pr', 'daily_task',
          'weekly_challenge', 'streak_day', 'streak_week', 'achievement', 'milestone',
          'adjustment_reversal', 'manual_adjust'], 1, '事件类型'),
        T('rule_code', 40, 1, '规则代码'),
        I('points', 1, null, '分值'),
        T('source_ref', 60, 0, '关联实体'),
        T('note', 200, 0, '说明'),
        T('rule_version', 20, 1, '规则版本'),
        AT('occurred_at')
      ]
    },

    m_xp_account: {
      idField: 'member_id',
      fields: [
        ID('member_id', /^M\d{4,}$/, '会员ID'),
        I('lifetime_xp', 1, null, '累计经验'),
        I('level', 1, [1, 99], '等级'),
        T('level_title', 20, 1, '等级称号'),
        I('xp_into_level', 1, null, '本级已获经验'),
        I('xp_for_level', 1, null, '本级所需经验'),
        DT('recalculated_at', 1, '重算时间')
      ]
    },

    m_unlocks: {
      idField: 'unlock_id', prefix: 'UL',
      fields: [
        ID('unlock_id', /^UL\d{4}$/, '解锁ID'),
        REF('member_id', '会员ID'),
        T('achievement_code', 40, 1, '成就代码'),
        I('tier', 0, [1, 9], '层级'),
        AT('unlocked_at'),
        T('biz_key', 120, 1, '防重业务键'),
        T('progress_snapshot', 200, 0, '达成快照')
      ]
    },

    m_challenges: {
      idField: 'challenge_id', prefix: 'CH',
      fields: [
        ID('challenge_id', /^CH\d{4}$/, '任务ID'),
        REF('member_id', '会员ID'),
        E('period_type', ['daily', 'weekly'], 1, '周期类型'),
        T('period_key', 10, 1, '周期键'),
        T('challenge_code', 40, 1, '任务代码'),
        T('title', 50, 1, '任务标题'),
        N('target_value', 1, '目标值'),
        N('current_value', 1, '当前值'),
        T('unit', 10, 0, '单位'),
        E('status', ['open', 'done', 'expired'], 1, '状态'),
        I('reward_xp', 1, [0, 9999], '奖励经验'),
        T('biz_key', 120, 1, '防重业务键'),
        DT('completed_at', 0, '完成时间'),
        AT('created_at')
      ]
    },

    m_streaks: {
      idField: 'member_id',
      fields: [
        ID('member_id', /^M\d{4,}$/, '会员ID'),
        I('active_days_streak', 1, null, '当前连续天数'),
        I('best_days_streak', 1, null, '最佳连续天数'),
        D('last_train_date', 0, '上次训练日期'),
        I('weekly_goal_streak', 1, null, '连续达标周数'),
        I('best_weekly_streak', 1, null, '最佳连续周数'),
        D('last_settled_week', 0, '已结算周'),
        DT('updated_at', 1, '更新时间')
      ]
    },

    m_records: {
      idField: 'record_id', prefix: 'PR',
      fields: [
        ID('record_id', /^PR\d{4}$/, '纪录ID'),
        REF('member_id', '会员ID'),
        REF('exercise_id', '动作ID'),
        E('record_type', ['one_rm', 'max_weight', 'max_reps', 'max_volume'], 1, '纪录类型'),
        N('value', 1, '纪录值'),
        REF('set_id', '来源组ID'),
        REF('session_id', '来源训练ID'),
        N('previous_value', 0, '刷新前的值'),
        AT('achieved_at')
      ]
    },

    m_timeline: {
      idField: 'timeline_id', prefix: 'TL',
      fields: [
        ID('timeline_id', /^TL\d{4}$/, '时间线ID'),
        REF('member_id', '会员ID'),
        E('event_type', ['level_up', 'achievement', 'record', 'streak', 'goal_milestone', 'week_target'], 1, '事件类型'),
        T('ref_id', 40, 0, '关联ID'),
        T('title', 60, 1, '标题'),
        T('detail', 200, 0, '详情'),
        AT('occurred_at')
      ]
    },

    m_adjustments: {
      idField: 'adjustment_id', prefix: 'AJ',
      fields: [
        ID('adjustment_id', /^AJ\d{4}$/, '调整ID'),
        REF('member_id', '会员ID'),
        /* 'week' 是阶段7 追加的一档（15 §2）：建议针对「某一周」而不是某一份计划——
           同一周里可以同时并存教练安排、教练建议、会员自建计划，只有以"周"作粒度，
           「同一周同一条规则只提一次」这条幂等规则才成立。纯放宽枚举，存量行不受影响。 */
        E('target_type', ['plan', 'plan_item', 'profile', 'difficulty', 'week'], 1, '目标类型'),
        T('target_id', 20, 0, '目标ID'),
        E('adjust_type', ['volume', 'intensity', 'rest', 'exercise_swap', 'frequency', 'reclassify'], 1, '调整类型'),
        T('before_value', 100, 0, '调整前'),
        T('after_value', 100, 0, '调整后'),
        T('reason_code', 40, 1, '原因代码'),
        T('reason_text', 200, 1, '原因说明'),
        E('applied_by', ['member', 'system'], 1, '执行者'),
        /* 阶段7 追加（14 §2）：把「建议 → 用户决策」这条链补上。
           suggested = 系统给出的建议（未决）；accepted / rejected / modified = 用户的三种决策。
           拒绝也要单独落一行，否则无法复盘「为什么这个建议没被采纳」。
           三列全部必填=0，既有 4 处 member_edit 留痕不受影响。 */
        E('decision', ['suggested', 'accepted', 'rejected', 'modified'], 0, '用户决策'),
        DT('decided_at', 0, '决策时间'),
        T('rule_version', 20, 0, '规则版本'),
        AT('created_at')
      ]
    }
  };

  /* ---------- 派生：列顺序、ID 前缀 ---------- */

  var TABLES = Object.keys(SCHEMAS);
  var ID_PREFIX = {};
  TABLES.forEach(function (t) { ID_PREFIX[t] = SCHEMAS[t].prefix || ''; });
  var COLUMNS = {};
  TABLES.forEach(function (t) {
    COLUMNS[t] = SCHEMAS[t].fields.map(function (f) { return f.name; });
  });

  /* ---------- 唯一约束（store 层执行） ---------- */

  var UNIQUES = {
    m_favorites: [['member_id', 'kind', 'ref_id']],
    m_xp_ledger: [['member_id', 'biz_key']],
    m_challenges: [['member_id', 'period_key', 'challenge_code']],
    m_records: [['member_id', 'exercise_id', 'record_type']],
    m_unlocks: [['member_id', 'achievement_code', 'tier']]
  };

  /* ---------- 日期与格式工具 ---------- */

  function isDate(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }
  function isDateTime(v) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return false;
    return isDate(v.slice(0, 10));
  }
  function isNum(v) { return /^-?\d+(\.\d+)?$/.test(v); }

  /* ---------- 单字段强校验 ---------- */

  function checkField(f, rec, errs, warns) {
    var raw = rec[f.name] === undefined || rec[f.name] === null ? '' : String(rec[f.name]).trim();
    if (f.required && raw === '') {
      errs.push({ row: rec._row, field: f.name, message: f.label + '为必填项，不能为空' });
      return;
    }
    if (raw === '') return;

    switch (f.type) {
      case 'date':
        if (!isDate(raw)) errs.push({ row: rec._row, field: f.name, message: f.label + '日期格式非法：' + raw });
        break;
      case 'datetime':
        if (!isDateTime(raw)) errs.push({ row: rec._row, field: f.name, message: f.label + '时间格式非法：' + raw + '（要求 YYYY-MM-DD HH:mm:ss）' });
        break;
      case 'enum':
        if (f.values.indexOf(raw) < 0)
          errs.push({ row: rec._row, field: f.name, message: f.label + '枚举值非法：' + raw + '（允许 ' + f.values.join('/') + '）' });
        break;
      case 'bool':
        if (raw !== 'Y' && raw !== 'N')
          errs.push({ row: rec._row, field: f.name, message: f.label + '布尔值非法：' + raw + '（允许 Y/N）' });
        break;
      case 'int':
        if (!/^-?\d+$/.test(raw)) {
          errs.push({ row: rec._row, field: f.name, message: f.label + '必须为整数：' + raw });
        } else {
          var n = parseInt(raw, 10);
          if (f.warnRange && (n < f.warnRange[0] || n > f.warnRange[1]))
            warns.push({ row: rec._row, field: f.name, message: f.label + '超出建议范围 ' + f.warnRange[0] + '-' + f.warnRange[1] + '：' + raw });
        }
        break;
      case 'num':
        /* 数值必须强拒收，否则后续计算会拿到 NaN */
        if (!isNum(raw)) errs.push({ row: rec._row, field: f.name, message: f.label + '必须为数字：' + raw });
        else if (f.min !== undefined && parseFloat(raw) < f.min)
          errs.push({ row: rec._row, field: f.name, message: f.label + '不得小于 ' + f.min + '：' + raw });
        else if (f.maxv !== undefined && parseFloat(raw) > f.maxv)
          errs.push({ row: rec._row, field: f.name, message: f.label + '不得大于 ' + f.maxv + '：' + raw });
        break;
      case 'json':
        try { JSON.parse(raw); }
        catch (e) { errs.push({ row: rec._row, field: f.name, message: f.label + '不是合法 JSON' }); }
        break;
      case 'text':
        if (f.max && raw.length > f.max)
          warns.push({ row: rec._row, field: f.name, message: f.label + '长度超过 ' + f.max + ' 字符' });
        break;
      case 'id':
        if (f.pattern && !f.pattern.test(raw))
          warns.push({ row: rec._row, field: f.name, message: f.label + '格式与规范不符：' + raw });
        break;
    }
  }

  /* ---------- 条件必填（强拒收） ---------- */

  var COND = {
    m_goals: function (rec, errs) {
      if (rec.status === 'achieved' && !rec.achieved_at)
        errs.push({ row: rec._row, field: 'achieved_at', message: '目标已达成（status=achieved）必须填写达成日期 achieved_at' });
      if (rec.kind === 'stage' && !rec.parent_goal_id)
        errs.push({ row: rec._row, field: 'parent_goal_id', message: '阶段目标（kind=stage）必须指定上级长期目标 parent_goal_id' });
    },
    m_plans: function (rec, errs) {
      if (rec.coach_confirmed === 'Y') {
        if (!rec.coach_confirmed_at) errs.push({ row: rec._row, field: 'coach_confirmed_at', message: 'coach_confirmed=Y 必须填写确认时间' });
        if (!rec.coach_confirmed_by) errs.push({ row: rec._row, field: 'coach_confirmed_by', message: 'coach_confirmed=Y 必须填写确认人' });
      }
    },
    m_bags: function (rec, errs) {
      if (rec.kind === 'today' && !rec.plan_date)
        errs.push({ row: rec._row, field: 'plan_date', message: '今日背包（kind=today）必须填写 plan_date' });
      if (rec.kind === 'template' && !rec.name)
        errs.push({ row: rec._row, field: 'name', message: '训练模板（kind=template）必须填写名称 name' });
    },
    m_exercises: function (rec, errs) {
      /* 版权留痕：非场馆自有内容必须写明出处 */
      if (rec.source && rec.source !== 'gym_owned' && !rec.source_note)
        errs.push({ row: rec._row, field: 'source_note', message: '来源为 ' + rec.source + ' 时必须填写出处与授权说明 source_note' });
    },
    m_sets: function (rec, errs) {
      /* 逐组记录的核心约束：必须强拒收，不能只警告 */
      if (rec.reps !== undefined && String(rec.reps).trim() !== '' && parseInt(rec.reps, 10) < 1)
        errs.push({ row: rec._row, field: 'reps', message: '次数 reps 必须 ≥1，实际为 ' + rec.reps });
      if (rec.weight !== undefined && String(rec.weight).trim() !== '' && parseFloat(rec.weight) < 0)
        errs.push({ row: rec._row, field: 'weight', message: '重量 weight 必须 ≥0，实际为 ' + rec.weight });
    },
    m_sessions: function (rec, errs) {
      if ((rec.status === 'completed' || rec.status === 'abandoned') && !rec.ended_at)
        errs.push({ row: rec._row, field: 'ended_at', message: '会话状态为 ' + rec.status + ' 时必须填写结束时间 ended_at' });
    }
  };

  /** 条件校验单独入口（供测试直接调用） */
  function condCheck(table, rec) {
    var errs = [];
    if (COND[table]) COND[table](rec, errs);
    return errs;
  }

  /* ---------- 行级 / 表级校验 ---------- */

  function validateRow(table, rec) {
    var s = SCHEMAS[table];
    if (!s) return { ok: false, errors: [{ row: rec._row, field: '', message: '未知表名：' + table }], warnings: [] };
    var errs = [], warns = [];
    s.fields.forEach(function (f) { checkField(f, rec, errs, warns); });
    if (COND[table]) COND[table](rec, errs);
    return { ok: errs.length === 0, errors: errs, warnings: warns };
  }

  /** 与既有 validateTable 语义一致：错误行拒收，警告行保留，ID 重复保留首行 */
  function validateTable(table, records) {
    var s = SCHEMAS[table];
    if (!s) return { accepted: [], errors: [{ row: 0, field: '', message: '未知表名：' + table }], warnings: [] };
    var errors = [], warnings = [], accepted = [], seen = {};
    records.forEach(function (rec) {
      var r = validateRow(table, rec);
      if (r.ok) {
        var idv = rec[s.idField];
        if (seen[idv]) r.errors.push({ row: rec._row, field: s.idField, message: 'ID 重复：' + idv + '（保留首行，本行拒收）' });
        else seen[idv] = true;
      }
      r.errors.forEach(function (e) { e.table = table; errors.push(e); });
      r.warnings.forEach(function (w) { w.table = table; warnings.push(w); });
      if (r.errors.length === 0) accepted.push(rec);
    });
    return { accepted: accepted, errors: errors, warnings: warnings };
  }

  /** 表头必填列检查（缺必填列 → 整文件不可用） */
  function validateHeader(table, header) {
    var s = SCHEMAS[table];
    if (!s) return { ok: false, missing: [], message: '未知表名：' + table };
    var missing = s.fields.filter(function (f) { return f.required && header.indexOf(f.name) < 0; })
      .map(function (f) { return f.name; });
    return missing.length ? { ok: false, missing: missing, message: '缺少必填列：' + missing.join(', ') }
      : { ok: true, missing: [] };
  }

  /* ---------- 快照校验（会员端自有版本，独立于 fxp-persist） ---------- */

  function validateMemberSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return { ok: false, reason: 'not_object' };
    if (snap.v !== MEMBER_VERSION) return { ok: false, reason: 'version_mismatch', got: snap.v, want: MEMBER_VERSION };
    if (!isDate(snap.savedAt)) return { ok: false, reason: 'bad_savedAt' };
    if (!snap.tables || typeof snap.tables !== 'object') return { ok: false, reason: 'no_tables' };
    for (var i = 0; i < TABLES.length; i++) {
      if (!Array.isArray(snap.tables[TABLES[i]])) return { ok: false, reason: 'table_missing', table: TABLES[i] };
    }
    return { ok: true };
  }

  /* ---------- 注册注入（不修改 fxp-validate.js 本身） ---------- */

  function register(V) {
    if (!V || !V.SCHEMAS) throw new Error('register(V) 需要一个带 SCHEMAS 的校验模块');
    TABLES.forEach(function (t) { V.SCHEMAS[t] = SCHEMAS[t]; });
    return TABLES.length;
  }

  return {
    MEMBER_VERSION: MEMBER_VERSION,
    SCHEMAS: SCHEMAS,
    TABLES: TABLES,
    COLUMNS: COLUMNS,
    ID_PREFIX: ID_PREFIX,
    UNIQUES: UNIQUES,
    register: register,
    validateRow: validateRow,
    validateTable: validateTable,
    validateHeader: validateHeader,
    condCheck: condCheck,
    validateMemberSnapshot: validateMemberSnapshot,
    isDate: isDate,
    isDateTime: isDateTime,
    isNum: isNum
  };
});


/* ===== ../src/js/fxp-member-store.js ===== */
/* Fitness XP 会员端 V2 — 存储层（19 表容器 / CRUD / 归属校验 / 独立键持久化 / 导出导入；UMD）
 *
 * 依赖：fxp-member-schema（契约）、fxp-engine（仅 nextSeqId）、fxp-csv（导入导出）
 * 不依赖：fxp-persist（原因见下）、fxp-validate（不修改它，契约层自行注入）
 *
 * 【与既有模块的关系 —— 重要修正 2026-10-16】
 * 设计文档 06 曾计划复用 P.createPersistence(storage,{key:'fxp-member'})。
 * 实际代码核实后此路不通：fxp-persist.js 的 save()/load() 内部强制调用 validateSnapshot()，
 * 该函数硬编码 TABLES=['coaches','members','sessions','followups','tasks'] 并要求
 * savedAt/queue/xp 结构，会员端 19 表快照必然被拒（reason: bad_table:coaches）。
 * 因此本模块自建持久化，但严格沿用 fxp-persist 的三条设计原则：
 *   1) 拒收优于猜测：结构/版本/记录任一不符 → 整体丢弃回空白态，绝不加载半份；
 *   2) 可逆：提供 clear()；
 *   3) storage 可注入（便于测试与禁用 localStorage 的环境）。
 * 这样既有 fxp-persist.js 保持零改动。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./fxp-member-schema.js'),
      require('./fxp-engine.js'),
      require('./fxp-csv.js')
    );
  } else {
    root.FXP = root.FXP || {};
    /* 注意：fxp-csv.js 在浏览器端是 Object.assign 到 root.FXP（散开，非 .csv 子对象），
       故这里直接传 root.FXP 作为 CSV 依赖。加载顺序必须保证 csv/engine/schema 已在它之前。 */
    root.FXP.memberStore = factory(root.FXP.memberSchema, root.FXP.engine, root.FXP);
  }
})(typeof self !== 'undefined' ? self : this, function (MSCH, E, CSV) {
  'use strict';

  var KEY = 'fxp-member';
  var TABLES = MSCH.TABLES;

  /* 子表 → 父表（用于解析归属；会员端数据必须能追溯到某个会员） */
  var OWNER_PATH = {
    m_sets: ['session_id', 'm_sessions'],
    m_bag_items: ['bag_id', 'm_bags'],
    m_plan_items: ['plan_id', 'm_plans']
  };
  /* 全局表：不属于任何单个会员，不受归属校验 */
  var GLOBAL_TABLES = ['m_exercises'];

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  /**
   * createStore(opts)
   * opts.storage  {getItem,setItem,removeItem}（必填，可注入 mock）
   * opts.today    'YYYY-MM-DD'（快照日期，默认取当天）
   * opts.key      存储键，默认 'fxp-member'
   */
  function createStore(opts) {
    opts = opts || {};
    var storage = opts.storage;
    if (!storage || typeof storage.getItem !== 'function')
      throw new Error('createStore 需要一个 localStorage 兼容的 storage');
    var KEY_ = opts.key || KEY;

    var tables = {}, byId = {};
    TABLES.forEach(function (t) { tables[t] = []; byId[t] = {}; });

    function idField(t) { return MSCH.SCHEMAS[t].idField; }
    function today() {
      if (opts.today) return opts.today;
      var d = new Date();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    /* ---------- 归属解析 ---------- */

    /** 返回该行所属的 member_id；全局表/无法解析时返回 null */
    function resolveOwner(table, row) {
      if (!isObj(row)) return null;
      if (row.member_id) return row.member_id;
      var p = OWNER_PATH[table];
      if (!p) return null;
      var parent = byId[p[1]][row[p[0]]];
      return parent ? parent.member_id : null;
    }

    /**
     * 归属校验：会员 A 不得读写会员 B 的数据。
     * 这是无服务端环境下（决策 Q8=A）的补偿措施之一，校验发生在数据层而非 UI 层。
     */
    function assertOwner(memberId, table, row) {
      if (GLOBAL_TABLES.indexOf(table) >= 0) return { ok: true };
      if (!memberId) return { ok: false, reason: 'no_actor', message: '未指定操作者，拒绝访问' };
      var owner = resolveOwner(table, row);
      if (owner === null) return { ok: false, reason: 'unresolvable', message: '无法解析该记录的归属会员，拒绝访问' };
      if (owner !== memberId)
        return { ok: false, reason: 'not_owner', message: '数据归属校验失败：该记录属于其他会员（' + owner + '）' };
      return { ok: true };
    }

    /* ---------- 读写 ---------- */

    function all(table) { return tables[table]; }

    function find(table, id) { return byId[table][id] || null; }

    function findBy(table, pred) {
      return tables[table].filter(function (r) { return pred(r); });
    }

    /** 带归属校验的单条读取（找不到 / 归属不符都返回 null 并给出原因） */
    function get(table, id, memberId) {
      var row = find(table, id);
      if (!row) return null;
      var a = assertOwner(memberId, table, row);
      return a.ok ? row : null;
    }

    function count(table) { return tables[table].length; }

    function nextId(table) {
      var p = MSCH.ID_PREFIX[table];
      if (!p) return null;   /* 主键即 member_id 的表不自动生成 */
      return E.nextSeqId(tables[table], idField(table), p, 4);
    }

    /** 唯一约束检查；返回冲突提示或 null */
    function uniqueHit(table, row) {
      var rules = MSCH.UNIQUES[table];
      if (!rules) return null;
      for (var i = 0; i < rules.length; i++) {
        var keys = rules[i];
        var dup = tables[table].some(function (r) {
          if (r[idField(table)] === row[idField(table)]) return false;   /* 自身不算冲突 */
          return keys.every(function (k) { return String(r[k] || '') === String(row[k] || ''); });
        });
        if (dup) return '与唯一约束冲突：(' + keys.join(', ') + ') 已存在相同记录';
      }
      return null;
    }

    /**
     * insert(table, rec, opt)
     * opt.actor 会员ID（给出则做归属校验）；opt.skipValidate 跳过行校验（仅内部恢复用）
     * 返回 {ok, row, errors, warnings, reason}
     */
    function insert(table, rec, opt) {
      opt = opt || {};
      if (!MSCH.SCHEMAS[table]) return { ok: false, reason: 'unknown_table' };
      var idf = idField(table);
      var row = {};
      Object.keys(rec).forEach(function (k) { row[k] = rec[k]; });

      if (!row[idf]) {
        var nid = nextId(table);
        if (nid === null) return { ok: false, reason: 'id_required', message: '该表主键需由调用方提供' };
        row[idf] = nid;
      }
      if (find(table, row[idf])) return { ok: false, reason: 'id_exists', message: 'ID 已存在：' + row[idf] };

      if (opt.actor) {
        var a = assertOwner(opt.actor, table, row);
        if (!a.ok) return { ok: false, reason: a.reason, message: a.message };
      }
      if (!opt.skipValidate) {
        var v = MSCH.validateRow(table, Object.assign({ _row: 0 }, row));
        if (v.errors.length) return { ok: false, reason: 'invalid', errors: v.errors, warnings: v.warnings };
      }
      var hit = uniqueHit(table, row);
      if (hit) return { ok: false, reason: 'unique_violation', message: hit };

      tables[table].push(row);
      byId[table][row[idf]] = row;
      return { ok: true, row: row };
    }

    /** update：只允许改非主键字段；归属校验先行 */
    function update(table, id, patch, opt) {
      opt = opt || {};
      var row = find(table, id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (opt.actor) {
        var a = assertOwner(opt.actor, table, row);
        if (!a.ok) return { ok: false, reason: a.reason, message: a.message };
      }
      Object.keys(patch).forEach(function (k) {
        if (k !== idField(table)) row[k] = patch[k];
      });
      if (!opt.skipValidate) {
        var v = MSCH.validateRow(table, Object.assign({ _row: 0 }, row));
        if (v.errors.length) return { ok: false, reason: 'invalid', errors: v.errors };
      }
      return { ok: true, row: row };
    }

    /** remove：计划数据允许真删（计划不是事实）；执行数据调用方应自行禁止 */
    function remove(table, id, opt) {
      opt = opt || {};
      var row = find(table, id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (opt.actor) {
        var a = assertOwner(opt.actor, table, row);
        if (!a.ok) return { ok: false, reason: a.reason, message: a.message };
      }
      tables[table] = tables[table].filter(function (r) { return r !== row; });
      delete byId[table][id];
      return { ok: true };
    }

    /* ---------- 持久化（独立键，不共用 fxp-workspace） ---------- */

    function snapshot() {
      var t = {};
      TABLES.forEach(function (k) { t[k] = tables[k]; });
      return { v: MSCH.MEMBER_VERSION, savedAt: today(), tables: t };
    }

    function save() {
      var snap = snapshot();
      var chk = MSCH.validateMemberSnapshot(snap);
      if (!chk.ok) return { ok: false, reason: chk.reason, message: '快照未通过完整性校验，拒绝保存：' + chk.reason };
      try {
        storage.setItem(KEY_, JSON.stringify(snap));
        return { ok: true };
      } catch (e) {
        return {
          ok: false, reason: 'storage_error',
          message: '本地保存失败（' + (e && e.message ? e.message : '未知') + '），请及时导出 CSV 备份'
        };
      }
    }

    /**
     * load()：整体采纳或整体丢弃，不加载半份。
     * 返回 {ok, reason}；reason: empty / corrupt_json / storage_error / 快照原因
     */
    function load() {
      var text;
      try { text = storage.getItem(KEY_); }
      catch (e) { return { ok: false, reason: 'storage_error' }; }
      if (!text) return { ok: false, reason: 'empty' };
      var s;
      try { s = JSON.parse(text); }
      catch (e) { return { ok: false, reason: 'corrupt_json' }; }
      var chk = MSCH.validateMemberSnapshot(s);
      if (!chk.ok) return { ok: false, reason: chk.reason };
      reset();
      TABLES.forEach(function (t) {
        var src = s.tables[t] || [];
        src.forEach(function (r) {
          if (!isObj(r)) return;
          var row = {};
          Object.keys(r).forEach(function (k) { row[k] = r[k]; });
          tables[t].push(row);
          if (row[idField(t)]) byId[t][row[idField(t)]] = row;
        });
      });
      return { ok: true };
    }

    function clear() {
      try { storage.removeItem(KEY_); return { ok: true }; }
      catch (e) { return { ok: false, reason: 'storage_error' }; }
    }

    function reset() {
      TABLES.forEach(function (t) { tables[t] = []; byId[t] = {}; });
    }

    /** 清空内存与存储（回到空白工作区） */
    function clearAll() { reset(); return clear(); }

    /* ---------- 导出 / 导入 ---------- */

    /** 导出 19 个 CSV（空表也导出表头，保证往返结构一致） */
    function exportAll() {
      return TABLES.map(function (t) {
        return { table: t, text: CSV.toCSV(all(t), MSCH.COLUMNS[t]) };
      });
    }

    /**
     * 导入单表 CSV 文本。
     * opt.mode 'merge'（同 ID 覆盖）| 'replace'（清空后写入）
     * 返回 {ok, added, updated, rejected, errors, warnings}
     */
    function importText(table, text, opt) {
      opt = opt || {};
      if (!MSCH.SCHEMAS[table]) return { ok: false, reason: 'unknown_table' };
      var mode = opt.mode || 'merge';
      var rows = CSV.parseCSV(String(text).replace(/^\uFEFF/, ''));
      var rec = CSV.toRecords(rows);
      if (!rec.header.length) return { ok: false, reason: 'empty_file' };

      var h = MSCH.validateHeader(table, rec.header);
      if (!h.ok) return { ok: false, reason: 'bad_header', message: h.message, errors: [{ row: 0, field: '', message: h.message }] };

      var vres = MSCH.validateTable(table, rec.records);
      if (vres.errors.length) {
        /* 与导入管线一致：任一行有错 → 整份拒收，不写入半个文件 */
        return { ok: false, reason: 'row_invalid', errors: vres.errors, warnings: vres.warnings };
      }

      if (mode === 'replace') {
        tables[table] = []; byId[table] = {};
      }

      var added = 0, updated = 0;
      vres.accepted.forEach(function (r) {
        var row = {};
        Object.keys(r).forEach(function (k) { if (k !== '_row') row[k] = r[k]; });
        var id = row[idField(table)];
        var exist = find(table, id);
        if (exist) {
          Object.keys(row).forEach(function (k) { if (k !== idField(table)) exist[k] = row[k]; });
          updated++;
        } else {
          tables[table].push(row);
          byId[table][id] = row;
          added++;
        }
      });
      return { ok: true, added: added, updated: updated, rejected: 0, errors: [], warnings: vres.warnings };
    }

    return {
      KEY: KEY_,
      TABLES: TABLES,
      tables: tables,
      all: all, find: find, findBy: findBy, get: get, count: count,
      insert: insert, update: update, remove: remove,
      nextId: nextId,
      assertOwner: assertOwner, resolveOwner: resolveOwner,
      save: save, load: load, clear: clear, clearAll: clearAll, reset: reset,
      snapshot: snapshot,
      exportAll: exportAll, importText: importText
    };
  }

  return { KEY: KEY, createStore: createStore, TABLES: TABLES };
});


/* ===== ../src/js/fxp-member-seed.js ===== */
/* fxp-member-seed.js — 会员端内置动作库种子数据（68 个通用动作；UMD）
 *
 * 设计约束：
 *   1. 纯数据模块：不引用 schema / store / 规则层，只产出 m_exercises 的合法记录数组。
 *   2. 字段契约与 src/js/fxp-member-schema.js 的 m_exercises 完全一致（25 个字段）。
 *   3. 内容来源全部为 self_authored：自有文本描述，事实性通用技术说明，
 *      不涉及第三方编排结构，不含任何媒体文件。
 *   4. content_hash = FNV-1a 32 位哈希（8 位小写十六进制），输入 name + steps，
 *      用于后续检测本地动作内容是否被改写。
 *
 * RAW 元组顺序（便于审核）：
 *   0 name            动作名称
 *   1 alias           别名
 *   2 category        训练目的（枚举）
 *   3 movement_pattern动作模式（枚举）
 *   4 primary_muscles 目标肌群
 *   5 secondary_muscles 辅助肌群
 *   6 unilateral     是否单侧（Y/N）
 *   7 equipment      器械（枚举）
 *   8 equipment_alt  可替代器械
 *   9 difficulty     难度（枚举）
 *  10 steps          执行步骤（3-5 步，单字符串）
 *  11 common_mistakes 常见错误
 *  12 reference_sets_reps 参考组数次数
 *  13 suitable_for   适用人群
 *  14 contraindications 适用限制
 *  15 caution_note   安全提示
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FXP = root.FXP || {};
    root.FXP.memberSeed = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SOURCE_NOTE = '内置动作库 · 自有文本 · 事实性描述，不涉及第三方编排结构，不含媒体文件';
  var CREATED_AT = '2026-10-16';

  /* ---- 动作 → AI 监测类型键 ----
   *
   * 这里**只写"键"，不写等级**。等级 A/B/C 由 AI 教练的统一配置
   *（03_AI教练/js/aic-config.js 的 getMonitor）现算，动作库页面一律读那份配置展示。
   * 存键不存等级，是为了让"这个动作到底能监测到什么"只有一处真值：
   * 以后某个动作从 B 升到 A，只改 AI 配置，动作库不用同步，也不会出现两处文案不一致。
   *
   * 只有"人体关键点能稳定观测、且已经写进 AI 配置并跑过测试"的动作才允许出现在这里。
   * 没有出现的动作一律是空值 → 页面按 C 级（暂不支持监测）展示，不伪造任何能力。
   */
  var AI_TYPE = {
    '深蹲': 'bodyweight_squat',
    '弓步蹲': 'lunge',
    '哑铃箭步走': 'lunge',
    '臀桥': 'glute_bridge',
    '杠铃臀桥': 'glute_bridge',
    '弹力带臀桥': 'glute_bridge',
    '标准俯卧撑': 'push_up',
    '跪姿俯卧撑': 'push_up',
    '上斜俯卧撑': 'push_up',
    '引体向上': 'pull_up',
    '哑铃卧推': 'bench_press',
    '杠铃卧推': 'bench_press',
    '上斜哑铃卧推': 'bench_press',
    '上斜杠铃卧推': 'bench_press',
    '史密斯机卧推': 'bench_press',
    '哑铃肩推': 'shoulder_press',
    '杠铃肩推': 'shoulder_press',
    '哑铃弯举': 'bicep_curl',
    '杠铃弯举': 'bicep_curl',
    '哑铃划船': 'bent_over_row',
    '杠铃划船': 'bent_over_row',
    '单臂哑铃划船': 'bent_over_row',
    '俯身反向划船': 'bent_over_row',
    '杠铃硬拉': 'deadlift',
    '哑铃硬拉': 'deadlift',
    '壶铃硬拉': 'deadlift',
    '高位下拉': 'lat_pulldown',
    '哑铃侧平举': 'lateral_raise',
    '弹力带侧平举': 'lateral_raise',
    '卷腹': 'sit_up'
  };

  /* ---- 原始数据（紧凑元组，便于审核）---- */

  var RAW = [

    /* ===== 一、自重下肢（8） ===== */
    ['深蹲', '徒手深蹲 / Bodyweight Squat', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、竖脊肌、核心肌群', 'N', 'bodyweight', '哑铃、壶铃、史密斯机', 'beginner',
      '1. 双脚与肩同宽或略宽站立，脚尖自然外展约十五至三十度。 2. 收紧核心、挺胸，双手前平举或抱于胸前保持平衡。 3. 髋膝同时屈曲下蹲，重心压在全脚掌，膝盖朝脚尖方向推出。 4. 蹲至大腿与地面接近平行，全程保持腰背中立不塌腰。 5. 脚跟发力蹬地起身，髋部前送回到站立位，呼吸节奏均匀。',
      '膝盖内扣、脚跟离地、腰椎过度反弓、下蹲时躯干过度前倾。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '零基础会员、热身环节、居家训练',
      '膝关节急性损伤者慎用，严重髋活动受限者先评估',
      '下蹲深度以不出现腰部塌陷为准'],

    ['弓步蹲', '原地箭步蹲 / Split Squat Lunge', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、小腿三头肌、髋内收肌', 'Y', 'bodyweight', '哑铃、壶铃', 'beginner',
      '1. 站立挺胸，双手叉腰或持哑铃于体侧，核心收紧。 2. 一腿向前迈出约一大步，前脚全掌踩实地面。 3. 垂直下蹲至前腿大腿接近水平，后膝下沉接近但不撞击地面。 4. 前脚跟发力蹬起，收回成站立位。 5. 两腿交替完成，躯干保持直立不前倾、不左右摇晃。',
      '步幅过小导致前膝严重超脚尖，后腿蹬地借力，躯干前倾塌腰。',
      '3 组 × 每侧 10-12 次，组间休息 60 秒',
      '下肢基础力量训练、平衡能力练习',
      '膝关节疼痛或半月板损伤者慎用，急性踝扭伤者禁用',
      '后膝触地前及时停住，避免用惯性弹动'],

    ['保加利亚分腿蹲', '后脚抬高分腿蹲 / Bulgarian Split Squat', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、髋内收肌、核心肌群', 'Y', 'bodyweight', '哑铃、壶铃、史密斯机', 'intermediate',
      '1. 背对凳子约一步距离站立，将后脚脚背搭在约膝盖高度的稳固凳面。 2. 前脚向前迈出，位置以下蹲时前膝不过度超过脚尖为准。 3. 躯干微前倾，重心压在前脚脚跟与前掌之间。 4. 下蹲至前腿大腿接近水平，后膝下沉接近地面。 5. 前腿发力蹬起回到起始位，完成规定次数后换腿。',
      '前脚站得太近导致膝部压力过大，骨盆歪斜，用后脚推凳借力。',
      '3 组 × 每侧 8-10 次，组间休息 90 秒',
      '有一定下肢基础、希望强化单腿力量的会员',
      '膝关节疼痛或平衡功能明显受限者慎用',
      '先徒手掌握平衡后再增加负重'],

    ['臀桥', '仰卧顶髋 / Glute Bridge', 'strength', 'hinge',
      '臀大肌', '腘绳肌、核心肌群、髋内收肌', 'N', 'bodyweight', '杠铃、弹力带、壶铃', 'beginner',
      '1. 仰卧屈膝，双脚与髋同宽踩实地面，脚跟距臀部约一掌距离。 2. 双臂置于体侧掌心向下，收紧腹部，先做骨盆后倾。 3. 脚跟发力顶髋抬起，直到肩、髋、膝接近一条直线。 4. 顶点主动夹紧臀部停顿一至二秒。 5. 缓慢下落，臀部接近但不完全放松贴地，保持张力连续。',
      '用腰部反弓代偿顶髋，顶点过度挺腰，脚跟离地改用脚尖发力。',
      '3 组 × 15-20 次，组间休息 45 秒',
      '久坐人群臀肌激活、热身与康复初期训练',
      '腰椎间盘突出急性期禁用，严重腰背疼痛者先评估',
      '顶髋高度以腹部能保持收紧为准，不追求过度抬腰'],

    ['单腿臀桥', '单腿顶髋 / Single-Leg Glute Bridge', 'strength', 'hinge',
      '臀大肌、腘绳肌', '核心肌群、臀中肌、竖脊肌', 'Y', 'bodyweight', '弹力带、杠铃', 'intermediate',
      '1. 仰卧屈膝，一脚踩实地面，另一腿伸直抬起与对侧大腿大致平行。 2. 收紧核心与臀部，保持骨盆处于水平位。 3. 支撑脚脚跟发力顶髋，抬至肩、髋、膝成一条直线。 4. 顶点停顿一至二秒后缓慢下落。 5. 完成一侧次数后换腿，两侧训练量保持一致。',
      '抬髋时骨盆明显歪斜，抬起的腿掉落导致节奏失控，腰部反弓。',
      '3 组 × 每侧 8-12 次，组间休息 60 秒',
      '已掌握双腿臀桥、需要纠正左右臀肌力量差的会员',
      '腰椎间盘突出急性期禁用，髋关节疼痛者慎用',
      '若出现骨盆明显下沉，改为双腿版本继续练习'],

    ['靠墙静蹲', '静力蹲 / Wall Sit', 'strength', 'squat',
      '股四头肌', '臀大肌、核心肌群', 'N', 'bodyweight', '弹力带、哑铃', 'beginner',
      '1. 背靠墙站立，双脚向前迈出约一步半距离，与髋同宽踩实。 2. 沿墙缓慢下滑至大腿与地面平行或略高，小腿与地面垂直。 3. 腰背贴墙，双手叉腰或前平举，收紧腹部。 4. 保持均匀呼吸，静态维持目标时长。 5. 结束时缓慢起身，避免突然站起引起头晕。',
      '下滑过深导致髌骨压力过大，憋气，腰背离墙塌腰。',
      '3 组 × 静态保持 30-45 秒，组间休息 60 秒',
      '膝关节康复中期、股四头肌耐力训练、不宜做动态蹲的会员',
      '髌骨软化或膝关节炎急性发作期慎用',
      '膝盖角度不要低于九十度，出现刺痛立即停止'],

    ['台阶上步', '箱台上步 / Step-Up', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、小腿三头肌、核心肌群', 'Y', 'bodyweight', '哑铃、壶铃', 'novice',
      '1. 面向约膝盖高度的稳固台阶或箱台站立，一脚全掌踩实台面。 2. 重心前移，用上方腿的脚跟发力蹬起身体。 3. 另一腿跟上轻触台面站直，不要靠后腿蹬地借力。 4. 控制下台阶，前脚先落地再收回后脚。 5. 完成规定次数后换腿，全程躯干稳定不左右摇晃。',
      '用后腿蹬地弹起，台面过高导致骨盆歪斜，下落时直接跳下。',
      '3 组 × 每侧 10-12 次，组间休息 60 秒',
      '下肢功能训练、日常上下楼能力强化',
      '膝关节疼痛、半月板损伤者慎用，急性踝扭伤者禁用',
      '台阶高度以能保持骨盆水平为准，务必使用稳固台面'],

    ['提踵', '站姿提踵 / Calf Raise', 'strength', 'isolation',
      '小腿三头肌', '比目鱼肌、胫骨前肌', 'N', 'bodyweight', '哑铃、腿举机、史密斯机', 'beginner',
      '1. 自然站立，双手扶墙或扶稳固椅背保持平衡，双脚与髋同宽。 2. 缓慢踮起脚尖至最高点，感受小腿后侧收缩。 3. 顶点停顿一秒后控制下落，站在台阶边缘做可增大活动范围。 4. 全程膝盖保持微屈不锁死，重心均匀分布在两脚。 5. 节奏均匀，避免靠身体惯性上下弹动。',
      '靠身体弹动完成、下落过快、膝盖完全锁死、脚踝内翻。',
      '3 组 × 15-20 次，组间休息 45 秒',
      '小腿耐力训练、踝关节稳定性训练、跑步爱好者',
      '跟腱炎急性期禁用，严重踝关节不稳者先做静态平衡练习',
      '站在台阶边缘做时务必扶稳支撑物'],

    /* ===== 二、自重上肢推（6） ===== */
    ['标准俯卧撑', '俯卧撑 / Push-Up', 'strength', 'push_horizontal',
      '胸大肌、肱三头肌', '三角肌前束、核心肌群', 'N', 'bodyweight', '弹力带、哑铃', 'novice',
      '1. 俯撑于地面，双手略宽于肩、指尖朝前，手腕位于肩正下方。 2. 收紧核心与臀部，使头、肩、髋、踝成一条直线。 3. 屈肘下放身体，肘部与躯干约呈四十五度，胸降至离地一拳。 4. 手掌推地撑起，回到肘部微屈的起始位。 5. 下放吸气、撑起呼气，全程躯干不塌陷、不耸肩。',
      '腰部下沉、臀部过高、肘部过度外展成九十度、只做半程。',
      '3 组 × 8-15 次，组间休息 60-90 秒',
      '已具备基础支撑力量、希望强化上肢推力的会员',
      '腕关节疼痛者慎用，肩关节撞击综合征患者避免大深度下放',
      '腕部不适可改用哑铃或俯卧撑架支撑'],

    ['跪姿俯卧撑', '跪姿推 / Knee Push-Up', 'strength', 'push_horizontal',
      '胸大肌、肱三头肌', '三角肌前束、核心肌群', 'N', 'bodyweight', '弹力带', 'beginner',
      '1. 双膝跪地并拢，小腿抬起或脚踝交叉，双手略宽于肩撑地。 2. 收紧腹部与臀部，从膝到头保持一条直线，避免塌腰。 3. 屈肘下放至胸部接近地面，肘部与躯干约四十五度。 4. 推地撑起回到起始位，肩胛保持后缩下沉。 5. 能标准完成十二次以上后，可进阶至标准俯卧撑。',
      '髋部后坐变成拜佛式、腰部塌陷、颈部前伸看地。',
      '3 组 × 10-15 次，组间休息 60 秒',
      '零基础会员、上肢力量较弱者的入门动作',
      '腕关节急性损伤者慎用，膝部不适者加软垫',
      '膝盖下垫软垫，优先保证躯干成一条直线'],

    ['上斜俯卧撑', '高位俯卧撑 / Incline Push-Up', 'strength', 'push_horizontal',
      '胸大肌、肱三头肌', '三角肌前束、核心肌群', 'N', 'bodyweight', '弹力带', 'beginner',
      '1. 双手撑在约六十至九十厘米高的稳固台面，双手略宽于肩。 2. 身体从头到踝成一条直线，脚跟向后蹬，核心收紧。 3. 屈肘下放至胸部接近台面边缘，肘部与躯干约四十五度。 4. 推起回到起始位，肩胛保持下沉稳定。 5. 台面越低难度越大，可循序渐进降低高度。',
      '台面不稳固、臀部后坐、肘部过度外展、肩胛完全松开。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '零基础会员、肩部力量不足者、康复后期上肢训练',
      '腕关节急性损伤者慎用，肩关节术后遵医嘱',
      '台面必须稳固防滑，越低难度越大需逐步过渡'],

    ['下斜俯卧撑', '脚高位俯卧撑 / Decline Push-Up', 'strength', 'push_horizontal',
      '胸大肌上部、三角肌前束', '肱三头肌、核心肌群', 'N', 'bodyweight', '弹力带', 'intermediate',
      '1. 双脚置于约三十至六十厘米高的稳固台面，双手撑地略宽于肩。 2. 收紧核心与臀部，身体从头到踝保持一条直线。 3. 屈肘下放至胸部接近地面，肘部与躯干约四十五度。 4. 推地撑起回到起始位，注意肩部不要耸起。 5. 台面越高负荷越大，需具备标准俯卧撑基础后再做。',
      '台面过高导致肩部压力过大，腰部下沉，颈部过度后仰。',
      '3 组 × 8-12 次，组间休息 90 秒',
      '已能标准完成十五次俯卧撑、希望强化上胸与肩部的会员',
      '肩关节疼痛者慎用，腕关节损伤者先做上斜版本',
      '脚部支撑物必须稳固，出现肩前侧疼痛立即停止'],

    ['钻石俯卧撑', '窄距俯卧撑 / Diamond Push-Up', 'strength', 'push_horizontal',
      '肱三头肌、胸大肌内侧', '三角肌前束、核心肌群', 'N', 'bodyweight', '哑铃、弹力带', 'advanced',
      '1. 俯撑位，双手拇指与食指相触成菱形，置于胸部正下方。 2. 收紧核心与臀部，身体从头到踝成一条直线。 3. 屈肘下放，肘部贴近躯干向后走，胸降至离地一拳。 4. 推地撑起回到肘部微屈位。 5. 控制节奏，避免腰部下沉或耸肩代偿，腕部不适可改用哑铃支撑。',
      '手位过于靠前、肘部外张、腰部塌陷、腕部过度受压。',
      '3 组 × 6-10 次，组间休息 90 秒',
      '已具备扎实俯卧撑基础、希望强化肱三头肌的会员',
      '腕关节疼痛者禁用，肘关节疼痛者慎用',
      '腕部不适时改用两只哑铃做窄距支撑'],

    ['派克俯卧撑', '下犬式俯卧撑 / Pike Push-Up', 'strength', 'push_vertical',
      '三角肌前束、肱三头肌', '斜方肌、核心肌群', 'N', 'bodyweight', '哑铃', 'advanced',
      '1. 从俯撑位将臀部向上顶起，身体成倒 V 字形，髋部位于肩上方。 2. 双手与肩同宽或略窄，头部自然放松于两臂之间。 3. 屈肘使头顶向地面靠近，肘部略向外打开。 4. 推地撑起回到倒 V 位，保持背部平直不塌腰。 5. 脚踩实地面或垫高可进一步增加肩部负荷。',
      '背部拱起塌腰、下沉幅度不够、头颈位置过度前伸。',
      '3 组 × 6-10 次，组间休息 90 秒',
      '希望以自重方式强化肩部推力、为倒立撑做准备的会员',
      '肩关节疼痛或撞击综合征患者禁用，高血压者慎做过头位动作',
      '出现肩前侧刺痛立即停止，颈部保持中立'],

    /* ===== 三、自重上肢拉与核心（8） ===== */
    ['引体向上', 'Pull-Up', 'strength', 'pull_vertical',
      '背阔肌、肱二头肌', '斜方肌、菱形肌、核心肌群', 'N', 'bodyweight', '弹力带、高位下拉器', 'intermediate',
      '1. 双手略宽于肩正握单杠，身体自然悬垂，肩胛下沉收紧。 2. 收紧核心与臀部，避免身体摆动借力。 3. 肩胛后缩下压带动躯干上拉，直至下巴过杠。 4. 控制下落至手臂完全伸直，肩胛完全放松。 5. 力量不足者可先用弹力带辅助，或先练离心下放。',
      '靠摆浪甩身上杠、只做半程、颈部过度前伸去够杠。',
      '4 组 × 3-8 次，组间休息 120 秒',
      '已具备基础背部力量、希望强化上肢拉力的会员',
      '肩关节疼痛者慎用，高血压者避免憋气发力',
      '杠高与握法要确保安全落地，避免脱手滑落'],

    ['澳式引体', '反向划船 / Inverted Row', 'strength', 'pull_horizontal',
      '背阔肌、斜方肌', '肱二头肌、菱形肌、核心肌群', 'N', 'bodyweight', '弹力带、绳索、悬吊带', 'beginner',
      '1. 将杠铃杆或稳固横杆置于约腰部高度，仰卧于杆下方。 2. 双手略宽于肩正握，身体从头到踝保持一条直线。 3. 脚跟蹬地，收紧核心与臀部，肩胛后缩带动胸部向杆靠近。 4. 胸部触杆后停顿一秒，控制回落到手臂伸直。 5. 杠位越低难度越大，可通过调整高度逐步提升。',
      '臀部下沉塌腰、靠颈部前伸凑杆、只用二头肌硬拉。',
      '3 组 × 10-12 次，组间休息 60 秒',
      '引体向上入门替代、背部基础力量训练',
      '严重腰椎间盘突出者慎用，肩关节急性疼痛者先评估',
      '横杆必须稳固承重，身体越低难度越大需循序渐进'],

    ['俯身反向划船', '桌沿划船 / Suspension Row', 'strength', 'pull_horizontal',
      '背阔肌、菱形肌', '斜方肌、肱二头肌、核心肌群', 'N', 'bodyweight', '弹力带、绳索', 'beginner',
      '1. 使用稳固的桌沿或悬吊带，握距与肩同宽，双脚踩实。 2. 身体后仰至与地面约四十五度，从头到踝保持一条直线。 3. 肩胛后缩下压，肘部贴近躯干将胸部拉向握点。 4. 顶点停顿一秒后缓慢回到起始位。 5. 身体越接近水平难度越大，注意不要塌腰或耸肩。',
      '躯干中途下沉、肩胛不后缩、靠屈腕勾拉、支撑物不稳固。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '背部激活、引体向上前的过渡训练',
      '腰椎间盘突出急性期慎用，严重肩痛者先评估',
      '务必确认桌沿或悬吊点稳固可靠后再发力'],

    ['平板支撑', '前臂支撑 / Plank', 'strength', 'core',
      '腹直肌、核心肌群', '臀大肌、三角肌前束', 'N', 'bodyweight', '', 'beginner',
      '1. 俯卧，前臂撑地，肘位于肩正下方，两侧前臂平行。 2. 脚尖蹬地抬起身体，使头、肩、髋、踝成一条直线。 3. 收紧腹部与臀部，主动把地面往后推，避免臀部抬高或塌陷。 4. 保持均匀呼吸，静态维持目标时长。 5. 出现腰部酸痛即停止，缩短时长或改为跪姿版本。',
      '臀部抬高或塌陷、憋气、头颈下垂、肘部远离肩部。',
      '3 组 × 静态保持 30-60 秒，组间休息 45 秒',
      '全体会员核心训练、腰背稳定的基础动作',
      '腰椎间盘突出急性期禁用，腹直肌分离者慎用',
      '优先保证姿势质量，宁可缩短时长也不塌腰'],

    ['侧平板支撑', '侧撑 / Side Plank', 'strength', 'core',
      '腹斜肌、核心肌群', '臀中肌、三角肌、腰方肌', 'Y', 'bodyweight', '', 'beginner',
      '1. 侧卧，下方前臂撑地，肘在肩正下方，双脚并拢或前后叠放。 2. 抬髋离地，使头、肩、髋、踝成一条直线。 3. 收紧腹部与臀部，上方手叉腰或向上伸展。 4. 保持均匀呼吸，静态维持目标时长后换侧。 5. 两侧时长保持一致，避免躯干前后旋转。',
      '髋部下沉、躯干向前后旋转、肩部塌陷顶肩。',
      '3 组 × 每侧 20-40 秒，组间休息 45 秒',
      '核心侧向稳定训练、腰痛预防、跑步与球类爱好者',
      '肩关节急性疼痛者慎用，腰椎术后遵医嘱',
      '肩部不适可改为屈肘九十度或跪姿侧撑'],

    ['死虫式', 'Dead Bug', 'strength', 'core',
      '腹直肌、核心肌群', '腹斜肌、髋屈肌群', 'N', 'bodyweight', '弹力带', 'beginner',
      '1. 仰卧，双臂伸直指向天花板，屈髋屈膝九十度使大腿垂直地面。 2. 腰部主动压向地面，消除腰与地面之间的空隙。 3. 缓慢伸展对侧手臂与腿，接近但不触碰地面。 4. 收回至起始位后换另一侧交替进行。 5. 全程保持腰椎贴地，速度越慢越能体现控制力。',
      '伸展过程中腰部拱起离地、动作过快、颈部紧张。',
      '3 组 × 每侧 10-12 次，组间休息 45 秒',
      '腰痛康复训练、核心抗伸展能力训练',
      '严重腰椎间盘突出急性期禁用',
      '一旦腰部离地即缩小幅度，不以手脚够地为标准'],

    ['鸟狗式', '四点跪对侧伸展 / Bird Dog', 'strength', 'core',
      '竖脊肌、臀大肌', '核心肌群、腹斜肌、三角肌后束', 'Y', 'bodyweight', '弹力带', 'beginner',
      '1. 四点跪位，双手在肩正下方，双膝在髋正下方。 2. 收紧核心，保持背部平直如桌面，骨盆不旋转。 3. 缓慢伸展右臂与左腿，直至接近与躯干平行。 4. 顶点停顿一至二秒，感受臀部与背部收缩后缓慢收回。 5. 换对侧交替进行，避免腰部塌陷或躯干晃动。',
      '抬腿过高导致腰部反弓，躯干左右晃动，速度过快。',
      '3 组 × 每侧 10-12 次，组间休息 45 秒',
      '腰背稳定训练、久坐人群、康复中期训练',
      '严重腰椎间盘突出急性期禁用，肩腕急性损伤者慎用',
      '伸展幅度以骨盆不倾斜为准，可在膝下垫软垫'],

    ['卷腹', '仰卧卷腹 / Crunch', 'strength', 'core',
      '腹直肌', '腹斜肌、髋屈肌群', 'N', 'bodyweight', '哑铃、弹力带', 'beginner',
      '1. 仰卧屈膝，双脚踩实地面，双手轻扶耳侧或交叉于胸前。 2. 收紧腹部，先做轻微骨盆后倾使腰部贴地。 3. 用腹部力量把胸廓向骨盆方向卷起，上背离地即可。 4. 顶点停顿一秒后缓慢下落，控制离心过程。 5. 双手不要用力拉扯颈部，全程保持呼吸不憋气。',
      '双手抱头用力拉颈，靠髋屈肌抬起整个躯干，下落直接躺平。',
      '3 组 × 15-20 次，组间休息 45 秒',
      '腹部基础训练、希望改善核心耐力的会员',
      '腰椎间盘突出急性期禁用，颈椎不适者避免抱头',
      '只卷起上背，腰始终贴地，避免做成仰卧起坐'],

    /* ===== 四、哑铃（12） ===== */
    ['哑铃卧推', 'Dumbbell Bench Press', 'strength', 'push_horizontal',
      '胸大肌、肱三头肌', '三角肌前束、核心肌群', 'N', 'dumbbell', '杠铃、器械、弹力带', 'novice',
      '1. 仰卧于平凳，双脚踩实地面，肩胛后缩下沉贴紧凳面。 2. 双手持哑铃置于胸部两侧，掌心朝前，腕关节保持中立。 3. 推起哑铃至胸部正上方，两侧轨迹略呈弧形靠拢。 4. 顶点不要锁死肘关节，保持胸部持续紧张。 5. 缓慢下放至胸侧有拉伸感，肩部保持下沉不耸起。',
      '哑铃下放过低导致肩前侧拉伤，两铃相互撞击，腰部过度反弓。',
      '4 组 × 8-12 次，组间休息 90 秒',
      '有基础训练经验、希望均衡发展两侧胸部的会员',
      '肩关节疼痛者慎用，手腕不稳者先减轻重量',
      '大重量训练建议有人保护，起落动作要控制'],

    ['上斜哑铃卧推', 'Incline Dumbbell Press', 'strength', 'push_horizontal',
      '胸大肌上部、三角肌前束', '肱三头肌、核心肌群', 'N', 'dumbbell', '杠铃、器械、弹力带', 'novice',
      '1. 将可调凳调至三十至四十五度，仰卧后肩胛后缩下沉贴紧。 2. 双手持哑铃置于上胸部两侧，掌心朝前。 3. 推起至锁骨上方，顶点轻靠但不相互撞击。 4. 缓慢下放至胸部有明显拉伸感，肘部角度以舒适为准。 5. 凳角越高越偏重三角肌前束，建议不超过四十五度。',
      '凳角过高达六十度以上变成肩推，腰部反弓过大，哑铃轨迹飘忽。',
      '3 组 × 10-12 次，组间休息 90 秒',
      '希望强化上胸线条、肩部推力尚可的会员',
      '肩关节撞击综合征患者慎用，腰椎不适者降低凳角',
      '起铃时先用腿部助力把哑铃送至胸前，避免肩部直接受力'],

    ['哑铃肩推', '哑铃过头推举 / Dumbbell Shoulder Press', 'strength', 'push_vertical',
      '三角肌前束、肱三头肌', '斜方肌、核心肌群', 'N', 'dumbbell', '杠铃、壶铃、器械', 'novice',
      '1. 坐姿或站姿持哑铃于肩两侧，掌心朝前，肘部略向前。 2. 收紧核心与臀部，避免腰椎过度反弓。 3. 推起哑铃至头顶上方，顶点轻靠但不相互撞击。 4. 顶点不要锁死肘关节，头部保持中立不前伸。 5. 缓慢下放至耳侧高度，控制离心，避免靠惯性甩起。',
      '腰椎过度反弓，靠蹬腿甩起重量，下放时肩部完全松掉。',
      '3 组 × 8-12 次，组间休息 90 秒',
      '希望强化肩部与上肢推力的会员',
      '肩关节疼痛或活动受限者慎用，颈椎不适者改坐姿',
      '站姿推举时先收紧腹部，重量过大建议改坐姿'],

    ['哑铃弯举', 'Dumbbell Bicep Curl', 'strength', 'isolation',
      '肱二头肌', '肱肌、前臂肌群', 'N', 'dumbbell', '弹力带、绳索', 'beginner',
      '1. 站姿持哑铃于体侧，掌心朝前，肘部贴紧躯干两侧。 2. 保持上臂固定不动，屈肘将哑铃举向肩部。 3. 顶点停顿一秒，充分收缩肱二头肌。 4. 缓慢下放至手臂完全伸直，感受拉伸。 5. 全程避免躯干前后摆动借力，手腕不要过度后翻。',
      '靠躯干前后摆动甩起，肘部前移离开躯干，下放过快失去张力。',
      '3 组 × 10-15 次，组间休息 60 秒',
      '手臂塑形入门、上肢基础训练',
      '肘关节疼痛者慎用，腕部腱鞘炎患者减轻重量',
      '重量宁轻勿重，全程保持上臂固定'],

    ['锤式弯举', '中立握弯举 / Hammer Curl', 'strength', 'isolation',
      '肱肌、肱二头肌', '肱桡肌、前臂肌群', 'N', 'dumbbell', '绳索、弹力带', 'beginner',
      '1. 站姿持哑铃于体侧，掌心相对呈握锤状，肘部贴紧躯干。 2. 屈肘举起哑铃至肩部高度，保持掌心始终相对。 3. 顶点停顿一秒，重点感受上臂外侧与前臂收缩。 4. 缓慢下放至手臂伸直，控制离心过程。 5. 可两侧交替或同时进行，避免用肩部甩动借力。',
      '中途翻腕变成普通弯举，躯干摆动，下放时肘部完全放松。',
      '3 组 × 10-12 次，组间休息 60 秒',
      '手臂围度训练、前臂与抓握力量强化',
      '肘关节疼痛者慎用，腕部急性损伤者先评估',
      '保持掌心相对是动作关键，重量不宜过大'],

    ['哑铃划船', '俯身哑铃划船 / Dumbbell Row', 'strength', 'pull_horizontal',
      '背阔肌、斜方肌', '肱二头肌、菱形肌、竖脊肌', 'N', 'dumbbell', '杠铃、绳索、弹力带', 'novice',
      '1. 双脚与髋同宽站立，微屈膝，髋部前屈至躯干与地面约四十五度。 2. 保持腰背中立，双手持哑铃自然下垂于膝前方。 3. 肩胛后缩带动肘部向后上方走，把哑铃拉向腰侧。 4. 顶点停顿一秒夹紧背部后缓慢下放。 5. 全程避免躯干上下起伏，头部保持自然中立位。',
      '躯干角度不断变化借力，圆背发力，靠屈腕勾拉。',
      '4 组 × 8-12 次，组间休息 90 秒',
      '背部厚度训练、有基础的下肢与核心稳定能力者',
      '腰椎间盘突出者慎用，严重圆背者先练髋铰链模式',
      '出现背部圆起立即减重，必要时改为单臂支撑版本'],

    ['单臂哑铃划船', '单臂俯身划船 / Single-Arm Dumbbell Row', 'strength', 'pull_horizontal',
      '背阔肌、菱形肌', '斜方肌、肱二头肌、核心肌群', 'Y', 'dumbbell', '绳索、弹力带、器械', 'beginner',
      '1. 一手与同侧膝支撑于凳面，另一脚踩实地面，躯干接近水平。 2. 支撑臂伸直，肩胛稳定，避免躯干旋转。 3. 持铃手自然下垂，肩胛后缩带动肘部向后上方走。 4. 哑铃拉至腰侧后停顿一秒，缓慢放回。 5. 完成一侧次数后换手，两侧重量与次数保持一致。',
      '躯干随拉起一起旋转、肘部外张过大、肩胛不后缩。',
      '3 组 × 每侧 10-12 次，组间休息 75 秒',
      '背部力量训练、希望纠正左右背肌不对称的会员',
      '腰椎间盘突出者慎用，肩关节急性疼痛者先评估',
      '凳面高度以躯干能保持水平且不旋转为准'],

    ['哑铃深蹲', '持铃深蹲 / Dumbbell Squat', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、核心肌群、竖脊肌', 'N', 'dumbbell', '壶铃、杠铃、史密斯机', 'beginner',
      '1. 双手持哑铃于体侧或托于肩前，双脚与肩同宽站立。 2. 收紧核心、挺胸，重心压在全脚掌。 3. 髋膝同时屈曲下蹲，膝盖朝脚尖方向，蹲至大腿接近水平。 4. 脚跟发力蹬地起身，髋部前送回到站立位。 5. 全程腰背保持中立，避免膝盖内扣或脚跟离地。',
      '膝盖内扣、脚跟离地、腰椎反弓、持铃晃动失去平衡。',
      '4 组 × 10-12 次，组间休息 90 秒',
      '自重深蹲已熟练、希望增加下肢负荷的会员',
      '膝关节疼痛者慎用，严重腰椎间盘突出者先评估',
      '先用高脚杯握法熟悉发力模式，再过渡到体侧持铃'],

    ['哑铃硬拉', 'Dumbbell Deadlift', 'strength', 'hinge',
      '腘绳肌、臀大肌', '竖脊肌、背阔肌、前臂肌群', 'N', 'dumbbell', '杠铃、壶铃', 'novice',
      '1. 双脚与髋同宽站立，哑铃置于脚背上方外侧，胫骨贴近哑铃。 2. 屈髋屈膝下握哑铃，腰背保持中立，肩略在铃前方。 3. 脚跟蹬地，髋膝同时伸展把哑铃沿腿部提起。 4. 站直时肩胛后缩下沉，不要过度后仰腰部。 5. 下放时先屈髋后屈膝，保持哑铃贴近腿部回到地面。',
      '圆背提拉、起始时臀部先抬起、哑铃远离身体、站直时挺腰过度。',
      '3 组 × 8-10 次，组间休息 90 秒',
      '杠铃硬拉入门替代、后链肌群基础训练',
      '腰椎间盘突出者禁用，严重腘绳肌拉伤者慎用',
      '先徒手掌握髋铰链模式，再逐步增加重量'],

    ['哑铃箭步走', '行走弓步 / Walking Lunge', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、小腿三头肌、核心肌群', 'Y', 'dumbbell', '壶铃、杠铃', 'novice',
      '1. 双手持哑铃于体侧，站立挺胸，核心收紧。 2. 一腿向前迈出一大步，前脚全掌踩实地面。 3. 后膝下沉接近地面，前腿大腿接近水平后蹬地起身。 4. 后腿向前迈出接替成下一次弓步，连续向前行走。 5. 保持躯干直立，步幅以能控制膝盖稳定为准。',
      '步幅过小导致膝部前冲，躯干左右摇晃，后膝直接撞地。',
      '3 组 × 每侧 10-12 次，组间休息 75 秒',
      '下肢耐力与协调性训练、有一定基础的会员',
      '膝关节疼痛者慎用，平衡功能受限者先做原地版本',
      '场地需平整无障碍，可先做原地弓步再过渡到行走'],

    ['哑铃侧平举', '侧平举 / Dumbbell Lateral Raise', 'strength', 'isolation',
      '三角肌中束', '三角肌前束、斜方肌', 'N', 'dumbbell', '弹力带、绳索', 'beginner',
      '1. 站姿持哑铃于体侧，掌心相对，肘部微屈约十至二十度。 2. 收紧核心，肩胛下沉，避免耸肩。 3. 用三角肌中束带动手臂向两侧抬起至肩部高度。 4. 顶点停顿一秒，拇指略高于小指可减少肩峰撞击风险。 5. 缓慢下放至体侧，全程不靠惯性甩动。',
      '靠惯性甩起重量、抬得过高超过肩、耸肩带动斜方肌代偿。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '肩部宽度塑形、肩部力量入门训练',
      '肩关节疼痛或撞击综合征患者慎用',
      '重量宜轻，出现肩峰处刺痛立即停止并降低抬升高度'],

    ['哑铃飞鸟', '仰卧飞鸟 / Dumbbell Fly', 'strength', 'isolation',
      '胸大肌', '三角肌前束、肱二头肌', 'N', 'dumbbell', '绳索、蝴蝶机', 'novice',
      '1. 仰卧于平凳，双手持哑铃置于胸部正上方，掌心相对。 2. 肘部保持约十至三十度微屈，并全程固定该角度。 3. 以胸大肌带动双臂向两侧划弧下落，至胸部有明显拉伸感。 4. 用胸部力量把哑铃沿原弧线收回至胸部上方。 5. 重量不宜过大，避免肘部伸直造成肩关节压力过大。',
      '下放幅度过大拉伤肩前侧，肘部角度不断变化，用三头肌推起。',
      '3 组 × 10-12 次，组间休息 75 秒',
      '胸部塑形、有一定卧推基础的会员',
      '肩关节疼痛或有脱位史者禁用，胸大肌拉伤者禁用',
      '大重量飞鸟风险高，末端可请人协助起铃'],

    /* ===== 五、杠铃（10） ===== */
    ['杠铃深蹲', '后蹲 / Barbell Back Squat', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、竖脊肌、核心肌群', 'N', 'barbell', '哑铃、史密斯机、壶铃', 'intermediate',
      '1. 将杠铃置于斜方肌上，双手略宽于肩握杆，肘部向下收。 2. 出杠后双脚与肩同宽或略宽站定，脚尖外展约十五至三十度。 3. 收紧核心与背部，髋膝同时屈曲下蹲，膝盖朝脚尖方向推出。 4. 蹲至大腿低于水平后脚跟蹬地起身，髋部前送。 5. 全程腰背保持中立，无深蹲架保护时不要使用接近极限的重量。',
      '腰椎反弓或圆背、膝盖内扣、脚跟离地、蹲深不够。',
      '4-5 组 × 5-8 次，组间休息 120-180 秒',
      '已掌握自重深蹲模式、追求下肢最大力量的会员',
      '腰椎间盘突出者禁用，膝关节疼痛者慎用',
      '务必在深蹲架内进行并设置好保险杠高度'],

    ['杠铃硬拉', '传统硬拉 / Conventional Deadlift', 'strength', 'hinge',
      '腘绳肌、臀大肌、竖脊肌', '背阔肌、斜方肌、前臂肌群', 'N', 'barbell', '哑铃、壶铃、六角杠', 'intermediate',
      '1. 双脚与髋同宽站立，杠铃杆贴近胫骨、位于脚掌中部上方。 2. 屈髋屈膝下握，腰背保持中立，肩略在杠前，手臂自然垂直。 3. 深吸气收紧核心，脚跟蹬地把地面推离，髋膝同步伸展。 4. 杠过膝后髋部前送站直，肩胛后缩下沉，不后仰腰部。 5. 下放先屈髋后屈膝，控制杠铃贴腿回落，全程避免圆背。',
      '起始圆背、臀部先于肩抬起、杠铃远离身体、末端过度后仰腰部。',
      '4-5 组 × 3-6 次，组间休息 150-180 秒',
      '已掌握髋铰链模式、追求全身最大力量的会员',
      '腰椎间盘突出者禁用，严重高血压者慎用',
      '不接受动作变形，出现圆背立即终止该组'],

    ['罗马尼亚硬拉', 'RDL / Romanian Deadlift', 'strength', 'hinge',
      '腘绳肌、臀大肌', '竖脊肌、背阔肌、前臂肌群', 'N', 'barbell', '哑铃、壶铃', 'intermediate',
      '1. 站姿持杠铃于大腿前方，双手与肩同宽，肘部保持伸直。 2. 微屈膝并保持该角度不变，以髋部后推主导，杠铃沿大腿下滑。 3. 下降至腘绳肌有明显拉伸感或杠铃到膝下即可停止。 4. 髋部前送夹臀站起，全程背部保持中立不圆背。 5. 重量以能控制腰椎稳定为准，不要为追求深度而弓背。',
      '变成深蹲式下蹲、背部圆起、杠铃离开腿部、膝屈角度不断变化。',
      '4 组 × 8-10 次，组间休息 90-120 秒',
      '后链肌群强化、硬拉辅助训练',
      '腰椎间盘突出者禁用，腘绳肌拉伤急性期禁用',
      '下降幅度以背部能保持平直为上限'],

    ['杠铃卧推', '平板卧推 / Barbell Bench Press', 'strength', 'push_horizontal',
      '胸大肌、肱三头肌', '三角肌前束、核心肌群', 'N', 'barbell', '哑铃、史密斯机、器械', 'intermediate',
      '1. 仰卧于平凳，双眼位于杠铃杆正下方，双脚踩实地面。 2. 双手略宽于肩握杆，腕关节保持中立，肩胛后缩下沉。 3. 出杠后缓慢下放至下胸或胸中部，肘部与躯干约四十五度。 4. 胸部发力推起至手臂接近伸直，顶点不锁死肘关节。 5. 大重量训练建议有保护者或在卧推架内完成，避免用腰部反弓借力。',
      '腰部过度反弓、杠铃落点过高靠近颈部、肘部外展九十度、触胸后弹起。',
      '4-5 组 × 5-8 次，组间休息 120-180 秒',
      '有训练经验、追求上肢推力的会员',
      '肩关节疼痛者慎用，腕关节不稳者先做哑铃版本',
      '大重量必须有保护者或安全架，勿空握'],

    ['上斜杠铃卧推', 'Incline Barbell Bench Press', 'strength', 'push_horizontal',
      '胸大肌上部、三角肌前束', '肱三头肌、核心肌群', 'N', 'barbell', '哑铃、史密斯机、器械', 'intermediate',
      '1. 将凳面调至三十至四十五度，仰卧后双眼位于杠铃杆正下方。 2. 双手略宽于肩握杆，肩胛后缩下沉贴紧凳面。 3. 出杠后缓慢下放至上胸部，肘部与躯干约四十五度。 4. 推起至手臂接近伸直，杠铃轨迹略向头部方向倾斜。 5. 全程保持核心收紧，避免颈部过度抬起或腰椎反弓过大。',
      '凳角过高变成肩推，落点过低，肩胛未后缩导致肩前侧受压。',
      '4 组 × 6-10 次，组间休息 120 秒',
      '希望强化上胸、已掌握平板卧推的会员',
      '肩关节撞击综合征患者慎用，腰椎不适者降低凳角',
      '大重量需在卧推架内或有保护者时进行'],

    ['杠铃划船', '俯身杠铃划船 / Barbell Bent-Over Row', 'strength', 'pull_horizontal',
      '背阔肌、菱形肌', '斜方肌、肱二头肌、竖脊肌', 'N', 'barbell', '哑铃、绳索、器械', 'intermediate',
      '1. 双脚与髋同宽站立，屈髋至躯干与地面约四十五度，膝微屈。 2. 双手略宽于肩握杆，腰背保持中立，颈部自然延伸。 3. 肩胛后缩带动杠铃沿大腿上拉至下腹部或胸骨下缘。 4. 顶点停顿一秒夹紧背部，缓慢放回至手臂伸直。 5. 全程避免躯干大幅晃动，出现圆背应立即减重。',
      '躯干角度随拉起变化借力，圆背发力，杠铃落点过高偏向颈部。',
      '4 组 × 6-10 次，组间休息 120 秒',
      '背部厚度训练、有基础髋铰链能力的会员',
      '腰椎间盘突出者禁用，严重圆背者先纠正动作模式',
      '一旦背部圆起立即停止，宁可减重也不变形'],

    ['杠铃肩推', '站姿杠铃推举 / Overhead Press', 'strength', 'push_vertical',
      '三角肌前束、肱三头肌', '斜方肌、核心肌群、胸大肌上部', 'N', 'barbell', '哑铃、器械、壶铃', 'intermediate',
      '1. 站姿或坐姿把杠铃托于锁骨前方，双手略宽于肩握杆。 2. 收紧核心与臀部，避免腰椎过度反弓。 3. 推起杠铃至头顶上方，上臂贴近耳侧，头部在过顶前略微后移让位。 4. 顶点不锁死肘关节，缓慢下放回到锁骨位。 5. 重量较大时建议在深蹲架内进行，避免靠蹬腿借力。',
      '腰椎过度反弓，靠蹬腿推起，杠铃轨迹偏离中线，头部过度后仰。',
      '4 组 × 5-8 次，组间休息 120-150 秒',
      '有训练经验、追求上肢垂直推力的会员',
      '肩关节活动受限或疼痛者慎用，颈椎不适者改坐姿',
      '肩部柔韧性不足时先做胸椎与肩屈活动度训练'],

    ['杠铃臀桥', '杠铃顶髋 / Barbell Hip Thrust', 'strength', 'hinge',
      '臀大肌', '腘绳肌、核心肌群、髋内收肌', 'N', 'barbell', '哑铃、壶铃、弹力带', 'intermediate',
      '1. 上背靠在约四十厘米高的凳沿，杠铃置于髋部，双手握杆固定。 2. 双脚与髋同宽踩实地面，脚跟距臀部约一掌。 3. 先做骨盆后倾收紧腹部，再脚跟发力顶髋抬起。 4. 抬至肩、髋、膝成一条直线，顶点夹紧臀部停顿一秒。 5. 缓慢下放，臀部接近地面但不放松张力，全程腰椎不反弓。',
      '靠腰部反弓顶髋、脚跟离地、膝盖过度外张、杠铃滑动。',
      '4 组 × 8-12 次，组间休息 90-120 秒',
      '臀肌专项强化、已掌握自重臀桥的会员',
      '腰椎间盘突出急性期禁用，髋屈肌紧张者先做拉伸',
      '杠铃务必加护垫并使用卡箍固定'],

    ['杠铃弯举', '站姿杠铃弯举 / Barbell Curl', 'strength', 'isolation',
      '肱二头肌', '肱肌、前臂肌群', 'N', 'barbell', '哑铃、绳索、弹力带', 'beginner',
      '1. 站姿双手与肩同宽反握杠铃，肘部贴紧躯干两侧。 2. 收紧核心，肩胛下沉，上臂保持固定不动。 3. 屈肘把杠铃举至胸前，顶点停顿一秒收缩肱二头肌。 4. 缓慢下放至手臂完全伸直，控制离心过程。 5. 腕部不适可换用曲杆，避免靠躯干摆动甩起重量。',
      '肘部前移离开躯干，靠腰背摆动甩起，下放过快。',
      '3 组 × 8-12 次，组间休息 60-90 秒',
      '手臂力量训练、有一定训练基础的会员',
      '肘关节疼痛者慎用，腕部腱鞘炎患者可换曲杆',
      '直杆对手腕压力大，不适时改用 EZ 曲杆'],

    ['高翻', '力量翻 / Power Clean', 'strength', 'hinge',
      '臀大肌、股四头肌、斜方肌', '腘绳肌、竖脊肌、三角肌前束', 'N', 'barbell', '哑铃、壶铃', 'advanced',
      '1. 起始姿势同硬拉：杠铃贴近胫骨，双手略宽于肩，髋部高于膝。 2. 髋膝快速伸展做爆发性提拉，杠铃沿腿部加速上升并保持贴近身体。 3. 杠至大腿中部时做二次屈膝、耸肩提肘，把杠铃带到锁骨前架位。 4. 迅速翻肘接杠，顺势微屈膝缓冲后站直完成。 5. 需先掌握硬拉与悬垂翻技术，建议在教练指导下进行。',
      '用手臂硬拉替代髋部发力，杠铃远离身体，接杠时手腕过度折叠。',
      '5-6 组 × 2-3 次，组间休息 150-180 秒',
      '有系统训练经验、追求爆发力与全身协调的会员',
      '腰椎间盘突出者禁用，腕肩急性损伤者禁用，初学者禁用',
      '必须在专业指导下进行，场地需有举重台或缓冲垫'],

    /* ===== 六、器械与绳索（10） ===== */
    ['高位下拉', '引体辅助下拉 / Lat Pulldown', 'strength', 'pull_vertical',
      '背阔肌', '肱二头肌、斜方肌、菱形肌', 'N', 'machine', '弹力带、绳索、哑铃', 'beginner',
      '1. 调整挡腿垫固定大腿，双手宽握横杆，坐稳后躯干微后倾约十度。 2. 肩胛先下沉后缩，避免耸肩启动。 3. 用背部力量把横杆拉至上胸，肘部向下向后走。 4. 顶点停顿一秒夹紧背部，缓慢回放至手臂完全伸直。 5. 避免靠躯干大幅后仰甩动，颈部保持中立位。',
      '躯干后仰过大借力，横杆拉到颈后，回放时直接松手。',
      '3-4 组 × 10-12 次，组间休息 75 秒',
      '引体向上入门替代、背部宽度训练',
      '肩关节疼痛者慎用，颈后下拉方式不建议使用',
      '一律拉至上胸位置，不要采用颈后下拉'],

    ['坐姿划船', '器械划船 / Seated Cable Row', 'strength', 'pull_horizontal',
      '背阔肌、菱形肌', '斜方肌、肱二头肌、竖脊肌', 'N', 'machine', '绳索、弹力带、哑铃', 'beginner',
      '1. 坐于器械，双脚踩稳踏板，膝微屈，双手握住把手。 2. 挺胸保持腰背中立，肩胛先下沉后缩。 3. 用背部力量把手柄拉向下腹部，肘部贴近躯干。 4. 顶点停顿一秒，缓慢回放至手臂伸直但不塌肩。 5. 全程躯干不要前后大幅摆动，避免靠惯性完成。',
      '躯干前后晃动借力，圆背拉拽，回放时肩胛完全松掉。',
      '3-4 组 × 10-12 次，组间休息 75 秒',
      '背部基础训练、久坐人群姿势改善',
      '腰椎间盘突出者慎用，肩关节急性疼痛者先评估',
      '重量以能保持挺胸、背不圆为准'],

    ['腿举', '倒蹬 / Leg Press', 'strength', 'squat',
      '股四头肌、臀大肌', '腘绳肌、小腿三头肌', 'N', 'machine', '杠铃、哑铃、史密斯机', 'beginner',
      '1. 坐入器械，背部与头部贴紧靠背，双脚与髋同宽踩在踏板中部。 2. 解开保险后缓慢屈膝下放，控制踏板靠近身体。 3. 下放至臀部即将离座卷起之前停止，不要继续加深。 4. 脚跟发力蹬起至腿部接近伸直，顶点不锁死膝关节。 5. 全程腰背贴紧靠背，出现腰椎不适立即停止。',
      '下放过深导致骨盆卷离靠背，顶点锁死膝关节，脚位过高压力集中在膝。',
      '3-4 组 × 10-12 次，组间休息 90 秒',
      '下肢力量训练、杠铃深蹲的替代或补充',
      '膝关节疼痛者慎用，腰椎间盘突出者控制下放深度',
      '下放深度以骨盆不离开靠背为上限'],

    ['腿弯举', '俯卧勾腿 / Leg Curl', 'strength', 'isolation',
      '腘绳肌', '腓肠肌、臀大肌', 'N', 'machine', '哑铃、弹力带、瑞士球', 'beginner',
      '1. 俯卧或坐于腿弯举器械，把滚垫卡在踝关节上方，固定好大腿。 2. 双手握稳把手，髋部紧贴垫面不要抬起。 3. 屈膝把滚垫向臀部方向勾起，感受腘绳肌收缩。 4. 顶点停顿一秒后缓慢回放至腿部接近伸直。 5. 避免靠惯性甩动，重量以能控制离心为准。',
      '靠惯性弹动，髋部抬起借力，回放时配重块直接砸下。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '腘绳肌强化、前链后链平衡训练、跑者膝预防',
      '腘绳肌拉伤急性期禁用，膝关节术后遵医嘱',
      '出现腘绳肌抽筋或刺痛立即停止并拉伸放松'],

    ['腿伸展', '坐姿伸膝 / Leg Extension', 'strength', 'isolation',
      '股四头肌', '髋屈肌群', 'N', 'machine', '弹力带、哑铃', 'beginner',
      '1. 坐入器械，背部贴紧靠背，把滚垫卡在踝关节前方。 2. 双手握稳把手，固定大腿，膝关节对准器械转轴。 3. 缓慢伸膝至腿部接近完全伸直，顶点停顿一秒收缩股四头肌。 4. 控制回放至起始角度，保持张力连续。 5. 重量不宜过大，髌骨出现疼痛感应立即停止并降低幅度。',
      '重量过大靠甩动伸膝，髋部离开靠背，回放过快失去张力。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '股四头肌孤立训练、膝关节康复中期（遵医嘱）',
      '髌骨软化、髌腱炎患者慎用，膝关节炎急性期禁用',
      '出现髌骨周围疼痛立即停止，改用闭链动作替代'],

    ['蝴蝶机夹胸', '器械飞鸟 / Machine Chest Fly', 'strength', 'isolation',
      '胸大肌', '三角肌前束、肱二头肌', 'N', 'machine', '绳索、哑铃、弹力带', 'beginner',
      '1. 调整座椅高度使手柄与胸中部大致同高，上臂与地面接近平行。 2. 背部贴紧靠背，双手握住手柄，肘部保持微屈并固定该角度。 3. 用胸大肌带动双臂向前内收，两手在胸前中线会合。 4. 顶点停顿一秒充分收缩胸部，缓慢打开至有拉伸感。 5. 肩部不要耸起，打开幅度以肩关节舒适为准。',
      '打开幅度过大拉伤肩前侧，耸肩发力，靠手臂推而不是胸部内收。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '胸部孤立训练、飞鸟类动作的入门替代',
      '肩关节疼痛或有脱位史者禁用，胸大肌拉伤者禁用',
      '打开幅度不要超过肩部舒适范围'],

    ['绳索面拉', 'Face Pull', 'strength', 'pull_horizontal',
      '三角肌后束、斜方肌中下束', '菱形肌、肱二头肌', 'N', 'cable', '弹力带、哑铃', 'beginner',
      '1. 把绳索调至上胸高度，双手各握绳端，面对滑轮站立。 2. 双臂前伸抓住绳索，后退一步使绳索保持张力，微屈膝站稳。 3. 把绳拉向面部两侧，同时外旋上臂，肘部向两侧打开。 4. 顶点停顿一秒，感受后肩与上背收紧后缓慢回放。 5. 躯干保持稳定不前倾借力，重量宜轻以体会肩胛控制。',
      '重量过大变成普通划船，缺少肩外旋，躯干前倾借力。',
      '3 组 × 15-20 次，组间休息 45-60 秒',
      '圆肩驼背改善、肩部健康维护、推类训练的平衡动作',
      '肩关节急性疼痛者慎用',
      '重量宁轻勿重，重点是肩胛后缩与肩外旋控制'],

    ['绳索下压', '三头肌下压 / Triceps Pushdown', 'strength', 'isolation',
      '肱三头肌', '肘肌、前臂肌群', 'N', 'cable', '弹力带、哑铃', 'beginner',
      '1. 面对高位滑轮站立，双手握住横杆或绳把，肘部夹紧躯干两侧。 2. 上臂保持固定不动，微屈膝站稳，躯干略前倾。 3. 伸肘把把手向下压至大腿前方，末段可略微分开绳端。 4. 顶点停顿一秒收缩肱三头肌，缓慢回放至肘约九十度。 5. 避免肘部外张或用肩部压杆借力，全程控制速度。',
      '肘部外张，靠肩部下压与躯干前倾借力，回放过快。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '手臂后侧塑形、卧推与肩推的辅助训练',
      '肘关节疼痛者慎用，肩关节急性疼痛者先评估',
      '上臂必须夹住不动，重量以能保持肘部固定为准'],

    ['绳索弯举', '低位绳索弯举 / Cable Curl', 'strength', 'isolation',
      '肱二头肌', '肱肌、前臂肌群', 'N', 'cable', '哑铃、弹力带', 'beginner',
      '1. 将低位滑轮装上直杆或绳把，双手反握，站距约一步远。 2. 上臂贴紧躯干，肘部位于身体两侧，核心收紧。 3. 屈肘把手柄举向肩部，顶点停顿一秒收缩肱二头肌。 4. 缓慢回放至手臂接近伸直，保持绳索全程有张力。 5. 躯干不要前后摆动，站位越靠后阻力方向越偏向上方。',
      '肘部前移离开躯干，躯干摆动借力，回放时配重块松掉。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '手臂塑形、希望获得全程持续张力的会员',
      '肘关节疼痛者慎用，腕部急性损伤者先评估',
      '保持绳索全程张力，不要让配重块落回'],

    ['史密斯机卧推', '史密斯卧推 / Smith Machine Bench Press', 'strength', 'push_horizontal',
      '胸大肌、肱三头肌', '三角肌前束、核心肌群', 'N', 'machine', '杠铃、哑铃、器械', 'novice',
      '1. 仰卧于史密斯机平凳上，使肩部位于杠铃杆正下方，双脚踩实地面。 2. 双手略宽于肩握杆，肩胛后缩下沉贴紧凳面。 3. 解锁转动杠铃后缓慢下放至胸中部，肘部与躯干约四十五度。 4. 推起至手臂接近伸直，顶点不锁死肘关节。 5. 固定轨迹减轻了稳定需求，但仍需保持肩部下沉，避免肘部过度外展。',
      '把凳位摆放得过于靠后导致杠铃落到颈部，肘部外展九十度，肩胛未后缩。',
      '3-4 组 × 8-10 次，组间休息 90 秒',
      '缺少保护者时的卧推替代、胸部力量训练',
      '肩关节疼痛者慎用，腕关节不稳者先做哑铃版本',
      '固定轨迹不代表安全，仍要控制下放速度与幅度'],

    /* ===== 七、壶铃与弹力带（6） ===== */
    ['壶铃摆荡', '壶铃摇摆 / Kettlebell Swing', 'strength', 'hinge',
      '臀大肌、腘绳肌', '竖脊肌、核心肌群、斜方肌', 'N', 'kettlebell', '哑铃、弹力带', 'intermediate',
      '1. 双脚略宽于肩站立，壶铃置于身前一脚远处，双手或单手握住把手。 2. 屈髋微屈膝，把壶铃向后从胯下荡出，腰背保持中立。 3. 髋部快速前送并夹紧臀部，让壶铃顺势荡至胸部高度。 4. 壶铃靠惯性上升，手臂只是传导力量，顶点身体成站直姿态。 5. 壶铃回落时再次屈髋缓冲接住，节奏连贯，避免用手臂硬拉。',
      '做成深蹲式下蹲，用手臂把壶铃抬到过头，圆背摆荡。',
      '4 组 × 15-20 次，组间休息 60-90 秒',
      '体能与后链爆发力训练、有一定髋铰链基础的会员',
      '腰椎间盘突出者禁用，肩关节急性疼痛者慎用',
      '核心是髋部发力而非手臂上抬，疲劳时立即停止'],

    ['壶铃硬拉', 'Kettlebell Deadlift', 'strength', 'hinge',
      '腘绳肌、臀大肌', '竖脊肌、背阔肌、前臂肌群', 'N', 'kettlebell', '杠铃、哑铃、六角杠', 'beginner',
      '1. 双脚略宽于肩站立，壶铃置于两脚之间靠近脚跟的位置。 2. 屈髋屈膝下沉握住壶铃把手，腰背保持中立，肩略在壶铃上方。 3. 脚跟蹬地，髋膝同步伸展把壶铃提起，手臂自然伸直。 4. 站直时夹紧臀部与背部，不要后仰腰部。 5. 下放先屈髋后屈膝，壶铃沿腿部轨迹回到地面。',
      '圆背提拉，起始时臀部先抬起，壶铃远离身体。',
      '3 组 × 10-12 次，组间休息 75 秒',
      '杠铃硬拉入门替代、后链模式学习',
      '腰椎间盘突出者禁用，腘绳肌拉伤急性期禁用',
      '先徒手掌握髋铰链模式再负重'],

    ['壶铃高脚杯深蹲', '壶铃抱铃深蹲 / Goblet Squat', 'strength', 'squat',
      '股四头肌、臀大肌', '核心肌群、竖脊肌、三角肌前束', 'N', 'kettlebell', '哑铃、杠铃', 'beginner',
      '1. 双手托住壶铃两侧把手把它抱于胸前，肘部向下贴紧躯干。 2. 双脚与肩同宽或略宽站立，脚尖外展，收紧核心。 3. 髋膝同时屈曲下蹲，膝盖朝脚尖方向，蹲至大腿接近水平或更低。 4. 脚跟发力蹬地起身，髋部前送回到站立位。 5. 全程保持躯干直立、腰背中立，壶铃不要远离胸口。',
      '下蹲时躯干前倒，肘部外张使壶铃远离身体，膝盖内扣。',
      '3-4 组 × 10-12 次，组间休息 75 秒',
      '深蹲模式学习、希望建立躯干直立姿势的会员',
      '膝关节疼痛者慎用，严重腰椎间盘突出者先评估',
      '肘部要始终贴住躯干内侧，靠前侧负重帮助保持直立'],

    ['弹力带划船', '站姿弹力带划船 / Band Row', 'strength', 'pull_horizontal',
      '背阔肌、菱形肌', '斜方肌、肱二头肌、核心肌群', 'N', 'band', '绳索、哑铃、器械', 'beginner',
      '1. 把弹力带固定于胸高位置，双手各握一端，面向锚点站立。 2. 后退至弹力带保持一定张力，双脚前后开立，膝微屈。 3. 肩胛后缩下压，肘部贴近躯干把手拉向腰侧。 4. 顶点停顿一秒夹紧背部，缓慢回放至手臂伸直。 5. 躯干不要前后晃动，可通过站位远近调节阻力大小。',
      '躯干前后晃动借力，肩胛不后缩，弹力带突然滑脱。',
      '3 组 × 12-15 次，组间休息 60 秒',
      '居家背部训练、出差便携训练、背部激活',
      '肩关节急性疼痛者慎用，腰椎间盘突出者保持躯干稳定',
      '固定点必须牢固，检查弹力带无裂口后再使用'],

    ['弹力带侧平举', '弹力带肩外展 / Band Lateral Raise', 'strength', 'isolation',
      '三角肌中束', '三角肌前束、斜方肌', 'N', 'band', '哑铃、绳索', 'beginner',
      '1. 双脚踩住弹力带中部，双手握住两端置于体侧，掌心相对。 2. 肘部保持微屈，肩胛下沉，核心收紧。 3. 双臂向两侧抬起至肩部高度，全程对抗弹力带阻力。 4. 顶点停顿一秒后缓慢下放，保持张力不松。 5. 避免耸肩或用躯干侧屈借力，可换更细的带子降低阻力。',
      '耸肩带动斜方肌代偿，靠躯干侧屈借力，下放时突然松手。',
      '3 组 × 15-20 次，组间休息 45 秒',
      '肩部耐力训练、居家与便携训练',
      '肩关节撞击综合征患者慎用',
      '阻力随抬升增大，末端不要强求抬到过肩高度'],

    ['弹力带臀桥', '弹力带顶髋 / Banded Glute Bridge', 'strength', 'hinge',
      '臀大肌、臀中肌', '腘绳肌、核心肌群、髋内收肌', 'N', 'band', '杠铃、壶铃、哑铃', 'beginner',
      '1. 仰卧屈膝，把弹力带套在膝盖上方，双脚与髋同宽踩实地面。 2. 双脚轻微外撑使弹力带保持张力，收紧腹部做骨盆后倾。 3. 脚跟发力顶髋抬起，至肩、髋、膝成一条直线。 4. 顶点夹紧臀部并向外对抗弹力带，停顿一至二秒。 5. 缓慢下放，膝盖始终向外对抗弹力带，不要内扣。',
      '顶髋时腰椎反弓，膝盖向内扣，弹力带滑到膝关节上造成挤压。',
      '3 组 × 15-20 次，组间休息 45 秒',
      '臀肌激活、膝内扣纠正、热身环节',
      '腰椎间盘突出急性期禁用，膝关节炎急性期慎用',
      '弹力带套在膝上方而非关节线上，避免直接压迫髌骨'],

    /* ===== 八、有氧（5） ===== */
    ['跑步机慢跑', 'Treadmill Jog', 'cardio', 'locomotion',
      '心肺系统、股四头肌、腘绳肌', '小腿三头肌、臀大肌、核心肌群', 'N', 'cardio_machine', '椭圆机、户外慢跑、划船机', 'beginner',
      '1. 上机前先用低速步行一至二分钟热身，站稳后再逐步提速。 2. 目视前方，躯干自然直立，手臂前后自然摆动，不要紧握扶手。 3. 速度以能正常说话为宜，步频保持均匀，全脚掌自然落地。 4. 结束前用三至五分钟逐步减速步行，不要急停。 5. 全程扣好安全夹，鞋带与衣物收纳整齐。',
      '紧握扶手导致姿势变形，步幅过大跨步，突然跳下跑带。',
      '每次 20-40 分钟，中等强度，每周 3-5 次',
      '减脂人群、心肺基础训练、热身与放松',
      '严重膝关节炎者慎用，心血管疾病患者须遵医嘱',
      '务必使用安全夹，出现胸闷头晕立即减速停止'],

    ['椭圆机', 'Elliptical Trainer', 'cardio', 'locomotion',
      '心肺系统、股四头肌', '腘绳肌、臀大肌、三角肌', 'N', 'cardio_machine', '跑步机、动感单车、划船机', 'beginner',
      '1. 双脚踩稳踏板，双手握住活动扶手，先用低速熟悉运动轨迹。 2. 躯干保持直立，核心微收，不要把体重压在扶手上。 3. 阻力与速度以呼吸平稳、能持续说话为宜。 4. 正向与反向踩踏可交替进行，兼顾不同肌群负荷。 5. 结束时逐步减速，等设备完全停稳再下机。',
      '身体过度前倾压在扶手上，只用腿部不参与上肢，速度忽快忽慢。',
      '每次 20-40 分钟，中等强度，每周 3-5 次',
      '低冲击有氧需求者、关节不适人群、减脂人群',
      '严重膝关节或髋关节病变者先咨询医生',
      '下机前确认踏板完全停稳'],

    ['划船机', '室内划船 / Rowing Machine', 'cardio', 'pull_horizontal',
      '心肺系统、背阔肌、股四头肌', '腘绳肌、臀大肌、肱二头肌', 'N', 'cardio_machine', '跑步机、椭圆机、动感单车', 'novice',
      '1. 坐上滑轨并固定双脚，双手握住把手，小腿接近垂直。 2. 按腿部、躯干、手臂的顺序依次发力蹬伸，把手沿大腿拉至腹部下缘。 3. 回桨按手臂、躯干、腿的相反顺序复位，节奏约为拉桨一比回桨二。 4. 保持腰背中立，不要靠躯干过度后仰完成拉桨。 5. 以每分钟桨频与心率控制强度，初学者先做十至十五分钟。',
      '拉桨与回桨顺序颠倒，躯干过度后仰，全程只用手臂拉。',
      '每次 10-30 分钟，中等强度，每周 2-4 次',
      '全身有氧与心肺训练、希望兼顾背部力量的会员',
      '腰椎间盘突出者慎用，严重肩背疼痛者先评估',
      '重点在腿部蹬伸顺序，腰背一旦圆起立即停止'],

    ['动感单车', '室内骑行 / Stationary Bike', 'cardio', 'locomotion',
      '心肺系统、股四头肌', '腘绳肌、小腿三头肌、臀大肌', 'N', 'cardio_machine', '椭圆机、跑步机、划船机', 'beginner',
      '1. 调整座椅高度，使踏板处于最低点时膝部微屈约二十五至三十五度。 2. 双脚卡入脚踏并扣紧绑带，核心微收，肩部放松。 3. 坐姿骑行保持踏频稳定，站姿爬坡时躯干略前倾但不左右晃动。 4. 阻力以能维持目标踏频为准，避免过大阻力压迫膝关节。 5. 结束后逐步降阻减速，膝髋出现不适立即停止。',
      '座椅过低导致膝部过度屈曲，阻力过大硬踩，长时间耸肩握把。',
      '每次 20-40 分钟，中等强度，每周 3-5 次',
      '减脂人群、膝关节不宜承受冲击者、康复期有氧',
      '严重膝关节炎者慎用，心血管疾病患者须遵医嘱',
      '座椅高度务必先调好，避免膝髋不适'],

    ['开合跳', 'Jumping Jack', 'cardio', 'locomotion',
      '心肺系统、小腿三头肌', '三角肌、股四头肌、核心肌群', 'N', 'bodyweight', '弹力带、跳绳', 'beginner',
      '1. 自然站立，双手置于体侧，双脚并拢。 2. 跳起的同时双脚向外分开略宽于肩，双臂经体侧上举过头。 3. 再跳一次回到并拢站姿，手臂同时放下。 4. 前脚掌落地缓冲，膝部微屈保持弹性，节奏均匀。 5. 可先做分步版本熟悉节奏，再过渡到连续跳跃。',
      '落地时膝部僵直无缓冲，手臂只抬到肩部，节奏忽快忽慢。',
      '每次 3-5 组 × 30-60 秒，组间休息 30 秒',
      '热身环节、居家有氧、团体课循环训练',
      '膝踝关节急性损伤者禁用，严重骨质疏松者禁用',
      '穿有缓冲的运动鞋，避免在地砖等硬地面长时间做'],

    /* ===== 九、活动度与体态（3） ===== */
    ['猫牛式', 'Cat-Cow', 'mobility', 'core',
      '竖脊肌、腹直肌', '核心肌群、肩胛带肌群、臀大肌', 'N', 'bodyweight', '', 'beginner',
      '1. 四点跪位，双手在肩正下方、双膝在髋正下方，脊柱处于中立位。 2. 吸气时缓慢抬头塌腰、坐骨上翘做牛式，感受脊柱逐节伸展。 3. 呼气时低头含胸、尾骨内收，背部拱起做猫式。 4. 配合呼吸缓慢重复，动作由腰椎向胸椎逐节带动。 5. 全程动作轻柔，出现刺痛或麻木应立即停止。',
      '动作过快失去逐节控制，只动头颈不动脊柱，憋气完成。',
      '2-3 组 × 8-10 次，配合呼吸，节奏缓慢',
      '热身与放松环节、久坐人群、腰背僵硬者',
      '腰椎滑脱或椎管狭窄者避免过大塌腰幅度',
      '出现放射性疼痛或麻木立即停止并就医评估'],

    ['胸椎旋转', '四足胸椎旋转 / Thoracic Rotation', 'posture', 'core',
      '胸椎旋转肌群、腹斜肌', '竖脊肌、肩胛带肌群', 'N', 'bodyweight', '弹力带、泡沫轴', 'beginner',
      '1. 从四点跪位或侧卧位开始，一手置于头后或耳侧，肩胛保持下沉稳定。 2. 保持骨盆与腰椎稳定不动，以胸椎为轴缓慢旋转上半身。 3. 旋转至舒适极限后停顿一至二秒，呼气时再稍加深幅度。 4. 缓慢回到起始位后换另一侧重复。 5. 避免用腰部代偿旋转，重点是胸椎活动而非追求幅度。',
      '用腰椎代替胸椎旋转，骨盆跟着一起转动，旋转过快弹动。',
      '2-3 组 × 每侧 8-10 次，节奏缓慢，配合呼吸',
      '圆肩驼背改善、久坐人群、肩颈紧张者',
      '腰椎间盘突出急性期慎用，脊柱术后遵医嘱',
      '旋转幅度以骨盆保持不动为准，出现腰痛即减小幅度'],

    ['90/90 髋部转换', '90/90 髋转换 / 90/90 Hip Switch', 'mobility', 'core',
      '髋部旋转肌群、臀中肌', '核心肌群、髋内收肌、臀大肌', 'N', 'bodyweight', '弹力带、瑜伽垫', 'intermediate',
      '1. 从坐姿开始双腿屈膝九十度，一腿在前一腿在后形成 90/90 姿势。 2. 双手可撑于体后或体侧辅助，躯干保持直立，重心均匀分布。 3. 在不借助手部过多推力的情况下，把双腿同时翻转到反向的 90/90 姿势。 4. 翻转过程中尽量保持躯干直立，不要倒向一侧。 5. 缓慢重复，重点是髋内外旋的控制，可用呼吸配合放松。',
      '靠双手把腿搬过去，躯干大幅倒向一侧，速度过快失去控制。',
      '2-3 组 × 每侧 6-8 次，节奏缓慢，配合呼吸',
      '髋关节活动度训练、深蹲准备、久坐人群',
      '髋关节术后或髋关节撞击综合征患者禁用，急性髋痛者禁用',
      '出现髋部前方卡压样疼痛立即停止，不要强行翻转']
  ];

  /* ---- 工具：FNV-1a 32 位哈希（8 位小写十六进制） ---- */

  function mix(h, byte) {
    return Math.imul(h ^ byte, 0x01000193) >>> 0;
  }

  /** 对字符串做 FNV-1a 32 位哈希，按 UTF-8 逐字节处理，输出 8 位小写十六进制 */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        h = mix(h, c);
      } else if (c < 0x800) {
        h = mix(h, 0xc0 | (c >> 6));
        h = mix(h, 0x80 | (c & 0x3f));
      } else {
        h = mix(h, 0xe0 | (c >> 12));
        h = mix(h, 0x80 | ((c >> 6) & 0x3f));
        h = mix(h, 0x80 | (c & 0x3f));
      }
    }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  /* ---- 展开为完整记录 ---- */

  function build() {
    return RAW.map(function (r, i) {
      var name = r[0];
      var steps = r[10];
      return {
        exercise_id: 'EX' + pad4(i + 1),
        name: name,
        alias: r[1],
        category: r[2],
        movement_pattern: r[3],
        primary_muscles: r[4],
        secondary_muscles: r[5],
        unilateral: r[6],
        equipment: r[7],
        equipment_alt: r[8],
        difficulty: r[9],
        steps: steps,
        common_mistakes: r[11],
        reference_sets_reps: r[12],
        suitable_for: r[13],
        contraindications: r[14],
        caution_note: r[15],
        source: 'self_authored',
        source_note: SOURCE_NOTE,
        media_ref: '',
        ai_monitor_type: AI_TYPE[name] || '',
        version: 1,
        content_hash: fnv1a(name + steps),
        deprecated: 'N',
        created_at: CREATED_AT,
        updated_at: ''
      };
    });
  }

  var EXERCISES = build();

  return {
    EXERCISES: EXERCISES,
    VERSION: 1,
    BUILT_AT: CREATED_AT,
    fnv1a: fnv1a
  };
});


/* ===== ../src/js/fxp-member-identity.js ===== */
/* Fitness XP 会员端 V2 — 身份层（自助注册 / 身份核验 / 在册判定 / 内置动作库载入 / 自建动作）
 *
 * 依赖：fxp-member-schema（契约）、fxp-member-seed（内置动作库）
 * 不依赖：fxp-persist、fxp-validate（契约由 schema 层注入）
 *
 * 【会员号命名空间 —— 决策 Q15=A】
 *   M 前缀 = 教练端在册会员（由教练录入）
 *   S 前缀 = 会员端自助注册（本模块生成）
 *   两者永不相撞；S 号一经生成即为永久主键，会员后来被教练添加时也不改写为 M 号，
 *   教练端侧另有 coach_member_id 作映射。
 *
 * 【数据保护红线 —— 决策 Q16=A，本模块必须遵守】
 *   readCoachMembers() 对教练端 fxp-workspace **只读**，且只读 members 表的三个字段
 *   （member_id / name / phone）。本模块任何路径都不得写 fxp-workspace。
 *   在册判定只用于决定「是否开放同步入口」，不影响会员端任何功能的可用性。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./fxp-member-schema.js'),
      require('./fxp-member-seed.js')
    );
  } else {
    root.FXP = root.FXP || {};
    root.FXP.memberIdentity = factory(root.FXP.memberSchema, root.FXP.memberSeed);
  }
})(typeof self !== 'undefined' ? self : this, function (MSCH, SEED) {
  'use strict';

  var SELF_PREFIX = 'S';
  var COACH_KEY = 'fxp-workspace';

  /* ---------------------------------------------------------------- 工具 */

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

  /** FNV-1a 32 位哈希，返回 8 位小写十六进制。与 seed 模块同算法，便于比对。 */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function nowStr(d) {
    d = d || new Date();
    return todayStr(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** 手机号：11 位数字且以 1 开头 */
  function isPhone(v) { return typeof v === 'string' && /^1\d{10}$/.test(v); }
  /** 取手机号后 4 位；非法手机号返回空串（不等于任何合法后 4 位） */
  function phone4(v) { return isPhone(v) ? v.slice(-4) : ''; }

  /* ---------------------------------------------------------------- 会员号生成 */

  /**
   * 生成自助注册会员号：扫描现有 S 号取最大值 +1。
   * 不复用 E.nextSeqId，因为会员号有 M/S 两个独立序列，必须分开计数。
   * @returns {string|null} 'S0001' 形态；超过 9999 时返回 null
   */
  function newSelfId(list, idField) {
    var max = 0;
    (list || []).forEach(function (r) {
      var id = r && r[idField];
      if (typeof id !== 'string' || id.charAt(0) !== SELF_PREFIX) return;
      var n = parseInt(id.slice(1), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    var next = max + 1;
    if (next > 9999) return null;
    return SELF_PREFIX + ('0000' + next).slice(-4);
  }

  /* ---------------------------------------------------------------- 自助注册 */

  /**
   * register(store, input) —— 会员端自助注册，不依赖教练端任何数据。
   *
   * input.name                 必填，1-30 字
   * input.phone                必填，11 位手机号
   * input.pin                  选填，4-8 位数字；留空表示不启用本地口令
   * input.experience_level 等  选填，供档案页跳过引导时使用；缺省给安全默认值
   *
   * @returns {{ok:true, member_id}|{ok:false, reason, errors}}
   */
  function register(store, input, opt) {
    input = input || {};
    opt = opt || {};
    var name = String(input.name == null ? '' : input.name).trim();
    var phone = String(input.phone == null ? '' : input.phone).trim();
    var pin = input.pin == null ? '' : String(input.pin).trim();
    var errs = [];

    if (!name) errs.push('name: 请填写姓名或昵称');
    else if (name.length > 30) errs.push('name: 不超过 30 字');
    if (!isPhone(phone)) errs.push('phone: 请填写 11 位手机号（1 开头）');
    if (pin !== '' && !/^\d{4,8}$/.test(pin)) errs.push('pin: 口令须为 4-8 位数字，或不填');
    if (errs.length) return { ok: false, reason: 'invalid_input', errors: errs };

    var list = store.all('m_profiles');
    var dup = list.filter(function (r) { return r && r.phone === phone; });
    if (dup.length) return { ok: false, reason: 'phone_exists', errors: ['phone: 该手机号已注册'] };

    var id = newSelfId(list, 'member_id');
    if (!id) return { ok: false, reason: 'id_exhausted', errors: ['会员号已用尽（S9999）'] };

    var rec = {
      member_id: id,
      name: name,
      phone: phone,
      pin_hash: pin !== '' ? fnv1a(pin) : '',
      member_source: 'self',
      coach_member_id: '',
      experience_level: input.experience_level || 'newbie',
      primary_goal: input.primary_goal || 'health',
      available_equipment: input.available_equipment || 'bodyweight',
      available_days_per_week: input.available_days_per_week || '3',
      session_minutes: input.session_minutes || '60',
      limitations: input.limitations || '',
      limitation_note: '',
      preferred_intensity: input.preferred_intensity || '',
      player_type: '',
      player_type_at: '',
      frequency_goal: input.frequency_goal || '3',
      pause_until: '',
      remind_enabled: '',
      remind_time: '',
      onboarding_done: input.onboarding_done || 'N',
      created_at: opt.now ? opt.now() : nowStr(),
      updated_at: ''
    };

    var res = store.insert('m_profiles', rec, { actor: id });
    if (!res.ok) {
      return {
        ok: false,
        reason: res.reason || 'insert_failed',
        errors: res.errors ? res.errors.map(function (e) { return e.field + ': ' + e.message; }) : []
      };
    }
    return { ok: true, member_id: id };
  }

  /* ---------------------------------------------------------------- 身份核验 */

  /**
   * adoptCoachMember(store, c, now) —— 教练端在册会员首次在会员端出现时建档。
   *
   * 为什么需要它：教练录入的会员拿到的是 M 号，若会员端只认本地档案，
   * 这些会员在会员端就永远核验不通过（H.2 承诺「核验通过后沿用 M 号」会落空）。
   *
   * 边界（严守 Q14=A 独立性）：
   *   - 只在会员本人主动核验且手机号后 4 位匹配时才建档；
   *   - 一次只落地这一条记录，**不是导入教练端名册**；
   *   - 只写入会员端自己的存储，绝不写 fxp-workspace。
   */
  function adoptCoachMember(store, c, now) {
    var id = String(c.member_id || '').trim().toUpperCase();
    var rec = {
      member_id: id,
      name: String(c.name || id),
      phone: String(c.phone || ''),
      pin_hash: '',
      member_source: 'coach',
      coach_member_id: id,
      experience_level: 'newbie',
      primary_goal: 'health',
      available_equipment: 'bodyweight',
      available_days_per_week: '3',
      session_minutes: '60',
      limitations: '',
      limitation_note: '',
      preferred_intensity: '',
      player_type: '',
      player_type_at: '',
      frequency_goal: '3',
      pause_until: '',
      remind_enabled: '',
      remind_time: '',
      onboarding_done: 'N',
      created_at: now || nowStr(),
      updated_at: ''
    };
    var res = store.insert('m_profiles', rec, { actor: id });
    if (!res.ok) {
      return {
        ok: false,
        reason: res.reason || 'insert_failed',
        errors: res.errors ? res.errors.map(function (e) { return e.field + ': ' + e.message; }) : []
      };
    }
    return { ok: true, member_id: id, name: rec.name };
  }

  /**
   * verify(store, input[, coachMembers]) —— 决策 Q7=A：会员号 + 手机号后 4 位。
   *
   * 核验源（满足 Q14=A 的独立性）：
   *   ① 会员端自建档案（自助注册的 S 号，或已被采纳的 M 号）
   *   ② 教练端在册会员的只读投影：本地无档案时，若 M 号存在且手机后 4 位匹配，
   *      则在本端建档并沿用 M 号（adoptCoachMember）
   *
   * coachMembers 缺省为 []，因此不传时行为与以前完全一致（只认本地档案）。
   * 若该会员设置了本地口令，则口令也必须匹配。
   */
  function verify(store, input, coachMembers) {
    input = input || {};
    var id = String(input.member_id == null ? '' : input.member_id).trim().toUpperCase();
    var p4 = String(input.phone4 == null ? '' : input.phone4).trim();
    var pin = input.pin == null ? '' : String(input.pin).trim();

    if (!id) return { ok: false, reason: 'missing_id', message: '请输入会员号' };
    if (!/^[MS]\d{4}$/.test(id)) return { ok: false, reason: 'bad_id', message: '会员号格式应为 M0001 或 S0001' };
    if (!/^\d{4}$/.test(p4)) return { ok: false, reason: 'bad_phone4', message: '请输入手机号后 4 位' };

    var row = store.find('m_profiles', id);
    if (!row) {
      var hit = null;
      (coachMembers || []).forEach(function (m) {
        if (m && String(m.member_id || '').trim().toUpperCase() === id) hit = m;
      });
      if (!hit) return { ok: false, reason: 'not_found', message: '会员端未找到该会员号' };
      if (phone4(hit.phone) !== p4) return { ok: false, reason: 'mismatch', message: '手机号后 4 位不匹配' };
      var a = adoptCoachMember(store, hit, input.now);
      if (!a.ok) {
        return { ok: false, reason: a.reason || 'adopt_failed', message: '建档失败，请稍后重试' };
      }
      return { ok: true, member_id: id, name: a.name, adopted: true };
    }
    if (phone4(row.phone) !== p4) return { ok: false, reason: 'mismatch', message: '手机号后 4 位不匹配' };

    if (row.pin_hash) {
      if (pin === '') return { ok: false, reason: 'pin_required', message: '该会员已设置本地口令' };
      if (fnv1a(pin) !== row.pin_hash) return { ok: false, reason: 'bad_pin', message: '口令不正确' };
    }
    return { ok: true, member_id: id, name: row.name };
  }

  /**
   * createVerifyGate({store, maxFail, lockMs, now}) —— 核验闸门，含失败锁定。
   * 注意：这是本地计数，不是安全机制（Q8=A 无服务端），仅用于防止同设备上随手乱试。
   */
  function createVerifyGate(opts) {
    opts = opts || {};
    var store = opts.store;
    var maxFail = opts.maxFail || 5;
    var lockMs = opts.lockMs || 60000;
    var fails = 0, lockedUntil = 0;
    function now() { return opts.now ? opts.now() : Date.now(); }
    /* 教练端在册名单支持传数组或取值函数；函数形式保证每次核验都读到最新投影 */
    function coachList() {
      var c = opts.coachMembers;
      if (typeof c === 'function') { try { return c() || []; } catch (e) { return []; } }
      return c || [];
    }

    function state() {
      var n = now();
      var locked = lockedUntil > n;
      return { locked: locked, remainSec: locked ? Math.ceil((lockedUntil - n) / 1000) : 0, fails: fails };
    }
    return {
      state: state,
      reset: function () { fails = 0; lockedUntil = 0; },
      check: function (input) {
        var st = state();
        if (st.locked) {
          return { ok: false, reason: 'locked', message: '失败次数过多，请 ' + st.remainSec + ' 秒后再试' };
        }
        var r = verify(store, input, coachList());
        if (r.ok) { fails = 0; lockedUntil = 0; return r; }
        fails++;
        if (fails >= maxFail) {
          lockedUntil = now() + lockMs;
          r.locked = true;
          /* 触发锁定的这一次，必须直接把「为什么被锁」说清楚。
             否则页面会显示底层原因（如「手机号后 4 位不匹配」），
             用户只看到按钮变灰却不知道是失败次数过多所致。 */
          r.reason = 'locked';
          r.message = '连续 ' + fails + ' 次核验失败，已锁定 ' + Math.ceil(lockMs / 1000) + ' 秒';
        }
        r.fails = fails;
        return r;
      }
    };
  }

  /* ---------------------------------------------------------------- 在册判定（只读） */

  /**
   * readCoachMembers(storage) —— **只读**解析教练端快照的 members 投影。
   *
   * 红线：本函数只 getItem，绝不 setItem/removeItem 教练端键。
   * 任何异常（键不存在、JSON 损坏、结构不符）都返回 members: [] 而不是抛错，
   * 保证教练端不存在时会员端照常可用（决策 Q14=A 独立性）。
   */
  function readCoachMembers(storage) {
    var raw = null;
    try {
      raw = storage && typeof storage.getItem === 'function' ? storage.getItem(COACH_KEY) : null;
    } catch (e) {
      return { ok: false, reason: 'unreadable', members: [] };
    }
    if (!raw) return { ok: false, reason: 'no_workspace', members: [] };

    var snap = null;
    try { snap = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'bad_json', members: [] }; }
    if (!isObj(snap) || !isObj(snap.tables) || !isArr(snap.tables.members)) {
      return { ok: false, reason: 'bad_shape', members: [] };
    }

    var out = [];
    snap.tables.members.forEach(function (r) {
      if (!isObj(r)) return;
      /* 只取三个字段，不接触教练端的风险等级/跟进结论等内部信息（决策 Q3=A） */
      out.push({
        member_id: String(r.member_id || ''),
        name: String(r.name || ''),
        phone: String(r.phone || '')
      });
    });
    return { ok: true, members: out };
  }

  /**
   * enrollState(store, memberId, coachMembers) —— 判定该会员是否已被教练添加。
   * 命中条件：会员号相等，或（姓名 + 手机号后 4 位）同时相等。
   */
  function enrollState(store, memberId, coachMembers) {
    var row = store.find('m_profiles', memberId);
    if (!row) return { enrolled: false, reason: 'no_member' };
    var list = coachMembers || [];
    var myName = String(row.name || '');
    var myP4 = phone4(row.phone);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.member_id && c.member_id === memberId) {
        return { enrolled: true, by: 'id', coach_member_id: c.member_id, coach_name: c.name };
      }
      if (c.name && myName && c.name === myName && myP4 && phone4(c.phone) === myP4) {
        return { enrolled: true, by: 'name_phone', coach_member_id: c.member_id, coach_name: c.name };
      }
    }
    return { enrolled: false, reason: 'not_enrolled' };
  }

  /* ---------------------------------------------------------------- 内置动作库 */

  /**
   * loadSeed(store) —— 载入内置动作库，按 exercise_id 幂等（已存在则跳过，不覆盖）。
   * 会员可物理删除内置动作，之后仍可用本函数重新载入（决策 Q4=A）。
   */
  function loadSeed(store) {
    var raw = (SEED && SEED.EXERCISES) ? SEED.EXERCISES : [];
    if (!raw.length) return { ok: false, reason: 'no_seed', added: 0, skipped: 0, errors: [] };
    var added = 0, skipped = 0, errs = [];
    raw.forEach(function (r) {
      if (store.find('m_exercises', r.exercise_id)) { skipped++; return; }
      var row = {};
      Object.keys(r).forEach(function (k) { row[k] = r[k]; });
      /* m_exercises 是全局表，归属校验自动通过 */
      var res = store.insert('m_exercises', row);
      if (res.ok) added++;
      else errs.push(r.exercise_id + ':' + (res.reason || 'invalid'));
    });
    if (errs.length) return { ok: false, reason: 'insert_failed', added: added, skipped: skipped, errors: errs };
    return { ok: true, added: added, skipped: skipped, errors: [] };
  }

  /* ---------------------------------------------------------------- 自建动作 */

  /**
   * createExercise(store, input) —— 会员自建动作（决策 Q4=A「开放自建」）。
   * 必填：name / category / movement_pattern / primary_muscles / equipment / difficulty / steps
   * 自动补齐：exercise_id（EX 序列）、source='custom'、source_note、version=1、
   *           content_hash、deprecated='N'、created_at。
   * 注意 source 必须是非 gym_owned，而 schema 的 COND 要求此时必须填 source_note，故自动补。
   */
  function createExercise(store, input, opt) {
    input = input || {};
    opt = opt || {};
    var required = {
      name: 30, category: null, movement_pattern: null,
      primary_muscles: 100, equipment: null, difficulty: null, steps: 800
    };
    var errs = [];
    Object.keys(required).forEach(function (k) {
      var v = input[k];
      if (v == null || String(v).trim() === '') { errs.push(k + ': 必填'); return; }
      if (required[k] !== null && String(v).length > required[k]) {
        errs.push(k + ': 超过 ' + required[k] + ' 字');
      }
    });
    if (errs.length) return { ok: false, reason: 'invalid_input', errors: errs };

    var list = store.all('m_exercises');
    var id = opt.id || nextExerciseId(list);
    if (!id) return { ok: false, reason: 'id_exhausted', errors: ['动作 ID 已用尽'] };

    var steps = String(input.steps).trim();
    var rec = {
      exercise_id: id,
      name: String(input.name).trim(),
      alias: input.alias ? String(input.alias).trim() : '',
      category: input.category,
      movement_pattern: input.movement_pattern,
      primary_muscles: String(input.primary_muscles).trim(),
      secondary_muscles: input.secondary_muscles ? String(input.secondary_muscles).trim() : '',
      unilateral: input.unilateral === 'Y' ? 'Y' : 'N',
      equipment: input.equipment,
      equipment_alt: input.equipment_alt ? String(input.equipment_alt).trim() : '',
      difficulty: input.difficulty,
      steps: steps,
      common_mistakes: input.common_mistakes ? String(input.common_mistakes).trim() : '',
      reference_sets_reps: input.reference_sets_reps ? String(input.reference_sets_reps).trim() : '',
      suitable_for: input.suitable_for ? String(input.suitable_for).trim() : '',
      contraindications: input.contraindications ? String(input.contraindications).trim() : '',
      caution_note: input.caution_note ? String(input.caution_note).trim() : '',
      source: 'custom',
      source_note: input.source_note ? String(input.source_note).trim() : '会员自建动作 · 由会员本人录入',
      media_ref: '',
      version: 1,
      content_hash: fnv1a(String(input.name).trim() + steps),
      deprecated: 'N',
      created_at: opt.today ? opt.today() : todayStr(),
      updated_at: ''
    };

    var res = store.insert('m_exercises', rec);
    if (!res.ok) {
      return {
        ok: false,
        reason: res.reason || 'insert_failed',
        errors: res.errors ? res.errors.map(function (e) { return e.field + ': ' + e.message; }) : []
      };
    }
    return { ok: true, exercise_id: id };
  }

  /** 取下一个 EX 号：扫描全部现有记录取最大 +1（不区分来源，内置与自建共用序列） */
  function nextExerciseId(list) {
    var max = 0;
    (list || []).forEach(function (r) {
      var id = r && r.exercise_id;
      if (typeof id !== 'string' || id.indexOf('EX') !== 0) return;
      var n = parseInt(id.slice(2), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    var next = max + 1;
    if (next > 9999) return null;
    return 'EX' + ('0000' + next).slice(-4);
  }

  /* ---------------------------------------------------------------- 对外接口 */

  return {
    COACH_KEY: COACH_KEY,
    SELF_PREFIX: SELF_PREFIX,
    fnv1a: fnv1a,
    isPhone: isPhone,
    phone4: phone4,
    nowStr: nowStr,
    todayStr: todayStr,
    newSelfId: newSelfId,
    nextExerciseId: nextExerciseId,
    register: register,
    adoptCoachMember: adoptCoachMember,
    verify: verify,
    createVerifyGate: createVerifyGate,
    readCoachMembers: readCoachMembers,
    enrollState: enrollState,
    loadSeed: loadSeed,
    createExercise: createExercise
  };
});


/* ===== ../src/js/fxp-member-goal.js ===== */
/* Fitness XP 会员端 V2 — 目标管理领域层（长期目标 / 阶段目标 / 本地可解释拆分 / 进度与达成；UMD）
 *
 * 依赖：fxp-member-schema（契约层，只用于「表是否存在」的就绪检查）
 *      fxp-member-store（只用于识别调用方误把模块本身当 store 实例传入）
 * 不依赖：任何 UI、fxp-persist、fxp-xp、任何外部网络
 *
 * 【本模块的边界 —— 后续接手的人请先读这段】
 *   1) 只做领域层：**不碰 DOM、不发 XP、不写 m_timeline**。
 *      达成信号通过返回值（achieved / allStagesDone）交给上层，由成长系统决定是否发奖。
 *   2) **不自己持久化**：所有写库函数只改内存中的 store，store.save() 由调用方统一调用。
 *      这是本项目既定约定（见 fxp-member-store.js 与既有测试），本模块不得破例。
 *   3) **不自己建存储**：store 一律由调用方注入（memberStore.createStore() 的返回值），
 *      本模块任何路径都不出现 localStorage / fetch / console。
 *
 * 【表结构要点 —— 容易踩坑的两条】
 *   1) m_goals **没有 current_value 字段**。按项目既定表结构，`start_value` 就是「当前实测值」：
 *      updateCurrentValue() 会把最新实测值写回 start_value。因此它既是起点也是当前值，
 *      进度计算需要的「原始起点」要靠 resolveOrigin() 从阶段目标链上找回（见 progress() 注释）。
 *   2) m_goals 也没有 seq 字段（schema 里没有，CSV 列顺序也固定），
 *      所以阶段排序一律按 target_date 升序，本模块不臆造字段。
 *
 * 【拆分算法的三条原则】
 *   1) 本地可解释：只用本地规则与传入参数，**不用随机数、不调外部接口**，
 *      同一输入（含同一 opt.today）必得同一输出，便于测试与向会员解释。
 *   2) 保守优先：经验越少 / 执行率越低 → 越多目标量压到后半程，前期量更小。
 *   3) 安全优先于好看：超过安全变化率时削减目标量并给出 warnings，
 *      **绝不为让数字好看而给出不现实的目标**，也不做任何医疗或结果承诺（见 DISCLAIMER）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./fxp-member-schema.js'),
      require('./fxp-member-store.js')
    );
  } else {
    root.FXP = root.FXP || {};
    root.FXP.memberGoal = factory(root.FXP.memberSchema, root.FXP.memberStore);
  }
})(typeof self !== 'undefined' ? self : this, function (MSCH, MSTORE) {
  'use strict';

  /* ---------------------------------------------------------------- 常量表 */

  /* 以下枚举与 fxp-member-schema.js 的 m_goals 定义一一对应，改动 schema 时这里要同步 */
  var KINDS = ['long_term', 'stage'];
  var GOAL_TYPES = ['weight', 'waist', 'strength_pr', 'frequency', 'custom'];
  var DIRECTIONS = ['decrease', 'increase'];
  var STATUSES = ['active', 'achieved', 'abandoned'];

  var TABLE_GOALS = 'm_goals';
  var TABLE_ADJ = 'm_adjustments';
  var TABLE_PROFILES = 'm_profiles';
  var TABLE_SESSIONS = 'm_sessions';

  /** 未填目标日期时的默认跨度：12 周（84 天）——会员不填也能用 */
  var DEFAULT_WEEKS = 12;
  /** 周数夹取范围：太短拆不出阶段，太长则本地推算失去参考意义 */
  var WEEKS_MIN = 4, WEEKS_MAX = 52;
  /** 阶段数夹取范围（常规）：2-6 个阶段 */
  var STAGE_MIN = 2, STAGE_MAX = 6;
  /** 触发安全护栏后允许的最大阶段数（文档规定上限 8） */
  var STAGE_MAX_SAFE = 8;
  /** 曲线指数上限：再大就会把全部量压到最后一段，失去「拆小步骤」的意义 */
  var EXP_MAX = 2;
  /** 标题长度上限（schema 允许 50，产品口径收紧到 40，先按产品口径拦） */
  var TITLE_MAX = 40;
  /** 数值合理性上限：超过后 toFixed 会输出科学计数法，进不了 schema 的 num 正则 */
  var VALUE_ABS_MAX = 1e9;
  /** 浮点比较容差 */
  var EPS = 1e-9;
  /** 近 4 周完成率低于该值视为「执行不足」，前半程进一步压轻 */
  var LOW_ADHERENCE = 0.6;

  /**
   * 保守系数表（按训练基础）。
   * 含义：经验越少 → 系数越小 → 曲线指数 c = 1/系数 越大 → 权重 w_i = i^c 越向后倾斜，
   *       即「更多目标量放在后半程，前期更保守」。
   * 为什么用「系数」而不是直接写指数：系数能直接表达「打几折起步」，对会员解释更直观。
   */
  var CONSERVATIVE = {
    newbie: 0.7,        /* c = 1.43 */
    novice: 0.85,       /* c = 1.18 */
    intermediate: 1.0,  /* c = 1.00（线性递增） */
    advanced: 1.0       /* c = 1.00 —— 有基础者不必再额外保守 */
  };

  /**
   * 安全变化率上限（每周）。
   * 只有这两类设护栏；其余类型（力量 PR / 频次 / 自定义）个体差异过大，
   * 本地规则给不出可信上限，**宁可不设也不装作知道**（见模块头「安全优先于好看」）。
   */
  var SAFE_RATE = {
    weight_decrease_pct: 0.01,  /* 减重：每周不超过起始体重的 1% */
    waist_per_week: 1           /* 腰围：每周不超过 1cm */
  };

  /**
   * 固定免责说明。
   * 为什么硬编码而不是交给 UI：任何走本模块的页面都可能直接把 notes 渲染出来，
   * 免责声明必须随数据一起给到，避免上层漏写（做医疗 claim 是红线）。
   */
  var DISCLAIMER = '阶段目标由本地规则推算，用于帮你把大目标拆成可执行的小步骤，' +
    '不构成医疗或健康建议，也不承诺结果。';

  /* ---------------------------------------------------------------- 依赖惰性解析 */

  /**
   * 取全局命名空间。
   * 为什么不在模块顶层就取 root.FXP：浏览器里 <script> 的加载顺序不保证，
   * 本模块可能先于 memberSchema / memberStore 载入；顶层取到 undefined 就永远补不回来。
   * 因此所有依赖都在**函数体内**按需解析：Node 下走 factory 入参，浏览器下走全局。
   */
  function ns() {
    if (typeof self !== 'undefined' && self && self.FXP) return self.FXP;
    if (typeof window !== 'undefined' && window && window.FXP) return window.FXP;
    if (typeof globalThis !== 'undefined' && globalThis && globalThis.FXP) return globalThis.FXP;
    return null;
  }

  /** 契约层（可为空：未就绪时写库函数会明确拒绝，而不是带着错误假设往下走） */
  function schema() {
    if (MSCH) return MSCH;
    var n = ns();
    return (n && n.memberSchema) || null;
  }

  /** 存储层模块本体（只用于识别「误传模块而非实例」，本模块绝不用它建存储） */
  function storeModule() {
    if (MSTORE) return MSTORE;
    var n = ns();
    return (n && n.memberStore) || null;
  }

  /* ---------------------------------------------------------------- 基础工具 */

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 本地日期 YYYY-MM-DD（与 identity 模块同行为：用本地时间，不做 UTC） */
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  /** 本地时间 YYYY-MM-DD HH:MM:SS（同上，与 identity 一致） */
  function nowStr(d) {
    d = d || new Date();
    return todayStr(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** 合法 YYYY-MM-DD（含真实日历校验：2026-02-30 这种必须判否） */
  function isDateStr(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var p = v.split('-');
    var y = parseInt(p[0], 10), m = parseInt(p[1], 10), day = parseInt(p[2], 10);
    if (m < 1 || m > 12 || day < 1) return false;
    var dt = new Date(y, m - 1, day);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === day;
  }

  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  /** 字符串 → 本地零点 Date；非法返回 null */
  function toDate(s) {
    if (!isDateStr(s)) return null;
    var p = s.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  /** a - b 的天数；任一端非法返回 null（调用方必须处理 null，不许当 0 用） */
  function diffDays(a, b) {
    var da = toDate(a), db = toDate(b);
    if (!da || !db) return null;
    /* 用 Math.round 抹掉夏令时造成的 23/25 小时误差 */
    return Math.round((da.getTime() - db.getTime()) / 86400000);
  }

  function addDays(s, n) {
    var d = toDate(s);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }

  /** 任意入参 → 有限数字；非法一律 null（NaN / Infinity / 空串 / 非数字串都不放过） */
  function numOf(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).trim());
    if (typeof n !== 'number' || !isFinite(n)) return null;
    return n;
  }

  function isNum(v) { return numOf(v) !== null; }

  /** 数值合理性：绝对值过大时 toFixed 会产出科学计数法，schema 的 num 正则会拒收 */
  function inRange(n) { return isNum(n) && Math.abs(n) <= VALUE_ABS_MAX; }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  /** 保留 1 位小数并去掉多余的 0：65.0 → '65'，65.5 → '65.5'。
   *  写入 m_goals 前统一走这里，保证存进去的串一定能过 schema 的 num 正则。 */
  function fmt1(n) {
    if (!isNum(n)) return '';
    var s = (Math.round(n * 10) / 10).toFixed(1);
    if (s.charAt(s.length - 1) === '0') s = s.slice(0, -2);
    if (s === '-0') s = '0';
    return s;
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  /** 单位拼串：有单位就带空格，没单位就只给数字（不臆造单位） */
  function withUnit(s, unit) { return unit ? s + ' ' + unit : s; }

  /** store 的 errors（{field,message}[]）→ 中文单行，便于直接返回给 UI */
  function errTexts(res) {
    if (!res || !res.errors) return [];
    return res.errors.map(function (e) {
      return (e.field ? e.field + ': ' : '') + (e.message || '校验未通过');
    });
  }

  /* ---------------------------------------------------------------- 入口防御 */

  /**
   * store 有效性检查。
   * 特别拦一种误用：把 memberStore 模块本体（有 createStore 但没 all/insert）当实例传进来。
   * 不拦的话后续会在 undefined 上调用 all()，报错点离根因很远。
   */
  function badStore(store) {
    if (!store || typeof store.all !== 'function' || typeof store.insert !== 'function' ||
      typeof store.update !== 'function' || typeof store.find !== 'function' ||
      typeof store.findBy !== 'function' || typeof store.nextId !== 'function') return true;
    var M = storeModule();
    if (M && store === M) return true;
    return false;
  }

  /** 写库前的契约就绪检查：schema 没加载就明确拒绝，避免写入无人校验的数据 */
  function noSchema() {
    var S = schema();
    return !(S && S.SCHEMAS && S.SCHEMAS[TABLE_GOALS]);
  }

  /**
   * 取「属于该会员」的目标行。
   * 为什么不直接用 store.get()：store.find() 不做归属校验，
   * 本模块所有读写都必须显式比对 member_id（无服务端环境下的数据层补偿，见 Q8=A）。
   */
  function ownedGoal(store, memberId, goalId) {
    var row = store.find(TABLE_GOALS, goalId);
    if (!row) return { ok: false, reason: 'not_found', errors: ['目标不存在：' + goalId] };
    if (row.member_id !== memberId) {
      return { ok: false, reason: 'not_owner', errors: ['数据归属校验失败：该目标属于其他会员'] };
    }
    return { ok: true, goal: row };
  }

  /* ---------------------------------------------------------------- 输入校验 */

  /**
   * 单位默认值（仅在未填时兜底）。
   * 为什么兜底而不是报错：schema 里 unit 是必填，空串会被拒收并抛出难以理解的英文式错误；
   * 与其让会员卡住，不如按目标类型给一个本地常识默认值，并在 notes 里说明。
   */
  var DEFAULT_UNIT = { weight: 'kg', waist: 'cm', strength_pr: 'kg', frequency: '次', custom: '次' };

  /**
   * 校验目标输入（创建与修改共用，保证两处口径一致）。
   * @param {Object} input
   * @param {Object} o  {partial:true 表示只校验 patch 里出现的字段}
   * @returns {{ok:boolean, errors:string[], value:Object, notes:string[]}}
   *          value 里只放**通过校验并已归一化**的字段（数值为 number，日期为字符串）
   */
  function validateInput(input, o) {
    input = input || {};
    o = o || {};
    var errors = [], notes = [], value = {};

    /* ---- 标题 ---- */
    if (!o.partial || input.title !== undefined) {
      var title = String(input.title == null ? '' : input.title).trim();
      if (!title) errors.push('title: 请填写目标标题');
      else if (title.length > TITLE_MAX) errors.push('title: 不超过 ' + TITLE_MAX + ' 字');
      else value.title = title;
    }

    /* ---- 数值：必须有限，且绝对值在可表示范围内 ---- */
    function takeNum(field, required, label) {
      if (o.partial && input[field] === undefined) return;
      var raw = input[field];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        if (required) errors.push(field + ': 请填写' + label);
        return;
      }
      var n = numOf(raw);
      if (n === null) { errors.push(field + ': ' + label + '必须是有效数字'); return; }
      if (!inRange(n)) { errors.push(field + ': ' + label + '超出合理范围'); return; }
      value[field] = n;
    }
    takeNum('target_value', !o.partial, '目标值');
    takeNum('start_value', false, '起始值');

    /* ---- 单位 ---- */
    if (!o.partial || input.unit !== undefined) {
      var unit = String(input.unit == null ? '' : input.unit).trim();
      if (unit) value.unit = unit.slice(0, 10);
    }

    /* ---- 日期：给了就必须合法 ---- */
    function takeDate(field, label) {
      if (o.partial && input[field] === undefined) return;
      var v = input[field];
      if (v === undefined || v === null || String(v).trim() === '') return;   /* 缺省由上层补默认 */
      v = String(v).trim();
      if (!isDateStr(v)) { errors.push(field + ': ' + label + '格式非法，应为 YYYY-MM-DD'); return; }
      value[field] = v;
    }
    takeDate('start_date', '开始日期');
    takeDate('target_date', '目标日期');

    /* ---- 目标类型 / 方向 ---- */
    if (!o.partial || input.goal_type !== undefined) {
      var gt = String(input.goal_type == null ? '' : input.goal_type).trim();
      if (gt && GOAL_TYPES.indexOf(gt) < 0) errors.push('goal_type: 目标类型非法：' + gt);
      else if (gt) value.goal_type = gt;
    }
    if (!o.partial || input.direction !== undefined) {
      var dir = String(input.direction == null ? '' : input.direction).trim();
      if (dir && DIRECTIONS.indexOf(dir) < 0) errors.push('direction: 目标方向非法：' + dir);
      else if (dir) value.direction = dir;
    }

    /* ---- 起止关系：只有两端都合法时才比 ---- */
    if (value.start_date && value.target_date) {
      var gap = diffDays(value.target_date, value.start_date);
      if (gap === null || gap <= 0) errors.push('target_date: 目标日期必须晚于开始日期');
    }

    return { ok: errors.length === 0, errors: errors, value: value, notes: notes };
  }

  /** 目标类型缺失时的兜底：按方向与单位反推最贴近的一类，猜不出就 custom（不装懂） */
  function guessType(input, value) {
    var gt = String(input.goal_type == null ? '' : input.goal_type).trim();
    if (gt && GOAL_TYPES.indexOf(gt) >= 0) return gt;
    var unit = String(input.unit == null ? (value && value.unit) || '' : input.unit).trim();
    if (unit === 'kg') return 'weight';
    if (unit === 'cm') return 'waist';
    if (unit === '次') return 'frequency';
    return 'custom';
  }

  /** 方向缺失时的兜底：数值变小=decrease，变大或相等=increase */
  function guessDirection(input, value) {
    var d = String(input.direction == null ? '' : input.direction).trim();
    if (d && DIRECTIONS.indexOf(d) >= 0) return d;
    var s = value.start_value, t = value.target_value;
    if (isNum(s) && isNum(t) && t < s) return 'decrease';
    return 'increase';
  }

  /* ---------------------------------------------------------------- 创建长期目标 */

  /**
   * createLongTerm(store, memberId, input, opt) —— 创建长期目标（kind='long_term'）。
   *
   * input.title        必填，≤40 字
   * input.goal_type    选填，缺省按单位/数值反推（weight/waist/strength_pr/frequency/custom）
   * input.direction    选填，缺省按起止数值反推（decrease/increase）
   * input.start_value  选填，起点值
   * input.target_value 必填，目标值
   * input.unit         选填，缺省按目标类型给常识值（kg/cm/次）
   * input.start_date   选填，缺省取今天
   * input.target_date  选填，缺省 = 开始日期 + 12 周（84 天），并在 notes 里写明
   *
   * 设计要点：
   *   - opt.actor 固定用 memberId 传给 store，归属校验下沉到数据层（防止跨会员改写）；
   *   - **不调用 store.save()**，持久化由调用方统一做；
   *   - store 返回的错误原样上抛（{ok:false, reason, errors}），不吞掉。
   *
   * @returns {{ok:true, goal, notes}|{ok:false, reason, errors}}
   */
  function createLongTerm(store, memberId, input, opt) {
    input = input || {};
    opt = opt || {};
    if (badStore(store)) return { ok: false, reason: 'bad_store', errors: ['store 无效：请传入 memberStore.createStore() 返回的实例'] };
    if (!memberId) return { ok: false, reason: 'no_actor', errors: ['缺少会员ID'] };
    if (noSchema()) return { ok: false, reason: 'no_schema', errors: ['契约层 memberSchema 未就绪'] };

    var v = validateInput(input, {});
    if (!v.ok) return { ok: false, reason: 'invalid_input', errors: v.errors };
    var value = v.value, notes = [];

    var today = opt.today || todayStr();
    var startDate = value.start_date || today;
    if (!value.start_date) notes.push('未填写开始日期，已默认取今天（' + startDate + '）');

    var targetDate = value.target_date;
    if (!targetDate) {
      targetDate = addDays(startDate, DEFAULT_WEEKS * 7);
      if (!targetDate) return { ok: false, reason: 'invalid_input', errors: ['target_date: 无法推算默认目标日期'] };
      notes.push('未填写目标日期，已默认按开始日期后 ' + DEFAULT_WEEKS + ' 周（' + targetDate + '）设定');
    }

    var gap = diffDays(targetDate, startDate);
    if (gap === null || gap <= 0) {
      return { ok: false, reason: 'invalid_input', errors: ['target_date: 目标日期必须晚于开始日期'] };
    }

    var goalType = guessType(input, value);
    var direction = guessDirection(input, value);
    var unit = value.unit;
    if (!unit) {
      unit = DEFAULT_UNIT[goalType] || '次';
      notes.push('未填写单位，已按目标类型默认取「' + unit + '」');
    }

    var now = opt.now || nowStr();
    var rec = {
      goal_id: store.nextId(TABLE_GOALS),
      member_id: memberId,
      parent_goal_id: '',
      kind: 'long_term',
      goal_type: goalType,
      title: value.title,
      target_value: fmt1(value.target_value),
      start_value: isNum(value.start_value) ? fmt1(value.start_value) : '',
      unit: unit,
      direction: direction,
      start_date: startDate,
      target_date: targetDate,
      status: 'active',
      achieved_at: '',
      created_at: now,
      updated_at: ''
    };
    if (!rec.goal_id) return { ok: false, reason: 'id_exhausted', errors: ['目标 ID 已用尽（GO9999）'] };

    var res = store.insert(TABLE_GOALS, rec, { actor: memberId });
    if (!res.ok) {
      return { ok: false, reason: res.reason || 'insert_failed', errors: errTexts(res) };
    }
    return { ok: true, goal: res.row, notes: notes };
  }

  /* ---------------------------------------------------------------- 阶段拆分（纯函数） */

  /**
   * 训练基础 → 保守系数。
   * 未识别 / 缺失一律按 newbie（最低档）：**不采信不认识的值**，宁可保守。
   */
  function conservativeOf(level) {
    var k = String(level == null ? '' : level).trim();
    if (CONSERVATIVE[k] !== undefined) return CONSERVATIVE[k];
    return CONSERVATIVE.newbie;
  }

  /**
   * 安全速率上限（每周变化量的绝对值）。
   * @returns {{limit:number|null, label:string}} limit 为 null 表示本类型不设护栏
   */
  function safeLimit(goalType, direction, startValue) {
    if (goalType === 'weight' && direction === 'decrease') {
      /* 起始体重不合理（缺失 / 非正 / 超出人类范围）时**跳过本条护栏**，不硬套公式 */
      if (!isNum(startValue) || startValue <= 0 || startValue > 1000) {
        return { limit: null, label: '起始体重不合理，已跳过减重速率护栏' };
      }
      return { limit: startValue * SAFE_RATE.weight_decrease_pct, label: '每周不超过起始体重的 1%' };
    }
    if (goalType === 'waist') {
      return { limit: SAFE_RATE.waist_per_week, label: '每周不超过 1cm' };
    }
    return { limit: null, label: '' };
  }

  /**
   * suggestStages(profile, longTermGoal, history, opt) —— **纯函数**：只算不写，可反复调用。
   *
   * @param {Object} profile  会员档案 {experience_level, available_days_per_week, session_minutes,
   *                          primary_goal}；为 undefined 时按最保守档降级
   * @param {Object} longTermGoal  长期目标行（m_goals 的 kind='long_term'）
   * @param {Object} history  {completedSessions:number, weeklyCompletionRate:number|null}
   *                          近 4 周执行情况；新会员传 0 / null
   * @param {Object} opt      {today:'YYYY-MM-DD'}，仅当长期目标缺日期时才会用到
   *
   * 算法（本地、确定性、可解释；无随机数、无外部调用）：
   *   1) totalDelta = |target_value - start_value|
   *   2) weeks = ceil(天数/7)，夹到 [4,52]，算不出来取 12
   *   3) n = clamp(round(weeks/4), 2, 6)
   *   4) 保守系数按训练基础查表；曲线指数 c = 1/系数，上限 2
   *   5) 权重 w_i = i^c 归一化分摊 totalDelta，最后一个阶段吸收误差
   *      —— **最后一个阶段的 target_value 严格等于长期目标的 target_value**（无护栏削减时）
   *   6) 阶段 target_date = start_date + round(weeks*i/n)*7 天，最后一个阶段 = 长期目标日期
   *   7) 安全护栏：必需周变化率超过上限 → 先增大阶段数（上限 8），仍超则**封顶目标量**
   *      并把理由写进 warnings（安全优先于好看，绝不给不现实的目标）
   *
   * @returns {{ok:boolean, stages:Object[], notes:string[], warnings:string[], meta:Object, reason?:string}}
   *          stages[i] = {title, kind, goal_type, direction, unit, start_value, target_value,
   *                       start_date, target_date, parent_goal_id, seq}
   */
  function suggestStages(profile, longTermGoal, history, opt) {
    opt = opt || {};
    var ltg = isObj(longTermGoal) ? longTermGoal : null;
    var warnings = [];
    var notes = [];

    if (!ltg) {
      return {
        ok: false, reason: 'missing_goal', stages: [], notes: [DISCLAIMER],
        warnings: ['缺少长期目标，无法拆分阶段'], meta: {}
      };
    }

    var startV = numOf(ltg.start_value);
    var targetV = numOf(ltg.target_value);
    if (startV === null) {
      return {
        ok: false, reason: 'missing_start_value', stages: [], notes: [DISCLAIMER],
        warnings: ['长期目标缺少起始值 start_value，无法推算阶段量'], meta: {}
      };
    }
    if (targetV === null) {
      return {
        ok: false, reason: 'bad_target_value', stages: [], notes: [DISCLAIMER],
        warnings: ['长期目标的目标值 target_value 不是有效数字'], meta: {}
      };
    }

    var unit = String(ltg.unit == null ? '' : ltg.unit).trim();
    var goalType = GOAL_TYPES.indexOf(ltg.goal_type) >= 0 ? ltg.goal_type : 'custom';
    var direction = DIRECTIONS.indexOf(ltg.direction) >= 0 ? ltg.direction : (targetV >= startV ? 'increase' : 'decrease');
    if (String(ltg.direction || '') && DIRECTIONS.indexOf(ltg.direction) < 0) {
      warnings.push('目标方向字段非法（' + ltg.direction + '），已按数值变化方向按 ' + direction + ' 处理');
    }
    /* 方向与实际数值相反时不改数据，只提示：这是会员填写时的常见笔误 */
    if (direction === 'increase' && targetV < startV) warnings.push('方向为「越大越好」，但目标值小于起始值，请确认是否填反');
    if (direction === 'decrease' && targetV > startV) warnings.push('方向为「越小越好」，但目标值大于起始值，请确认是否填反');
    if (String(ltg.kind || '') === 'stage') warnings.push('传入的是阶段目标，阶段不再往下拆分');

    /* ---- 1) 跨度（周）---- */
    var startDate = isDateStr(ltg.start_date) ? ltg.start_date : null;
    var targetDate = isDateStr(ltg.target_date) ? ltg.target_date : null;
    if (!startDate || !targetDate) {
      startDate = startDate || opt.today || todayStr();
      if (!targetDate) targetDate = addDays(startDate, DEFAULT_WEEKS * 7);
      notes.push('长期目标缺少' + (isDateStr(ltg.start_date) ? '目标日期' : '开始日期') +
        '，已按默认跨度 ' + DEFAULT_WEEKS + ' 周推算');
    }
    var days = diffDays(targetDate, startDate);
    var weeks;
    if (days === null || days <= 0) {
      weeks = DEFAULT_WEEKS;
      targetDate = addDays(startDate, DEFAULT_WEEKS * 7);
      notes.push('起止日期无法计算出正跨度，已按默认 ' + DEFAULT_WEEKS + ' 周推算');
    } else {
      weeks = clamp(Math.ceil(days / 7), WEEKS_MIN, WEEKS_MAX);
      if (days < WEEKS_MIN * 7) warnings.push('目标跨度不足 ' + WEEKS_MIN + ' 周，已按 ' + WEEKS_MIN + ' 周排期，建议适当放宽周期');
    }

    var totalDelta = Math.abs(targetV - startV);
    var sign = direction === 'increase' ? 1 : -1;

    /* ---- 2) 阶段数 ---- */
    var n = clamp(Math.round(weeks / 4), STAGE_MIN, STAGE_MAX);

    /* ---- 3) 保守系数与曲线指数 ---- */
    profile = isObj(profile) ? profile : {};
    history = isObj(history) ? history : {};
    var level = String(profile.experience_level == null ? '' : profile.experience_level).trim();
    var conservative = conservativeOf(level);
    if (!level) notes.push('会员档案缺少训练基础，已按最保守档（newbie，系数 ' + conservative + '）处理');

    var completed = numOf(history.completedSessions);
    var rate = numOf(history.weeklyCompletionRate);
    var lowAdherence = false;
    if (rate === null || rate < LOW_ADHERENCE) lowAdherence = true;
    /* 一条额外保险：自称有基础但近 4 周一条训练记录都没有 → 不采信自报档位 */
    if (completed !== null && completed <= 0) {
      conservative = Math.min(conservative, CONSERVATIVE.newbie);
      notes.push('近 4 周没有已完成训练记录，保守系数已下调到 ' + conservative);
    }

    var c = 1 / conservative;
    if (lowAdherence) c = c + 0.2;
    if (c > EXP_MAX) c = EXP_MAX;
    if (c < 1) c = 1;   /* 系数表最大为 1，理论上不会触发，纯粹防御 */
    if (lowAdherence) {
      notes.push('近 4 周训练完成率' + (rate === null ? '无数据' : Math.round(rate * 100) + '%') +
        '，低于 ' + Math.round(LOW_ADHERENCE * 100) + '%，前半程已进一步压轻（曲线指数 ' + round1(c) + '）');
    }

    /* ---- 4) 安全护栏 ---- */
    var rail = safeLimit(goalType, direction, startV);
    var needPerWeek = weeks > 0 ? totalDelta / weeks : 0;
    var capped = false;
    var effective = totalDelta;

    if (rail.limit !== null && needPerWeek > rail.limit + EPS) {
      /* 先按文档把阶段数拉到「允许范围内的最大值（上限 8）」：
       * 这里的「允许范围」解释为「每个阶段至少 1 周」，故取 min(8, max(n, weeks))。
       * 说明：增大 n 只让阶段更细，**不改变总量与总周数**，因此周变化率不会因此下降，
       *       真正生效的是下面这一步封顶。这样做是为了让每阶段的量更小、更好回头调整。 */
      n = Math.min(STAGE_MAX_SAFE, Math.max(n, weeks));
      var safeTotal = rail.limit * weeks;
      if (totalDelta > safeTotal + EPS) {
        capped = true;
        effective = Math.min(totalDelta, safeTotal);
      }
      if (rail.label) warnings.push('原始目标需要每周变化 ' + fmt1(needPerWeek) + ' ' + (unit || '') +
        '，超过安全边界（' + rail.label + '），已按安全速率重新排期');
      if (capped) {
        var needWeeks = Math.ceil(totalDelta / rail.limit);
        warnings.push('按每周 ' + fmt1(rail.limit) + ' ' + (unit || '') + ' 的安全速率推算，达到原目标至少需要 ' +
          needWeeks + ' 周，当前阶段排期（' + weeks + ' 周）只能到 ' +
          withUnit(fmt1(startV + sign * effective), unit) + '。目标本身建议你延长周期。');
      }
    }

    /* ---- 5) 权重曲线分摊：w_i = i^c，归一化 ---- */
    var weights = [], wsum = 0, i;
    for (i = 1; i <= n; i++) {
      var w = Math.pow(i, c);
      weights.push(w);
      wsum += w;
    }
    if (wsum <= 0) wsum = 1;   /* 防御：n≥2 且 c≥1 时不可能为 0 */

    /* 终点值：未封顶时严格等于长期目标的 target_value；封顶时按安全速率能到的量 */
    var finalTarget = capped ? round1(startV + sign * effective) : targetV;

    var stages = [];
    var cum = 0;
    var prevTarget = startV;
    var prevDate = startDate;

    for (i = 1; i <= n; i++) {
      var last = (i === n);
      var delta = effective * weights[i - 1] / wsum;
      cum += delta;

      var sTargetDate = last ? targetDate : addDays(startDate, Math.round(weeks * i / n) * 7);
      if (!sTargetDate) sTargetDate = last ? targetDate : targetDate;   /* 兜底：日期推算失败则贴到终点 */

      var sTarget;
      if (last) {
        sTarget = finalTarget;
      } else {
        sTarget = round1(startV + sign * cum);
        /* 单调夹取：四舍五入可能让相邻两阶段等值或越过终点，这里按方向压回去，
         * 保证「阶段值单调推进」且「不超过终点值」两条可读性质。 */
        if (sign > 0) {
          if (sTarget < prevTarget) sTarget = prevTarget;
          if (sTarget > finalTarget) sTarget = finalTarget;
        } else {
          if (sTarget > prevTarget) sTarget = prevTarget;
          if (sTarget < finalTarget) sTarget = finalTarget;
        }
      }

      stages.push({
        title: '第 ' + i + ' 阶段：到 ' + sTargetDate + ' 前达到 ' + withUnit(fmt1(sTarget), unit),
        kind: 'stage',
        goal_type: goalType,
        direction: direction,
        unit: unit,
        start_value: fmt1(prevTarget),
        target_value: fmt1(sTarget),
        start_date: prevDate,
        target_date: sTargetDate,
        parent_goal_id: String(ltg.goal_id || ''),
        seq: i
      });

      prevTarget = sTarget;
      prevDate = sTargetDate;
    }

    /* ---- 6) 说明 ---- */
    if (totalDelta <= EPS) {
      notes.push('起始值与目标值相同，阶段目标只是把时间切成 ' + n + ' 段，用于保持记录节奏');
    }
    notes.push('总跨度 ' + weeks + ' 周，拆成 ' + n + ' 个阶段（约每 ' + round1(weeks / n) + ' 周一个）。');
    notes.push('训练基础 ' + (level || '未填写') + '，保守系数 ' + conservative +
      '，曲线指数 ' + round1(c) + '：经验越少，越多目标量放在后半程。');
    notes.push('全程平均每周需要变化 ' + fmt1(needPerWeek) + ' ' + (unit || '') + '。');
    if (rail.limit !== null) notes.push('安全上限：' + rail.label + '（' + fmt1(rail.limit) + ' ' + (unit || '') + '/周）。');
    notes.push(DISCLAIMER);

    return {
      ok: true,
      stages: stages,
      notes: notes,
      warnings: warnings,
      meta: {
        weeks: weeks,
        stageCount: n,
        totalDelta: round1(totalDelta),
        effectiveDelta: round1(effective),
        conservative: conservative,
        exponent: round1(c),
        requiredPerWeek: round1(needPerWeek),
        safePerWeek: rail.limit === null ? null : round1(rail.limit),
        capped: capped,
        finalTarget: round1(finalTarget)
      }
    };
  }

  /* ---------------------------------------------------------------- 执行历史（本地派生） */

  /**
   * readHistory(store, memberId, profile, opt) —— 从 m_sessions 派生近 4 周执行情况。
   * 为什么放在领域层：suggestStages 需要「近 4 周完成率」做保守修正，
   * 而它是纯函数不能读库，于是由调用方（acceptStages）算好再传进去。
   * @returns {{completedSessions:number, weeklyCompletionRate:number|null}}
   */
  function readHistory(store, memberId, profile, opt) {
    opt = opt || {};
    var today = opt.today || todayStr();
    var from = addDays(today, -28);
    var completed = 0;
    if (from) {
      store.findBy(TABLE_SESSIONS, function (r) {
        return r && r.member_id === memberId && r.status === 'completed' &&
          isDateStr(r.session_date) && r.session_date >= from && r.session_date <= today;
      }).forEach(function () { completed++; });
    }
    /* 期望次数取「每周可训练天数」，取不到则按 3 次/周的保守口径 */
    var perWeek = numOf(profile && (profile.frequency_goal || profile.available_days_per_week));
    if (perWeek === null || perWeek <= 0) perWeek = 3;
    var expected = perWeek * 4;
    var rate = expected > 0 ? clamp(completed / expected, 0, 1) : null;
    return { completedSessions: completed, weeklyCompletionRate: rate };
  }

  /* ---------------------------------------------------------------- 采纳阶段 */

  /**
   * acceptStages(store, memberId, longTermGoalId, opt) —— 采纳拆分建议并写入 m_goals。
   *
   * 幂等：该长期目标下只要已存在 kind='stage' 且 status='active' 的阶段，
   *      直接返回 {ok:false, reason:'already_exists', added:0}，**绝不产生第二套**。
   *
   * opt.profile  可选，直接给档案对象（不给则从 m_profiles 读）
   * opt.history  可选，直接给执行历史（不给则从 m_sessions 派生）
   * opt.today    可选，'YYYY-MM-DD'，用于确定「近 4 周」窗口
   *
   * 同样**不调用 store.save()**。
   *
   * @returns {{ok:true, added:number, stages:Object[], notes, warnings}|{ok:false, reason, added:number}}
   */
  function acceptStages(store, memberId, longTermGoalId, opt) {
    opt = opt || {};
    if (badStore(store)) return { ok: false, reason: 'bad_store', added: 0, errors: ['store 无效：请传入 memberStore.createStore() 返回的实例'] };
    if (!memberId) return { ok: false, reason: 'no_actor', added: 0, errors: ['缺少会员ID'] };
    if (noSchema()) return { ok: false, reason: 'no_schema', added: 0, errors: ['契约层 memberSchema 未就绪'] };

    var own = ownedGoal(store, memberId, longTermGoalId);
    if (!own.ok) return { ok: false, reason: own.reason, added: 0, errors: own.errors };

    var exist = store.findBy(TABLE_GOALS, function (r) {
      return r && r.parent_goal_id === longTermGoalId && r.kind === 'stage' && r.status === 'active';
    });
    if (exist.length) {
      return { ok: false, reason: 'already_exists', added: 0, errors: ['该长期目标下已有 ' + exist.length + ' 个进行中的阶段目标'] };
    }

    var profile = opt.profile;
    if (!isObj(profile)) {
      var pro = store.find(TABLE_PROFILES, memberId);
      profile = pro || {};
    }
    var history = isObj(opt.history) ? opt.history : readHistory(store, memberId, profile, opt);

    var sug = suggestStages(profile, own.goal, history, { today: opt.today });
    if (!sug.ok) {
      return { ok: false, reason: sug.reason || 'suggest_failed', added: 0, errors: sug.warnings };
    }

    var now = opt.now || nowStr();
    var rows = [], errs = [];
    for (var i = 0; i < sug.stages.length; i++) {
      var s = sug.stages[i];
      var rec = {
        goal_id: store.nextId(TABLE_GOALS),
        member_id: memberId,
        parent_goal_id: String(own.goal.goal_id),
        kind: 'stage',
        goal_type: s.goal_type,
        title: s.title,
        target_value: s.target_value,
        start_value: s.start_value,
        unit: s.unit,
        direction: s.direction,
        start_date: s.start_date,
        target_date: s.target_date,
        status: 'active',
        achieved_at: '',
        created_at: now,
        updated_at: ''
      };
      var res = store.insert(TABLE_GOALS, rec, { actor: memberId });
      if (!res.ok) {
        errs.push('第 ' + (i + 1) + ' 阶段写入失败：' + (res.reason || 'invalid') + ' ' + errTexts(res).join('；'));
        continue;
      }
      rows.push(res.row);
    }

    if (errs.length) {
      return { ok: false, reason: 'insert_failed', added: rows.length, errors: errs, notes: sug.notes, warnings: sug.warnings };
    }
    return { ok: true, added: rows.length, stages: rows, notes: sug.notes, warnings: sug.warnings, meta: sug.meta };
  }

  /* ---------------------------------------------------------------- 查询 */

  /**
   * listGoals(store, memberId, opt) —— 列出该会员的目标树。
   * @returns {{longTerms:Object[], children:Object}}
   *          longTerms：kind='long_term' 且 parent_goal_id 为空，按 created_at 倒序
   *          children：{[longTermGoalId]: 阶段目标数组}，按 target_date 升序
   *                    （m_goals 没有 seq 字段，故不依赖 seq，一律按日期排）
   */
  function listGoals(store, memberId, opt) {
    opt = opt || {};
    var empty = { longTerms: [], children: {} };
    if (badStore(store) || !memberId) return empty;

    var mine = store.findBy(TABLE_GOALS, function (r) { return r && r.member_id === memberId; });

    var longTerms = mine.filter(function (r) {
      return r.kind !== 'stage' && !String(r.parent_goal_id || '');
    });
    longTerms.sort(function (a, b) {
      var ca = String(a.created_at || ''), cb = String(b.created_at || '');
      if (ca !== cb) return ca < cb ? 1 : -1;
      return String(a.goal_id) < String(b.goal_id) ? 1 : -1;
    });

    var children = {};
    mine.forEach(function (r) {
      if (r.kind !== 'stage') return;
      var pid = String(r.parent_goal_id || '');
      if (!pid) return;
      if (!children[pid]) children[pid] = [];
      children[pid].push(r);
    });
    Object.keys(children).forEach(function (pid) {
      children[pid].sort(function (a, b) {
        var ta = String(a.target_date || ''), tb = String(b.target_date || '');
        if (ta !== tb) return ta < tb ? -1 : 1;
        return String(a.goal_id) < String(b.goal_id) ? -1 : 1;
      });
    });

    return { longTerms: longTerms, children: children };
  }

  /**
   * getGoal(store, memberId, goalId) —— 单条读取（带归属校验）。
   * @returns {{ok:true, goal}|{ok:false, reason, errors}}
   */
  function getGoal(store, memberId, goalId, opt) {
    opt = opt || {};
    if (badStore(store)) return { ok: false, reason: 'bad_store', errors: ['store 无效'] };
    if (!memberId) return { ok: false, reason: 'no_actor', errors: ['缺少会员ID'] };
    return ownedGoal(store, memberId, goalId);
  }

  /* ---------------------------------------------------------------- 改目标 */

  /**
   * 写一条调整留痕到 m_adjustments。
   *
   * schema 的 target_type 枚举里没有 goal 这一档，按最接近的一档记为 'plan'（计划/目标类），
   * 具体对象写在 target_id（GO 号）与 reason_text 里；adjust_type 同理取 'volume'（量级变化）。
   * reason_code 固定 'goal_value_changed'，reason_text 写人话。
   */
  function logAdjustment(store, memberId, goal, before, after, opt) {
    var unit = String(goal.unit || '');
    var text = '会员把目标值从 ' + withUnit(fmt1(before), unit) + ' 改为 ' + withUnit(fmt1(after), unit) +
      '（目标 ' + goal.goal_id + '）';
    var rec = {
      adjustment_id: store.nextId(TABLE_ADJ),
      member_id: memberId,
      target_type: 'plan',
      target_id: String(goal.goal_id),
      adjust_type: 'volume',
      before_value: withUnit(fmt1(before), unit),
      after_value: withUnit(fmt1(after), unit),
      reason_code: 'goal_value_changed',
      reason_text: text.slice(0, 200),
      applied_by: (opt && opt.appliedBy) === 'system' ? 'system' : 'member',
      created_at: (opt && opt.now) || nowStr()
    };
    if (!rec.adjustment_id) return { ok: false, reason: 'id_exhausted', errors: ['调整记录 ID 已用尽（AJ9999）'] };
    var res = store.insert(TABLE_ADJ, rec, { actor: memberId });
    if (!res.ok) return { ok: false, reason: res.reason || 'insert_failed', errors: errTexts(res) };
    return { ok: true, row: res.row };
  }

  /** updateGoal 允许改的字段白名单 */
  var PATCH_FIELDS = ['title', 'target_value', 'target_date', 'unit', 'start_value'];

  /**
   * updateGoal(store, memberId, goalId, patch, opt) —— 修改目标（标题 / 目标值 / 目标日期 / 单位 / 起始值）。
   *
   * 规则：
   *   - 只允许白名单字段；出现其它字段**整体拒收**（拒收优于猜测是本项目一贯原则）；
   *   - 已达成（status='achieved'）的目标不允许再改，返回 {ok:false, reason:'already_achieved'}；
   *   - target_value 真的变化时才写 m_adjustments 留痕；留痕失败会**回滚**已改的目标值，
   *     避免出现「值变了但没有记录」的账实不符；
   *   - 校验口径与 createLongTerm 完全一致（共用 validateInput）。
   *
   * @returns {{ok:true, goal, adjusted:boolean}|{ok:false, reason, errors}}
   */
  function updateGoal(store, memberId, goalId, patch, opt) {
    patch = isObj(patch) ? patch : {};
    opt = opt || {};
    if (badStore(store)) return { ok: false, reason: 'bad_store', errors: ['store 无效：请传入 memberStore.createStore() 返回的实例'] };
    if (!memberId) return { ok: false, reason: 'no_actor', errors: ['缺少会员ID'] };
    if (noSchema()) return { ok: false, reason: 'no_schema', errors: ['契约层 memberSchema 未就绪'] };

    var own = ownedGoal(store, memberId, goalId);
    if (!own.ok) return { ok: false, reason: own.reason, errors: own.errors };
    var goal = own.goal;

    if (goal.status === 'achieved') {
      return { ok: false, reason: 'already_achieved', errors: ['目标已达成，不能再修改；如需继续请新建目标'] };
    }

    var keys = Object.keys(patch);
    var bad = keys.filter(function (k) { return PATCH_FIELDS.indexOf(k) < 0; });
    if (bad.length) {
      return { ok: false, reason: 'field_not_allowed', errors: ['不允许修改的字段：' + bad.join('、')] };
    }
    if (!keys.length) return { ok: false, reason: 'empty_patch', errors: ['没有需要修改的字段'] };

    var v = validateInput(patch, { partial: true });
    if (!v.ok) return { ok: false, reason: 'invalid_input', errors: v.errors };

    /* 目标日期还要与既有开始日期比对（patch 里可能只带了 target_date） */
    var newStart = v.value.start_date || goal.start_date;
    var newTarget = v.value.target_date || goal.target_date;
    if (v.value.target_date) {
      var gap = diffDays(newTarget, newStart);
      if (gap === null || gap <= 0) {
        return { ok: false, reason: 'invalid_input', errors: ['target_date: 目标日期必须晚于开始日期'] };
      }
    }

    var apply = {};
    if (v.value.title !== undefined) apply.title = v.value.title;
    if (v.value.unit !== undefined) apply.unit = v.value.unit;
    if (v.value.target_date !== undefined) apply.target_date = v.value.target_date;
    if (v.value.target_value !== undefined) apply.target_value = fmt1(v.value.target_value);
    if (v.value.start_value !== undefined) apply.start_value = fmt1(v.value.start_value);
    apply.updated_at = opt.now || nowStr();

    var beforeV = numOf(goal.target_value);
    var afterV = v.value.target_value;
    var changed = afterV !== undefined && afterV !== null && (beforeV === null || Math.abs(beforeV - afterV) > EPS);

    var res = store.update(TABLE_GOALS, goalId, apply, { actor: memberId });
    if (!res.ok) return { ok: false, reason: res.reason || 'update_failed', errors: errTexts(res) };

    if (!changed) return { ok: true, goal: res.row, adjusted: false };

    var log = logAdjustment(store, memberId, goal, beforeV, afterV, opt);
    if (!log.ok) {
      /* 回滚：留痕写不进去就不能让目标值悄悄变掉，否则「改了没记录」无从追溯 */
      var back = { target_value: String(goal.target_value), updated_at: apply.updated_at };
      store.update(TABLE_GOALS, goalId, back, { actor: memberId });
      return {
        ok: false, reason: 'adjust_log_failed', errors: ['目标值改回原值：调整留痕写入失败（' + (log.reason || '未知') + '）'].concat(log.errors || [])
      };
    }
    return { ok: true, goal: res.row, adjusted: true, adjustment: log.row };
  }

  /* ---------------------------------------------------------------- 更新实测值 / 达成 */

  /**
   * updateCurrentValue(store, memberId, goalId, value, opt) —— 记录最新实测值并判定达成。
   *
   * 【重要】m_goals 没有 current_value 字段：本函数把实测值写回 **start_value**，
   * 也就是说表中 start_value 的语义是「当前值」，不再是「起点」。
   * 进度需要的「原始起点」由 progress() 从阶段链上找回（见 resolveOrigin）。
   *
   * 达成判定：direction='decrease' → value <= target_value；'increase' → value >= target_value。
   * 达成时置 status='achieved'、achieved_at=今天（schema 的 COND 要求 achieved 必须带达成日期）。
   * 注意 store.update 是原地改同一个行对象，因此「操作前是否为 active」必须先取快照。
   *
   * 边界：
   *   - **不发放 XP、不写时间线**，只把 achieved / allStagesDone 信号返回给上层；
   *   - 阶段目标达成时检查同父目标下所有阶段是否都达成，是则 allStagesDone=true；
   *     **只给信号，不自动改长期目标状态**（按文档要求，长期目标是否置达成由会员确认或自行操作）；
   *   - 已放弃（abandoned）的目标仍可记录数值，但不再翻转状态。
   *
   * @returns {{ok:true, goal, achieved:boolean, newlyAchieved:boolean, allStagesDone:boolean}
   *          |{ok:false, reason, errors}}
   */
  function updateCurrentValue(store, memberId, goalId, value, opt) {
    opt = opt || {};
    if (badStore(store)) return { ok: false, reason: 'bad_store', errors: ['store 无效：请传入 memberStore.createStore() 返回的实例'] };
    if (!memberId) return { ok: false, reason: 'no_actor', errors: ['缺少会员ID'] };

    var own = ownedGoal(store, memberId, goalId);
    if (!own.ok) return { ok: false, reason: own.reason, errors: own.errors };
    var goal = own.goal;

    var v = numOf(value);
    if (v === null) return { ok: false, reason: 'invalid_input', errors: ['value: 请填写有效的实测数值'] };
    if (!inRange(v)) return { ok: false, reason: 'invalid_input', errors: ['value: 数值超出合理范围'] };

    var tv = numOf(goal.target_value);
    var reached = false;
    if (tv !== null) {
      reached = goal.direction === 'decrease' ? (v <= tv) : (v >= tv);
    }

    /* store.update 是**原地改同一个行对象**，所以状态必须在改之前取快照，
     * 否则改完之后再读 goal.status 永远是新值，「本次是否新达成」就判不出来了。 */
    var wasActive = goal.status === 'active';

    var apply = { start_value: fmt1(v), updated_at: opt.now || nowStr() };
    var today = opt.today || todayStr();
    if (reached && wasActive) {
      apply.status = 'achieved';
      apply.achieved_at = today;
    }

    var res = store.update(TABLE_GOALS, goalId, apply, { actor: memberId });
    if (!res.ok) return { ok: false, reason: res.reason || 'update_failed', errors: errTexts(res) };

    /* achieved      = 录入后该目标满足达成条件（含此前已达成的情况）
     * newlyAchieved = 本次录入才刚刚达成；上层要发 XP/写时间线请以这个为准（配合 biz_key 去重） */
    var out = {
      ok: true, goal: res.row, achieved: reached, newlyAchieved: reached && wasActive, allStagesDone: false
    };

    var pid = String(goal.parent_goal_id || '');
    if (reached && goal.kind === 'stage' && pid) {
      var sibs = store.findBy(TABLE_GOALS, function (r) {
        return r && r.member_id === memberId && r.parent_goal_id === pid && r.kind === 'stage';
      });
      var all = sibs.length > 0;
      for (var i = 0; i < sibs.length; i++) {
        if (sibs[i].status !== 'achieved') { all = false; break; }
      }
      out.allStagesDone = all;
      out.parentGoalId = pid;
    }
    return out;
  }

  /**
   * setStatus(store, memberId, goalId, status, opt) —— 手工置状态。
   * status 仅允许 active / achieved / abandoned。
   * 置 achieved 时补 achieved_at（已有则保留，保证幂等）；置其它状态时清空 achieved_at。
   *
   * @returns {{ok:true, goal}|{ok:false, reason, errors}}
   */
  function setStatus(store, memberId, goalId, status, opt) {
    opt = opt || {};
    if (badStore(store)) return { ok: false, reason: 'bad_store', errors: ['store 无效：请传入 memberStore.createStore() 返回的实例'] };
    if (!memberId) return { ok: false, reason: 'no_actor', errors: ['缺少会员ID'] };
    if (STATUSES.indexOf(status) < 0) {
      return { ok: false, reason: 'invalid_input', errors: ['status: 状态非法：' + status + '（允许 ' + STATUSES.join('/') + '）'] };
    }

    var own = ownedGoal(store, memberId, goalId);
    if (!own.ok) return { ok: false, reason: own.reason, errors: own.errors };

    var apply = { status: status, updated_at: opt.now || nowStr() };
    if (status === 'achieved') apply.achieved_at = own.goal.achieved_at || opt.today || todayStr();
    else apply.achieved_at = '';

    var res = store.update(TABLE_GOALS, goalId, apply, { actor: memberId });
    if (!res.ok) return { ok: false, reason: res.reason || 'update_failed', errors: errTexts(res) };
    return { ok: true, goal: res.row };
  }

  /* ---------------------------------------------------------------- 进度 */

  /** 取某长期目标下的阶段列表（按 target_date 升序，与 listGoals 同口径） */
  function kidsOf(store, memberId, pid) {
    var list = store.findBy(TABLE_GOALS, function (r) {
      return r && r.member_id === memberId && r.parent_goal_id === pid && r.kind === 'stage';
    });
    list.sort(function (a, b) {
      var ta = String(a.target_date || ''), tb = String(b.target_date || '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.goal_id) < String(b.goal_id) ? -1 : 1;
    });
    return list;
  }

  /**
   * 找「原始起点」。
   *
   * 为什么需要：m_goals 没有 current_value，start_value 被 updateCurrentValue 覆写成当前值后，
   * 长期目标自身的起点就丢了，必须靠阶段链找回。
   *
   * 找回规则（确定性、可解释）：
   *   ① opt.originValue（调用方明确指定，优先级最高）
   *   ② 阶段目标：起点 = 上一个阶段的 target_value（阶段链首尾相接，且 target_value 不会被实测覆盖）；
   *      第一个阶段则递归取长期目标自身的起点
   *   ③ 长期目标：候选集 = 自身 start_value + 所有阶段的 start_value，
   *      取**离目标最远**的那个（decrease 取最大、increase 取最小）。
   *      理由：任何一次实测只会把值往目标方向推进，不会把起点推得更远，
   *            所以「最远离目标」的候选最接近真正的起点。
   *   ④ 都没有 → 退化为当前值，此时 percent 必然为 0，并在 reason 里如实说明（不假装算出进度）
   */
  function resolveOrigin(store, memberId, goal, opt) {
    if (isNum(opt.originValue)) return { value: numOf(opt.originValue), from: 'option' };

    if (goal.kind !== 'stage') {
      var cands = [];
      var self = numOf(goal.start_value);
      if (self !== null) cands.push({ v: self, from: 'current' });
      kidsOf(store, memberId, goal.goal_id).forEach(function (r) {
        var v = numOf(r.start_value);
        if (v !== null) cands.push({ v: v, from: 'first_stage' });
      });
      if (!cands.length) return { value: null, from: 'none' };
      var pick = cands[0];
      var wantMax = goal.direction !== 'increase';   /* decrease 取最大，increase 取最小 */
      cands.forEach(function (c) {
        var better = wantMax ? c.v > pick.v : c.v < pick.v;
        /* 同值时优先取阶段链上的起点：它比「当前值」更能说明来源，也便于上层排查 */
        if (!better && c.v === pick.v && pick.from === 'current' && c.from !== 'current') better = true;
        if (better) pick = c;
      });
      /* 只有「唯一候选就是当前值」才算真的找不到起点（此时进度必然为 0，如实说明）；
       * 若当前值在多个候选里胜出，说明会员的实测值比所有阶段起点都更远离目标（例如体重回升），
       * 这时以当前值为起点是诚实的，进度会自然算出 0，不算数据缺失。 */
      if (pick.from === 'current' && cands.length > 1) pick = { v: pick.v, from: 'self_extreme' };
      return { value: pick.v, from: pick.from };
    }

    var pid = String(goal.parent_goal_id || '');
    if (pid) {
      var sibs = kidsOf(store, memberId, pid);
      var idx = -1;
      for (var i = 0; i < sibs.length; i++) { if (sibs[i].goal_id === goal.goal_id) { idx = i; break; } }
      if (idx > 0) {
        var pv = numOf(sibs[idx - 1].target_value);
        if (pv !== null) return { value: pv, from: 'prev_stage' };
      }
      var parent = store.find(TABLE_GOALS, pid);
      if (parent && parent.member_id === memberId && parent.goal_id !== goal.goal_id) {
        var po = resolveOrigin(store, memberId, parent, {});   /* 递归一层：长期目标没有再上级 */
        if (po.value !== null) return { value: po.value, from: 'parent' };
      }
    }
    var cur = numOf(goal.start_value);
    return { value: cur, from: cur === null ? 'none' : 'current' };
  }

  /**
   * progress(store, memberId, goalId, opt) —— 计算目标进度。
   *
   * percent 按 direction 计算：
   *   increase：(当前值 - 起点) / (目标值 - 起点)
   *   decrease：(起点 - 当前值) / (起点 - 目标值)
   * 结果夹到 [0,100] 并保留 1 位小数。
   *
   * isOverdue：今天 > target_date 且 status 仍为 active。
   * remain：按方向到目标还差多少；已经越过目标时记 0（不出现负数，避免 UI 显示「-2kg 待完成」）。
   *
   * opt.originValue 可显式指定原始起点，详见 resolveOrigin。
   * **任何数据缺失都返回 percent=0 并带 reason，绝不抛异常。**
   *
   * @returns {{percent:number, currentValue, startValue, targetValue, remain:number,
   *            direction:string, isOverdue:boolean, originValue, originFrom:string, reason?:string}}
   */
  function progress(store, memberId, goalId, opt) {
    opt = opt || {};
    var today = opt.today || todayStr();
    var base = {
      percent: 0, currentValue: null, startValue: null, targetValue: null,
      remain: 0, direction: '', isOverdue: false, originValue: null, originFrom: 'none'
    };
    if (badStore(store)) return Object.assign({}, base, { reason: 'bad_store' });
    if (!memberId) return Object.assign({}, base, { reason: 'no_actor' });

    var own = ownedGoal(store, memberId, goalId);
    if (!own.ok) return Object.assign({}, base, { reason: own.reason });
    var goal = own.goal;

    var cur = numOf(goal.start_value);          /* 当前值就存在 start_value 里 */
    var tv = numOf(goal.target_value);
    var direction = DIRECTIONS.indexOf(goal.direction) >= 0 ? goal.direction : 'increase';

    if (cur === null || tv === null) {
      return Object.assign({}, base, {
        currentValue: cur, targetValue: tv, direction: direction, reason: 'missing_value'
      });
    }

    var origin = resolveOrigin(store, memberId, goal, opt);
    var sv = origin.value;
    if (origin.from === 'current') {
      /* 起点已被覆盖成当前值，只能诚实返回 0 并说明原因，不假装算出进度 */
      return Object.assign({}, base, {
        currentValue: cur, startValue: sv, targetValue: tv, direction: direction,
        originValue: sv, originFrom: origin.from, reason: 'no_origin',
        isOverdue: goal.status === 'active' && isDateStr(goal.target_date) && today > goal.target_date
      });
    }

    var distance = Math.abs(tv - sv);
    var percent = 0;
    if (distance <= EPS) {
      percent = goal.status === 'achieved' ? 100 : 0;
    } else {
      var moved = direction === 'decrease' ? (sv - cur) : (cur - sv);
      percent = round1(clamp(moved / distance * 100, 0, 100));
    }

    var remainRaw = direction === 'decrease' ? (cur - tv) : (tv - cur);
    var remain = remainRaw > 0 ? round1(remainRaw) : 0;

    return {
      percent: percent,
      currentValue: cur,
      startValue: sv,
      targetValue: tv,
      remain: remain,
      direction: direction,
      isOverdue: goal.status === 'active' && isDateStr(goal.target_date) && today > goal.target_date,
      originValue: sv,
      originFrom: origin.from,
      unit: String(goal.unit || ''),
      status: String(goal.status || ''),
      targetDate: String(goal.target_date || ''),
      goalId: String(goal.goal_id || '')
    };
  }

  /* ---------------------------------------------------------------- 对外接口 */

  return {
    /* 常量表（供 UI 下拉框与测试复用，避免各处硬编码字符串） */
    KINDS: KINDS,
    GOAL_TYPES: GOAL_TYPES,
    DIRECTIONS: DIRECTIONS,
    STATUSES: STATUSES,
    CONSERVATIVE: CONSERVATIVE,
    SAFE_RATE: SAFE_RATE,
    PATCH_FIELDS: PATCH_FIELDS,
    DEFAULT_WEEKS: DEFAULT_WEEKS,
    DISCLAIMER: DISCLAIMER,

    todayStr: todayStr,
    nowStr: nowStr,
    readHistory: readHistory,

    createLongTerm: createLongTerm,
    suggestStages: suggestStages,
    acceptStages: acceptStages,
    listGoals: listGoals,
    getGoal: getGoal,
    updateGoal: updateGoal,
    updateCurrentValue: updateCurrentValue,
    setStatus: setStatus,
    progress: progress
  };
});


/* ===== ../src/js/fxp-member-plan.js ===== */
/* Fitness XP 会员端 V2 — 计划与背包领域层（周计划生成 / 增删改查 / 教练已确认只读拦截 / 今日训练背包；UMD）
 *
 * 依赖：fxp-member-schema（**可选**，仅用于日期格式校验；缺失时退化为本地正则）
 * 不依赖：fxp-persist、任何 DOM、任何第三方库
 *
 * 【职责边界】
 *   1. 周计划：按「会员档案 + 动作库」用**确定性规则**生成一周草稿（generatePlan 是纯函数），
 *      落库（createWeekPlan）、增删改查、发布（publishPlan）、复制（copyPlan）。
 *   2. 教练 vs 会员安排分离（02 §B.3 任务书硬性要求）：
 *      coach_confirmed='Y' 的计划及其 plan_items，**任何会员端写操作都必须在代码层被拒绝**，
 *      不能只靠 UI 隐藏按钮。本模块用 planGuard() 统一拦截，理由码固定为 coach_confirmed_readonly。
 *   3. 今日背包（02 §D）：获取/增删/排序/替换（两阶段：先差异预览，再确认执行）、
 *      存为模板、从模板/历史复制载入。
 *
 * 【本模块的三条硬约定（与项目其它模块一致）】
 *   A. store 由调用方传入：本模块不 new 存储、不读写 localStorage、不调用 store.save()；
 *      持久化由调用方统一执行（这是项目既定约定，避免多层嵌套保存）。
 *   B. 所有写操作都带 { actor: memberId }，跨会员归属校验交给 store.assertOwner。
 *   C. 失败必须把原因向上返回（reason / message / errors），绝不静默吞掉。
 *
 * 【红线（02 §D.3）】
 *   系统不得以任何理由在未经会员点击确认的情况下删除或替换背包里的动作。
 *   器械不匹配、时长超限、与教练安排冲突 —— 都只是提示，绝不自动执行。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root || {});
  } else {
    root.FXP = root.FXP || {};
    root.FXP.memberPlan = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (ROOT) {
  'use strict';

  /* ================================================================ 一、常量与查表 */

  /* 难度档位序号：用于「难度差 ≥2 档」判定与「训练基础 → 难度上限」映射 */
  var DIFF_RANK = { beginner: 1, novice: 2, intermediate: 3, advanced: 4 };

  /* 训练基础 → 允许的最高难度（02 §B.2：新手 ≤novice，进阶 →intermediate，高级 全放开）
     说明：newbie 与 novice 的上限都是 novice（2），因为 novice 会员也只保证到 novice 难度。 */
  var LEVEL_MAX_DIFF = { newbie: 2, novice: 2, intermediate: 3, advanced: 4 };

  /* 部位分化表（本模块自行定义，02 §B.2 只给了「N≤2 全身 / N=3 上下肢+全身 / N≥4 部位」的原则）
     设计原则：只用 movement_pattern 一个维度（动作库里每个动作都有），不需要额外的部位字段，
     因此规则简单、可解释、可向会员一句话说清。每个部位给出「优先动作模式」的有序列表。 */
  var FOCUS_PATTERNS = {
    '全身': ['squat', 'push_horizontal', 'pull_horizontal', 'hinge', 'core'],
    '上肢': ['push_horizontal', 'pull_horizontal', 'push_vertical', 'pull_vertical', 'isolation'],
    '上肢推': ['push_horizontal', 'push_vertical', 'isolation'],
    '上肢拉': ['pull_horizontal', 'pull_vertical', 'isolation'],
    '下肢': ['squat', 'hinge', 'carry', 'locomotion'],
    '下肢前侧': ['squat', 'locomotion', 'carry'],
    '下肢后侧': ['hinge', 'carry', 'locomotion'],
    '核心': ['core', 'carry', 'isolation']
  };

  /* N（每周可练天数） → 各训练日的部位。N 相同时顺序固定，保证确定性。 */
  var SPLIT_BY_N = {
    1: ['全身'],
    2: ['全身', '全身'],
    3: ['上肢', '下肢', '全身'],
    4: ['上肢推', '上肢拉', '下肢', '核心'],
    5: ['上肢推', '上肢拉', '下肢', '核心', '全身'],
    6: ['上肢推', '上肢拉', '下肢前侧', '下肢后侧', '核心', '全身'],
    7: ['上肢推', '上肢拉', '下肢前侧', '下肢后侧', '核心', '全身', '上肢']
  };

  /* N → 安排在星期几（1=周一 … 7=周日）。刻意让训练日之间留出休息日，且不与周末全占满。 */
  var DAYS_BY_N = {
    1: [3],
    2: [1, 4],
    3: [1, 3, 5],
    4: [1, 2, 4, 5],
    5: [1, 2, 3, 5, 6],
    6: [1, 2, 3, 4, 5, 6],
    7: [1, 2, 3, 4, 5, 6, 7]
  };

  var DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /* 器械中文俗称 → 枚举值（会员档案里的 available_equipment 是自由文本，允许写中文） */
  var EQUIP_ALIAS = {
    '徒手': 'bodyweight', '自重': 'bodyweight', '哑铃': 'dumbbell', '杠铃': 'barbell',
    '器械': 'machine', '固定器械': 'machine', '绳索': 'cable', '龙门架': 'cable',
    '弹力带': 'band', '壶铃': 'kettlebell', '有氧器械': 'cardio_machine', '其他': 'other'
  };

  var DEFAULT_REST_SEC = 90;      /* 组间休息默认值（02 §B.2） */
  var DEFAULT_SESSION_MIN = 45;   /* session_minutes 缺失时的默认单次时长 */
  var DEFAULT_DAYS = 3;           /* available_days_per_week 缺失时的默认天数 */
  var DEFAULT_SETS = 3;           /* reference_sets_reps 解析失败时的默认组数 */
  var DEFAULT_REPS = 10;          /* reference_sets_reps 解析失败时的默认次数 */

  /* 计划侧写操作被教练只读拦截时的统一返回文案（02 §B.3 原话） */
  var READONLY_MSG = '这是教练已确认的安排，如需调整请联系教练';

  /* ================================================================ 二、基础工具 */

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 本地日期 → 'YYYY-MM-DD'（不用 toISOString，避免时区偏移把日期挪走一天） */
  function fmtDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** todayStr([d]) —— 今天的本地日期字符串 'YYYY-MM-DD' */
  function todayStr(d) {
    d = d || new Date();
    return fmtDate(d);
  }

  /** nowStr([d]) —— 'YYYY-MM-DD HH:mm:ss'，与 schema 的 datetime 格式一致 */
  function nowStr(d) {
    d = d || new Date();
    return fmtDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** 取契约层（浏览器端脚本顺序问题，因此只在函数体内取，不在模块顶层取） */
  function memberSchema() {
    var r = ROOT || {};
    var F = r.FXP;
    if (!F && typeof self !== 'undefined') F = self.FXP;
    return (F && F.memberSchema) ? F.memberSchema : null;
  }

  /** 'YYYY-MM-DD' 合法性：优先用契约层的 isDate，缺失时退化为本地正则 */
  function isDateStr(v) {
    var s = String(v == null ? '' : v);
    var S = memberSchema();
    if (S && typeof S.isDate === 'function') return S.isDate(s);
    return /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  /** 字符串 → 本地 Date；非法输入退化为「今天」，保证不会抛出 */
  function toDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s == null ? '' : s));
    if (!m) return new Date();
    var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 0, 0, 0, 0);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  /**
   * mondayOf(dateStr) —— 取某日期所在 ISO 周的周一（周一为一周之始）。
   * 用本地日期计算，不做 UTC 换算；非法输入退化为「今天所在周的周一」。
   * @returns {string} 'YYYY-MM-DD'
   */
  function mondayOf(dateStr) {
    var d = toDate(dateStr);
    var dow = d.getDay();            /* 0=周日 … 6=周六 */
    var back = (dow + 6) % 7;        /* 周一→0，周日→6 */
    return fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
  }

  /**
   * addDays(dateStr, n) —— 日期加减天数（n 可为负）。n 非有限数时按 0 处理。
   * @returns {string} 'YYYY-MM-DD'
   */
  function addDays(dateStr, n) {
    var k = typeof n === 'number' ? n : parseInt(n, 10);
    if (!isFinite(k) || isNaN(k)) k = 0;
    k = Math.round(k);
    var d = toDate(dateStr);
    return fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + k));
  }

  /** 星期几严格校验：1-7 返回整数，其它（空/NaN/越界）返回 0 表示非法 */
  function strictDay(v) {
    var n = numOr(v, null);
    if (n === null || !isFinite(n)) return 0;
    n = Math.round(n);
    if (n < 1 || n > 7) return 0;
    return n;
  }

  /** 整数化：非法/非有限 → 默认值 def，再夹到 [min,max] */
  function clampInt(v, def, min, max) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n) || isNaN(n)) n = def;
    n = Math.round(n);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  /** 取整数，失败返回 def（用于快照版本号等必填整数） */
  function intOr(v, def) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!isFinite(n) || isNaN(n)) return def;
    return Math.round(n);
  }

  /** 取浮点数，失败返回 def；weight 用（def 传 null 时返回空串，表示「未设定」） */
  function numOr(v, def) {
    if (v === null || v === undefined || String(v).trim() === '') return def;
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n) || isNaN(n)) return def;
    return n;
  }

  /**
   * 数值卫生检查：NaN / Infinity 必须有明确拒绝路径（不允许脏数据进入计划与背包）。
   * @returns {{ok:boolean, reason:?string}}
   */
  function numSane(v, label) {
    if (v === null || v === undefined || String(v).trim() === '') return { ok: true };
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n) || isNaN(n)) {
      return { ok: false, reason: 'bad_number', message: (label || '数值') + '不是有效数字（NaN/Infinity 一律拒绝）' };
    }
    return { ok: true };
  }

  /** 把 store 的失败结果翻译成统一形态，绝不吞掉原因 */
  function storeFail(res, fallbackReason) {
    var out = { ok: false, reason: res && res.reason ? res.reason : (fallbackReason || 'store_failed') };
    if (res && res.message) out.message = res.message;
    if (res && res.errors && res.errors.length) {
      out.errors = res.errors.map(function (e) {
        return (e.field ? e.field + ': ' : '') + e.message;
      });
    }
    return out;
  }

  function fail(reason, message) {
    return { ok: false, reason: reason, message: message };
  }

  /* ================================================================ 三、档案 / 动作库解析 */

  /** 文本 → 标签数组（支持中英文逗号、顿号、分号、斜杠分隔；空串 → []） */
  function splitTags(v) {
    if (v === null || v === undefined) return [];
    return String(v).split(/[,，、;；\/|\s]+/).filter(function (s) { return s !== ''; });
  }

  /** 会员可用器械集合（小写枚举值集合）；空集合表示「不限制器械」 */
  function equipSetOf(profile) {
    var out = {};
    splitTags(profile.available_equipment).forEach(function (t) {
      var k = String(t).trim().toLowerCase();
      if (!k) return;
      if (EQUIP_ALIAS[t]) k = EQUIP_ALIAS[t];
      out[k] = true;
    });
    return out;
  }

  /** 会员身体限制标签数组（去空白，长度 ≥2 才参与匹配，避免单字噪声） */
  function limitationTags(profile) {
    return splitTags(profile.limitations).map(function (s) { return s.replace(/\s/g, ''); })
      .filter(function (s) { return s.length >= 2; });
  }

  /**
   * 新动作的 contraindications 是否命中会员 limitations。
   * 匹配方式：双向子串（去空白后比较）——「膝关节疼痛」能命中「膝关节疼痛、半月板损伤者慎用」。
   * 这是**硬过滤 / 拦截**判定，不是提示。
   */
  function hitLimitation(exercise, profile) {
    var c = String((exercise && exercise.contraindications) || '').replace(/\s/g, '');
    if (!c) return false;
    var tags = limitationTags(profile);
    for (var i = 0; i < tags.length; i++) {
      if (c.indexOf(tags[i]) >= 0) return true;
      /* 反向：限制写得比禁忌更细时（如「髌骨软化」vs「髌骨软化或髌腱炎」）同样命中 */
      if (tags[i].length >= 4 && tags[i].indexOf(c) >= 0) return true;
    }
    return false;
  }

  /** 难度序号，未知难度按 beginner(1) 处理 */
  function diffRank(v) {
    return DIFF_RANK[String(v)] || 1;
  }

  /**
   * 解析 reference_sets_reps（如「3 组 × 12-15 次，组间休息 60 秒」）。
   * 解析规则（本模块自行定义，文档未写死）：
   *   组数  ← /(\d+)\s*组/
   *   次数  ← /(\d+)[-~到](\d+)\s*次/ 的区间；无区间则取 /(\d+)\s*次/；
   *           若只有「静态保持 30-45 秒」这类描述（无「次」），次数按 1 计（一次保持）。
   *   休息  ← /休息\s*(\d+)/；解析不到则用默认 90 秒。
   * 取区间哪一端由 primary_goal 决定（02 §B.2：primary_goal 影响参考组数次数取值）。
   * 解析不出时退回 3 组 × 10 次。
   * @returns {{sets:int, reps:int, rest:int, lo:int, hi:int, parsed:boolean}}
   */
  function parseRefSetsReps(text, goal) {
    var s = String(text == null ? '' : text);
    var sets = 0, lo = 0, hi = 0, rest = 0, parsed = false;

    var mSets = s.match(/(\d+)\s*组/);
    if (mSets) { sets = parseInt(mSets[1], 10); parsed = true; }

    var mRange = s.match(/(\d+)\s*[-~—～到]\s*(\d+)\s*次/);
    if (mRange) {
      lo = parseInt(mRange[1], 10); hi = parseInt(mRange[2], 10);
    } else {
      var mOne = s.match(/(\d+)\s*次/);
      if (mOne) { lo = hi = parseInt(mOne[1], 10); }
      else if (/秒/.test(s)) { lo = hi = 1; }   /* 静态保持类：按 1 次计 */
    }

    var mRest = s.match(/休息\s*(\d+)/);
    if (mRest) rest = parseInt(mRest[1], 10);

    if (!isFinite(sets) || isNaN(sets) || sets <= 0) sets = DEFAULT_SETS;
    if (!isFinite(rest) || isNaN(rest) || rest <= 0) rest = DEFAULT_REST_SEC;
    if (!isFinite(lo) || isNaN(lo) || lo <= 0) lo = DEFAULT_REPS;
    if (!isFinite(hi) || isNaN(hi) || hi <= 0) hi = lo;
    if (hi < lo) hi = lo;

    return { sets: sets, reps: pickReps(lo, hi, goal), rest: rest, lo: lo, hi: hi, parsed: parsed };
  }

  /** 按主要目标在 [lo,hi] 区间里取次数：减脂取上限、力量取下限、增肌取中位、其余取保守下限 */
  function pickReps(lo, hi, goal) {
    switch (goal) {
      case 'fat_loss': return hi;
      case 'strength': return lo;
      case 'muscle_gain': return Math.round((lo + hi) / 2);
      default: return lo;   /* health / posture / rehab / 缺省 —— 保守 */
    }
  }

  /**
   * 构建候选池（纯函数）：按器械、难度、身体限制三层硬过滤。
   * 过滤原因互斥计数，供 notes 向会员解释「为什么这些动作不见了」。
   */
  function buildPool(profile, exercises) {
    var list = isArr(exercises) ? exercises : [];
    var eq = equipSetOf(profile);
    var eqAny = Object.keys(eq).length === 0;         /* 没填器械 → 不按器械过滤 */
    var maxRank = LEVEL_MAX_DIFF[String(profile.experience_level)] || 2;
    var stats = { total: list.length, deprecated: 0, no_equip: 0, no_level: 0, hit_limit: 0 };
    var kept = [];

    list.forEach(function (ex) {
      if (!isObj(ex)) return;
      if (ex.deprecated === 'Y') { stats.deprecated++; return; }
      /* 三个条件**独立**计数（一个动作可能同时不达标），这样 notes 里报给会员的数字才是真的 */
      var dropEq = !eqAny && !eq[String(ex.equipment || '').toLowerCase()];
      var dropLv = diffRank(ex.difficulty) > maxRank;
      var dropLim = hitLimitation(ex, profile);
      if (dropEq) stats.no_equip++;
      if (dropLv) stats.no_level++;
      if (dropLim) stats.hit_limit++;
      if (dropEq || dropLv || dropLim) return;
      kept.push(ex);
    });

    /* 按 exercise_id 排序 —— 确定性排序，保证同一输入必然同一输出（禁止 random） */
    kept.sort(function (a, b) {
      return String(a.exercise_id) < String(b.exercise_id) ? -1 : 1;
    });
    return { list: kept, stats: stats, equipAny: eqAny, maxRank: maxRank };
  }

  /* ================================================================ 四、周计划生成（纯函数） */

  /**
   * generatePlan(profile, exercises, weekStart) —— **纯函数**，不写库、不随机、无副作用。
   *
   * @param {object} profile   m_profiles 行（只用 02 §B.2 列出的那 7 个字段）
   * @param {array}  exercises m_exercises 数组（动作库）
   * @param {string} weekStart 'YYYY-MM-DD'，该周的周一（非法时退化为「本周一」，仅用于回传）
   *
   * @returns {{ok:true, week_start, days:[{day_of_week, focus, items:[…]}], week_target_count, notes:[string]}}
   *          或 {{ok:false, reason:'no_candidate', message:'…'}}
   *
   * 为什么拒绝硬凑：过滤后池子为空时产出空计划，会员会看到一个「什么都没有」的周计划而不知所以，
   * 因此按 02 §B.2「不做提示后仍可加」的精神，直接返回 no_candidate 并给出可执行的下一步。
   */
  function generatePlan(profile, exercises, weekStart) {
    profile = isObj(profile) ? profile : {};
    var week = normWeekStart(weekStart);
    var notes = [];

    /* --- 三个数值输入（缺失 → 默认；越界 → 夹住；都做 isFinite 校验） --- */
    var hadDays = !(profile.available_days_per_week === null || profile.available_days_per_week === undefined
      || String(profile.available_days_per_week).trim() === '');
    var N = clampInt(profile.available_days_per_week, DEFAULT_DAYS, 1, 7);
    var M = clampInt(profile.session_minutes, DEFAULT_SESSION_MIN, 15, 180);
    var perDay = clampInt(Math.round(M / 12), 3, 3, 8);

    notes.push(hadDays
      ? ('你每周可练 ' + N + ' 天 → 采用' + splitNameOf(N) + '分化')
      : ('未填写每周可训练天数 → 默认 ' + DEFAULT_DAYS + ' 天，采用' + splitNameOf(N) + '分化'));

    var goals = profile.primary_goal || '';
    var pool = buildPool(profile, exercises);

    /* --- 过滤过程逐条写进 notes，让会员看懂每个决定 --- */
    notes.push('可用器械：' + (pool.equipAny ? '未填写，不作器械限制' : String(profile.available_equipment))
      + ' → 动作库 ' + pool.stats.total + ' 个中保留 ' + pool.list.length + ' 个');
    notes.push('训练基础 ' + (profile.experience_level || '未填写') + ' → 难度上限 '
      + rankName(pool.maxRank) + '（含），已排除 ' + pool.stats.no_level + ' 个难度超标的动作');
    if (limitationTags(profile).length) {
      notes.push('有' + limitationTags(profile).join('、') + ' → 已过滤 '
        + pool.stats.hit_limit + ' 个不适用的动作');
    }
    if (pool.stats.no_equip > 0) {
      notes.push('器械不匹配已排除 ' + pool.stats.no_equip + ' 个动作');
    }
    if (pool.stats.deprecated > 0) notes.push('已跳过 ' + pool.stats.deprecated + ' 个标记停用的动作');

    if (!pool.list.length) {
      return {
        ok: false,
        reason: 'no_candidate',
        message: '按你的器械与身体限制，动作库里没有可用动作。请先放宽限制或扩充动作库。'
      };
    }

    /* --- 每节动作数（02 §B.2：clamp(round(M/12), 3, 8)）与休息默认 90 秒 --- */
    notes.push('单次 ' + M + ' 分钟 → 每节 ' + perDay + ' 个动作（round(' + M + '/12) 夹在 3-8 之间）');
    notes.push('组间休息默认 ' + DEFAULT_REST_SEC + ' 秒（动作库写了参考休息时以参考值为准）');
    if (goals) {
      notes.push('主要目标 ' + goals + ' → 参考次数取' + repPickWord(goals));
    }

    /* --- 按运动模式分桶；桶内游标跨天轮转，保证各天不总是同一批动作 --- */
    var buckets = {};
    pool.list.forEach(function (ex) {
      var p = String(ex.movement_pattern || '');
      if (!buckets[p]) buckets[p] = [];
      buckets[p].push(ex);
    });
    var cursor = {};

    var focuses = SPLIT_BY_N[N] || SPLIT_BY_N[3];
    var weekDays = DAYS_BY_N[N] || DAYS_BY_N[3];
    notes.push('训练日安排在' + weekDays.map(function (d) { return DAY_NAMES[d]; }).join(''));

    var days = [];
    for (var i = 0; i < weekDays.length; i++) {
      var day = weekDays[i];
      var focus = focuses[i] || '全身';
      var patterns = FOCUS_PATTERNS[focus] || FOCUS_PATTERNS['全身'];
      var used = {};
      var picked = [];

      /* 轮转取动作：按 focus 的优先模式顺序逐个取，同一天内 exercise_id 不重复；
         池子不够就少放几个（不硬凑、不重复填充同一个动作） */
      var guard = 0;
      var limit = perDay * (patterns.length + 1) + 8;
      while (picked.length < perDay && guard < limit) {
        guard++;
        var p = patterns[(guard - 1) % patterns.length];
        var ex = takeNext(buckets, cursor, p, used);
        if (ex) { used[ex.exercise_id] = true; picked.push(ex); }
      }

      var items = picked.map(function (ex, k) {
        var ref = parseRefSetsReps(ex.reference_sets_reps, goals);
        return {
          day_of_week: day,
          order_index: k + 1,
          exercise_id: ex.exercise_id,
          exercise_name_snapshot: String(ex.name || ''),
          exercise_version: intOr(ex.version, 1),
          target_sets: ref.sets,
          target_reps: ref.reps,
          target_weight: '',
          target_rest_sec: ref.rest
        };
      });

      if (items.length < perDay) {
        notes.push(DAY_NAMES[day] + '（' + focus + '）可用动作不足 → 实际安排 '
          + items.length + ' 个（目标 ' + perDay + ' 个），没有硬凑');
      }
      days.push({ day_of_week: day, focus: focus, items: items });
    }

    var freq = clampInt(profile.frequency_goal, 0, 0, 7);
    if (freq > 0 && freq !== N) {
      notes.push('你的每周目标次数是 ' + freq + ' 次，本周计划安排了 ' + N + ' 个训练日，可在计划里改');
    }

    return { ok: true, week_start: week, days: days, week_target_count: N, notes: notes };
  }

  /** 从某个运动模式的桶里取下一个「今天还没用过」的动作；取不到返回 null。游标跨天保留。 */
  function takeNext(buckets, cursor, pattern, used) {
    var b = buckets[pattern];
    if (!b || !b.length) return null;
    var start = cursor[pattern] || 0;
    for (var k = 0; k < b.length; k++) {
      var idx = (start + k) % b.length;
      if (!used[b[idx].exercise_id]) {
        cursor[pattern] = (idx + 1) % b.length;
        return b[idx];
      }
    }
    return null;
  }

  function splitNameOf(n) {
    if (n <= 2) return '全身';
    if (n === 3) return '上下肢+全身';
    return '部位';
  }
  function rankName(r) {
    if (r <= 1) return 'beginner';
    if (r === 2) return 'novice';
    if (r === 3) return 'intermediate';
    return 'advanced';
  }
  function repPickWord(goal) {
    if (goal === 'fat_loss') return '区间上限（次数更多）';
    if (goal === 'strength') return '区间下限（次数更少）';
    if (goal === 'muscle_gain') return '区间中位';
    return '区间下限（保守）';
  }

  /** 周起始日归一化：必须是合法日期，并统一取该周的周一 */
  function normWeekStart(v) {
    var s = String(v == null ? '' : v).trim();
    if (!isDateStr(s)) return mondayOf(todayStr());
    return mondayOf(s);
  }

  /* ================================================================ 五、计划侧：只读拦截与归属 */

  /** coach_confirmed='Y' 的统一拒绝返回（02 §B.3 硬性不变式） */
  function readonlyFail() {
    return { ok: false, reason: 'coach_confirmed_readonly', message: READONLY_MSG };
  }

  /**
   * planGuard(store, memberId, planId) —— 所有计划写操作的统一前置：
   *   ① 存在性；② 归属（跨会员）；③ coach_confirmed='Y' → 一律拒绝。
   * 放在同一个入口是为了避免「某个新函数忘了加拦截」这种漏网之鱼。
   */
  function planGuard(store, memberId, planId) {
    var plan = store.find('m_plans', planId);
    if (!plan) return fail('not_found', '未找到该周计划：' + planId);
    if (plan.member_id !== memberId) {
      return fail('not_owner', '数据归属校验失败：该计划属于其他会员');
    }
    if (plan.coach_confirmed === 'Y') return readonlyFail();
    return { ok: true, plan: plan };
  }

  /** 教练来源且未确认的计划被会员改动时，打 member_edited='Y'，source 保持 coach 不变 */
  function editPatch(plan, patch) {
    var out = patch || {};
    if (plan.source === 'coach' && plan.coach_confirmed !== 'Y') out.member_edited = 'Y';
    out.updated_at = nowStr();
    return out;
  }

  /** 计划项改动后，把「会员动过教练建议」这件事回写到父计划上 */
  function touchPlanEdited(store, memberId, plan) {
    if (plan.source !== 'coach') return { ok: true };
    var res = store.update('m_plans', plan.plan_id, { member_edited: 'Y', updated_at: nowStr() }, { actor: memberId });
    return res.ok ? { ok: true } : storeFail(res, 'update_failed');
  }

  /** 该会员某周是否存在「教练已确认」的计划（用于生成/复制时的冲突预检） */
  function findCoachConfirmed(store, memberId, weekStart) {
    var hit = null;
    store.findBy('m_plans', function (r) {
      return r.member_id === memberId && r.week_start === weekStart;
    }).forEach(function (r) {
      if (r.coach_confirmed === 'Y' && !hit) hit = r;
    });
    return hit;
  }

  /** 某计划的全部 items，按 order_index（同序号按 ID）稳定排序 */
  function itemsOfPlan(store, planId) {
    return store.findBy('m_plan_items', function (r) { return r.plan_id === planId; })
      .sort(byOrderThenId);
  }
  function byOrderThenId(a, b) {
    var d = intOr(a.order_index, 0) - intOr(b.order_index, 0);
    if (d !== 0) return d;
    return String(a.plan_item_id) < String(b.plan_item_id) ? -1 : 1;
  }

  /** 某计划某天的 items，按 order_index 排序 */
  function itemsOfDay(store, planId, day) {
    return store.findBy('m_plan_items', function (r) {
      return r.plan_id === planId && intOr(r.day_of_week, 0) === day;
    }).sort(byOrderThenId);
  }

  /** 把某天的 order_index 重写成 1..n 连续（排序后按序赋值） */
  function reindexDay(store, memberId, planId, day) {
    var list = itemsOfDay(store, planId, day);
    for (var i = 0; i < list.length; i++) {
      store.update('m_plan_items', list[i].plan_item_id, { order_index: i + 1 }, { actor: memberId });
    }
    return list;
  }

  /** 把整个背包的 order_index 重写成 1..n 连续 */
  function reindexBag(store, memberId, bagId) {
    var list = itemsOfBag(store, bagId);
    for (var i = 0; i < list.length; i++) {
      store.update('m_bag_items', list[i].bag_item_id, { order_index: i + 1 }, { actor: memberId });
    }
    return list;
  }

  /* ================================================================ 六、计划侧：对外函数 */

  /**
   * createWeekPlan(store, memberId, profile, exercises, opt) —— 生成并落库一周草稿。
   *
   * profile / exercises 可省略（省略时从 store 读取 m_profiles / m_exercises）。
   * opt.week_start   周起始日（缺省本周一；内部统一归一到周一）
   * opt.source       计划来源，默认 'member'
   * opt.note         备注
   *
   * 前置：该周若已存在 coach_confirmed='Y' 的计划 → 拒绝（02 §B.4「该周已有教练安排」）。
   * @returns {{ok:true, plan_id, plan, days, notes} | {ok:false, reason, message}}
   */
  function createWeekPlan(store, memberId, profile, exercises, opt) {
    opt = opt || {};
    if (!memberId) return fail('no_actor', '未指定会员，拒绝写计划');
    var prof = profile || store.find('m_profiles', memberId) || {};
    var exs = exercises || store.all('m_exercises');
    var week = normWeekStart(opt.week_start || opt.weekStart);

    if (findCoachConfirmed(store, memberId, week)) {
      return fail('coach_week_exists', '该周已有教练安排，不能生成会员计划');
    }

    var g = generatePlan(prof, exs, week);
    if (!g.ok) return g;

    var now = opt.now || nowStr();
    var planId = store.nextId('m_plans');
    if (!planId) return fail('id_exhausted', '计划 ID 已用尽');

    var res = store.insert('m_plans', {
      plan_id: planId,
      member_id: memberId,
      week_start: week,
      week_target_count: g.week_target_count,
      source: opt.source || 'member',
      coach_confirmed: 'N',
      coach_confirmed_at: '',
      coach_confirmed_by: '',
      member_edited: 'N',
      status: 'draft',
      note: opt.note ? String(opt.note).slice(0, 300) : '',
      created_at: now,
      updated_at: ''
    }, { actor: memberId });
    if (!res.ok) return storeFail(res, 'insert_failed');

    var inserted = 0;
    for (var i = 0; i < g.days.length; i++) {
      var day = g.days[i];
      for (var k = 0; k < day.items.length; k++) {
        var it = day.items[k];
        var ir = store.insert('m_plan_items', {
          plan_item_id: store.nextId('m_plan_items'),
          plan_id: planId,
          day_of_week: it.day_of_week,
          order_index: it.order_index,
          exercise_id: it.exercise_id,
          exercise_name_snapshot: it.exercise_name_snapshot,
          exercise_version: it.exercise_version,
          target_sets: it.target_sets,
          target_reps: it.target_reps,
          target_weight: '',
          target_rest_sec: it.target_rest_sec,
          note: ''
        }, { actor: memberId });
        if (!ir.ok) return storeFail(ir, 'insert_failed');
        inserted++;
      }
    }

    return { ok: true, plan_id: planId, plan: res.row, days: g.days, notes: g.notes, inserted: inserted };
  }

  /**
   * publishPlan(store, memberId, planId, opt) —— draft → published。
   * 已 published 视为幂等成功（already:true）；archived 拒绝；coach_confirmed='Y' 拒绝。
   */
  function publishPlan(store, memberId, planId, opt) {
    opt = opt || {};
    var g = planGuard(store, memberId, planId);
    if (!g.ok) return g;
    if (g.plan.status === 'published') return { ok: true, plan: g.plan, already: true };
    if (g.plan.status === 'archived') return fail('bad_status', '已归档的计划不能发布');
    var res = store.update('m_plans', planId, editPatch(g.plan, { status: 'published' }), { actor: memberId });
    if (!res.ok) return storeFail(res, 'update_failed');
    return { ok: true, plan: res.row };
  }

  /**
   * getWeekPlan(store, memberId, weekStart, opt) —— 取某周计划（含 items）。
   *
   * 教练计划与会员计划**并存**，不互相覆盖（02 §B.3），因此返回的是列表而不是单条：
   * @returns {{ok:true, week_start, plans:[{plan, items}], coach_plan, member_plan, conflict:boolean}}
   *   conflict = 同一周同时存在 coach 与 member 计划（交给上层 UI 提示「可自由选择其中一个执行」）。
   */
  function getWeekPlan(store, memberId, weekStart, opt) {
    opt = opt || {};
    if (!memberId) return fail('no_actor', '未指定会员，拒绝读计划');
    var week = normWeekStart(weekStart);
    var rows = store.findBy('m_plans', function (r) {
      return r.member_id === memberId && r.week_start === week;
    }).sort(function (a, b) { return String(a.plan_id) < String(b.plan_id) ? -1 : 1; });

    var plans = rows.map(function (p) {
      return { plan: p, items: itemsOfPlan(store, p.plan_id) };
    });
    var coach = null, member = null;
    rows.forEach(function (p) {
      if (p.source === 'coach') { if (!coach) coach = p; }
      else if (!member) member = p;
    });
    return {
      ok: true, week_start: week, plans: plans,
      coach_plan: coach, member_plan: member,
      conflict: !!(coach && member)
    };
  }

  /**
   * updatePlanMeta(store, memberId, planId, patch, opt) —— 只改周目标次数与备注。
   * patch.week_target_count 必须是 1-7 的有限整数；patch.note ≤300 字。其余字段一律不收，
   * 避免调用方误把 plan 的其它字段（source / coach_confirmed）改掉。
   */
  function updatePlanMeta(store, memberId, planId, patch, opt) {
    opt = opt || {};
    var g = planGuard(store, memberId, planId);
    if (!g.ok) return g;
    patch = patch || {};
    var out = {};

    if (patch.week_target_count !== undefined && patch.week_target_count !== null
      && String(patch.week_target_count).trim() !== '') {
      var sane = numSane(patch.week_target_count, '本周目标次数');
      if (!sane.ok) return sane;
      var n = clampInt(patch.week_target_count, 0, 0, 7);
      if (n < 1) return fail('bad_range', '本周目标次数必须在 1-7 之间');
      out.week_target_count = n;
    }
    if (patch.note !== undefined) out.note = String(patch.note).slice(0, 300);
    if (!Object.keys(out).length) return fail('nothing_to_update', '没有可更新的字段（只支持 week_target_count / note）');

    var before = String(g.plan.week_target_count || '');
    var res = store.update('m_plans', planId, editPatch(g.plan, out), { actor: memberId });
    if (!res.ok) return storeFail(res, 'update_failed');

    if (out.week_target_count !== undefined) {
      logAdjustment(store, memberId, {
        target_type: 'plan', target_id: planId, adjust_type: 'frequency',
        before_value: before, after_value: String(out.week_target_count),
        reason_code: 'member_edit', reason_text: '会员自行调整本周目标次数'
      }, opt);
    }
    return { ok: true, plan: res.row };
  }

  /**
   * addPlanItem(store, memberId, planId, input, opt) —— 往某天追加一个动作。
   * input.day_of_week 1-7（必填）；input.exercise_id 必填（或直接给 input.exercise 对象）；
   * input.target_sets/target_reps/target_weight/target_rest_sec 可给，缺失时按动作库参考值兜底。
   * opt.order_index 可指定插入位置（缺省追加到当天末尾），写入后当天 order_index 重排为 1..n。
   */
  function addPlanItem(store, memberId, planId, input, opt) {
    opt = opt || {};
    input = input || {};
    var g = planGuard(store, memberId, planId);
    if (!g.ok) return g;

    /* 星期几**严格校验**而不是夹取：夹取会把「周日」静默变成「周日」之外的某天，
       会员会发现动作出现在错误的日期里却不知道为什么，因此越界一律明确拒绝。 */
    var day = strictDay(input.day_of_week);
    if (!day) return fail('bad_day', 'day_of_week 必须是 1-7（1=周一）');

    var ex = resolveExercise(store, input);
    if (!ex.ok) return ex;

    var sane = numSane(input.target_weight, '目标重量');
    if (!sane.ok) return sane;

    var ref = parseRefSetsReps(ex.exercise.reference_sets_reps, '');
    var list = itemsOfDay(store, planId, day);
    var pos = clampInt(opt.order_index, list.length + 1, 1, 99);
    if (pos > list.length + 1) pos = list.length + 1;

    var res = store.insert('m_plan_items', {
      plan_item_id: store.nextId('m_plan_items'),
      plan_id: planId,
      day_of_week: day,
      order_index: pos,
      exercise_id: ex.exercise.exercise_id,
      exercise_name_snapshot: ex.exercise.name,
      exercise_version: intOr(ex.exercise.version, 1),
      target_sets: clampInt(input.target_sets, ref.sets, 1, 20),
      target_reps: clampInt(input.target_reps, ref.reps, 1, 999),
      target_weight: weightValue(input.target_weight),
      target_rest_sec: clampInt(input.target_rest_sec, ref.rest, 0, 600),
      note: input.note ? String(input.note).slice(0, 200) : ''
    }, { actor: memberId });
    if (!res.ok) return storeFail(res, 'insert_failed');

    reindexDay(store, memberId, planId, day);
    touchPlanEdited(store, memberId, g.plan);
    return { ok: true, plan_item_id: res.row.plan_item_id, item: res.row };
  }

  /** removePlanItem(store, memberId, planItemId, opt) —— 真删一条计划项，并把当天序号重排连续 */
  function removePlanItem(store, memberId, planItemId, opt) {
    opt = opt || {};
    var item = store.find('m_plan_items', planItemId);
    if (!item) return fail('not_found', '未找到该计划项：' + planItemId);
    var g = planGuard(store, memberId, item.plan_id);
    if (!g.ok) return g;
    var day = intOr(item.day_of_week, 0);

    var res = store.remove('m_plan_items', planItemId, { actor: memberId });
    if (!res.ok) return storeFail(res, 'remove_failed');

    reindexDay(store, memberId, item.plan_id, day);
    touchPlanEdited(store, memberId, g.plan);
    logAdjustment(store, memberId, {
      target_type: 'plan_item', target_id: planItemId, adjust_type: 'exercise_swap',
      before_value: item.exercise_name_snapshot || '', after_value: '',
      reason_code: 'member_edit', reason_text: '会员从周计划中移除动作'
    }, opt);
    return { ok: true, removed: 1 };
  }

  /**
   * movePlanItem(store, memberId, planItemId, dir, opt) —— 同一天内的排序。
   * dir: 'up' 上移 | 'down' 下移 | 'top' 置顶。到头了返回 already_first / already_last（不是报错）。
   * 操作后立刻把当天所有受影响项的 order_index 重写为 1..n 连续。
   */
  function movePlanItem(store, memberId, planItemId, dir, opt) {
    opt = opt || {};
    var item = store.find('m_plan_items', planItemId);
    if (!item) return fail('not_found', '未找到该计划项：' + planItemId);
    var g = planGuard(store, memberId, item.plan_id);
    if (!g.ok) return g;

    var day = intOr(item.day_of_week, 0);
    var list = itemsOfDay(store, item.plan_id, day);
    var idx = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].plan_item_id === planItemId) idx = i; }
    if (idx < 0) return fail('not_found', '该计划项不在当天的排序列表里');

    var moved = reorder(list, idx, dir);
    if (!moved.ok) return moved;

    /* 先按新顺序落库，再统一重排为 1..n（避免中间态出现空洞或重复序号） */
    for (var k = 0; k < moved.list.length; k++) {
      store.update('m_plan_items', moved.list[k].plan_item_id, { order_index: k + 1 }, { actor: memberId });
    }
    reindexDay(store, memberId, item.plan_id, day);
    touchPlanEdited(store, memberId, g.plan);
    return { ok: true, order: moved.list.map(function (r) { return r.plan_item_id; }) };
  }

  /**
   * updatePlanItem(store, memberId, planItemId, patch, opt) —— 改组数/次数/重量/休息/备注。
   * 只收这 5 个字段（其它字段如 exercise_id 请走替换流程，避免快照与动作对不上）。
   * 数值做 isFinite 校验；重量为负直接拒绝。
   */
  function updatePlanItem(store, memberId, planItemId, patch, opt) {
    opt = opt || {};
    var item = store.find('m_plan_items', planItemId);
    if (!item) return fail('not_found', '未找到该计划项：' + planItemId);
    var g = planGuard(store, memberId, item.plan_id);
    if (!g.ok) return g;
    patch = patch || {};

    var out = {};
    var fields = ['target_sets', 'target_reps', 'target_weight', 'target_rest_sec', 'note'];
    var limits = { target_sets: [1, 20], target_reps: [1, 999], target_rest_sec: [0, 600] };
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (patch[f] === undefined) continue;
      if (f === 'note') { out.note = String(patch[f]).slice(0, 200); continue; }
      var sane = numSane(patch[f], f);
      if (!sane.ok) return sane;
      if (f === 'target_weight') {
        var w = numOr(patch[f], null);
        if (w !== null && w < 0) return fail('bad_range', '目标重量不能为负数');
        out.target_weight = (w === null ? '' : w);
      } else {
        var cur = intOr(item[f], limits[f][0]);
        out[f] = clampInt(patch[f], cur, limits[f][0], limits[f][1]);
      }
    }
    if (!Object.keys(out).length) return fail('nothing_to_update', '没有可更新的字段');

    var res = store.update('m_plan_items', planItemId, out, { actor: memberId });
    if (!res.ok) return storeFail(res, 'update_failed');

    logAdjustment(store, memberId, {
      target_type: 'plan_item', target_id: planItemId,
      adjust_type: (out.target_weight !== undefined ? 'intensity' : 'volume'),
      before_value: describeTargets(item), after_value: describeTargets(res.row),
      reason_code: 'member_edit', reason_text: '会员自行调整计划动作的目标值'
    }, opt);
    touchPlanEdited(store, memberId, g.plan);
    return { ok: true, item: res.row };
  }

  function describeTargets(r) {
    return (r.target_sets || '') + '组×' + (r.target_reps || '') + '次 ' + (r.target_weight || '') + 'kg';
  }

  /**
   * copyPlan(store, memberId, fromPlanId, targetWeekStart, opt) —— 复制上周/指定计划 → 新草稿。
   * 新计划 source='member'、status='draft'，week_target_count 继承；items 深拷贝（新 ID、新快照）。
   * 目标周已存在 coach_confirmed='Y' 的计划 → 拒绝并提示「该周已有教练安排」。
   * 注意：源计划是 coach_confirmed='Y' 时**允许**复制（对源只读，产物是新的会员草稿）。
   */
  function copyPlan(store, memberId, fromPlanId, targetWeekStart, opt) {
    opt = opt || {};
    if (!memberId) return fail('no_actor', '未指定会员，拒绝写计划');
    var src = store.find('m_plans', fromPlanId);
    if (!src) return fail('not_found', '未找到来源计划：' + fromPlanId);
    if (src.member_id !== memberId) return fail('not_owner', '数据归属校验失败：该计划属于其他会员');

    var week = normWeekStart(targetWeekStart);
    if (findCoachConfirmed(store, memberId, week)) {
      return fail('coach_week_exists', '该周已有教练安排，不能把计划复制到这一周');
    }

    var now = opt.now || nowStr();
    var newId = store.nextId('m_plans');
    if (!newId) return fail('id_exhausted', '计划 ID 已用尽');

    var res = store.insert('m_plans', {
      plan_id: newId,
      member_id: memberId,
      week_start: week,
      week_target_count: intOr(src.week_target_count, DEFAULT_DAYS),
      source: 'member',
      coach_confirmed: 'N',
      coach_confirmed_at: '',
      coach_confirmed_by: '',
      member_edited: 'N',
      status: 'draft',
      note: opt.note !== undefined ? String(opt.note).slice(0, 300) : String(src.note || ''),
      created_at: now,
      updated_at: ''
    }, { actor: memberId });
    if (!res.ok) return storeFail(res, 'insert_failed');

    var n = 0;
    itemsOfPlan(store, fromPlanId).forEach(function (it) {
      var ir = store.insert('m_plan_items', {
        plan_item_id: store.nextId('m_plan_items'),
        plan_id: newId,
        day_of_week: intOr(it.day_of_week, 1),
        order_index: intOr(it.order_index, n + 1),
        exercise_id: it.exercise_id,
        exercise_name_snapshot: it.exercise_name_snapshot,
        exercise_version: intOr(it.exercise_version, 1),
        target_sets: intOr(it.target_sets, DEFAULT_SETS),
        target_reps: intOr(it.target_reps, DEFAULT_REPS),
        target_weight: it.target_weight === undefined || it.target_weight === null ? '' : it.target_weight,
        target_rest_sec: clampInt(it.target_rest_sec, DEFAULT_REST_SEC, 0, 600),
        note: it.note || ''
      }, { actor: memberId });
      if (ir.ok) n++;
    });

    return { ok: true, plan_id: newId, plan: res.row, copied: n };
  }

  /**
   * deletePlan(store, memberId, planId, opt) —— 删除计划及其全部 items。
   * 判定（02 §B.3 优先）：
   *   coach_confirmed='Y'                      → coach_confirmed_readonly（永不放行）
   *   status='draft' / 'archived'              → 直接删
   *   status='published' 且 opt.archive!==true → need_archive（先归档再删，防止误删正在执行的计划）
   *   status='published' 且 opt.archive===true → 置为 archived 后删除
   */
  function deletePlan(store, memberId, planId, opt) {
    opt = opt || {};
    var plan = store.find('m_plans', planId);
    if (!plan) return fail('not_found', '未找到该周计划：' + planId);
    if (plan.member_id !== memberId) return fail('not_owner', '数据归属校验失败：该计划属于其他会员');
    if (plan.coach_confirmed === 'Y') return readonlyFail();

    if (plan.status === 'published' && opt.archive !== true) {
      return fail('need_archive', '已发布的计划需先归档：请传 opt.archive=true 后再删除');
    }
    if (plan.status === 'published') {
      var ar = store.update('m_plans', planId, { status: 'archived', updated_at: nowStr() }, { actor: memberId });
      if (!ar.ok) return storeFail(ar, 'update_failed');
    }

    var items = itemsOfPlan(store, planId);
    items.forEach(function (it) { store.remove('m_plan_items', it.plan_item_id, { actor: memberId }); });
    var res = store.remove('m_plans', planId, { actor: memberId });
    if (!res.ok) return storeFail(res, 'remove_failed');
    return { ok: true, removed_items: items.length };
  }

  /** dayItems(store, memberId, planId, dayOfWeek, opt) —— 取某天（1-7）的 items，按 order_index 排序 */
  function dayItems(store, memberId, planId, dayOfWeek, opt) {
    opt = opt || {};
    var plan = store.find('m_plans', planId);
    if (!plan) return fail('not_found', '未找到该周计划：' + planId);
    if (plan.member_id !== memberId) return fail('not_owner', '数据归属校验失败：该计划属于其他会员');
    var day = strictDay(dayOfWeek);
    if (!day) return fail('bad_day', 'day_of_week 必须是 1-7（1=周一）');
    return { ok: true, day_of_week: day, items: itemsOfDay(store, planId, day) };
  }

  /* ================================================================ 七、背包侧：内部工具 */

  /** 某背包的全部 items，按 order_index（同序号按 ID）稳定排序 */
  function itemsOfBag(store, bagId) {
    return store.findBy('m_bag_items', function (r) { return r.bag_id === bagId; })
      .sort(byOrderThenId);
  }

  /**
   * bagGuard(store, memberId, bagId) —— 背包写操作前置：存在性 / 归属 / 状态。
   * status='confirmed' 的背包已经把内容写进会话快照（02 §D.5），再改就不会影响进行中的训练，
   * 只會造成「背包与快照不一致」的误解，因此拒绝修改。
   */
  function bagGuard(store, memberId, bagId) {
    var bag = store.find('m_bags', bagId);
    if (!bag) return fail('not_found', '未找到该背包：' + bagId);
    if (bag.member_id !== memberId) return fail('not_owner', '数据归属校验失败：该背包属于其他会员');
    if (bag.status === 'confirmed') return fail('bag_confirmed', '背包已确认并开始训练，不能再修改');
    if (bag.status === 'discarded') return fail('bag_discarded', '背包已丢弃，不能修改');
    return { ok: true, bag: bag };
  }

  /** 解析动作：优先按 exercise_id 从动作库取（保证快照来自库），input.exercise 作为兜底 */
  function resolveExercise(store, input) {
    var id = String(input.exercise_id || (input.exercise && input.exercise.exercise_id) || '').trim();
    if (!id) return fail('missing_exercise', '缺少 exercise_id');
    var ex = store.find('m_exercises', id);
    if (!ex && isObj(input.exercise) && input.exercise.exercise_id === id) ex = input.exercise;
    if (!ex) return fail('exercise_not_found', '动作库中不存在该动作：' + id);
    return { ok: true, exercise: ex };
  }

  /** 重量值：空 → ''（未设定）；负数已在调用方拒绝 */
  function weightValue(v) {
    var w = numOr(v, null);
    return (w === null ? '' : w);
  }

  /** 把背包/计划项的目标值规范化成可插入的形态（缺项用参考值兜底） */
  function bagItemTargets(store, ex, input) {
    var ref = parseRefSetsReps(ex.reference_sets_reps, '');
    return {
      target_sets: clampInt(input.target_sets, ref.sets, 1, 20),
      target_reps: clampInt(input.target_reps, ref.reps, 1, 999),
      target_weight: weightValue(input.target_weight),
      target_rest_sec: clampInt(input.target_rest_sec, ref.rest, 0, 600)
    };
  }

  /** 通用重排：把 idx 处的元素按 dir 移动，返回新顺序数组 */
  function reorder(list, idx, dir) {
    var arr = list.slice();
    if (dir === 'up') {
      if (idx <= 0) return { ok: false, reason: 'already_first', message: '已经是第一个了' };
      var t = arr[idx - 1]; arr[idx - 1] = arr[idx]; arr[idx] = t;
    } else if (dir === 'down') {
      if (idx >= arr.length - 1) return { ok: false, reason: 'already_last', message: '已经是最后一个了' };
      var t2 = arr[idx + 1]; arr[idx + 1] = arr[idx]; arr[idx] = t2;
    } else if (dir === 'top') {
      if (idx <= 0) return { ok: false, reason: 'already_first', message: '已经是第一个了' };
      var m = arr.splice(idx, 1)[0];
      arr.unshift(m);
    } else {
      return { ok: false, reason: 'bad_dir', message: 'dir 只能是 up / down / top' };
    }
    return { ok: true, list: arr };
  }

  /* ================================================================ 八、背包侧：对外函数 */

  /**
   * getTodayBag(store, memberId, opt) —— 取今日背包；没有则新建（02 §D.1：一天最多一个 draft）。
   * opt.today   指定日期（缺省今天），'YYYY-MM-DD'
   * opt.create  缺省 true；传 false 时若不存在返回 {ok:false, reason:'not_found'}（只读探测）
   *
   * 为什么「一天最多一个」：背包是**尚未成为事实的意图**，重复建会让会员自己都分不清该练哪个。
   * 已 confirmed 的历史背包不阻止新建草稿（当天练完仍可再准备），但 confirmed 背包本身不可改。
   */
  function getTodayBag(store, memberId, opt) {
    opt = opt || {};
    if (!memberId) return fail('no_actor', '未指定会员，拒绝读写背包');
    var day = opt.today && isDateStr(opt.today) ? opt.today : todayStr();

    var found = null;
    store.findBy('m_bags', function (r) {
      return r.member_id === memberId && r.kind === 'today' && r.plan_date === day && r.status === 'draft';
    }).forEach(function (r) { if (!found) found = r; });

    if (found) return { ok: true, bag: found, items: itemsOfBag(store, found.bag_id), created: false };
    if (opt.create === false) return fail('not_found', '今天还没有背包');

    var bagId = store.nextId('m_bags');
    if (!bagId) return fail('id_exhausted', '背包 ID 已用尽');
    var res = store.insert('m_bags', {
      bag_id: bagId,
      member_id: memberId,
      kind: 'today',
      name: '',
      plan_date: day,
      source_plan_id: '',
      source_session_id: '',
      status: 'draft',
      last_used_at: '',
      created_at: opt.now || nowStr(),
      updated_at: ''
    }, { actor: memberId });
    if (!res.ok) return storeFail(res, 'insert_failed');
    return { ok: true, bag: res.row, items: [], created: true };
  }

  /**
   * addToBag(store, memberId, bagId, input, opt) —— 往背包加一个动作。
   * input.source 必须是 library / plan / template / history 之一（02 §D.2），缺省 'library'。
   * 加入时**必须**把动作名与版本写进快照字段，这是「改动作库不影响历史背包」的关键。
   *
   * 红线提醒：命中身体限制时这里**只提示不拦截**（warnings），因为会员是主动添加；
   * 系统不得代替会员决定删什么加什么（02 §D.3）。只有「替换」场景才是硬拦截（见 replaceBagItem）。
   */
  function addToBag(store, memberId, bagId, input, opt) {
    opt = opt || {};
    input = input || {};
    var g = bagGuard(store, memberId, bagId);
    if (!g.ok) return g;

    var src = String(input.source || 'library');
    if (['library', 'plan', 'template', 'history'].indexOf(src) < 0) {
      return fail('bad_source', 'source 只能是 library / plan / template / history');
    }
    var ex = resolveExercise(store, input);
    if (!ex.ok) return ex;
    var sane = numSane(input.target_weight, '目标重量');
    if (!sane.ok) return sane;

    var t = bagItemTargets(store, ex.exercise, input);
    var list = itemsOfBag(store, bagId);
    var res = store.insert('m_bag_items', {
      bag_item_id: store.nextId('m_bag_items'),
      bag_id: bagId,
      order_index: list.length + 1,
      exercise_id: ex.exercise.exercise_id,
      exercise_name_snapshot: String(ex.exercise.name || ''),
      exercise_version: intOr(ex.exercise.version, 1),
      source: src,
      replaced_from_id: '',
      target_sets: t.target_sets,
      target_reps: t.target_reps,
      target_weight: t.target_weight,
      target_rest_sec: t.target_rest_sec,
      note: input.note ? String(input.note).slice(0, 200) : ''
    }, { actor: memberId });
    if (!res.ok) return storeFail(res, 'insert_failed');

    store.update('m_bags', bagId, { updated_at: nowStr() }, { actor: memberId });

    var warnings = [];
    if (opt.profile && hitLimitation(ex.exercise, opt.profile)) {
      warnings.push('该动作的适用限制与你填写的身体限制重合，请量力而行（系统不会替你移除）');
    }
    return { ok: true, bag_item_id: res.row.bag_item_id, item: res.row, warnings: warnings };
  }

  /**
   * removeFromBag(store, memberId, bagItemId, opt) —— 硬删除一条背包项（02 §D.3 允许真删）。
   * 背包是意图、尚未成为事实，所以不需要留痕撤销；删除后立刻把 order_index 重排为 1..n。
   * 调用方（UI）负责二次确认「删除这个动作？」，本模块只负责执行。
   */
  function removeFromBag(store, memberId, bagItemId, opt) {
    opt = opt || {};
    var item = store.find('m_bag_items', bagItemId);
    if (!item) return fail('not_found', '未找到该背包项：' + bagItemId);
    var g = bagGuard(store, memberId, item.bag_id);
    if (!g.ok) return g;

    var res = store.remove('m_bag_items', bagItemId, { actor: memberId });
    if (!res.ok) return storeFail(res, 'remove_failed');

    reindexBag(store, memberId, item.bag_id);
    store.update('m_bags', item.bag_id, { updated_at: nowStr() }, { actor: memberId });
    return { ok: true, removed: 1, order: itemsOfBag(store, item.bag_id).map(function (r) { return r.bag_item_id; }) };
  }

  /**
   * moveBagItem(store, memberId, bagItemId, dir, opt) —— 上移 / 下移 / 置顶。
   * 不引入拖拽库，用 order_index 表达顺序；操作后立刻把全部受影响项的 order_index 写回 1..n 连续。
   */
  function moveBagItem(store, memberId, bagItemId, dir, opt) {
    opt = opt || {};
    var item = store.find('m_bag_items', bagItemId);
    if (!item) return fail('not_found', '未找到该背包项：' + bagItemId);
    var g = bagGuard(store, memberId, item.bag_id);
    if (!g.ok) return g;

    var list = itemsOfBag(store, item.bag_id);
    var idx = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].bag_item_id === bagItemId) idx = i; }
    if (idx < 0) return fail('not_found', '该背包项不在排序列表里');

    var moved = reorder(list, idx, dir);
    if (!moved.ok) return moved;

    for (var k = 0; k < moved.list.length; k++) {
      store.update('m_bag_items', moved.list[k].bag_item_id, { order_index: k + 1 }, { actor: memberId });
    }
    reindexBag(store, memberId, item.bag_id);
    store.update('m_bags', item.bag_id, { updated_at: nowStr() }, { actor: memberId });
    return { ok: true, order: moved.list.map(function (r) { return r.bag_item_id; }) };
  }

  /**
   * updateBagItem(store, memberId, bagItemId, patch, opt) —— 改组数/次数/重量/休息/备注。
   * 只收这 5 个字段：换动作必须走 replaceBagItem（因为要写 replaced_from_id 并做差异确认）。
   */
  function updateBagItem(store, memberId, bagItemId, patch, opt) {
    opt = opt || {};
    var item = store.find('m_bag_items', bagItemId);
    if (!item) return fail('not_found', '未找到该背包项：' + bagItemId);
    var g = bagGuard(store, memberId, item.bag_id);
    if (!g.ok) return g;
    patch = patch || {};

    var out = {};
    var fields = ['target_sets', 'target_reps', 'target_weight', 'target_rest_sec', 'note'];
    var limits = { target_sets: [1, 20], target_reps: [1, 999], target_rest_sec: [0, 600] };
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (patch[f] === undefined) continue;
      if (f === 'note') { out.note = String(patch[f]).slice(0, 200); continue; }
      var sane = numSane(patch[f], f);
      if (!sane.ok) return sane;
      if (f === 'target_weight') {
        var w = numOr(patch[f], null);
        if (w !== null && w < 0) return fail('bad_range', '目标重量不能为负数');
        out.target_weight = (w === null ? '' : w);
      } else {
        var cur = intOr(item[f], limits[f][0]);
        out[f] = clampInt(patch[f], cur, limits[f][0], limits[f][1]);
      }
    }
    if (!Object.keys(out).length) return fail('nothing_to_update', '没有可更新的字段');

    var res = store.update('m_bag_items', bagItemId, out, { actor: memberId });
    if (!res.ok) return storeFail(res, 'update_failed');
    store.update('m_bags', item.bag_id, { updated_at: nowStr() }, { actor: memberId });
    return { ok: true, item: res.row };
  }

  /* ---------------------------------------------------------------- 替换：差异预览（纯函数） */

  /**
   * replacePreview(bagItem, newExercise, memberProfile) —— **纯函数**，替换的差异分析（02 §D.4）。
   *
   * @param {object} bagItem        当前背包项（A）
   * @param {object} newExercise    拟替换成的动作（B，m_exercises 行或同构对象）
   * @param {object} memberProfile  会员档案（用于判断 B 的 contraindications 是否命中 limitations）
   *
   * @returns {{
   *   ok:boolean, muscleChange:boolean, equipmentChange:boolean,
   *   difficultyGap:int, loadChangePct:number, contraindicationHit:boolean,
   *   reasons:[{level:'info'|'warn'|'block', text:string, severity?:'high'}],
   *   confirmLabel:string, before:object, after:object
   * }}
   *
   * 说明：
   *   - 规格原文里写过一个 musceChange（疑似 muscle 的笔误）。保留两个键只会让上层取错，
   *     因此这里只输出语义正确的 muscleChange，历史键不再提供。
   *   - 计划负荷 = 组数 × 次数 × 重量；自重（重量为空/0）按 1 个单位计，保证除法有意义。
   *     「之前」取背包项当前目标值，「之后」沿用当前重量、按 B 的参考组数次数换算。
   *   - contraindicationHit 是**拦截**信号，不是提示：命中即禁止替换。
   *   - 本函数不写库、不产生副作用，只负责把差异讲清楚，执行与否交给会员。
   */
  function replacePreview(bagItem, newExercise, memberProfile) {
    var a = isObj(bagItem) ? bagItem : {};
    var b = isObj(newExercise) ? newExercise : {};
    var profile = isObj(memberProfile) ? memberProfile : {};
    var reasons = [];

    /* 背包项本身只存快照（名称/版本），器械、难度、肌群要从原动作身上取：
       调用方可以把原动作对象挂在 bagItem.exercise 上（replaceBagItem 内部就是这样做的）。
       取不到时按「未知」处理：不臆造差异，避免对会员误报橙色/红色标记。 */
    var aSrc = isObj(a.exercise) ? a.exercise : a;

    var aMuscles = splitTags(aSrc.primary_muscles);
    var bMuscles = splitTags(b.primary_muscles);
    var overlap = 0;
    bMuscles.forEach(function (m) { if (aMuscles.indexOf(m) >= 0) overlap++; });

    var muscleChange = false;
    if (aMuscles.length && bMuscles.length) {
      muscleChange = (overlap < bMuscles.length || overlap < aMuscles.length);
    }

    var aEquip = aSrc.equipment === undefined || aSrc.equipment === null ? null : String(aSrc.equipment);
    var bEquip = b.equipment === undefined || b.equipment === null ? null : String(b.equipment);
    var equipmentChange = !!(aEquip && bEquip && aEquip !== bEquip);

    var aDiff = aSrc.difficulty === undefined || aSrc.difficulty === null ? null : String(aSrc.difficulty);
    var bDiff = b.difficulty === undefined || b.difficulty === null ? null : String(b.difficulty);
    var difficultyGap = (aDiff && bDiff) ? Math.abs(diffRank(bDiff) - diffRank(aDiff)) : 0;

    var beforeLoad = loadOf(intOr(a.target_sets, 0), intOr(a.target_reps, 0), numOr(a.target_weight, 0));
    var ref = parseRefSetsReps(b.reference_sets_reps, '');
    var afterLoad = loadOf(ref.sets, ref.reps, numOr(a.target_weight, 0));
    var loadChangePct = 0;
    if (beforeLoad > 0) loadChangePct = Math.round(((afterLoad - beforeLoad) / beforeLoad) * 1000) / 10;
    else if (afterLoad > 0) loadChangePct = 100;

    var contraindicationHit = hitLimitation(b, profile);

    if (equipmentChange) {
      reasons.push({
        level: 'warn',
        text: '需要不同器械：' + aEquip + ' → ' + bEquip
      });
    }
    if (difficultyGap >= 2) {
      reasons.push({
        level: 'warn', severity: 'high',
        text: '难度变化较大：' + aDiff + ' → ' + bDiff + '（相差 ' + difficultyGap + ' 档）'
      });
    }
    if (muscleChange) {
      reasons.push({
        level: overlap === 0 ? 'warn' : 'info',
        text: '目标肌群改变：' + (aMuscles.join('、') || '未知') + ' → ' + (bMuscles.join('、') || '未知')
      });
    }
    if (Math.abs(loadChangePct) > 25) {
      reasons.push({
        level: 'warn',
        text: '训练负荷变化明显：' + (loadChangePct > 0 ? '+' : '') + loadChangePct + '%（'
          + beforeLoad + ' → ' + afterLoad + '）'
      });
    }
    if (contraindicationHit) {
      reasons.push({
        level: 'block',
        text: '该动作与你的身体限制冲突（' + (b.contraindications || '') + '），不能替换'
      });
    }

    var hasWarn = false;
    reasons.forEach(function (r) { if (r.level === 'warn' || r.level === 'block') hasWarn = true; });

    return {
      ok: !contraindicationHit,
      muscleChange: muscleChange,
      equipmentChange: equipmentChange,
      difficultyGap: difficultyGap,
      loadChangePct: loadChangePct,
      contraindicationHit: contraindicationHit,
      reasons: reasons,
      confirmLabel: hasWarn ? '我确认仍要替换' : '替换为这个动作',
      before: { exercise_id: a.exercise_id, name: a.exercise_name_snapshot, load: beforeLoad },
      after: { exercise_id: b.exercise_id, name: b.name, load: afterLoad }
    };
  }

  /** 计划负荷 = 组数 × 次数 × 重量（自重按 1 个单位计，避免出现 0 导致百分比无意义） */
  function loadOf(sets, reps, weight) {
    var w = numOr(weight, 0);
    if (!w || w <= 0) w = 1;
    return intOr(sets, 0) * intOr(reps, 0) * w;
  }

  /**
   * replaceBagItem(store, memberId, bagItemId, newExerciseId, opt) —— 执行替换（两阶段中的第二阶段）。
   *
   * 两阶段约定（对应 02 §D.3「生成替换预览 → 会员确认 → 换」）：
   *   ① 上层先调 replacePreview 拿到差异，把 reasons 展示给会员；
   *   ② 会员点确认后再调本函数，并传 opt.confirmed=true。
   * 硬保证：**只要存在 warn 级差异且 opt.confirmed!==true，就绝不改库**（返回 need_confirm + preview）。
   *
   * opt.profile   会员档案（缺失时从 m_profiles 读）；用于禁忌命中判定
   * opt.confirmed 存在 warn 时必须为 true
   * opt.target_sets / target_reps / target_weight / target_rest_sec 可选：确认时一并改目标值；
   *                不传则沿用原目标值（系统不自动换算负荷，改不改由会员决定）
   *
   * 成功后写 replaced_from_id = 原 exercise_id，并刷新名称与版本快照。
   */
  function replaceBagItem(store, memberId, bagItemId, newExerciseId, opt) {
    opt = opt || {};
    var item = store.find('m_bag_items', bagItemId);
    if (!item) return fail('not_found', '未找到该背包项：' + bagItemId);
    var g = bagGuard(store, memberId, item.bag_id);
    if (!g.ok) return g;

    var ex = resolveExercise(store, { exercise_id: newExerciseId });
    if (!ex.ok) return ex;
    if (ex.exercise.exercise_id === item.exercise_id) {
      return fail('same_exercise', '新动作与当前动作相同，无需替换');
    }

    var profile = opt.profile || store.find('m_profiles', memberId) || {};
    /* 把原动作对象挂到背包项副本上，让差异预览能比到器械/难度/肌群（背包项本身只存名称版本快照） */
    var oldEx = store.find('m_exercises', item.exercise_id);
    var view = Object.assign({}, item);
    if (oldEx) view.exercise = oldEx;
    var pv = replacePreview(view, ex.exercise, profile);

    /* 禁忌命中 = 拦截，不是提示（02 §D.4 最后一行） */
    if (pv.contraindicationHit) {
      return {
        ok: false, reason: 'contraindication_blocked',
        message: '该动作与你的身体限制冲突，不能替换', preview: pv
      };
    }

    var hasWarn = false;
    pv.reasons.forEach(function (r) { if (r.level === 'warn' || r.level === 'block') hasWarn = true; });
    if (hasWarn && opt.confirmed !== true) {
      return {
        ok: false, reason: 'need_confirm',
        message: '替换存在需要你确认的差异，确认后再执行', preview: pv
      };
    }

    var patch = {
      exercise_id: ex.exercise.exercise_id,
      exercise_name_snapshot: String(ex.exercise.name || ''),
      exercise_version: intOr(ex.exercise.version, 1),
      replaced_from_id: item.exercise_id
    };
    if (opt.target_sets !== undefined || opt.target_reps !== undefined
      || opt.target_rest_sec !== undefined || opt.target_weight !== undefined) {
      var sane = numSane(opt.target_weight, '目标重量');
      if (!sane.ok) return sane;
      if (opt.target_sets !== undefined) patch.target_sets = clampInt(opt.target_sets, intOr(item.target_sets, DEFAULT_SETS), 1, 20);
      if (opt.target_reps !== undefined) patch.target_reps = clampInt(opt.target_reps, intOr(item.target_reps, DEFAULT_REPS), 1, 999);
      if (opt.target_rest_sec !== undefined) patch.target_rest_sec = clampInt(opt.target_rest_sec, intOr(item.target_rest_sec, DEFAULT_REST_SEC), 0, 600);
      if (opt.target_weight !== undefined) {
        var w = numOr(opt.target_weight, null);
        if (w !== null && w < 0) return fail('bad_range', '目标重量不能为负数');
        patch.target_weight = (w === null ? '' : w);
      }
    }

    var res = store.update('m_bag_items', bagItemId, patch, { actor: memberId });
    if (!res.ok) return storeFail(res, 'update_failed');
    store.update('m_bags', item.bag_id, { updated_at: nowStr() }, { actor: memberId });

    logAdjustment(store, memberId, {
      target_type: 'plan_item', target_id: bagItemId, adjust_type: 'exercise_swap',
      before_value: item.exercise_name_snapshot || '',
      after_value: ex.exercise.name || '',
      reason_code: 'member_edit', reason_text: '会员替换背包动作（差异已确认）'
    }, opt);

    return { ok: true, item: res.row, preview: pv };
  }

  /* ---------------------------------------------------------------- 模板与历史（复制语义） */

  /**
   * saveAsTemplate(store, memberId, fromBagId, name, opt) —— 背包/计划 → kind='template'（02 §C.3 / D.6）。
   * 同名模板**不静默覆盖**：命中时返回 {ok:false, reason:'name_exists'}，让上层问「已有同名模板，覆盖？」；
   * 调用方拿到后再带 opt.overwrite=true 重调一次，才真正覆盖（覆盖 = 清空旧 items 后重新写入副本）。
   */
  function saveAsTemplate(store, memberId, fromBagId, name, opt) {
    opt = opt || {};
    var nm = String(name == null ? '' : name).trim();
    if (!nm) return fail('missing_name', '请给模板起个名字');
    if (nm.length > 30) return fail('name_too_long', '模板名称不超过 30 字');

    var src = store.find('m_bags', fromBagId);
    if (!src) return fail('not_found', '未找到来源背包：' + fromBagId);
    if (src.member_id !== memberId) return fail('not_owner', '数据归属校验失败：该背包属于其他会员');

    var exist = null;
    store.findBy('m_bags', function (r) {
      return r.member_id === memberId && r.kind === 'template' && r.name === nm;
    }).forEach(function (r) { if (!exist) exist = r; });

    if (exist && opt.overwrite !== true) {
      return { ok: false, reason: 'name_exists', message: '已有同名模板「' + nm + '」，确认覆盖？', bag_id: exist.bag_id };
    }

    /* 先把源内容读出来（覆盖模式下「源就是目标自己」时，先清空会把内容一起清掉） */
    var srcItems = itemsOfBag(store, fromBagId).map(function (it) {
      var c = {};
      Object.keys(it).forEach(function (k) { c[k] = it[k]; });
      return c;
    });

    var targetId;
    if (exist) {
      targetId = exist.bag_id;
      itemsOfBag(store, targetId).forEach(function (it) {
        store.remove('m_bag_items', it.bag_item_id, { actor: memberId });
      });
      store.update('m_bags', targetId, { updated_at: nowStr() }, { actor: memberId });
    } else {
      targetId = store.nextId('m_bags');
      if (!targetId) return fail('id_exhausted', '背包 ID 已用尽');
      var res = store.insert('m_bags', {
        bag_id: targetId,
        member_id: memberId,
        kind: 'template',
        name: nm,
        plan_date: '',
        source_plan_id: src.source_plan_id || '',
        source_session_id: '',
        status: 'draft',
        last_used_at: '',
        created_at: opt.now || nowStr(),
        updated_at: ''
      }, { actor: memberId });
      if (!res.ok) return storeFail(res, 'insert_failed');
    }

    /* 复制：新 ID、新快照，源背包与模板互不引用 */
    var n = 0;
    srcItems.forEach(function (it, i) {
      var ir = store.insert('m_bag_items', {
        bag_item_id: store.nextId('m_bag_items'),
        bag_id: targetId,
        order_index: i + 1,
        exercise_id: it.exercise_id,
        exercise_name_snapshot: it.exercise_name_snapshot,
        exercise_version: intOr(it.exercise_version, 1),
        source: it.source || 'library',
        replaced_from_id: '',
        target_sets: intOr(it.target_sets, DEFAULT_SETS),
        target_reps: intOr(it.target_reps, DEFAULT_REPS),
        target_weight: it.target_weight === undefined || it.target_weight === null ? '' : it.target_weight,
        target_rest_sec: clampInt(it.target_rest_sec, DEFAULT_REST_SEC, 0, 600),
        note: it.note || ''
      }, { actor: memberId });
      if (ir.ok) n++;
    });

    return { ok: true, bag_id: targetId, name: nm, copied: n, overwritten: !!exist };
  }

  /**
   * loadTemplate(store, memberId, templateBagId, opt) —— 模板 → 今日背包（**复制**，不是引用）。
   * opt.bagId 指定目标背包；缺省用今日背包（不存在则新建）。opt.today 可指定日期。
   * 复制而非引用，保证「改今日背包不影响模板」（02 §D.6）。
   */
  function loadTemplate(store, memberId, templateBagId, opt) {
    opt = opt || {};
    var tpl = store.find('m_bags', templateBagId);
    if (!tpl) return fail('not_found', '未找到该模板：' + templateBagId);
    if (tpl.member_id !== memberId) return fail('not_owner', '数据归属校验失败：该模板属于其他会员');
    if (tpl.kind !== 'template') return fail('not_template', '该背包不是模板（kind≠template）');

    var target = opt.bagId ? store.find('m_bags', opt.bagId) : null;
    if (opt.bagId && !target) return fail('not_found', '未找到目标背包：' + opt.bagId);
    if (!target) {
      var tb = getTodayBag(store, memberId, { today: opt.today, now: opt.now });
      if (!tb.ok) return tb;
      target = tb.bag;
    }
    var g = bagGuard(store, memberId, target.bag_id);
    if (!g.ok) return g;

    var base = itemsOfBag(store, target.bag_id).length;
    var n = 0;
    itemsOfBag(store, templateBagId).forEach(function (it, i) {
      var ir = store.insert('m_bag_items', {
        bag_item_id: store.nextId('m_bag_items'),
        bag_id: target.bag_id,
        order_index: base + i + 1,
        exercise_id: it.exercise_id,
        exercise_name_snapshot: it.exercise_name_snapshot,
        exercise_version: intOr(it.exercise_version, 1),
        source: 'template',
        replaced_from_id: '',
        target_sets: intOr(it.target_sets, DEFAULT_SETS),
        target_reps: intOr(it.target_reps, DEFAULT_REPS),
        target_weight: it.target_weight === undefined || it.target_weight === null ? '' : it.target_weight,
        target_rest_sec: clampInt(it.target_rest_sec, DEFAULT_REST_SEC, 0, 600),
        note: it.note || ''
      }, { actor: memberId });
      if (ir.ok) n++;
    });

    reindexBag(store, memberId, target.bag_id);
    store.update('m_bags', target.bag_id, { updated_at: nowStr(), last_used_at: nowStr() }, { actor: memberId });
    return { ok: true, bag_id: target.bag_id, added: n };
  }

  /**
   * loadFromHistory(store, memberId, sessionId, planArray, opt) —— 历史会话 → 今日背包（**复制**）。
   *
   * planArray 由调用方把「已按 exercise_id 去重好的动作数组」传进来（本模块不去猜会话模块的内部结构），
   * 元素形态：{exercise_id, exercise_name_snapshot?, exercise_version?, target_sets, target_reps,
   *            target_weight?, target_rest_sec?}
   * 缺失的名称/版本从 m_exercises 补齐（快照隔离）。
   *
   * 命中身体限制的动作**照常加入**，只在 warnings 里提示（红线：系统不得自动替会员做决定，02 §D.3）。
   * 同时在背包上记 source_session_id，便于 UI 标注「数据来源会话：WS0003 / 2026-10-09」。
   */
  function loadFromHistory(store, memberId, sessionId, planArray, opt) {
    opt = opt || {};
    if (!isArr(planArray) || !planArray.length) return fail('empty_plan', '没有可载入的历史动作');

    var target = opt.bagId ? store.find('m_bags', opt.bagId) : null;
    if (opt.bagId && !target) return fail('not_found', '未找到目标背包：' + opt.bagId);
    if (!target) {
      var tb = getTodayBag(store, memberId, { today: opt.today, now: opt.now });
      if (!tb.ok) return tb;
      target = tb.bag;
    }
    var g = bagGuard(store, memberId, target.bag_id);
    if (!g.ok) return g;

    var profile = opt.profile || store.find('m_profiles', memberId) || {};
    var base = itemsOfBag(store, target.bag_id).length;
    var seen = {};
    var n = 0, skipped = 0;
    var warnings = [];

    planArray.forEach(function (p, i) {
      if (!isObj(p)) return;
      var id = String(p.exercise_id || '').trim();
      if (!id || seen[id]) { skipped++; return; }   /* 防御性去重：调用方已去重，这里再兜一次 */
      seen[id] = true;

      var lib = store.find('m_exercises', id);
      var name = String(p.exercise_name_snapshot || (lib && lib.name) || id);
      var ver = intOr(p.exercise_version, intOr(lib && lib.version, 1));
      var ref = parseRefSetsReps(lib ? lib.reference_sets_reps : '', '');

      if (lib && hitLimitation(lib, profile)) {
        warnings.push(name + '：与你的身体限制重合，请量力而行（系统不会替你移除）');
      }

      var ir = store.insert('m_bag_items', {
        bag_item_id: store.nextId('m_bag_items'),
        bag_id: target.bag_id,
        order_index: base + n + 1,
        exercise_id: id,
        exercise_name_snapshot: name,
        exercise_version: ver,
        source: 'history',
        replaced_from_id: '',
        target_sets: clampInt(p.target_sets, ref.sets, 1, 20),
        target_reps: clampInt(p.target_reps, ref.reps, 1, 999),
        target_weight: weightValue(p.target_weight),
        target_rest_sec: clampInt(p.target_rest_sec, ref.rest, 0, 600),
        note: p.note ? String(p.note).slice(0, 200) : ''
      }, { actor: memberId });
      if (ir.ok) n++;
    });

    reindexBag(store, memberId, target.bag_id);
    store.update('m_bags', target.bag_id, {
      source_session_id: String(sessionId || ''),
      updated_at: nowStr(), last_used_at: nowStr()
    }, { actor: memberId });
    return { ok: true, bag_id: target.bag_id, added: n, skipped: skipped, warnings: warnings };
  }

  /**
   * clearBag(store, memberId, bagId, opt) —— 清空背包内的全部动作（背包行保留）。
   * 需要 opt.confirmed=true 二次确认（02 §D.7：长期未开始的背包要问「继续？/ 清空重来」）。
   */
  function clearBag(store, memberId, bagId, opt) {
    opt = opt || {};
    var g = bagGuard(store, memberId, bagId);
    if (!g.ok) return g;
    if (opt.confirmed !== true) return fail('need_confirm', '清空背包需要二次确认：请传 opt.confirmed=true');
    var items = itemsOfBag(store, bagId);
    items.forEach(function (it) { store.remove('m_bag_items', it.bag_item_id, { actor: memberId }); });
    store.update('m_bags', bagId, { updated_at: nowStr() }, { actor: memberId });
    return { ok: true, removed: items.length };
  }

  /* ================================================================ 九、调整留痕 */

  /**
   * logAdjustment(store, memberId, data, opt) —— 写 m_adjustments（每一次调整都要留痕，02 §B.2）。
   * 留痕失败**不影响主流程**（会员已经完成的操作不该因为日志写不进去而回滚），
   * 但失败原因会通过 warnings 向上返回，不做静默吞掉。opt.log===false 可关闭。
   */
  function logAdjustment(store, memberId, data, opt) {
    if (!opt || opt.log === false) return { ok: false, reason: 'log_disabled' };
    var res = store.insert('m_adjustments', {
      adjustment_id: store.nextId('m_adjustments'),
      member_id: memberId,
      target_type: data.target_type || 'plan',
      target_id: String(data.target_id || ''),
      adjust_type: data.adjust_type || 'volume',
      before_value: String(data.before_value === null || data.before_value === undefined ? '' : data.before_value).slice(0, 100),
      after_value: String(data.after_value === null || data.after_value === undefined ? '' : data.after_value).slice(0, 100),
      reason_code: String(data.reason_code || 'member_edit').slice(0, 40),
      reason_text: String(data.reason_text || '').slice(0, 200),
      applied_by: 'member',
      created_at: nowStr()
    }, { actor: memberId });
    return res.ok ? { ok: true } : storeFail(res, 'log_failed');
  }

  /**
   * previewReplace(store, memberId, bagItemId, newExerciseId, opt)
   *
   * 给 UI 用的「替换前先看差异」入口。
   *
   * 为什么不直接让调用方用 replacePreview：replacePreview 是纯函数，拿不到 store，
   * 需要调用方把原动作对象挂到背包项副本的 .exercise 上（背包项本身只存了名称与版本快照）。
   * 这个细节太容易漏 —— 漏了以后函数不会报错，只会安静地返回「没有任何差异」，
   * 于是会员看到的确认弹窗写着「两者的动作模式、主要肌群和难度基本一致」，
   * 而实际上器械、难度、肌群全变了。把取原动作这一步收进模块里，调用方就不可能漏。
   */
  function previewReplace(store, memberId, bagItemId, newExerciseId, opt) {
    opt = opt || {};
    var item = store.find('m_bag_items', bagItemId);
    if (!item) return fail('not_found', '未找到该背包项：' + bagItemId);
    var g = bagGuard(store, memberId, item.bag_id);
    if (!g.ok) return g;

    var ex = resolveExercise(store, { exercise_id: newExerciseId });
    if (!ex.ok) return ex;
    if (ex.exercise.exercise_id === item.exercise_id) {
      return fail('same_exercise', '新动作与当前动作相同，无需替换');
    }

    var view = Object.assign({}, item);
    var oldEx = store.find('m_exercises', item.exercise_id);
    if (oldEx) view.exercise = oldEx;
    var profile = opt.profile || store.find('m_profiles', memberId) || {};
    return replacePreview(view, ex.exercise, profile);
  }

  /* ================================================================ 十、对外接口 */

  return {
    /* 日期 */
    mondayOf: mondayOf,
    addDays: addDays,
    todayStr: todayStr,
    nowStr: nowStr,

    /* 计划侧 */
    generatePlan: generatePlan,
    createWeekPlan: createWeekPlan,
    publishPlan: publishPlan,
    getWeekPlan: getWeekPlan,
    updatePlanMeta: updatePlanMeta,
    addPlanItem: addPlanItem,
    removePlanItem: removePlanItem,
    movePlanItem: movePlanItem,
    updatePlanItem: updatePlanItem,
    copyPlan: copyPlan,
    deletePlan: deletePlan,
    dayItems: dayItems,

    /* 背包侧 */
    getTodayBag: getTodayBag,
    addToBag: addToBag,
    removeFromBag: removeFromBag,
    moveBagItem: moveBagItem,
    updateBagItem: updateBagItem,
    replacePreview: replacePreview,
    previewReplace: previewReplace,
    replaceBagItem: replaceBagItem,
    saveAsTemplate: saveAsTemplate,
    loadTemplate: loadTemplate,
    loadFromHistory: loadFromHistory,
    clearBag: clearBag
  };
});

/* ===== ../src/js/fxp-member-session.js ===== */
/* Fitness XP 会员端 V2 — 训练会话领域层（阶段 4：执行 → 逐组 → 结算 → 历史）
 *
 * 加载顺序（见 04_会员端/index.html）：
 *   csv → validate → engine → member-schema → member-store → member-seed
 *   → member-identity → member-goal → member-plan → 本文件
 *
 * 本模块负责「一次训练从开始到结束」的全部状态流转，以及历史记录的只读 + 修正通道。
 * 刻意**不负责** XP 结算（那是 fxp-member-xp.js 的事），也不负责背包/计划的编辑
 * （那是 fxp-member-plan.js 的事）。三者由 UI 层编排，避免领域层互相纠缠。
 *
 * 三条贯穿全模块的设计约束：
 *   1. **计划快照不可变**：会话一旦开始，就只认 session.plan_snapshot，不再读背包/计划。
 *      这是「以后改计划不会篡改历史训练」的唯一技术保证（02 §D.5）。
 *   2. **每组即写**：logSet 写完 m_sets 立刻调用 opt.persist()，不等会话结束。
 *      断电/关标签页也不丢组（02 §E.2）。
 *   3. **暂停计时只靠现有字段**：m_sessions 没有 paused_start 字段，本模块用
 *      「duration_sec 当作活跃时长检查点 + paused_ms 当作累计暂停」的约定算出净时长，
 *      不需要引入新字段（见 pauseSession 的详细注释）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.FXP = root.FXP || {}; root.FXP.memberSession = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 常量 */

  /* 输入范围（02 §E.2 写死，客户端即时拦截，不允许提交后才发现） */
  var LIMITS = {
    weight: { min: 0, max: 999.9, step: 0.5, label: '重量' },
    reps: { min: 1, max: 999, step: 1, label: '次数' },
    rpe: { min: 1, max: 10, step: 1, label: '强度自评' },
    rest_sec: { min: 0, max: 600, step: 5, label: '组间休息' }
  };

  /* m_set_corrections 允许修正的字段（schema 枚举决定，这里只做登记便于复用） */
  var CORRECTABLE = ['weight', 'reps', 'rpe', 'rest_sec', 'note'];

  /**
   * m_set_corrections 的 old_value / new_value 是**必填**文本，
   * 但自重训练的 weight 本来就是空。这里统一用一个可见占位符，
   * 既过得了校验，也让看流水的人一眼明白「当时就是没填重量」，而不是「数据丢了」。
   */
  var EMPTY_MARK = '(空)';
  function valText(v) {
    var s = v == null ? '' : String(v);
    return s === '' ? EMPTY_MARK : s;
  }
  /* 同一条 m_sets 同一字段 24 小时内最多修正次数（02 §E.5，防绕过审计） */
  var CORRECT_MAX_PER_DAY = 3;

  var FEELINGS = ['great', 'good', 'normal', 'tired', 'pain'];

  /* ---------------------------------------------------------------- 小工具 */

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function fail(reason, message) { return { ok: false, reason: reason, message: message }; }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }
  function nowStr(d) {
    var x = d || new Date();
    return todayStr(x) + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes()) + ':' + pad(x.getSeconds());
  }

  /** 把 'YYYY-MM-DD HH:MM:SS' 解析成毫秒；解析不出返回 NaN，由调用方决定怎么处理 */
  function toMs(s) {
    if (!s) return NaN;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  }

  function intOr(v, def) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : (def || 0);
  }
  function numOr(v, def) {
    var n = parseFloat(v);
    return isFinite(n) ? n : (def || 0);
  }
  function round1(n) { return Math.round(n * 10) / 10; }

  /**
   * 数值范围校验。
   * 返回 {ok, value, message}；value 是**规范化之后**的值（保留 1 位小数的数字）。
   * 之所以在这里就规范化：后端（schema）只做类型检查，不做业务上下限，
   * 而「重量 1000kg」这种明显是手滑的输入必须当场拦下，不能等结算时才发现。
   */
  function checkRange(raw, cfg, opt) {
    opt = opt || {};
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') {
      /* 重量允许留空（自重训练）；次数不允许 */
      return opt.allowEmpty ? { ok: true, value: null, empty: true } : { ok: false, message: cfg.label + '不能为空' };
    }
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, message: cfg.label + '只能填数字' };
    var n = parseFloat(s);
    if (!isFinite(n)) return { ok: false, message: cfg.label + '不是有效数字' };
    if (n < cfg.min || n > cfg.max) {
      return { ok: false, message: cfg.label + '应在 ' + cfg.min + '–' + cfg.max + ' 之间（当前 ' + n + '）' };
    }
    if (cfg.step === 0.5 && Math.abs(n / 0.5 - Math.round(n / 0.5)) > 1e-9) {
      return { ok: false, message: cfg.label + '的最小单位是 0.5（当前 ' + n + '）' };
    }
    if (cfg.step === 1 && Math.abs(n - Math.round(n)) > 1e-9) {
      return { ok: false, message: cfg.label + '需要是整数（当前 ' + n + '）' };
    }
    return { ok: true, value: n };
  }

  function storeFail(res, fallback) {
    return { ok: false, reason: res.reason || fallback, message: res.message || '', errors: res.errors };
  }

  /* ---------------------------------------------------------------- 会话状态判定 */

  /** 只有这两种状态的会话能进入执行页 */
  function isLive(s) { return !!s && (s.status === 'in_progress' || s.status === 'paused'); }

  /**
   * 取会话自己的行，并做归属校验。
   * 找不到和不属于自己都返回 not_found —— 不区分，避免通过报错差异探测别人的数据是否存在。
   */
  function guard(store, memberId, sessionId) {
    var s = store.find('m_sessions', sessionId);
    if (!s) return fail('not_found', '未找到该训练会话');
    var a = store.assertOwner(memberId, 'm_sessions', s);
    if (!a.ok) return fail('not_found', '未找到该训练会话');
    return { ok: true, session: s };
  }

  /** 某会话的全部组，按 sequence 升序 */
  function setsOf(store, sessionId) {
    return store.all('m_sets')
      .filter(function (r) { return r.session_id === sessionId; })
      .sort(function (a, b) { return intOr(a.sequence) - intOr(b.sequence); });
  }

  /* ---------------------------------------------------------------- 计划快照 */

  /**
   * 把一组「待训练条目」规范成快照。
   * 快照里刻意只存**当时的值**，不存任何 ID 引用——引用会在源数据被改后悄悄变掉，
   * 这正是「改了计划，历史训练也跟着变」这类事故的根因。
   */
  function buildSnapshot(items, source) {
    var list = (items || []).map(function (it, i) {
      return {
        exercise_id: String(it.exercise_id || ''),
        name: String(it.exercise_name_snapshot || it.name || ''),
        version: intOr(it.exercise_version != null ? it.exercise_version : it.version, 1),
        target_sets: intOr(it.target_sets, 3),
        target_reps: intOr(it.target_reps, 10),
        target_weight: it.target_weight === '' || it.target_weight == null ? null : numOr(it.target_weight, 0),
        target_rest_sec: intOr(it.target_rest_sec, 90),
        order_index: intOr(it.order_index, i + 1)
      };
    }).sort(function (a, b) { return a.order_index - b.order_index; });

    return {
      items: list,
      source: source.type,
      source_id: source.id || '',
      taken_at: source.taken_at || nowStr()
    };
  }

  /* ---------------------------------------------------------------- 开始训练 */

  /**
   * 通用建会话。三个入口（背包 / 计划 / 自由训练）都收敛到这里，
   * 只是 source_type 与快照内容不同，避免三份代码各写一遍引入不一致。
   */
  function createSession(store, memberId, sourceType, sourceId, items, opt) {
    opt = opt || {};
    if (!memberId) return fail('no_actor', '未指定会员，拒绝创建会话');

    var snap = buildSnapshot(items, { type: sourceType, id: sourceId, taken_at: opt.now || nowStr() });
    var id = store.nextId('m_sessions');
    var rec = {
      session_id: id,
      member_id: memberId,
      session_date: opt.date || todayStr(),
      started_at: opt.now || nowStr(),
      ended_at: '',
      duration_sec: 0,
      paused_ms: 0,
      status: 'in_progress',
      source_type: sourceType,
      source_id: sourceId || '',
      plan_snapshot: JSON.stringify(snap),
      planned_exercise_count: snap.items.length,
      actual_exercise_count: 0,
      total_sets: 0,
      total_volume: 0,
      feeling: '',
      coach_session_id: '',
      rule_version: opt.ruleVersion || 'v2.0',
      created_at: opt.now || nowStr(),
      updated_at: opt.now || nowStr()
    };
    var r = store.insert('m_sessions', rec, { actor: memberId });
    if (!r.ok) return storeFail(r, 'insert_failed');
    return { ok: true, session: r.row, snapshot: snap };
  }

  /**
   * startFromBag(store, memberId, bag, opt) —— 从今日背包开始（02 §D.5）。
   * 背包内容被**复制**进快照，并把背包置 confirmed；此后改背包不影响进行中的会话。
   */
  function startFromBag(store, memberId, bag, items, opt) {
    opt = opt || {};
    if (!isObj(bag)) return fail('bad_bag', '未提供有效的背包');
    if (String(bag.member_id) !== String(memberId)) return fail('not_owner', '该背包属于其他会员');
    if (bag.status === 'confirmed') return fail('already_confirmed', '今天的背包已经开始训练了，请从首页继续');

    var r = createSession(store, memberId, 'bag', bag.bag_id, items, opt);
    if (!r.ok) return r;

    var u = store.update('m_bags', bag.bag_id, { status: 'confirmed', last_used_at: opt.now || nowStr() }, { actor: memberId });
    if (!u.ok) return storeFail(u, 'bag_update_failed');
    return r;
  }

  /** startFromPlan：从周计划某一天开始。同样是复制，不引用 plan_items。 */
  function startFromPlan(store, memberId, plan, dayItems, opt) {
    opt = opt || {};
    if (!isObj(plan)) return fail('bad_plan', '未提供有效的周计划');
    if (String(plan.member_id) !== String(memberId)) return fail('not_owner', '该计划属于其他会员');
    return createSession(store, memberId, 'plan', plan.plan_id, dayItems, opt);
  }

  /** startQuick：不依赖任何计划，直接开始（02 §A.3 空状态里的「直接开始一次训练」）。 */
  function startQuick(store, memberId, opt) {
    opt = opt || {};
    return createSession(store, memberId, 'quick', '', opt.items || [], opt);
  }

  /* ---------------------------------------------------------------- 逐组记录 */

  /**
   * logSet(store, memberId, sessionId, input, opt)
   *
   * input: {exercise_id, weight, reps, rpe, rest_sec, note, exercise_name_snapshot, exercise_version}
   * opt.persist: 函数；给了就在写完后立刻调用，用于「每组即写盘」。
   *
   * 校验顺序刻意按「最可能手滑的先报」：次数 → 重量 → 自评 → 休息。
   * 任何一项不通过都**不写库**，保证 m_sets 里不会有半条脏数据。
   */
  function logSet(store, memberId, sessionId, input, opt) {
    opt = opt || {};
    input = input || {};
    var g = guard(store, memberId, sessionId);
    if (!g.ok) return g;
    var s = g.session;
    if (!isLive(s)) return fail('not_live', '该会话已结束，不能再记录新的组');

    if (!input.exercise_id) return fail('no_exercise', '未指定动作');
    var ex = store.find('m_exercises', input.exercise_id);
    if (!ex) return fail('exercise_not_found', '动作库中不存在该动作：' + input.exercise_id);

    var rReps = checkRange(input.reps, LIMITS.reps);
    if (!rReps.ok) return fail('bad_reps', rReps.message);
    var rWeight = checkRange(input.weight, LIMITS.weight, { allowEmpty: true });
    if (!rWeight.ok) return fail('bad_weight', rWeight.message);
    var rRpe = input.rpe === '' || input.rpe == null ? { ok: true, value: null, empty: true }
      : checkRange(input.rpe, LIMITS.rpe);
    if (!rRpe.ok) return fail('bad_rpe', rRpe.message);
    var rRest = input.rest_sec === '' || input.rest_sec == null ? { ok: true, value: null, empty: true }
      : checkRange(input.rest_sec, LIMITS.rest_sec);
    if (!rRest.ok) return fail('bad_rest', rRest.message);

    var done = setsOf(store, sessionId);
    /* 同一动作内第几组（set_index）；sequence 是全会话的第几组，用于排序 */
    var sameEx = done.filter(function (r) { return r.exercise_id === String(input.exercise_id); });
    var setIndex = sameEx.length + 1;

    var now = opt.now || nowStr();
    var ins = store.insert('m_sets', {
      set_id: store.nextId('m_sets'),
      session_id: sessionId,
      exercise_id: String(input.exercise_id),
      exercise_name_snapshot: String(ex.exercise_name_snapshot || ex.name || ''),
      exercise_version: intOr(ex.version, 1),
      set_index: setIndex,
      sequence: done.length + 1,
      weight: rWeight.empty ? '' : rWeight.value,
      reps: rReps.value,
      rpe: rRpe.empty ? '' : rRpe.value,
      rest_sec: rRest.empty ? '' : rRest.value,
      note: input.note ? String(input.note).slice(0, 200) : '',
      is_pr: 'N',
      logged_at: now
    }, { actor: memberId });
    if (!ins.ok) return storeFail(ins, 'insert_failed');

    /* 会话汇总值同步刷新：不等结算，这样中途关页面也能看到大致进度 */
    var all = setsOf(store, sessionId);
    var vol = 0;
    var exIds = {};
    all.forEach(function (r) {
      vol += numOr(r.weight) * intOr(r.reps);
      exIds[r.exercise_id] = 1;
    });
    var up = store.update('m_sessions', sessionId, {
      total_sets: all.length,
      actual_exercise_count: Object.keys(exIds).length,
      total_volume: round1(vol),
      updated_at: now
    }, { actor: memberId });
    if (!up.ok) return storeFail(up, 'update_failed');

    /* 每组即写盘。这是「刷新页面不丢组」的落地点。 */
    var persisted = false;
    if (typeof opt.persist === 'function') {
      var pr = opt.persist();
      persisted = !(pr && pr.ok === false);
    }
    return { ok: true, set: ins.row, setIndex: setIndex, persisted: persisted };
  }

  /**
   * undoLastSet —— 撤销刚记的最后一组（02 §E.2）。
   * 只允许在会话进行中撤销，且只撤销最后一组；撤销会写 m_set_corrections 留痕（kind=undo），
   * 因为「记错了」本身是有价值的信息，不能删得无影无踪。
   */
  function undoLastSet(store, memberId, sessionId, opt) {
    opt = opt || {};
    var g = guard(store, memberId, sessionId);
    if (!g.ok) return g;
    if (!isLive(g.session)) return fail('not_live', '会话已结束，不能再撤销');

    var list = setsOf(store, sessionId);
    if (!list.length) return fail('nothing_to_undo', '还没有记录任何组');
    var last = list[list.length - 1];

    var now = opt.now || nowStr();
    var corr = store.insert('m_set_corrections', {
      correction_id: store.nextId('m_set_corrections'),
      set_id: last.set_id,
      member_id: memberId,
      field_name: 'weight',
      /* 撤销的是「整组」，不针对某个字段；这里借用 weight 档记录当时这组的重量，
         便于日后对账。自重训练没有重量，用 EMPTY_MARK 占位。 */
      old_value: valText(last.weight),
      new_value: EMPTY_MARK,
      reason: '撤销整组（' + (last.exercise_name_snapshot || last.exercise_id)
        + ' 第 ' + intOr(last.set_index, 1) + ' 组）',
      kind: 'undo',
      corrected_at: now
    }, { actor: memberId });
    if (!corr.ok) return storeFail(corr, 'correction_failed');

    var rm = store.remove('m_sets', last.set_id, { actor: memberId });
    if (!rm.ok) return storeFail(rm, 'remove_failed');

    var rest = setsOf(store, sessionId);
    var vol = 0, ids = {};
    rest.forEach(function (r) { vol += numOr(r.weight) * intOr(r.reps); ids[r.exercise_id] = 1; });
    store.update('m_sessions', sessionId, {
      total_sets: rest.length,
      actual_exercise_count: Object.keys(ids).length,
      total_volume: round1(vol),
      updated_at: now
    }, { actor: memberId });

    return { ok: true, removed: last.set_id, remaining: rest.length };
  }

  /* ---------------------------------------------------------------- 暂停与恢复 */

  /**
   * 计时约定的推导（重要，改这里之前先读完）：
   *
   *   elapsed   = 现在 − started_at          （墙上时间，含暂停）
   *   paused_ms = 累计暂停毫秒               （跨刷新可恢复的关键，存在表里）
   *   duration_sec = 「活跃秒数检查点」       （暂停瞬间写入，恢复时被重新推导）
   *
   * 暂停时：duration_sec ← elapsed − paused_ms    （把此刻之前的活跃时长固定下来）
   * 恢复时：paused_ms   ← elapsed − duration_sec  （把这段空窗计入暂停）
   * 结束时：duration_sec ← elapsed − paused_ms
   *
   * 这样**不需要** paused_start 字段：即便会员在暂停状态下关掉标签页、三天后才点恢复，
   * 恢复时算出来的 paused_ms 也自动包含整个空窗期，净时长依旧正确。
   */
  function netSeconds(session, now) {
    var startedMs = toMs(session.started_at);
    if (!isFinite(startedMs)) return 0;
    var elapsed = now - startedMs;
    var paused = intOr(session.paused_ms, 0);
    var sec = Math.floor((elapsed - paused) / 1000);
    return sec > 0 ? sec : 0;
  }

  function pauseSession(store, memberId, sessionId, opt) {
    opt = opt || {};
    var g = guard(store, memberId, sessionId);
    if (!g.ok) return g;
    var s = g.session;
    if (s.status !== 'in_progress') return fail('bad_status', '只有进行中的训练可以暂停');

    var now = toMs(opt.now || nowStr());
    var started = toMs(s.started_at);
    if (!isFinite(started)) return fail('bad_started_at', '会话开始时间异常，无法计算时长');

    var elapsed = now - started;
    var paused = intOr(s.paused_ms, 0);
    var activeSec = Math.floor((elapsed - paused) / 1000);
    if (activeSec < 0) activeSec = 0;

    var u = store.update('m_sessions', sessionId, {
      status: 'paused',
      duration_sec: activeSec,      /* 检查点：此刻为止的活跃秒数 */
      updated_at: opt.now || nowStr()
    }, { actor: memberId });
    if (!u.ok) return storeFail(u, 'update_failed');
    return { ok: true, session: u.row, activeSec: activeSec };
  }

  function resumeSession(store, memberId, sessionId, opt) {
    opt = opt || {};
    var g = guard(store, memberId, sessionId);
    if (!g.ok) return g;
    var s = g.session;
    if (s.status !== 'paused') return fail('bad_status', '只有暂停中的训练可以恢复');

    var now = toMs(opt.now || nowStr());
    var started = toMs(s.started_at);
    if (!isFinite(started)) return fail('bad_started_at', '会话开始时间异常，无法计算时长');

    var elapsed = now - started;
    var activeSec = intOr(s.duration_sec, 0);      /* 暂停时写下的检查点 */
    var pausedMs = elapsed - activeSec * 1000;
    if (pausedMs < 0) pausedMs = 0;                 /* 时钟回拨或数据异常时的兜底 */

    var u = store.update('m_sessions', sessionId, {
      status: 'in_progress',
      paused_ms: pausedMs,
      updated_at: opt.now || nowStr()
    }, { actor: memberId });
    if (!u.ok) return storeFail(u, 'update_failed');
    return { ok: true, session: u.row, pausedMs: pausedMs };
  }

  /* ---------------------------------------------------------------- 结束训练 */

  /**
   * complete(store, memberId, sessionId, opt) —— 结束并结算（02 §E.4）。
   * opt.feeling 必填（great/good/normal/tired/pain）。
   *
   * 本函数**只负责把会话收口**，不发放 XP；UI 应当在它成功之后调用
   * fxp-member-xp.js 的 settleSession()。之所以拆开：XP 结算需要「整事务回滚」，
   * 把两个职责混在一起会让回滚边界变得无法测试。
   */
  function complete(store, memberId, sessionId, opt) {
    opt = opt || {};
    var g = guard(store, memberId, sessionId);
    if (!g.ok) return g;
    var s = g.session;
    if (!isLive(s)) return fail('not_live', '该会话已经结束了');

    if (opt.feeling && FEELINGS.indexOf(opt.feeling) < 0) {
      return fail('bad_feeling', '训练感受取值非法：' + opt.feeling);
    }
    var feeling = opt.feeling || '';
    if (opt.requireFeeling !== false && !feeling) {
      return fail('feeling_required', '请先选择本次的训练感受');
    }

    var now = opt.now || nowStr();
    var nowMs = toMs(now);
    var started = toMs(s.started_at);
    if (!isFinite(started)) return fail('bad_started_at', '会话开始时间异常');

    /* 结束时统一重算：若在暂停中结束，paused_ms 里没有包含「暂停→结束」这段，
       所以这里用「暂停检查点 duration_sec」当作活跃时长，暂停期间的空窗不计入训练时长。 */
    var elapsed = nowMs - started;
    var activeSec;
    if (s.status === 'paused') {
      activeSec = intOr(s.duration_sec, 0);
    } else {
      var paused = intOr(s.paused_ms, 0);
      activeSec = Math.floor((elapsed - paused) / 1000);
      if (activeSec < 0) activeSec = 0;
    }

    var all = setsOf(store, sessionId);
    var vol = 0, ids = {};
    all.forEach(function (r) { vol += numOr(r.weight) * intOr(r.reps); ids[r.exercise_id] = 1; });

    var pausedMs = s.status === 'paused'
      ? (elapsed - activeSec * 1000)
      : intOr(s.paused_ms, 0);
    if (pausedMs < 0) pausedMs = 0;

    var u = store.update('m_sessions', sessionId, {
      status: 'completed',
      ended_at: now,
      duration_sec: activeSec,
      paused_ms: pausedMs,
      total_sets: all.length,
      actual_exercise_count: Object.keys(ids).length,
      total_volume: round1(vol),
      feeling: feeling,
      updated_at: now
    }, { actor: memberId });
    if (!u.ok) return storeFail(u, 'update_failed');

    return { ok: true, session: u.row, summary: summary(store, memberId, sessionId) };
  }

  /**
   * abandon —— 会员主动放弃。
   * 已记录的组**保留**（那是真实发生过的事实），但不结算、不进历史列表。
   */
  function abandon(store, memberId, sessionId, opt) {
    opt = opt || {};
    var g = guard(store, memberId, sessionId);
    if (!g.ok) return g;
    if (!isLive(g.session)) return fail('not_live', '该会话已经结束了');

    var now = opt.now || nowStr();
    var u = store.update('m_sessions', sessionId, { status: 'abandoned', ended_at: now, updated_at: now }, { actor: memberId });
    if (!u.ok) return storeFail(u, 'update_failed');
    return { ok: true, session: u.row, keptSets: setsOf(store, sessionId).length };
  }

  /* ---------------------------------------------------------------- 查询与结算数据 */

  /** 上次练某个动作的数据（02 §E.2 的「上一组对照」来源） */
  function lastSetsFor(store, memberId, exerciseId, opt) {
    opt = opt || {};
    var mine = store.all('m_sessions').filter(function (s) {
      return s.member_id === memberId && (s.status === 'completed' || s.status === 'abandoned');
    });
    if (opt.beforeSessionId) {
      mine = mine.filter(function (s) { return s.session_id !== opt.beforeSessionId; });
    }
    mine.sort(function (a, b) { return String(b.session_date).localeCompare(String(a.session_date)); });

    for (var i = 0; i < mine.length; i++) {
      var rows = setsOf(store, mine[i].session_id).filter(function (r) { return r.exercise_id === exerciseId; });
      if (rows.length) {
        return { ok: true, sessionId: mine[i].session_id, date: mine[i].session_date, sets: rows };
      }
    }
    return { ok: true, sessionId: '', date: '', sets: [] };
  }

  /**
   * summary(store, memberId, sessionId) —— 结算卡需要的全部数字（02 §E.4）。
   * 刻意只从 m_sessions / m_sets / plan_snapshot 现算，不做任何缓存，
   * 保证「结算卡上的每一项都能被重新算出来」这条硬要求成立。
   */
  function summary(store, memberId, sessionId) {
    var g = guard(store, memberId, sessionId);
    if (!g.ok) return null;
    var s = g.session;
    var all = setsOf(store, sessionId);

    var snap = {};
    try { snap = JSON.parse(s.plan_snapshot || '{}'); } catch (e) { snap = { items: [] }; }
    var planItems = snap.items || [];

    var byEx = {};
    all.forEach(function (r) {
      var k = r.exercise_id;
      if (!byEx[k]) {
        byEx[k] = {
          exercise_id: k, name: r.exercise_name_snapshot,
          plannedSets: 0, actualSets: 0, volume: 0, best: null, sets: []
        };
      }
      byEx[k].actualSets++;
      byEx[k].volume += numOr(r.weight) * intOr(r.reps);
      byEx[k].sets.push(r);
      if (!byEx[k].best || numOr(r.weight) > numOr(byEx[k].best.weight)) byEx[k].best = r;
    });

    /* 计划里出现、但一组都没练的动作也要出现在对比里（否则「完成度」会被算高） */
    planItems.forEach(function (p) {
      var k = p.exercise_id;
      if (!byEx[k]) {
        byEx[k] = { exercise_id: k, name: p.name, plannedSets: 0, actualSets: 0, volume: 0, best: null, sets: [] };
      }
      byEx[k].plannedSets = intOr(p.target_sets, 0);
    });

    var rows = Object.keys(byEx).map(function (k) {
      var v = byEx[k];
      return {
        exercise_id: v.exercise_id,
        name: v.name,
        planned_sets: v.plannedSets,
        actual_sets: v.actualSets,
        volume: round1(v.volume),
        top_weight: v.best ? numOr(v.best.weight) : 0
      };
    });
    rows.sort(function (a, b) {
      var ai = -1, bi = -1;
      planItems.forEach(function (p, i) { if (p.exercise_id === a.exercise_id) ai = i; if (p.exercise_id === b.exercise_id) bi = i; });
      return ai - bi;
    });

    var plannedTotal = planItems.reduce(function (a, p) { return a + intOr(p.target_sets, 0); }, 0);
    var totalVolume = all.reduce(function (a, r) { return a + numOr(r.weight) * intOr(r.reps); }, 0);
    /* 完成度：以「计划组数」为分母，实际组数为分子，上限 100% */
    var rate = plannedTotal > 0 ? Math.min(100, Math.round(all.length / plannedTotal * 1000) / 10) : 0;

    return {
      session_id: s.session_id,
      session_date: s.session_date,
      status: s.status,
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_sec: intOr(s.duration_sec, 0),
      paused_sec: Math.round(intOr(s.paused_ms, 0) / 1000),
      feeling: s.feeling,
      planned_exercise_count: planItems.length,
      actual_exercise_count: Object.keys(byEx).length,
      planned_sets: plannedTotal,
      total_sets: all.length,
      total_volume: round1(totalVolume),
      completion_rate: rate,
      per_exercise: rows,
      source_type: s.source_type,
      source_id: s.source_id
    };
  }

  /** 历史列表：只含 completed，倒序 */
  function history(store, memberId, opt) {
    opt = opt || {};
    var rows = store.all('m_sessions').filter(function (s) {
      return s.member_id === memberId && s.status === 'completed';
    }).sort(function (a, b) {
      return String(b.session_date).localeCompare(String(a.session_date))
        || String(b.session_id).localeCompare(String(a.session_id));
    });
    var page = intOr(opt.page, 1), size = intOr(opt.pageSize, 20);
    var start = (page - 1) * size;
    return {
      ok: true,
      total: rows.length,
      page: page,
      items: rows.slice(start, start + size).map(function (s) {
        return {
          session_id: s.session_id,
          session_date: s.session_date,
          duration_sec: intOr(s.duration_sec, 0),
          exercise_count: intOr(s.actual_exercise_count, 0),
          total_sets: intOr(s.total_sets, 0),
          total_volume: numOr(s.total_volume, 0),
          feeling: s.feeling,
          source_type: s.source_type
        };
      })
    };
  }

  /* ---------------------------------------------------------------- 历史修正（02 §E.5） */

  /**
   * correctSet —— 已 completed 会话里的组数据需要改时的唯一通道。
   * 每次修正都追加一条 m_set_corrections（原值/新值/原因齐全），
   * 同一条组同一字段 24 小时内最多 3 次。
   *
   * 注意：本函数**不回收也不补发 XP**（那是 XP 模块的事，会写反向冲抵）。
   * 这里只负责把「数据事实」改对并留痕。
   */
  function correctSet(store, memberId, setId, field, newValue, reason, opt) {
    opt = opt || {};
    if (CORRECTABLE.indexOf(field) < 0) {
      return fail('bad_field', '该字段不允许修正（允许：' + CORRECTABLE.join(' / ') + '）');
    }
    var reasonText = String(reason || '').trim();
    if (reasonText.length < 2) return fail('reason_required', '修正必须填写原因（至少 2 个字）');

    var row = store.find('m_sets', setId);
    if (!row) return fail('not_found', '未找到该组记录');
    var sg = guard(store, memberId, row.session_id);
    if (!sg.ok) return sg;
    if (sg.session.status !== 'completed') {
      return fail('not_completed', '只有已结束的训练可以走修正通道（进行中请直接用「撤销上一组」）');
    }

    var cfg = LIMITS[field];
    var checked;
    if (field === 'note') {
      checked = { ok: true, value: String(newValue || '').slice(0, 200) };
    } else {
      checked = checkRange(newValue, cfg, { allowEmpty: field === 'weight' });
      if (!checked.ok) return fail('bad_value', checked.message);
    }

    var now = opt.now || nowStr();
    var nowMs = toMs(now);
    var recent = store.all('m_set_corrections').filter(function (c) {
      return c.set_id === setId && c.field_name === field && c.kind !== 'undo'
        && isFinite(toMs(c.corrected_at)) && (nowMs - toMs(c.corrected_at)) <= 24 * 3600 * 1000;
    });
    if (recent.length >= CORRECT_MAX_PER_DAY && !opt.force) {
      return fail('too_many', '这一组最近 24 小时已经修正过 ' + recent.length + ' 次（上限 '
        + CORRECT_MAX_PER_DAY + ' 次）。请确认后再试，或联系教练协助。');
    }

    var oldValue = valText(row[field]);
    var corr = store.insert('m_set_corrections', {
      correction_id: store.nextId('m_set_corrections'),
      set_id: setId,
      member_id: memberId,
      field_name: field,
      old_value: oldValue,
      new_value: valText(checked.value),
      reason: reasonText.slice(0, 200),
      kind: 'correction',
      corrected_at: now
    }, { actor: memberId });
    if (!corr.ok) return storeFail(corr, 'correction_failed');

    var patch = {};
    patch[field] = checked.value == null ? '' : checked.value;
    var u = store.update('m_sets', setId, patch, { actor: memberId });
    if (!u.ok) return storeFail(u, 'update_failed');

    /* 组数据变了，会话汇总值要跟着重算，否则历史列表的总容量会和明细对不上 */
    var all = setsOf(store, row.session_id);
    var vol = 0, ids = {};
    all.forEach(function (r) { vol += numOr(r.weight) * intOr(r.reps); ids[r.exercise_id] = 1; });
    store.update('m_sessions', row.session_id, {
      total_volume: round1(vol),
      actual_exercise_count: Object.keys(ids).length,
      updated_at: now
    }, { actor: memberId });

    return { ok: true, correction: corr.row, oldValue: oldValue, newValue: valText(patch[field]), today: recent.length + 1 };
  }

  /** 某条组的修正流水（历史详情页用来展示「改过什么、为什么」） */
  function correctionsOf(store, memberId, setId) {
    return store.all('m_set_corrections')
      .filter(function (c) { return c.set_id === setId && c.member_id === memberId; })
      .sort(function (a, b) { return String(a.corrected_at).localeCompare(String(b.corrected_at)); });
  }

  /* ---------------------------------------------------------------- 导出 */

  return {
    LIMITS: LIMITS,
    CORRECTABLE: CORRECTABLE,
    CORRECT_MAX_PER_DAY: CORRECT_MAX_PER_DAY,
    FEELINGS: FEELINGS,

    startFromBag: startFromBag,
    startFromPlan: startFromPlan,
    startQuick: startQuick,

    logSet: logSet,
    undoLastSet: undoLastSet,

    pauseSession: pauseSession,
    resumeSession: resumeSession,
    complete: complete,
    abandon: abandon,

    isLive: isLive,
    setsOf: setsOf,
    lastSetsFor: lastSetsFor,
    summary: summary,
    history: history,
    netSeconds: netSeconds,

    correctSet: correctSet,
    correctionsOf: correctionsOf,

    buildSnapshot: buildSnapshot,
    todayStr: todayStr,
    nowStr: nowStr
  };
});


/* ===== ../src/js/fxp-member-xp.js ===== */
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


/* ===== ../src/js/fxp-member-explore.js ===== */
/* Fitness XP 会员端 V2 — 探索地图 + 灵感卡 领域层（UMD）
 *
 * 依赖：fxp-member-schema（只用于「表是否就绪」的检查）
 *      fxp-member-plan（灵感卡落地到背包 / 周计划；惰性解析，本模块加载时可以还没就绪）
 *      fxp-member-xp（只用来取 playerType；取不到时本地兜底）
 * 不依赖：任何 UI、localStorage、fetch、console、document
 *
 * 【本模块的边界 —— 接手的人请先读这段】
 *   1) 只做领域层：**不碰 DOM、不发 XP**。「首次尝试某动作」的 XP 由既有
 *      `XP_EXPLORE_NEW`（fxp-member-xp.js:1233）负责，本模块绝不重复发一次，
 *      否则同一次探索会加两遍分。探索地图与它共用同一个「已练过」判据：
 *      **该动作出现在某次已完成会话的 m_sets 里**。
 *   2) **不自己持久化**：所有写库函数只改内存 store，store.save() 由调用方统一调用。
 *   3) **不自己建存储**：store 一律由调用方注入。
 *   4) 灵感卡只负责「算出可落地的内容」，**绝不自动改背包**。是否写入必须由用户点头
 *      （cardToBag / cardToPlan 都是显式调用，没有任何自动触发路径）。
 *   5) 探索进度只读：它由真实训练决定，会员改不了；能改的只有视图层的排序。
 *
 * 【为什么解锁落 m_unlocks 而不是新开一张表】
 *   m_unlocks 的 `achievement_code` 是自由文本，且唯一键是
 *   `[member_id, achievement_code, tier]` —— 天然防重复解锁，不需要新表、
 *   不需要改 schema、不需要动导出导入。探索解锁用 `explore:{维度}:{键}` 作 code，
 *   与成就体系靠前缀区分（成就 code 不会含冒号）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    /* Node 下三个依赖都直接 require。
       为什么不在 Node 下也留 null 走「惰性解析」：Node 里没有 self.FXP 也没有浏览器全局命名空间，
       ns() 必然返回 null，cardToBag / cardToPlan 会永远卡在 not_ready。
       测试要能跑到落地路径，就必须在这里把真实模块注入进去。 */
    module.exports = factory(
      require('./fxp-member-schema.js'),
      require('./fxp-member-plan.js'),
      require('./fxp-member-xp.js')
    );
  } else {
    root.FXP = root.FXP || {};
    root.FXP.memberExplore = factory(root.FXP.memberSchema, root.FXP.memberPlan, root.FXP.memberXp);
  }
})(typeof self !== 'undefined' ? self : this, function (MSCH, PLAN, XP) {
  'use strict';

  /* ================================================================ 常量 */

  /** 探索规则版本：改阈值就必须改它，否则老解锁无法解释是哪版规则给的 */
  var RULE_VERSION = 'explore-v1';
  /** 灵感卡规则版本 */
  var INSPIRE_RULE_VERSION = 'inspire-v1';

  var DIMENSIONS = [
    { key: 'muscle', label: '肌群' },
    { key: 'pattern', label: '动作模式' },
    { key: 'difficulty', label: '难度' }
  ];

  /** 解锁阈值：达到 t2 需先满足 t1，函数里从高往低判 */
  var UNLOCK_RULE = {
    muscle: { t2: 3, t1: 1 },
    pattern: { t2: 3, t1: 1 },
    difficulty: { t2: 5, t1: 2 }
  };

  var DIFF_LABEL = {
    beginner: '入门',
    novice: '初级',
    intermediate: '中级',
    advanced: '高级'
  };
  var PATTERN_LABEL = {
    squat: '深蹲', hinge: '髋铰链', push_horizontal: '水平推', push_vertical: '垂直推',
    pull_horizontal: '水平拉', pull_vertical: '垂直拉', carry: '负重行走',
    core: '核心', locomotion: '位移', isolation: '孤立'
  };

  /* ---------------------------------------------------------------- 灵感卡模板池
   * 为什么放代码里而不是 seed：任务池（DAILY_POOL）就是这么做的，改模板不需要动数据版本，
   * 也不必担心老会员本地存着旧副本。模板不写死动作 ID —— 只声明「模式 / 难度 / 器械」，
   * 由会员自己的动作库现场解析出具体动作，这样动作库变化、器械不同都不会失效。
   */
  var INSPIRE_POOL = [
    {
      code: 'insp_wake_full', title: '15 分钟全身唤醒', pool: ['beginner', 'unstable'],
      minutes: 15, reason: '新手先建立动作模式，不追重量，做完不酸痛才算合适',
      items: [
        { pattern: 'squat', sets: 2, reps: 10, note: '慢下快上，找脚踩实的' },
        { pattern: 'push_horizontal', sets: 2, reps: 10, note: '肩胛收紧再推' },
        { pattern: 'core', sets: 2, reps: 12, note: '全程不憋气' }
      ],
      difficulty: ['beginner', 'novice']
    },
    {
      code: 'insp_leg_light', title: '轻重量腿日', pool: ['beginner', 'unstable'],
      minutes: 20, reason: '腿是最容易练过头的部位，新手从中低量开始',
      items: [
        { pattern: 'squat', sets: 3, reps: 10 },
        { pattern: 'hinge', sets: 2, reps: 10 },
        { pattern: 'core', sets: 2, reps: 12 }
      ],
      difficulty: ['beginner', 'novice']
    },
    {
      code: 'insp_upper_intro', title: '上肢入门：推拉平衡', pool: ['beginner'],
      minutes: 20, reason: '推与拉成对练，肩颈更舒服',
      items: [
        { pattern: 'push_horizontal', sets: 3, reps: 10 },
        { pattern: 'pull_horizontal', sets: 3, reps: 10 },
        { pattern: 'push_vertical', sets: 2, reps: 8 }
      ],
      difficulty: ['beginner', 'novice']
    },
    {
      code: 'insp_core_10', title: '10 分钟核心与体态', pool: ['beginner', 'unstable', 'all'],
      minutes: 10, reason: '时间不够时的最低门槛选项，做完就算完成一次训练',
      items: [
        { pattern: 'core', sets: 3, reps: 12 },
        { category: 'mobility', sets: 2, reps: 10 }
      ]
    },
    {
      code: 'insp_hinge_learn', title: '学会髋铰链', pool: ['unstable'],
      minutes: 15, reason: '很多人腰酸是因为髋不会发力，这个模板专门补这一课',
      items: [
        { pattern: 'hinge', sets: 3, reps: 10, note: '骨盆后倾启动，不要用腰拽' },
        { pattern: 'core', sets: 2, reps: 12 }
      ],
      difficulty: ['beginner', 'novice', 'intermediate']
    },
    {
      code: 'insp_push_pull', title: '推拉平衡日', pool: ['unstable', 'all'],
      minutes: 25, reason: '执行不稳定时优先练「成对」的动作，一次练完上半身',
      items: [
        { pattern: 'push_horizontal', sets: 3, reps: 10 },
        { pattern: 'pull_horizontal', sets: 3, reps: 10 },
        { pattern: 'squat', sets: 2, reps: 12 }
      ]
    },
    {
      code: 'insp_strength_55', title: '老炮力量 5×5', pool: ['veteran'],
      minutes: 40, reason: '低频高重量，适合已经能稳定完成每周计划的会员',
      items: [
        { pattern: 'squat', sets: 5, reps: 5 },
        { pattern: 'push_vertical', sets: 5, reps: 5 },
        { pattern: 'pull_vertical', sets: 5, reps: 5 }
      ],
      difficulty: ['intermediate', 'advanced']
    },
    {
      code: 'insp_volume_410', title: '容量日 4×10', pool: ['veteran'],
      minutes: 35, reason: '用中重量堆容量，组间休息压到 60 秒',
      items: [
        { pattern: 'squat', sets: 4, reps: 10 },
        { pattern: 'push_horizontal', sets: 4, reps: 10 },
        { pattern: 'pull_horizontal', sets: 4, reps: 10 },
        { pattern: 'hinge', sets: 3, reps: 10 }
      ]
    },
    {
      code: 'insp_unilateral', title: '单侧补短板', pool: ['veteran'],
      minutes: 30, reason: '两侧力量差是最常见的隐形短板，单侧动作能把它逼出来',
      items: [
        { pattern: 'squat', sets: 3, reps: 8, unilateral: true },
        { pattern: 'hinge', sets: 3, reps: 8, unilateral: true },
        { pattern: 'core', sets: 3, reps: 12 }
      ]
    },
    {
      code: 'insp_cardio_12', title: '12 分钟心肺循环', pool: ['all'],
      minutes: 12, reason: '不想举铁的日子用它保住连续记录',
      items: [
        { pattern: 'locomotion', sets: 3, reps: 20 },
        { pattern: 'core', sets: 2, reps: 15 }
      ]
    }
  ];

  /* ================================================================ 工具 */

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function intOr(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }
  function numOr(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }
  function clampInt(v, d, lo, hi) { var n = intOr(v, d); return n < lo ? lo : (n > hi ? hi : n); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function todayStr(d) {
    if (d) return d;
    var t = new Date();
    return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
  }
  function nowStr(d) {
    if (d) return d;
    var t = new Date();
    return todayStr() + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
  }

  /** 与 seed / xp 同族的稳定散列：同一输入永远同一输出，保证抽卡可复现 */
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h >>> 0;
  }

  function fail(reason, message) { return { ok: false, reason: reason, message: message }; }

  /** 惰性取计划模块：浏览器里 script 顺序不保证，顶层取可能拿到 undefined */
  function plan() {
    if (PLAN) return PLAN;
    var n = ns();
    return (n && n.memberPlan) || null;
  }
  function xp() {
    if (XP) return XP;
    var n = ns();
    return (n && n.memberXp) || null;
  }
  function ns() {
    if (typeof self !== 'undefined' && self && self.FXP) return self.FXP;
    if (typeof window !== 'undefined' && window && window.FXP) return window.FXP;
    if (typeof globalThis !== 'undefined' && globalThis && globalThis.FXP) return globalThis.FXP;
    return null;
  }

  /** store 形态检查：只认注入进来的实例，误传模块本体要明确报错 */
  function guard(store) {
    if (!store || typeof store.all !== 'function' || typeof store.find !== 'function') {
      return fail('bad_store', 'store 必须是 memberStore.createStore() 的实例');
    }
    if (typeof store.insert !== 'function') return fail('bad_store', '缺少写库能力：store 可能是模块本体');
    return { ok: true };
  }

  /** 拆肌群：primary_muscles 是「股四头肌、臀大肌」这种顿号分隔 */
  function musclesOf(ex) {
    var raw = String((ex && ex.primary_muscles) || '');
    if (!raw) return [];
    return raw.split(/[、,，/]/).map(function (s) { return s.trim(); }).filter(function (s) { return !!s; });
  }

  function labelOf(dim, key) {
    if (dim === 'difficulty') return DIFF_LABEL[key] || key;
    if (dim === 'pattern') return PATTERN_LABEL[key] || key;
    return key;
  }

  function deprecated(ex) {
    return ex.deprecated === true || ex.deprecated === 'Y' || ex.deprecated === 'y';
  }

  /* ================================================================ 探索：已练过的动作 */

  /**
   * triedMap(store, memberId) —— 已练过动作的明细。
   * 判据（与 XP_EXPLORE_NEW 一致口径）：动作出现在**已完成会话**的 m_sets 里。
   * 只认 completed：放弃的会话不算「练过」，否则中途放弃也会点亮地图。
   */
  function triedMap(store, memberId) {
    var done = {};
    store.all('m_sessions').forEach(function (s) {
      if (s.member_id !== memberId) return;
      if (s.status !== 'completed') return;
      done[s.session_id] = String(s.session_date || '');
    });
    var map = {};
    store.all('m_sets').forEach(function (r) {
      var d = done[r.session_id];
      if (d === undefined) return;
      var e = map[r.exercise_id];
      if (!e) { e = map[r.exercise_id] = { exercise_id: r.exercise_id, sets: 0, lastDate: '', volume: 0 }; }
      e.sets += 1;
      e.volume += numOr(r.weight, 0) * intOr(r.reps, 0);
      if (!e.lastDate || d > e.lastDate) e.lastDate = d;
    });
    return map;
  }

  function liveExercises(store) {
    return store.all('m_exercises').filter(function (ex) { return !deprecated(ex); });
  }

  /** 三维度统计：每个维度返回 [{key,label,total,done,level}] */
  function computeDimensions(store, tried) {
    var out = [];
    DIMENSIONS.forEach(function (d) {
      var keys = {};
      liveExercises(store).forEach(function (ex) {
        var ks = d.key === 'muscle' ? musclesOf(ex)
          : (d.key === 'pattern' ? [ex.movement_pattern] : [ex.difficulty]);
        ks.forEach(function (k) {
          if (!k) return;
          if (!keys[k]) keys[k] = { key: k, label: labelOf(d.key, k), total: 0, done: 0, exercises: [] };
          keys[k].total += 1;
          keys[k].exercises.push(ex.exercise_id);
          if (tried[ex.exercise_id]) keys[k].done += 1;
        });
      });
      var list = Object.keys(keys).map(function (k) {
        var it = keys[k];
        it.level = levelOf(d.key, it.done);
        it.percent = it.total ? Math.round(it.done / it.total * 1000) / 10 : 0;
        return it;
      });
      list.sort(function (a, b) {
        if (b.done !== a.done) return b.done - a.done;
        return String(a.key).localeCompare(String(b.key));
      });
      out.push({ key: d.key, label: d.label, keys: list });
    });
    return out;
  }

  function levelOf(dim, done) {
    var r = UNLOCK_RULE[dim] || { t2: 3, t1: 1 };
    if (done >= r.t2) return 2;
    if (done >= r.t1) return 1;
    return 0;
  }

  /* ================================================================ 探索：对外 API */

  function dimensions(store, memberId, opt) {
    opt = opt || {};
    var g = guard(store);
    if (!g.ok) return g;
    var tried = triedMap(store, memberId);
    var dims = computeDimensions(store, tried);
    var total = liveExercises(store).length;
    var doneN = Object.keys(tried).length;
    return {
      ok: true,
      dimensions: dims,
      summary: {
        totalExercises: total,
        triedExercises: doneN,
        percent: total ? Math.round(doneN / total * 1000) / 10 : 0,
        ruleVersion: RULE_VERSION
      }
    };
  }

  function findUnlock(store, memberId, code) {
    var hit = null;
    store.all('m_unlocks').forEach(function (u) {
      if (u.member_id === memberId && u.achievement_code === code) hit = u;
    });
    return hit;
  }

  /**
   * unlockScan(store, memberId, opt) —— 扫描并落解锁。
   * 幂等：已有同 code 的行只在层级提高时更新 tier，**绝不新增第二行**。
   * 不发 XP（理由见文件头第 1 条）。
   */
  function unlockScan(store, memberId, opt) {
    opt = opt || {};
    var g = guard(store);
    if (!g.ok) return g;
    var now = opt.now || nowStr();
    var tried = triedMap(store, memberId);
    var dims = computeDimensions(store, tried);
    var changed = [];

    dims.forEach(function (d) {
      d.keys.forEach(function (k) {
        if (k.level <= 0) return;
        var code = 'explore:' + d.key + ':' + k.key;
        var snap = JSON.stringify({
          dim: d.key, key: k.key, done: k.done, total: k.total, v: RULE_VERSION
        }).slice(0, 200);
        var row = findUnlock(store, memberId, code);

        if (!row) {
          var res = store.insert('m_unlocks', {
            unlock_id: store.nextId('m_unlocks'),
            member_id: memberId,
            achievement_code: code,
            tier: k.level,
            unlocked_at: now,
            biz_key: ('explore:' + memberId + ':' + code + '@' + RULE_VERSION).slice(0, 120),
            progress_snapshot: snap
          }, { actor: memberId });
          if (res.ok) changed.push({ code: code, tier: k.level, dim: d.key, key: k.key, isNew: true });
          return;
        }
        if (intOr(row.tier, 0) < k.level) {
          var up = store.update('m_unlocks', row.unlock_id, {
            tier: k.level, progress_snapshot: snap
          }, { actor: memberId });
          if (up.ok) changed.push({ code: code, tier: k.level, dim: d.key, key: k.key, isNew: false });
        }
      });
    });

    return { ok: true, changed: changed, ruleVersion: RULE_VERSION, scanned: Object.keys(tried).length };
  }

  /** 单个动作在会员这里的探索状态（供动作详情页展示「新手友好 / 练过几次」） */
  function exerciseState(store, memberId, exerciseId, opt) {
    opt = opt || {};
    var g = guard(store);
    if (!g.ok) return g;
    var ex = store.find('m_exercises', exerciseId);
    if (!ex) return fail('not_found', '未找到动作：' + exerciseId);
    var t = triedMap(store, memberId)[exerciseId] || null;
    var hasPR = store.all('m_records').some(function (r) {
      return r.member_id === memberId && r.exercise_id === exerciseId;
    });
    return {
      ok: true,
      exercise_id: exerciseId,
      name: ex.name,
      difficulty: ex.difficulty,
      beginnerFriendly: ex.difficulty === 'beginner',
      tried: !!t,
      sets: t ? t.sets : 0,
      lastDate: t ? t.lastDate : '',
      hasPR: hasPR
    };
  }

  /** 某个维度键下的已练 / 未练动作清单（点开维度看详情） */
  function dimensionDetail(store, memberId, dim, key, opt) {
    opt = opt || {};
    var g = guard(store);
    if (!g.ok) return g;
    if (!DIMENSIONS.some(function (d) { return d.key === dim; })) {
      return fail('bad_dimension', '维度只能是 muscle / pattern / difficulty');
    }
    var limit = intOr(opt.limit, 30);
    var tried = triedMap(store, memberId);
    var done = [], todo = [];
    liveExercises(store).forEach(function (ex) {
      var ks = dim === 'muscle' ? musclesOf(ex)
        : (dim === 'pattern' ? [ex.movement_pattern] : [ex.difficulty]);
      if (ks.indexOf(key) < 0) return;
      var t = tried[ex.exercise_id];
      var item = {
        exercise_id: ex.exercise_id, name: ex.name, difficulty: ex.difficulty,
        difficultyLabel: DIFF_LABEL[ex.difficulty] || ex.difficulty,
        equipment: ex.equipment, sets: t ? t.sets : 0, lastDate: t ? t.lastDate : '',
        beginnerFriendly: ex.difficulty === 'beginner'
      };
      (t ? done : todo).push(item);
    });
    var byDiff = function (a, b) {
      var ra = ['beginner', 'novice', 'intermediate', 'advanced'].indexOf(a.difficulty);
      var rb = ['beginner', 'novice', 'intermediate', 'advanced'].indexOf(b.difficulty);
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name));
    };
    done.sort(function (a, b) { return String(b.lastDate).localeCompare(String(a.lastDate)); });
    todo.sort(byDiff);
    return {
      ok: true, dim: dim, key: key, label: labelOf(dim, key),
      done: done.slice(0, limit), todo: todo.slice(0, limit),
      doneTotal: done.length, todoTotal: todo.length
    };
  }

  /* ================================================================ 灵感卡 */

  /** 会员可用器械是否覆盖这个动作 */
  function equipmentOk(profile, ex) {
    var list = String(profile.available_equipment || '').trim();
    if (!list) return ex.equipment === 'bodyweight';
    if (list.indexOf(ex.equipment) >= 0) return true;
    var alt = String(ex.equipment_alt || '');
    if (!alt) return false;
    var toks = list.split(/[、,，\s]+/);
    for (var i = 0; i < toks.length; i++) {
      if (toks[i] && alt.indexOf(toks[i]) >= 0) return true;
    }
    return false;
  }

  /** 伤病禁忌硬过滤：动作禁忌/注意里出现会员标注的任一标签就拿掉 */
  function blocked(profile, ex) {
    var lim = String(profile.limitations || '').trim();
    if (!lim) return false;
    var tags = lim.split(/[、,，\s]+/).filter(function (t) { return !!t; });
    var text = String(ex.contraindications || '') + ' ' + String(ex.caution_note || '');
    for (var i = 0; i < tags.length; i++) {
      if (text.indexOf(tags[i]) >= 0) return true;
    }
    return false;
  }

  function candidates(store, profile, item, card) {
    var diffs = card.difficulty || null;
    return liveExercises(store).filter(function (ex) {
      if (item.pattern && ex.movement_pattern !== item.pattern) return false;
      if (item.category && ex.category !== item.category) return false;
      if (!item.pattern && !item.category) return false;
      if (diffs && diffs.indexOf(ex.difficulty) < 0) return false;
      if (item.unilateral === true && ex.unilateral !== 'Y') return false;
      if (!equipmentOk(profile, ex)) return false;
      if (blocked(profile, ex)) return false;
      return true;
    });
  }

  /**
   * resolveCard(store, profile, card, opt) —— 把模板解析成具体动作。
   * 只要有一项解析不出动作，整张卡就作废（返回 ok:false, reason:'unresolved'），
   * 绝不降级成「随便塞个别的动作」，否则会员会拿到一个自己器械练不了的卡。
   */
  function resolveCard(store, profile, card, opt) {
    opt = opt || {};
    var seed = String(opt.seed || '');
    var items = [];
    var used = {};
    for (var i = 0; i < (card.items || []).length; i++) {
      var it = card.items[i];
      var list = candidates(store, profile, it, card);
      if (!list.length) return fail('unresolved', '没有可用动作：' + (it.pattern || it.category));
      var idx = hashStr(seed + card.code + (it.pattern || it.category)) % list.length;
      var pick = null;
      for (var k = 0; k < list.length; k++) {
        var cand = list[(idx + k) % list.length];
        if (!used[cand.exercise_id]) { pick = cand; break; }
      }
      if (!pick) return fail('unresolved', '动作不够用：' + card.code);
      used[pick.exercise_id] = 1;
      items.push({
        exercise_id: pick.exercise_id,
        name: pick.name,
        sets: clampInt(it.sets, 3, 1, 20),
        reps: clampInt(it.reps, 10, 1, 999),
        rest: clampInt(it.rest, 60, 0, 600),
        note: String(it.note || '')
      });
    }
    if (!items.length) return fail('unresolved', '模板没有可落地的内容');
    return {
      ok: true,
      code: card.code, title: card.title, desc: card.desc || '', reason: card.reason || '',
      minutes: intOr(card.minutes, 20), pool: card.pool || ['all'], source: 'builtin',
      ruleVersion: INSPIRE_RULE_VERSION, items: items
    };
  }

  /** 历史高效模板：最近一次「完成度高」的会话反推出来的重复练一遍 */
  function historyCard(store, memberId, opt) {
    opt = opt || {};
    var sess = store.all('m_sessions')
      .filter(function (s) { return s.member_id === memberId && s.status === 'completed'; })
      .sort(function (a, b) { return String(b.session_date).localeCompare(String(a.session_date)); });
    for (var i = 0; i < sess.length && i < 6; i++) {
      var s = sess[i];
      var byEx = {}, order = [];
      store.all('m_sets').forEach(function (r) {
        if (r.session_id !== s.session_id) return;
        if (!byEx[r.exercise_id]) { byEx[r.exercise_id] = { sets: 0, reps: [], exercise_id: r.exercise_id }; order.push(r.exercise_id); }
        byEx[r.exercise_id].sets += 1;
        byEx[r.exercise_id].reps.push(intOr(r.reps, 0));
      });
      if (order.length < 3) continue;
      var items = [];
      for (var j = 0; j < order.length && j < 6; j++) {
        var e = byEx[order[j]];
        var ex = store.find('m_exercises', e.exercise_id);
        if (!ex) continue;
        var reps = e.reps.filter(function (x) { return x > 0; });
        var mode = reps.length ? reps.sort()[Math.floor(reps.length / 2)] : 10;
        items.push({
          exercise_id: e.exercise_id, name: ex.name,
          sets: clampInt(e.sets, 3, 1, 20), reps: clampInt(mode, 10, 1, 999), rest: 60, note: ''
        });
      }
      if (items.length >= 3) {
        return {
          code: 'insp_history_repeat', title: '再练一遍你练得最好的那次',
          desc: '来自 ' + String(s.session_date) + ' 的训练记录',
          reason: '重复一次高完成度的训练，最容易找回节奏',
          minutes: 30, pool: ['all'], source: 'history',
          ruleVersion: INSPIRE_RULE_VERSION, items: items
        };
      }
    }
    return null;
  }

  /** 人群归类：优先用 xp.playerType（口径统一），取不到时本地兜底 */
  function playerTypeOf(store, memberId, opt) {
    opt = opt || {};
    var x = xp();
    if (x && typeof x.playerType === 'function') {
      var t = x.playerType(store, memberId, opt);
      if (t === 'beginner' || t === 'unstable' || t === 'veteran') return t;
    }
    var prof = store.find('m_profiles', memberId) || {};
    if (prof.player_type) return prof.player_type;
    if (prof.experience_level === 'newbie') return 'beginner';
    if (prof.experience_level === 'advanced') return 'veteran';
    return 'unstable';
  }

  /**
   * inspireCards(store, memberId, opt) —— 抽今天的灵感卡。
   * 确定性：同一会员同一天刷新结果不变（与每日任务同一套路），换一天才会换。
   */
  function inspireCards(store, memberId, opt) {
    opt = opt || {};
    var g = guard(store);
    if (!g.ok) return g;
    var prof = store.find('m_profiles', memberId) || {};
    var type = playerTypeOf(store, memberId, opt);
    var date = opt.today || todayStr();
    var seed = memberId + '|' + date;
    var count = clampInt(opt.count, 3, 1, 3);

    var pool = INSPIRE_POOL.filter(function (c) {
      return (c.pool || []).indexOf(type) >= 0 || (c.pool || []).indexOf('all') >= 0;
    });
    if (opt.includeHistory !== false) {
      var h = historyCard(store, memberId, opt);
      if (h) pool = pool.concat([h]);
    }

    var cards = [];
    for (var i = 0; i < pool.length; i++) {
      var c = pool[i];
      var r = c.source === 'history' ? c : resolveCard(store, prof, c, { seed: seed });
      if (!r || !r.ok) continue;
      if (c.source !== 'history') r.persona = type;
      cards.push(r);
    }
    cards.sort(function (a, b) { return hashStr(seed + a.code) - hashStr(seed + b.code); });

    return {
      ok: true, cards: cards.slice(0, count), persona: type, date: date,
      ruleVersion: INSPIRE_RULE_VERSION,
      hint: cards.length ? '' : '当前没有适合你器械与禁忌设置的灵感卡，换个器械或补充动作库后再看看'
    };
  }

  /**
   * cardToBag(store, memberId, bagId, card, opt) —— 把卡加进今日背包。
   * 只在你调用时写，没有任何自动触发。已在背包的同名动作跳过（不重复加）。
   */
  function cardToBag(store, memberId, bagId, card, opt) {
    opt = opt || {};
    var g = guard(store);
    if (!g.ok) return g;
    var P = plan();
    if (!P || typeof P.addToBag !== 'function') return fail('not_ready', '计划模块未就绪');
    if (!card || !card.items) return fail('bad_card', '缺少灵感卡内容');

    var added = [], skipped = [];
    for (var i = 0; i < card.items.length; i++) {
      var it = card.items[i];
      var exists = store.all('m_bag_items').some(function (b) {
        return b.bag_id === bagId && b.exercise_id === it.exercise_id;
      });
      if (exists) { skipped.push({ exercise_id: it.exercise_id, name: it.name, reason: 'already_in_bag' }); continue; }
      var r = P.addToBag(store, memberId, bagId, {
        source: 'template',
        exercise_id: it.exercise_id,
        target_sets: it.sets,
        target_reps: it.reps,
        target_rest_sec: it.rest
      }, opt);
      if (r.ok) added.push({ exercise_id: it.exercise_id, name: it.name, bag_item_id: (r.item && r.item.bag_item_id) || r.bag_item_id });
      else skipped.push({ exercise_id: it.exercise_id, name: it.name, reason: r.reason || 'failed' });
    }
    return { ok: true, added: added, skipped: skipped, bag_id: bagId };
  }

  /** cardToPlan(store, memberId, planId, dayOfWeek, card, opt) —— 把卡加进周计划某一天 */
  function cardToPlan(store, memberId, planId, dayOfWeek, card, opt) {
    opt = opt || {};
    var g = guard(store);
    if (!g.ok) return g;
    var P = plan();
    if (!P || typeof P.addPlanItem !== 'function') return fail('not_ready', '计划模块未就绪');
    if (!card || !card.items) return fail('bad_card', '缺少灵感卡内容');

    var added = [], skipped = [];
    for (var i = 0; i < card.items.length; i++) {
      var it = card.items[i];
      var exists = store.all('m_plan_items').some(function (p) {
        return p.plan_id === planId && p.day_of_week === dayOfWeek && p.exercise_id === it.exercise_id;
      });
      if (exists) { skipped.push({ exercise_id: it.exercise_id, name: it.name, reason: 'already_in_plan' }); continue; }
      var r = P.addPlanItem(store, memberId, planId, {
        day_of_week: dayOfWeek,
        exercise_id: it.exercise_id,
        target_sets: it.sets,
        target_reps: it.reps,
        target_rest_sec: it.rest,
        note: it.note || ('灵感卡：' + (card.title || ''))
      }, opt);
      if (r.ok) added.push({ exercise_id: it.exercise_id, name: it.name, plan_item_id: r.plan_item_id });
      else skipped.push({ exercise_id: it.exercise_id, name: it.name, reason: r.reason || 'failed' });
    }
    return { ok: true, added: added, skipped: skipped, plan_id: planId, day_of_week: dayOfWeek };
  }

  /* ================================================================ 导出 */

  return {
    RULE_VERSION: RULE_VERSION,
    INSPIRE_RULE_VERSION: INSPIRE_RULE_VERSION,
    DIMENSIONS: DIMENSIONS,
    UNLOCK_RULE: UNLOCK_RULE,
    INSPIRE_POOL: INSPIRE_POOL,
    DIFF_LABEL: DIFF_LABEL,
    PATTERN_LABEL: PATTERN_LABEL,

    dimensions: dimensions,
    unlockScan: unlockScan,
    exerciseState: exerciseState,
    dimensionDetail: dimensionDetail,

    inspireCards: inspireCards,
    resolveCard: resolveCard,
    historyCard: historyCard,
    cardToBag: cardToBag,
    cardToPlan: cardToPlan,
    playerTypeOf: playerTypeOf
  };
});


/* ===== ../src/js/fxp-member-growth.js ===== */
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


/* ===== ../03_AI教练/js/aic-config.js ===== */
/* Fitness XP — AI 动作教练：动作规则与阈值集中配置（UMD）
 *
 * 设计约束（任务书第六节）：
 *   1) 所有阈值/权重集中在本文件，页面与算法都不得硬编码数值；
 *   2) 每个动作一套规则对象，动作之间不共享阶段阈值；
 *   3) 阈值是"规则定义的可评估范围"，不是医学或运动安全标准，禁止对外表述为医学建议；
 *   4) ruleVersion 随任何阈值变更递增，训练记录会落库该版本，保证事后可追溯。
 *
 * 2026-10-18 扩展说明（AI 三大项 + 常见动作）：
 *   - 原实现只认「膝屈角」，只能跑徒手深蹲。现在每个动作自带 metric（主角度取自哪三个关键点），
 *     分析器按 metric 取角，状态机与评分逻辑完全复用，不再为某个动作写死关节。
 *   - 每个动作自带 monitor（监测等级 / 机位 / 必须可见部位 / 能算什么 / 明确不算什么）。
 *     等级只有 A / B / C 三档，页面一律读这里，禁止在页面里另写一套文案。
 *   - 本文件不声称能识别杠铃、配重或器械轨迹：卧推/硬拉只用人体关键点，
 *     凡是做不到的指标都写进 monitor.notMeasurable，由页面原样展示。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.aicConfig = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* MediaPipe Pose Landmarker 的 33 个关键点索引（BlazePose 拓扑）
   * 本阶段用到：躯干 4 点、下肢 10 点、上肢 6 点（肘/腕随三大项与手臂动作启用）。 */
  var LM = {
    NOSE: 0,
    LEFT_EAR: 7, RIGHT_EAR: 8,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_INDEX: 19, RIGHT_INDEX: 20,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    LEFT_HEEL: 29, RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32
  };

  /* ---------- 通用默认值（各动作只覆盖自己要改的部分） ---------- */

  var DEFAULT_CONFIDENCE = { minMeanVisibility: 0.55, goodMeanVisibility: 0.75 };
  var DEFAULT_FEEDBACK = {
    defaultCooldownMs: 6000,
    perCode: { VIEW_RECOMMEND: 120000, REP_COMPLETE: 0, DEPTH_SHORT: 3000 },
    consecutiveFrames: 8,
    maxTextLen: 24
  };
  var DEFAULT_SYMMETRY = { excellentDeg: 8, acceptableDeg: 15, poorDeg: 25 };

  /* 主角度类型：决定"取哪三个点算角"，以及 UI 上怎么称呼这个角度 */
  var METRIC_DEF = {
    knee:    { label: '膝屈角', minLabel: '最小膝屈角', maxLabel: '最大膝屈角',
               left: [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
               right: [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE] },
    hip:     { label: '髋角', minLabel: '最小髋角', maxLabel: '最大髋角',
               left: [LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE],
               right: [LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE] },
    elbow:   { label: '肘屈角', minLabel: '最小肘屈角', maxLabel: '最大肘屈角',
               left: [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST],
               right: [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST] },
    shoulder:{ label: '肩臂夹角', minLabel: '最小肩臂夹角', maxLabel: '最大肩臂夹角',
               left: [LM.LEFT_HIP, LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
               right: [LM.RIGHT_HIP, LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW] }
  };

  /** 按主角度类型生成 metric 段 */
  function metric(code) {
    var d = METRIC_DEF[code];
    if (!d) throw new Error('unknown_metric:' + code);
    return { code: code, label: d.label, minLabel: d.minLabel, maxLabel: d.maxLabel,
             joints: { left: d.left.slice(), right: d.right.slice() } };
  }

  /** 躯干维度默认「不评估」：只有机位合适且躯干角度有意义的动作才打开 */
  function torsoOff(reason) {
    return { maxLeanDeg: 40, noticeLeanDeg: 28, changeToleranceDeg: 12,
             evaluableViews: [], offReason: reason };
  }
  function torsoOn(maxLean, notice, change, views) {
    return { maxLeanDeg: maxLean, noticeLeanDeg: notice, changeToleranceDeg: change,
             evaluableViews: views || ['sagittal'], offReason: '' };
  }

  /** 幅度维度：mode=min 取本次最小角度（越小越深），mode=max 取最大角度（越大越充分） */
  function depthLevels(mode, rows) {
    return {
      mode: mode,
      levels: rows.map(function (r) {
        return { angle: r[0], score: r[1], level: r[2], label: r[3] };
      })
    };
  }

  /**
   * 生成一个动作规则对象。只传差异项，其余走默认值。
   * spec 必填：type / label / ruleVersion / metricCode / phase / depthRows / view / required / monitor
   */
  function makeRule(spec) {
    var m = metric(spec.metricCode);
    var joints = m.joints;
    var core = spec.coreJoints || (joints.left.concat(joints.right));
    return {
      exerciseType: spec.type,
      exerciseLabel: spec.label,
      ruleVersion: spec.ruleVersion,
      mediaSource: 'none',           // 不使用任何第三方图/像素材
      dataVersion: 1,

      view: spec.view,
      required: {
        core: core,
        torso: spec.torsoJoints || [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP]
      },
      minJointVisibility: spec.minJointVisibility || 0.5,

      metric: m,

      phase: {
        standAngle: spec.phase.stand,
        descendEnterAngle: spec.phase.descendEnter,
        bottomEnterAngle: spec.phase.bottomEnter,
        bottomExitAngle: spec.phase.bottomExit,
        debounceFrames: spec.phase.debounceFrames || 3,
        smoothAlpha: spec.phase.smoothAlpha || 0.45,
        minRepMs: spec.phase.minRepMs || 500,
        maxRepMs: spec.phase.maxRepMs || 10000,
        lossResetMs: spec.phase.lossResetMs || 1200,
        standingConfirmFrames: 2
      },

      depth: depthLevels(spec.depthMode || 'min', spec.depthRows),
      tempo: {
        minDescendMs: spec.tempo ? spec.tempo[0] : 500,
        maxDescendMs: spec.tempo ? spec.tempo[1] : 3500,
        reversalDeg: 7,
        maxReversals: 1,
        stabilityRatio: 0.55,
        minSampleReps: 3,
        descendLabel: spec.descendLabel || '下放时长',
        workingLabel: spec.workingLabel || '下放'
      },
      symmetry: spec.symmetry || DEFAULT_SYMMETRY,
      torso: spec.torso || torsoOff('该动作不评估躯干前倾'),
      confidence: spec.confidence || DEFAULT_CONFIDENCE,

      weights: spec.weights || { depth: 0.35, tempo: 0.20, symmetry: 0.20, torso: 0.25 },
      minEvaluableDims: spec.minEvaluableDims || 2,
      scoreCap: 100,

      feedback: spec.feedback || DEFAULT_FEEDBACK,

      /* 阶段中文名：状态机内部只用 standing/descending/bottom/ascending 四个 id，
       * 展示名按动作给，避免卧推也叫"下蹲中"。 */
      phaseLabels: spec.phaseLabels || {
        standing: '起始位', descending: '进行中', bottom: '最低点', ascending: '还原'
      },
      /* 复盘建议：只对"可评估且未达设定范围"的维度给出方向性提示，不给处方 */
      advice: spec.advice || {
        depth: '试着在一次练习里把幅度做得比上次稍充分一点，找到能稳定控制的范围后再放慢节奏。',
        tempo: '用心里数数的方式固定节奏，减少中途停顿。',
        symmetry: '留意两侧是否同步发力，站距或握距左右对齐。',
        torso: '保持躯干稳定，避免过程中角度突变。'
      },

      /* 监测能力声明：页面与动作库都读这一份，禁止各自硬编码 */
      monitor: spec.monitor
    };
  }

  /* ================= 1. 徒手深蹲（A 级，原有实现升级为通用配置） ================= */

  var SQUAT = makeRule({
    type: 'bodyweight_squat', label: '徒手深蹲', ruleVersion: 'squat-bw-2.0.0',
    metricCode: 'knee',
    phase: { stand: 152, descendEnter: 142, bottomEnter: 110, bottomExit: 125, debounceFrames: 3, smoothAlpha: 0.45 },
    depthMode: 'min',
    depthRows: [
      [95, 100, 'good', '下蹲深度达到设定范围'],
      [105, 82, 'ok', '深度接近设定范围'],
      [120, 60, 'partial', '深度不足设定范围'],
      [999, 35, 'poor', '下蹲幅度明显偏小']
    ],
    tempo: [500, 3500], descendLabel: '下蹲时长', workingLabel: '下蹲',
    torso: torsoOn(40, 28, 12, ['sagittal']),
    phaseLabels: { standing: '站立', descending: '下蹲中', bottom: '最低点', ascending: '起身' },
    advice: {
      depth: '试着在一次练习里把下蹲幅度做得比上次稍深一点，找到能稳定控制的深度后再放慢节奏。',
      tempo: '用心里数数的方式固定下蹲与起身节奏（例如下行 2 秒、起身 2 秒），减少中途停顿。',
      symmetry: '双脚站距与脚尖方向左右对齐，下蹲时留意两侧膝盖是否同步弯曲。',
      torso: '下蹲时保持视线与躯干方向一致，避免躯干过度前倾或角度突变。'
    },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '建议侧对摄像头站位，便于判断下蹲深度与躯干姿态'
    },
    monitor: {
      level: 'A',
      view: '侧面（矢状面）优先，正面可看膝与足的相对轨迹',
      mustVisible: ['髋', '膝', '踝', '肩'],
      measurable: ['下蹲幅度（最小膝屈角）', '单次节奏时长', '左右膝角差异', '侧面视角下的躯干前倾变化'],
      notMeasurable: ['膝关节内旋/内扣的真实三维角度', '足底压力分布', '脊柱实际屈曲角度', '负重重量'],
      limitations: [
        '单一二维视角不是三维测量：正面视角下"深度"会被压缩，不可作为深度结论',
        '深度以膝屈角近似，不等于髋关节实际屈曲角度',
        '穿着宽松、被器械或他人遮挡时会明显掉点'
      ],
      notes: '本动作是本原型中唯一经过完整合成序列 + 假摄像头端到端验证的动作'
    }
  });

  /* ================= 2. 卧推（B 级：只有人体关键点，不识杠铃） ================= */

  var BENCH = makeRule({
    type: 'bench_press', label: '卧推（杠铃/哑铃）', ruleVersion: 'bench-bw-1.0.0',
    metricCode: 'elbow',
    phase: { stand: 155, descendEnter: 145, bottomEnter: 105, bottomExit: 120, debounceFrames: 3, minRepMs: 600 },
    depthMode: 'min',
    depthRows: [
      [105, 100, 'good', '下放幅度达到设定范围'],
      [118, 82, 'ok', '幅度接近设定范围'],
      [132, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '下放幅度明显偏小']
    ],
    tempo: [600, 4000], descendLabel: '下放时长', workingLabel: '下放',
    phaseLabels: { standing: '手臂伸直', descending: '下放中', bottom: '最低点', ascending: '推起' },
    advice: {
      depth: '在肩部舒适的前提下把下放幅度做得比上次稍大一点，先找到能稳定控制的范围。',
      tempo: '下放与推起各用固定数数节奏，减少中途停顿。',
      symmetry: '留意两侧肘部是否同步伸展，握距左右对齐。',
      torso: ''
    },
    torso: torsoOff('卧推为仰卧姿态，"躯干前倾"指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    minEvaluableDims: 2,
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '建议从侧面或斜侧 45° 拍摄，必须能看到肩、肘、腕三点'
    },
    monitor: {
      level: 'B',
      view: '侧面或斜侧 45°，摄像头需与卧推凳同高或略高',
      mustVisible: ['肩', '肘', '腕', '躯干'],
      measurable: ['肘屈角变化推算的下放/推起幅度', '单次节奏时长', '左右肘角差异（需两侧同时可见）'],
      notMeasurable: [
        '杠铃或哑铃的实际位置与运行轨迹',
        '杠铃是否触胸',
        '实际负重重量',
        '握距与出杠轨迹',
        '肩关节健康相关结论'
      ],
      limitations: [
        '人体关键点不等于杠铃位置：本动作只用肩-肘-腕推算手臂动作，不推断器械',
        '仰卧姿态下 MediaPipe 关键点稳定性明显低于站姿，低置信度画面会只计数不给分',
        '卧推凳、保护架、杠铃片常遮挡肘腕，遮挡时该侧不参与计算'
      ],
      notes: '重量必须由会员手动填写，系统不声称能通过姿态识别重量'
    }
  });

  /* ================= 3. 硬拉（B 级：髋角近似，不识杠铃） ================= */

  var DEADLIFT = makeRule({
    type: 'deadlift', label: '硬拉', ruleVersion: 'deadlift-1.0.0',
    metricCode: 'hip',
    phase: { stand: 160, descendEnter: 150, bottomEnter: 100, bottomExit: 120, debounceFrames: 3, minRepMs: 800 },
    depthMode: 'min',
    depthRows: [
      [100, 100, 'good', '下放幅度达到设定范围'],
      [115, 82, 'ok', '幅度接近设定范围'],
      [135, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '下放幅度明显偏小']
    ],
    tempo: [800, 5000], descendLabel: '下放时长', workingLabel: '下放',
    phaseLabels: { standing: '站立锁定', descending: '下放中', bottom: '起始位', ascending: '拉起' },
    advice: {
      depth: '在下背部保持稳定的前提下把下放幅度做完整，先找到能稳定控制的范围。',
      tempo: '拉起与下放各用固定数数节奏，不要在下放阶段突然松劲。',
      symmetry: '留意两侧髋膝是否同步伸展，站距左右对齐。',
      torso: '全程保持躯干角度平稳变化，避免拉起过程中角度突变。'
    },
    torso: torsoOn(45, 32, 14, ['sagittal']),
    weights: { depth: 0.35, tempo: 0.20, symmetry: 0.20, torso: 0.25 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '必须侧对摄像头，且全身（头顶到脚）都在画面内'
    },
    monitor: {
      level: 'B',
      view: '正侧面，摄全身；正面或斜角过大时躯干维度自动标记为无法评估',
      mustVisible: ['肩', '髋', '膝', '踝'],
      measurable: ['髋角变化推算的下放/拉起幅度', '单次节奏时长', '左右髋角差异', '侧面视角下的躯干前倾'],
      notMeasurable: [
        '杠铃与身体的水平距离',
        '完整杠铃轨迹是否贴身',
        '实际负重重量',
        '脊柱屈伸角度与任何腰部受力结论',
        '锁定时肩髋是否完全对齐的精确判定'
      ],
      limitations: [
        '没有物体追踪：本动作只用人体关键点，不推断杠铃位置',
        '髋角为二维投影角，躯干旋转或站位偏斜时会失真',
        '杠铃片、护具、宽松衣物会造成关键点遮挡'
      ],
      notes: '重量手动填写；本系统不给出腰部或受伤风险相关的任何判断'
    }
  });

  /* ================= 4. 哑铃弯举（B 级） ================= */

  var CURL = makeRule({
    type: 'bicep_curl', label: '哑铃弯举', ruleVersion: 'curl-1.0.0',
    metricCode: 'elbow',
    phase: { stand: 150, descendEnter: 140, bottomEnter: 70, bottomExit: 85, debounceFrames: 3, minRepMs: 500 },
    depthMode: 'min',
    depthRows: [
      [70, 100, 'good', '屈肘幅度达到设定范围'],
      [85, 82, 'ok', '幅度接近设定范围'],
      [105, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '屈肘幅度明显偏小']
    ],
    tempo: [400, 3000], descendLabel: '弯举时长', workingLabel: '弯举',
    torso: torsoOff('弯举为局部动作，躯干前倾指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'frontal',
      recommendText: '正对或斜对摄像头，保证肩、肘、腕三点不被躯干遮挡'
    },
    monitor: {
      level: 'B',
      view: '正面或斜前 45°，手臂需在画面内不被躯干遮挡',
      mustVisible: ['肩', '肘', '腕'],
      measurable: ['肘屈角变化推算的弯举幅度', '单次节奏时长', '左右肘角差异'],
      notMeasurable: ['哑铃重量', '上臂是否贴紧躯干（肩后摆幅度）', '腕关节姿态'],
      limitations: [
        '只算肘屈角：耸肩、身体前后摆动等代偿动作无法识别',
        '手臂贴近躯干或被躯干遮挡时腕点容易丢失',
        '快速甩动会造成角度跳变，可能被判为未完成动作'
      ],
      notes: '重量手动填写'
    }
  });

  /* ================= 5. 肩上推举（B 级） ================= */

  var PRESS = makeRule({
    type: 'shoulder_press', label: '肩上推举', ruleVersion: 'press-1.0.0',
    metricCode: 'elbow',
    phase: { stand: 155, descendEnter: 145, bottomEnter: 95, bottomExit: 115, debounceFrames: 3, minRepMs: 600 },
    depthMode: 'min',
    depthRows: [
      [95, 100, 'good', '下放幅度达到设定范围'],
      [110, 82, 'ok', '幅度接近设定范围'],
      [128, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '下放幅度明显偏小']
    ],
    tempo: [600, 4000], descendLabel: '下放时长', workingLabel: '下放',
    torso: torsoOn(20, 12, 10, ['sagittal']),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    minEvaluableDims: 2,
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'frontal',
      recommendText: '正对或斜前 45° 拍摄，头顶以上需留出空间'
    },
    monitor: {
      level: 'B',
      view: '正面或斜前 45°，画面上沿要留出过头空间',
      mustVisible: ['肩', '肘', '腕'],
      measurable: ['肘屈角变化推算的推起幅度', '单次节奏时长', '左右肘角差异'],
      notMeasurable: ['杠铃/哑铃实际轨迹', '实际重量', '腰椎是否过度反弓', '过头稳定度'],
      limitations: [
        '手臂举过头顶时腕点易被画面裁切或掉点，掉点期间不计数',
        '站姿推举的腰部代偿无法由关键点判断',
        '坐姿时下半身关键点可能不可见，不影响本动作（只看上肢）'
      ],
      notes: '重量手动填写'
    }
  });

  /* ================= 6. 弓步蹲（B 级） ================= */

  var LUNGE = makeRule({
    type: 'lunge', label: '弓步蹲', ruleVersion: 'lunge-1.0.0',
    metricCode: 'knee',
    phase: { stand: 160, descendEnter: 150, bottomEnter: 110, bottomExit: 125, debounceFrames: 3, minRepMs: 700 },
    depthMode: 'min',
    depthRows: [
      [110, 100, 'good', '下蹲幅度达到设定范围'],
      [125, 82, 'ok', '幅度接近设定范围'],
      [140, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '下蹲幅度明显偏小']
    ],
    tempo: [700, 4000], descendLabel: '下蹲时长', workingLabel: '下蹲',
    torso: torsoOn(25, 15, 12, ['sagittal']),
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '侧对摄像头，两腿前后分开的方向要与镜头平行'
    },
    monitor: {
      level: 'B',
      view: '侧面，两腿前后分开的方向与镜头平行',
      mustVisible: ['髋', '双膝', '双踝'],
      measurable: ['下蹲幅度（最小膝屈角）', '单次节奏时长', '左右膝角差异'],
      notMeasurable: ['前后腿的负重分配', '步幅是否合适', '后膝是否触地的精确判定', '负重重量'],
      limitations: [
        '弓步是分腿动作，正面站位下两腿会互相遮挡',
        '本实现取两膝角度均值，无法区分前腿与后腿各自的角度',
        '躯干左右摇晃在二维视角下不易判断'
      ],
      notes: '重量手动填写'
    }
  });

  /* ================= 7. 俯卧撑（B 级） ================= */

  var PUSHUP = makeRule({
    type: 'push_up', label: '俯卧撑', ruleVersion: 'pushup-1.0.0',
    metricCode: 'elbow',
    phase: { stand: 155, descendEnter: 145, bottomEnter: 100, bottomExit: 120, debounceFrames: 4, minRepMs: 600, smoothAlpha: 0.4 },
    depthMode: 'min',
    depthRows: [
      [100, 100, 'good', '下放幅度达到设定范围'],
      [115, 82, 'ok', '幅度接近设定范围'],
      [135, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '下放幅度明显偏小']
    ],
    tempo: [500, 3500], descendLabel: '下放时长', workingLabel: '下放',
    torso: torsoOff('俯卧姿态下"躯干前倾"指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '摄像头放低到地面高度、侧对身体，能看到肩肘腕与躯干'
    },
    monitor: {
      level: 'B',
      view: '侧面且镜头贴近地面高度，全身需在画面内',
      mustVisible: ['肩', '肘', '腕', '髋或踝（用于确认身体姿态）'],
      measurable: ['肘屈角变化推算的下放幅度', '单次节奏时长', '左右肘角差异'],
      notMeasurable: ['身体是否成一条直线（腰是否塌）', '肩胛是否稳定', '胸部是否接近地面', '任何核心发力评估'],
      limitations: [
        '俯卧姿态下 MediaPipe 关键点稳定性显著下降，实测掉点率高',
        '地面视角很难同时拍到腕与踝，腕点丢失时该侧不参与',
        '本动作不做"身体是否成直线"的判断，需要人工确认'
      ],
      notes: '自重动作，无需填写重量'
    }
  });

  /* ================= 8. 臀桥（B 级，取最大髋角） ================= */

  var BRIDGE = makeRule({
    type: 'glute_bridge', label: '臀桥', ruleVersion: 'bridge-1.0.0',
    metricCode: 'hip',
    phaseLabels: { standing: '仰卧起始', descending: '顶起中', bottom: '最高点', ascending: '下落' },
    /* max 口径：起始位 = 仰卧屈膝（髋角小），做功方向 = 顶髋让髋角变大。
     * 所以这里 stand 是**小角度**，bottomEnter 是**大角度**，与深蹲正好相反。 */
    phase: { stand: 125, descendEnter: 135, bottomEnter: 158, bottomExit: 148, debounceFrames: 3, minRepMs: 700 },
    depthMode: 'max',
    /* 档位按"完整顶髋时肩-髋-膝接近一条直线（≈165~175）"往下排 */
    depthRows: [
      [158, 100, 'good', '顶髋幅度达到设定范围'],
      [145, 82, 'ok', '幅度接近设定范围'],
      [130, 60, 'partial', '幅度不足设定范围'],
      [0, 35, 'poor', '顶髋幅度明显偏小']
    ],
    tempo: [600, 4000], descendLabel: '顶起时长', workingLabel: '顶起',
    torso: torsoOff('臀桥为仰卧顶髋，"躯干前倾"指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '侧对摄像头放低机位，能看到肩、髋、膝三点'
    },
    monitor: {
      level: 'B',
      view: '侧面低机位，肩-髋-膝需同时可见',
      mustVisible: ['肩', '髋', '膝'],
      measurable: ['顶髋幅度（最大髋角）', '单次节奏时长', '左右髋角差异'],
      notMeasurable: ['骨盆是否后倾', '腰椎是否过度伸展', '臀部实际发力程度', '负重重量'],
      limitations: [
        '本动作评价的是"顶起时髋角最大值"，不是医学上的髋关节伸展角度',
        '仰卧且屈膝时髋点易被大腿遮挡',
        '不提供腰部或骨盆姿态的任何结论'
      ],
      notes: '重量手动填写（杠铃臀桥）'
    }
  });

  /* ================= 9. 俯身划船（B 级） ================= */

  var ROW = makeRule({
    type: 'bent_over_row', label: '俯身划船', ruleVersion: 'row-1.0.0',
    metricCode: 'elbow',
    phase: { stand: 150, descendEnter: 140, bottomEnter: 75, bottomExit: 95, debounceFrames: 3, minRepMs: 600 },
    depthMode: 'min',
    depthRows: [
      [75, 100, 'good', '屈肘幅度达到设定范围'],
      [90, 82, 'ok', '幅度接近设定范围'],
      [110, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '屈肘幅度明显偏小']
    ],
    tempo: [500, 3500], descendLabel: '拉起时长', workingLabel: '拉起',
    torso: torsoOn(55, 40, 15, ['sagittal']),
    weights: { depth: 0.40, tempo: 0.20, symmetry: 0.30, torso: 0.10 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '侧对或斜后 45° 拍摄，能看到肩、肘、腕与躯干倾斜'
    },
    monitor: {
      level: 'B',
      view: '侧面或斜后 45°，躯干倾斜方向需与镜头大致平行',
      mustVisible: ['肩', '肘', '腕', '髋'],
      measurable: ['肘屈角变化推算的拉起幅度', '单次节奏时长', '左右肘角差异', '躯干倾斜角的粗略变化'],
      notMeasurable: ['杠铃/哑铃轨迹', '实际重量', '肩胛后缩幅度', '脊柱中立位的精确判定'],
      limitations: [
        '俯身姿态下腕点常被大腿或器械遮挡',
        '躯干倾斜角为二维近似，不是真实的髋屈角度',
        '不判断动作是否"标准"，只给出与规则设定范围的偏差'
      ],
      notes: '重量手动填写'
    }
  });

  /* ================= 10. 侧平举（B 级，取最大肩臂夹角） ================= */

  var LATERAL = makeRule({
    type: 'lateral_raise', label: '哑铃侧平举', ruleVersion: 'lateral-1.0.0',
    metricCode: 'shoulder',
    phaseLabels: { standing: '双臂下垂', descending: '抬起中', bottom: '最高点', ascending: '下落' },
    /* max 口径：起始位 = 双臂自然下垂（肩臂夹角小），做功方向 = 抬起让夹角变大。 */
    phase: { stand: 38, descendEnter: 48, bottomEnter: 80, bottomExit: 68, debounceFrames: 3, minRepMs: 500 },
    depthMode: 'max',
    /* 抬到水平附近 ≈ 90°，档位从 80 往下排 */
    depthRows: [
      [80, 100, 'good', '抬起幅度达到设定范围'],
      [68, 82, 'ok', '幅度接近设定范围'],
      [55, 60, 'partial', '幅度不足设定范围'],
      [0, 35, 'poor', '抬起幅度明显偏小']
    ],
    tempo: [400, 3000], descendLabel: '抬起时长', workingLabel: '抬起',
    torso: torsoOff('侧平举为局部动作，躯干前倾指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'frontal',
      recommendText: '正对摄像头，两臂抬起的平面尽量与画面平行'
    },
    monitor: {
      level: 'B',
      view: '正面，两臂运动平面尽量与画面平行',
      mustVisible: ['肩', '肘', '髋（用于计算肩臂夹角）'],
      measurable: ['肩臂夹角的最大值（抬起幅度）', '单次节奏时长', '左右抬起幅度差异'],
      notMeasurable: ['哑铃重量', '是否耸肩', '肩关节内旋/外旋状态', '三角肌发力程度'],
      limitations: [
        '肩臂夹角为二维投影：两臂前后抬（不在画面平面内）时会明显低估',
        '耸肩代偿无法由关键点识别',
        '腕点不参与本动作计算，哑铃是否被看到不影响结果'
      ],
      notes: '重量手动填写'
    }
  });

  /* ================= 11. 引体向上（B 级） ================= */

  var PULLUP = makeRule({
    type: 'pull_up', label: '引体向上', ruleVersion: 'pullup-1.0.0',
    metricCode: 'elbow',
    phase: { stand: 150, descendEnter: 140, bottomEnter: 80, bottomExit: 100, debounceFrames: 3, minRepMs: 900 },
    depthMode: 'min',
    depthRows: [
      [80, 100, 'good', '拉起幅度达到设定范围'],
      [95, 82, 'ok', '幅度接近设定范围'],
      [115, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '拉起幅度明显偏小']
    ],
    tempo: [700, 4500], descendLabel: '拉起时长', workingLabel: '拉起',
    torso: torsoOff('悬垂姿态下"躯干前倾"指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'frontal',
      recommendText: '正对或斜前 45° 拍摄，画面上沿要留出单杠与头部空间'
    },
    monitor: {
      level: 'B',
      view: '正面或斜前 45°，画面需包含单杠与整个身体',
      mustVisible: ['肩', '肘', '腕'],
      measurable: ['肘屈角变化推算的拉起幅度', '单次节奏时长', '左右肘角差异'],
      notMeasurable: ['下巴是否过杠', '实际负重（自重/负重腰带/辅助配重）', '摆动借力（kipping）判定', '握距与握法'],
      limitations: [
        '没有物体追踪：不识别单杠位置，因此无法判断"下巴过杠"',
        '身体摆动或借力会造成角度异常，可能被判为未完成动作',
        '头部高于画面上沿时关键点会整段丢失'
      ],
      notes: '辅助配重与负重需手动填写'
    }
  });

  /* ================= 12. 高位下拉（B 级） ================= */

  var PULLDOWN = makeRule({
    type: 'lat_pulldown', label: '高位下拉', ruleVersion: 'pulldown-1.0.0',
    metricCode: 'elbow',
    phase: { stand: 150, descendEnter: 140, bottomEnter: 80, bottomExit: 100, debounceFrames: 3, minRepMs: 800 },
    depthMode: 'min',
    depthRows: [
      [80, 100, 'good', '下拉幅度达到设定范围'],
      [95, 82, 'ok', '幅度接近设定范围'],
      [115, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '下拉幅度明显偏小']
    ],
    tempo: [600, 4000], descendLabel: '下拉时长', workingLabel: '下拉',
    torso: torsoOff('坐姿下拉的躯干前倾指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'frontal',
      recommendText: '正对或斜前 45° 拍摄，需能看到肩、肘、腕'
    },
    monitor: {
      level: 'B',
      view: '正面或斜前 45°，需看到肩肘腕',
      mustVisible: ['肩', '肘', '腕'],
      measurable: ['肘屈角变化推算的下拉幅度', '单次节奏时长', '左右肘角差异'],
      notMeasurable: ['配重片重量', '握把轨迹', '躯干后仰幅度', '肩胛下沉幅度'],
      limitations: [
        '不识别器械：绳索与配重均不在识别范围内',
        '躯干后仰会造成关键点整体位移，可能被误判为幅度变化',
        '座位与器械框架常遮挡肘部'
      ],
      notes: '配重需手动填写'
    }
  });

  /* ================= 13. 卷腹 / 仰卧起坐（B 级，核心部位唯一接入动作） ================= */

  var SITUP = makeRule({
    type: 'sit_up', label: '卷腹（仰卧起坐）', ruleVersion: 'situp-1.0.0',
    metricCode: 'hip',
    phaseLabels: { standing: '仰卧起始', descending: '卷起中', bottom: '最高点', ascending: '躺回' },
    /* 仰卧平躺时肩-髋-膝接近一条直线（≈180），卷起后夹角明显变小。
     * 用的是"髋角"这同一个 metric，不需要为新动作改算法。 */
    phase: { stand: 168, descendEnter: 155, bottomEnter: 105, bottomExit: 125, debounceFrames: 3, minRepMs: 800 },
    depthMode: 'min',
    depthRows: [
      [110, 100, 'good', '卷起幅度达到设定范围'],
      [125, 82, 'ok', '幅度接近设定范围'],
      [140, 60, 'partial', '幅度不足设定范围'],
      [999, 35, 'poor', '卷起幅度明显偏小']
    ],
    tempo: [600, 4000], descendLabel: '卷起时长', workingLabel: '卷起',
    /* 仰卧位下"躯干前倾"这个指标没有意义（平躺时躯干本就水平），必须显式关掉，
     * 否则躯干维度会恒定报"前倾超出范围"，等于凭空捏造一个不存在的错误。 */
    torso: torsoOff('卷腹/仰卧起坐为仰卧位动作，"躯干前倾"指标不适用'),
    weights: { depth: 0.40, tempo: 0.25, symmetry: 0.35, torso: 0 },
    view: {
      frontalRatio: 1.10, sagittalRatio: 0.62, minVisibility: 0.5,
      recommended: 'sagittal',
      recommendText: '侧对摄像头放低机位，能看到肩、髋、膝三点'
    },
    monitor: {
      level: 'B',
      view: '侧面低机位，肩-髋-膝需同时可见',
      mustVisible: ['肩', '髋', '膝'],
      measurable: ['由髋角变化推算的卷起幅度', '单次节奏时长', '左右髋角差异'],
      notMeasurable: ['颈部是否发力', '腰椎受力与腰部是否离地', '脚是否固定与是否借力',
                      '腹肌实际发力程度', '负重重量'],
      limitations: [
        '本动作评价的是"肩-髋-膝夹角的变化范围"，不是腹肌激活程度',
        '仰卧位下髋点常被手臂或大腿遮挡',
        '不提供腰部、颈椎受力或任何医学结论'
      ],
      notes: '负重需手动填写'
    }
  });

  /* ---------- 注册表 ---------- */

  var RULES = {};
  [SQUAT, BENCH, DEADLIFT, CURL, PRESS, LUNGE, PUSHUP, BRIDGE, ROW, LATERAL, PULLUP, PULLDOWN, SITUP]
    .forEach(function (r) { RULES[r.exerciseType] = r; });

  /** 对外顺序：三大项在前，其余按可观测性排列；页面菜单直接按这个顺序渲染 */
  var RULE_LIST = ['bodyweight_squat', 'bench_press', 'deadlift', 'lunge', 'push_up',
                   'bent_over_row', 'lat_pulldown', 'pull_up', 'shoulder_press',
                   'bicep_curl', 'lateral_raise', 'glute_bridge', 'sit_up'];

  var LEVEL_TEXT = {
    A: 'AI 可监测',
    B: '有限监测',
    C: '暂不支持监测（手动记录）'
  };

  /**
   * 取某个动作的监测能力声明。没有配置的动作一律 C 级——
   * 这是"不在菜单里就不许宣称支持"的唯一判定入口。
   */
  function getMonitor(exerciseType) {
    var r = RULES[exerciseType];
    if (!r) {
      return {
        level: 'C',
        view: '',
        mustVisible: [],
        measurable: [],
        notMeasurable: ['本动作未接入摄像头监测'],
        limitations: ['可在动作库查看教学说明，训练重量与次数需手动记录'],
        notes: ''
      };
    }
    return r.monitor;
  }

  /**
   * 浅合并式规则覆盖（只覆盖传入键），用于"按会员/按门店微调阈值"。
   * 不修改原对象，返回新对象——避免运行期改阈值污染历史记录的规则版本语义。
   */
  function mergeRules(base, override) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (!override) return out;
    for (k in override) {
      if (!Object.prototype.hasOwnProperty.call(override, k)) continue;
      var v = override[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        var sub = {};
        var s;
        for (s in out[k]) if (Object.prototype.hasOwnProperty.call(out[k], s)) sub[s] = out[k][s];
        for (s in v) if (Object.prototype.hasOwnProperty.call(v, s)) sub[s] = v[s];
        out[k] = sub;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function getRules(exerciseType, override) {
    var base = RULES[exerciseType];
    if (!base) return null;
    return override ? mergeRules(base, override) : base;
  }

  /* 全局免责 / 边界说明：任何对外展示都必须带上，禁止删减 */
  var DISCLAIMER = [
    '本评价由本地规则基于二维关键点计算得出，不等于三维关节角度测量，也不代表肌骨负荷或受伤风险。',
    '结果受体型、活动度、着装、摄像头机位与画质影响；不同人之间的分数不具可比性。',
    '本评分仅用于训练反馈参考，不能作为专业教练评估或医疗诊断的替代。',
    '系统不识别杠铃/哑铃/器械与配重，重量一律由会员手动填写。'
  ].join('');

  /* 一眼可见的"识别"与"质量"区别说明 */
  var METRIC_NOTE = {
    detection: '识别成功率：成功稳定追踪身体的画面占比，只反映"看没看清"。',
    quality: '动作质量评分：在可信画面基础上，按规则给出的评分，已剔除无法可靠判断的维度。'
  };

  /* 监测等级说明（页面与动作库共用同一份文案） */
  var LEVEL_NOTE = {
    A: 'A 级：在指定机位与身体可见条件下，可完成阶段识别与次数计数，并通过合成序列与端到端测试。',
    B: 'B 级：可获取部分运动信息，部分指标受机位、遮挡与模型精度限制；未列出的指标一律不做判断。',
    C: 'C 级：不提供摄像头监测，可在动作库查看教学说明，重量/次数/组数由手动记录。'
  };

  return {
    LM: LM,
    METRIC_DEF: METRIC_DEF,
    RULES: RULES,
    RULE_LIST: RULE_LIST,
    SQUAT: SQUAT,
    BENCH: BENCH,
    DEADLIFT: DEADLIFT,
    getRules: getRules,
    getMonitor: getMonitor,
    mergeRules: mergeRules,
    LEVEL_TEXT: LEVEL_TEXT,
    LEVEL_NOTE: LEVEL_NOTE,
    DISCLAIMER: DISCLAIMER,
    METRIC_NOTE: METRIC_NOTE
  };
});


/* ===== js/member.js ===== */
/* Fitness XP 会员端 V2 — 应用层（hash 路由 + 页面渲染）
 *
 * 加载顺序（见 index.html）：csv → validate → engine → member-schema → member-store
 *                          → member-seed → member-identity → 本文件
 *
 * 独立性原则（决策 Q14=A）：本端不依赖教练端任何数据即可完成注册与全部训练功能。
 * 在册判定（Q16=A）只读教练端 members 投影，读写本端数据一律走 fxp-member 键。
 */
(function () {
  'use strict';

  var W = window;
  var MSCH = W.FXP.memberSchema;
  var MST = W.FXP.memberStore;
  var IDN = W.FXP.memberIdentity;
  var SEED = W.FXP.memberSeed;
  var GOAL = W.FXP.memberGoal;
  var PLAN = W.FXP.memberPlan;
  var SES = W.FXP.memberSession;
  var XP = W.FXP.memberXp;
  /* 阶段7：探索/灵感卡（EX）、成长/高级调整（GR）。
     GR 依赖 EX 的人群判定，所以 script 顺序必须是 explore → growth（见 index.html）。 */
  var EX = W.FXP.memberExplore;
  var GR = W.FXP.memberGrowth;
  var CSV = W.FXP;                      /* fxp-csv 在浏览器端散开到 FXP 根对象 */

  var store = null;
  var gate = null;
  /* 会话上下文：只存 sessionStorage，不写会员数据表 */
  var ctx = { member_id: '', name: '', verified: false };
  var SS_KEY = 'fxp-member-session';

  /* ---------------------------------------------------------------- 基础工具 */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function dab(str) { return str == null ? '' : String(str); }
  function has(v) { return !(v == null || String(v).trim() === ''); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function now() {
    var d = new Date();
    return today() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
      + ':' + ('0' + d.getSeconds()).slice(-2);
  }

  /* ---------------------------------------------------------------- 提示与落盘 */

  var toastTimer = null;
  /**
   * 全局轻提示。
   * 之所以单独做一层而不是每页各写一个提示节点：写盘失败可能在任何页面发生，
   * 而「静默丢数据」是本轮明确要杜绝的事（03 §数据完整性）。
   */
  function toast(msg, kind, ms) {
    var el = $('mToast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.className = 'm-toast m-toast-' + (kind || 'info');
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 3200);
  }

  /**
   * 落盘。写盘失败必须让用户看见，并给出「导出备份」的下一步（store.save 的报错文案已含此提示）。
   * 返回 true 表示写成功了。
   */
  function persist() {
    var r = store.save();
    if (r && r.ok === false) {
      toast(r.message || '保存失败，请导出备份', 'err', 6000);
      return false;
    }
    return true;
  }

  /** 统一的「执行 + 失败提示 + 落盘」包装：领域层返回 {ok, reason, message} */
  function run(res, okMsg) {
    if (!res || res.ok === false) {
      toast((res && (res.message || res.reason)) || '操作未成功', 'err', 5000);
      return false;
    }
    persist();
    if (okMsg) toast(okMsg, 'ok');
    return true;
  }

  /**
   * 让「写操作」按钮走完 处理中 → 成功 两个可见状态。
   *
   * 两个目的：
   *   1. 防重复提交。按钮一旦进入 disabled，再快的手速也点不进第二次；
   *      纯靠「点完就 render」挡不住连点——渲染是同步的，两次点击之间没有空隙。
   *   2. 给反馈。只换颜色不告诉用户结果等于没反馈；这里成功态会显示一段文案再复原。
   *
   * 用 setTimeout 让浏览器先把 spinner 画出来再跑重活，否则同步长任务期间
   * 界面一直是上一帧，用户看不到任何变化。
   *
   * fn 返回 false 视为失败：按钮直接复原，不显示成功态（失败原因由 toast 负责）。
   */
  function runBusy(btn, doingText, fn, okText) {
    if (!btn || btn.disabled) return;
    var old = btn.textContent;
    btn.disabled = true;
    btn.classList.add('m-btn-loading');
    btn.textContent = doingText || '处理中…';
    setTimeout(function () {
      var ok = false;
      try { ok = fn() !== false; }
      catch (e) { toast('操作出错：' + (e && e.message ? e.message : e), 'err', 6000); ok = false; }
      btn.disabled = false;
      btn.classList.remove('m-btn-loading');
      if (!ok) { btn.textContent = old; return; }
      btn.classList.add('m-btn-done');
      btn.textContent = okText || old;
      setTimeout(function () {
        btn.classList.remove('m-btn-done');
        btn.textContent = old;
      }, 1400);
    }, 30);
  }

  /* ---------------------------------------------------------------- 会话上下文 */

  /* 注意：ctx 一律原地修改，绝不整体重新赋值。
     因为 W.FXPM.ctx 持有的是同一个对象引用；若用 `ctx = {...}` 重赋值，
     对外暴露的引用会永久指向旧对象（注册/核验后读到空 member_id）。 */
  function setCtx(memberId, name, verified) {
    ctx.member_id = memberId || '';
    ctx.name = name || '';
    ctx.verified = !!verified;
  }
  function saveCtx() {
    try { sessionStorage.setItem(SS_KEY, JSON.stringify(ctx)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function loadCtx() {
    try {
      var raw = sessionStorage.getItem(SS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.member_id) setCtx(o.member_id, o.name || '', true);
    } catch (e) { /* 忽略 */ }
  }
  function clearCtx() {
    setCtx('', '', false);
    try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------------- 路由 */

  /* 形如 #route/id 的两段式路由。新增这类路由时只改这里。 */
  var ID_ROUTES = ['exercise', 'session', 'workout', 'summary'];

  function parseHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return { route: 'home', id: '', q: {} };
    var parts = h.split('?');
    var seg = parts[0].split('/');
    var q = {};
    if (parts[1]) {
      parts[1].split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0]) q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
      });
    }
    /* 带 ID 的两段式路由（#workout/WS0001）。
       早期版本逐个 if 列举，漏了 #summary → 结算页拿到的 id 是空串，
       页面只好显示「没有找到这次训练」。改成查表，新增路由不会再漏。 */
    if (seg.length >= 2 && ID_ROUTES.indexOf(seg[0]) >= 0) {
      return { route: seg[0], id: seg[1], q: q };
    }
    return { route: seg[0], id: '', q: q };
  }

  function go(hash) { location.hash = hash; }

  /* 加新路由必须同时改这里和 render() 的分支：只改分支不改白名单，
     targetRoute() 会静默把请求回落到 #home —— 页面看着正常，其实根本没进去。 */
  var KNOWN = ['home', 'register', 'verify', 'profile', 'exercises', 'exercise',
    'settings', 'goals', 'plan', 'bag', 'workout', 'summary', 'history', 'session',
    'growth', 'quick', 'explore'];

  function targetRoute() {
    var r = parseHash();
    if (KNOWN.indexOf(r.route) < 0) return { route: 'home', id: '', q: r.q };
    /* 规则 2：#register 永远可达，否则新用户被死锁 */
    if (r.route === 'register') return r;
    /* 规则 1.5：本端没有任何会员记录 → 引导注册 */
    if (r.route !== 'verify' && store.count('m_profiles') === 0) return { route: 'register', id: '', q: {} };
    /* 规则 2：未核验 → 拦到 #verify */
    if (!ctx.verified) return { route: 'verify', id: '', q: {} };
    return r;
  }

  /* ---------------------------------------------------------------- 顶部与底栏 */

  function renderChrome() {
    var st = $('mStoreState');
    if (st) {
      st.textContent = ctx.verified
        ? '会员 ' + ctx.member_id + ' · 本机存储'
        : '未核验 · 本机存储';
    }
    var right = $('mTopRight');
    if (right) {
      /* 名字可能很长：CSS 已经做了 max-width + ellipsis，这里补 title，
         让人能把截断的名字看全（CSS 注释里说的 title 就是这一处）。 */
      right.innerHTML = ctx.verified
        ? '<span class="m-chip" title="' + esc(ctx.name || ctx.member_id) + '">'
          + esc(ctx.name || ctx.member_id) + '</span>'
          + '<button class="m-linkbtn" id="btnLogout">切换会员</button>'
        : '';
    }
    var tab = $('mTabbar');
    if (tab) {
      if (!ctx.verified) { tab.hidden = true; tab.innerHTML = ''; return; }
      tab.hidden = false;
      var r = parseHash().route;
      /* 四个核心入口（视觉要求 §4）：今日 / 计划 / 动作库 / 我的。
         计划与我的各自覆盖一组子路由，用 tabGroup 归组后再判定高亮。 */
      var items = [
        { k: 'home', t: '今日' },
        { k: 'plan', t: '计划', group: ['plan', 'bag'] },
        { k: 'exercises', t: '动作库', group: ['exercises', 'exercise'] },
        { k: 'profile', t: '我的', group: ['profile', 'goals', 'growth', 'history', 'settings'] }
      ];
      tab.innerHTML = items.map(function (it) {
        var on = (it.group ? it.group.indexOf(r) >= 0 : r === it.k);
        return '<button class="m-tab' + (on ? ' m-tab-on' : '')
          + '" data-nav="' + it.k + '">' + it.t + '</button>';
      }).join('');
    }
  }

  /* ---------------------------------------------------------------- 页面：自助注册 */

  function pageRegister() {
    return ''
      + '<section class="m-card m-card-blue">'
      + '<div class="m-card-h"><h2>自助注册</h2>'
      + '<span class="m-pill">会员端独立可用</span></div>'
      + '<p class="m-p">不需要教练录入，注册后即可独立使用会员端的全部功能。'
      + '系统会自动给你一个 <b>S 开头</b>的会员号（如 S0001）。</p>'
      + '<div class="m-form">'
      + '<label class="m-fld"><span>姓名或昵称 <b class="m-req">*</b></span>'
      + '<input id="regName" type="text" maxlength="30" autocomplete="off" placeholder="例如：李四"></label>'
      + '<label class="m-fld"><span>手机号 <b class="m-req">*</b></span>'
      + '<input id="regPhone" type="tel" inputmode="numeric" maxlength="11" autocomplete="off" placeholder="11 位手机号"></label>'
      + '<label class="m-fld"><span>本地口令（选填）</span>'
      + '<input id="regPin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" placeholder="4-8 位数字，留空表示不启用">'
      + '<em class="m-tip">启用后，进入会员端时除会员号外还需输入该口令。</em></label>'
      + '<label class="m-fld"><span>训练基础</span><select id="regLevel">'
      + opt(['newbie', 'novice', 'intermediate', 'advanced'], ['零基础', '新手', '有一定基础', '资深'], 'newbie')
      + '</select></label>'
      + '<label class="m-fld"><span>主要目标</span><select id="regGoal">'
      + opt(['fat_loss', 'muscle_gain', 'strength', 'health', 'posture', 'rehab'],
        ['减脂', '增肌', '力量', '健康体能', '体态改善', '康复'], 'health')
      + '</select></label>'
      + '</div>'
      + '<div class="m-msg" id="regMsg"></div>'
      + '<div class="m-btn-row"><button class="m-btn m-btn-primary" id="btnReg">注册并进入</button>'
      + '<button class="m-btn m-btn-ghost" id="btnRegToVerify">我已有会员号</button></div>'
      + '</section>'
      + '<section class="m-card"><div class="m-card-h"><h2>注册说明</h2></div>'
      + '<ul class="m-list">'
      + '<li>本注册<b>只在本设备生效</b>，不上传、不与任何账号系统打通；换设备不会同步。</li>'
      + '<li>口令仅保存在本机且为哈希存储，<b>无法找回</b>；清除浏览器数据即不可恢复。</li>'
      + '<li>注册后如需与教练端打通，请让教练在教练端添加你（姓名与手机号一致即可自动关联）。</li>'
      + '</ul></section>';
  }

  function opt(vals, labels, sel) {
    return vals.map(function (v, i) {
      return '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + labels[i] + '</option>';
    }).join('');
  }

  function bindRegister() {
    var btn = $('btnReg');
    if (!btn) return;
    btn.addEventListener('click', function () {
      runBusy(btn, '正在建档…', function () {
        var msg = $('regMsg');
        var r = IDN.register(store, {
          name: $('regName').value,
          phone: $('regPhone').value,
          pin: $('regPin').value,
          experience_level: $('regLevel').value,
          primary_goal: $('regGoal').value
        }, { now: now });
        if (!r.ok) {
          msg.className = 'm-msg m-msg-err';
          msg.innerHTML = '注册未通过：<br>' + (r.errors || [r.message || r.reason]).map(esc).join('<br>');
          return false;
        }
        /* 新会员首次进入：载入内置动作库，保证功能开箱即用（决策 Q4=A） */
        IDN.loadSeed(store);
        store.save();
        setCtx(r.member_id, $('regName').value, true);
        saveCtx();
        go('#profile');
        return true;
      }, '已建档');
    });
    var toV = $('btnRegToVerify');
    if (toV) toV.addEventListener('click', function () { go('#verify'); });
  }

  /* ---------------------------------------------------------------- 页面：身份核验 */

  function pageVerify() {
    var st = gate ? gate.state() : { locked: false, remainSec: 0 };
    var list = store.all('m_profiles');
    return ''
      + '<section class="m-card m-card-blue">'
      + '<div class="m-card-h"><h2>身份核验</h2>'
      + '<span class="m-pill">' + list.length + ' 位会员本机已存</span></div>'
      + '<p class="m-p">用于区分训练记录的归属，<b>不是登录鉴权</b>。</p>'
      + '<div class="m-form">'
      + '<label class="m-fld"><span>会员号</span>'
      + '<input id="vfId" type="text" maxlength="8" autocomplete="off" placeholder="M0001 或 S0001"></label>'
      + '<label class="m-fld"><span>手机号后 4 位</span>'
      + '<input id="vfPhone4" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 位数字"></label>'
      + '<label class="m-fld"><span>本地口令（若已设置）</span>'
      + '<input id="vfPin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="没有设置可留空"></label>'
      + '</div>'
      + '<div class="m-msg' + (st.locked ? ' m-msg-err' : '') + '" id="vfMsg">'
      + (st.locked ? '连续 5 次核验失败，请 ' + st.remainSec + ' 秒后再试' : '') + '</div>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn m-btn-primary" id="btnVerify"' + (st.locked ? ' disabled' : '') + '>核验并进入</button>'
      + '<button class="m-btn m-btn-ghost" id="btnGoRegister">自助注册</button></div>'
      + '</section>'
      + '<section class="m-card"><div class="m-card-h"><h2>本机已存会员</h2></div>'
      + (list.length
        ? '<div class="m-chiprow">' + list.map(function (p) {
          return '<button class="m-chip m-chip-btn" data-pick="' + esc(p.member_id)
            + '">' + esc(p.member_id) + ' · ' + esc(p.name) + '</button>';
        }).join('') + '</div><p class="m-hint">点击会员号可自动填入（仍需输入手机后 4 位）。</p>'
        : '<p class="m-p">本机还没有任何会员记录。可自助注册，无需教练录入。</p>')
      + '</section>'
      + '<section class="m-card"><div class="m-card-h"><h2>为什么这样核验</h2></div>'
      + '<ul class="m-list">'
      + '<li>本页面用于区分训练记录归属，<b>不是登录鉴权</b>。同一设备上的其他使用者可以看到你的数据。</li>'
      + '<li>连续 5 次核验失败会锁定 60 秒（本地计数，<b>不是安全机制</b>）。</li>'
      + '<li>无服务端，因此<b>无法阻止</b>他人冒充；正式鉴权需后端，列在 V3。</li>'
      + '</ul></section>';
  }

  function bindVerify() {
    var btn = $('btnVerify');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var msg = $('vfMsg');
      var r = gate.check({
        member_id: $('vfId').value,
        phone4: $('vfPhone4').value,
        pin: $('vfPin').value
      });
      if (!r.ok) {
        msg.className = 'm-msg m-msg-err';
        msg.textContent = r.message || r.reason;
        if (r.locked) {
          btn.disabled = true;
          /* 到期自动解锁。原来只设一个 1 秒后的 render，那时仍在锁定期内，
             按钮会一直灰着直到用户手动刷新页面 —— 等于没有解锁。 */
          setTimeout(function () { render(); }, (gate.state().remainSec + 1) * 1000);
        }
        return;
      }
      setCtx(r.member_id, r.name || '', true);
      saveCtx();
      /* 教练端在册会员首次核验：已在 verify 内建档，这里补上内置动作库并落盘，
         保证其一进来就能直接用（Q4=A 开箱即用） */
      if (r.adopted) { IDN.loadSeed(store); store.save(); }
      var p = store.find('m_profiles', r.member_id);
      go(p && p.onboarding_done === 'Y' ? '#home' : '#profile');
    });
    var gr = $('btnGoRegister');
    if (gr) gr.addEventListener('click', function () { go('#register'); });
    var app = $('mApp');
    if (app) {
      app.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-pick]') : null;
        if (!t) return;
        var id = t.getAttribute('data-pick');
        var inp = $('vfId');
        if (inp) inp.value = id;
      });
    }
  }

  /* ---------------------------------------------------------------- 页面：训练首页 */

  /* ---------------------------------------------------------------- 首页派生计算 */

  /** 今日主行动：按 03 §P1 的状态机决定按钮文案与去向 */
  function todayAction() {
    var live = store.all('m_sessions').filter(function (s) {
      return s.member_id === ctx.member_id && SES.isLive(s);
    }).sort(function (a, b) { return String(b.started_at).localeCompare(String(a.started_at)); })[0];
    if (live) return { kind: 'resume', label: '继续训练', href: '#workout/' + live.session_id, tip: '你有一次训练还没结束' };

    var prof = store.find('m_profiles', ctx.member_id) || {};
    if (prof.pause_until && String(prof.pause_until) >= today()) {
      return { kind: 'paused', label: '训练暂停中，查看安排', href: '#plan', tip: '暂停至 ' + prof.pause_until + '，期间不会断连续记录' };
    }

    var bag = todayBag();
    if (bag) {
      var items = bagItems(bag.bag_id);
      if (items.length) return { kind: 'start', label: '开始今日训练', href: '#bag', tip: '背包里有 ' + items.length + ' 个动作' };
    }
    if (todayPlanItems().length) {
      return { kind: 'plan', label: '查看今日安排', href: '#plan', tip: '今天有计划，还没放进背包' };
    }
    return { kind: 'quick', label: '自由训练（直接开始）', href: '#quick', tip: '不依赖计划，随时可以开始' };
  }

  /**
   * 「需要我优先处理的事」——02 §A.2 的六条规则，按顺序取前 3 条，同类型只取 1 条。
   * 纯派生、不落库：写进库里就会在数据缺失时留下误导性的脏记录。
   */
  function priorities() {
    var out = [];
    var dow = jsDayToPlanDay(new Date().getDay());

    var live = store.all('m_sessions').filter(function (s) {
      return s.member_id === ctx.member_id && SES.isLive(s);
    })[0];
    if (live) out.push({ text: '你有一次训练还没结束', btn: '继续训练', href: '#workout/' + live.session_id });

    var bag = todayBag();
    var planItems = todayPlanItems();
    if (planItems.length && !(bag && bag.status === 'confirmed')) {
      out.push({ text: '今天安排了 ' + planItems.length + ' 个动作，还没确认背包', btn: '去确认背包', href: '#bag' });
    } else if (bag && bag.status === 'draft' && bagItems(bag.bag_id).length) {
      out.push({ text: '背包里准备好了 ' + bagItems(bag.bag_id).length + ' 个动作', btn: '确认并开始', href: '#bag' });
    }

    var d = new Date();
    if (d.getHours() >= 20) {
      var openDaily = store.all('m_challenges').filter(function (c) {
        return c.member_id === ctx.member_id && c.period_type === 'daily'
          && c.period_key === today() && c.status === 'open';
      });
      if (openDaily.length) out.push({ text: '今天还有 ' + openDaily.length + ' 条任务没完成', btn: '查看今日任务', href: '#home' });
    }

    var w = XP.weeklyStats(store, ctx.member_id, PLAN.mondayOf(today()));
    if (w.completedCount < w.frequencyGoal) {
      var gap = w.frequencyGoal - w.completedCount;
      /* 本周剩余天数（含今天）≤ 缺口 → 提醒安排 */
      var left = 7 - dow + 1;
      if (left <= gap) out.push({ text: '本周还差 ' + gap + ' 次训练就达成目标了', btn: '安排本周训练', href: '#plan' });
    }

    if (dow >= 5) {
      var nextWeek = PLAN.addDays(PLAN.mondayOf(today()), 7);
      var hasNext = store.all('m_plans').some(function (p) {
        return p.member_id === ctx.member_id && p.week_start === nextWeek;
      });
      if (!hasNext) out.push({ text: '可以开始规划下周的训练了', btn: '规划下周', href: '#plan?week=' + nextWeek });
    }
    return out.slice(0, 3);
  }

  /** JS 的 getDay()（0=周日）→ m_plan_items.day_of_week（1=周一） */
  function jsDayToPlanDay(jsDay) { return jsDay === 0 ? 7 : jsDay; }

  function todayBag() {
    var rows = store.all('m_bags').filter(function (b) {
      return b.member_id === ctx.member_id && b.kind === 'today'
        && b.plan_date === today() && b.status === 'draft';
    });
    return rows[0] || null;
  }
  function confirmedTodayBag() {
    return store.all('m_bags').filter(function (b) {
      return b.member_id === ctx.member_id && b.kind === 'today'
        && b.plan_date === today() && b.status === 'confirmed';
    })[0] || null;
  }
  function bagItems(bagId) {
    return store.all('m_bag_items')
      .filter(function (i) { return i.bag_id === bagId; })
      .sort(function (a, b) { return (+a.order_index) - (+b.order_index); });
  }
  /** 今天的计划动作：优先会员自己的计划，其次教练安排 */
  function todayPlanItems() {
    var dow = jsDayToPlanDay(new Date().getDay());
    var ws = PLAN.mondayOf(today());
    var plans = store.all('m_plans').filter(function (p) {
      return p.member_id === ctx.member_id && p.week_start === ws && p.status !== 'archived';
    });
    if (!plans.length) return [];
    var mine = plans.filter(function (p) { return p.source === 'member'; });
    var pick = mine.length ? mine[0] : plans[0];
    return PLAN.dayItems(store, ctx.member_id, pick.plan_id, dow).items || [];
  }

  /** 近 12 周每周完成次数（派生，用于训练节奏图） */
  function weeklyRhythm() {
    var thisMon = PLAN.mondayOf(today());
    var out = [];
    for (var i = 11; i >= 0; i--) {
      var ws = PLAN.addDays(thisMon, -7 * i);
      var w = XP.weeklyStats(store, ctx.member_id, ws);
      out.push({ week: ws, n: w.completedCount, current: ws === thisMon });
    }
    return out;
  }

  /* ================================================================ 阶段7 · 共享渲染片段
   *
   * 这两块（为什么慢 / 高级调整建议）要同时出现在首页、计划页和成长中心，
   * 抽成函数是为了让三处永远长一样——分开复制必然漂移，改一处漏两处。
   *
   * 共同守则：**只读渲染 + 显式按钮**。这里没有任何一处是自执行的写操作，
   * 改计划只会发生在用户点击并由 runBusy 包住的那一次调用里。
   */

  /** 「本周为什么慢」卡片：没有依据就返回空串，整块不渲染 */
  function slowCardHtml() {
    if (!GR) return '';
    var w = GR.whySlow(store, ctx.member_id, { today: today() });
    if (!w || !w.show) return '';
    return '<section class="m-card m-card-amber">'
      + '<div class="m-card-h"><h2>' + esc(w.head || '本周进度落后一点') + '</h2>'
      + '<span class="m-pill">完成 ' + w.done + ' / ' + w.goal + ' 次</span></div>'
      + '<ul class="m-why">'
      + w.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('')
      + '</ul>'
      + '<p class="m-hint">这里说的都是已经发生的事，不是在评价你。节奏断了随时可以再开始。</p>'
      + '<div class="m-btn-row"><a class="m-btn m-btn-primary m-btn-sm" href="'
      + esc(w.action.href) + '">' + esc(w.action.label) + '</a></div>'
      + '</section>';
  }

  /** 决策按钮文案：把「拒绝」说成人话，降低心理成本 */
  var DECISION_LABEL = { accepted: '就按这个来', rejected: '先不用，保持原样', modified: '改成这样再保存' };

  /** 高级调整建议卡组。list 为空时可以给 why（样本不足的措辞） */
  function adjustCardsHtml(list, why) {
    if (!GR) return '';
    if (!list || !list.length) {
      return why
        ? '<section class="m-card"><div class="m-card-h"><h2>这一周的建议</h2></div>'
          + '<p class="m-p">' + esc(why) + '</p></section>'
        : '';
    }
    return list.map(function (s, i) {
      var canEdit = s.plan && (s.plan.type === 'capacity' || s.plan.type === 'shorten');
      return '<section class="m-card m-card-purple" data-adj-card="' + esc(s.code) + '">'
        + '<div class="m-card-h"><h2>' + esc(s.title) + '</h2>'
        + '<span class="m-pill">' + esc(s.week) + ' 起</span></div>'
        + '<p class="m-p">' + esc(s.reason) + '</p>'
        + (s.evidence && s.evidence.length
          ? '<div class="m-evi">' + s.evidence.map(function (e) {
            return '<span class="m-evi-i"><i>' + esc(e.label) + '</i>' + esc(e.value) + '</span>';
          }).join('') + '</div>'
          : '')
        + '<p class="m-hint"><b>会发生什么：</b>' + esc(s.effect) + '</p>'
        + '<div class="m-btn-row">'
        + '<button class="m-btn m-btn-primary" data-adj="' + esc(s.code) + '" data-adj-d="accepted">'
        + DECISION_LABEL.accepted + '</button>'
        + '<button class="m-btn m-btn-ghost" data-adj="' + esc(s.code) + '" data-adj-d="rejected">'
        + DECISION_LABEL.rejected + '</button>'
        + '</div>'
        + (canEdit
          ? '<details class="m-mod"><summary>我想自己定</summary>'
            + '<label class="m-fld"><span>' + (s.plan.type === 'shorten' ? '本周目标次数' : '每组目标组数') + '</span>'
            + '<input type="number" min="1" max="20" id="adjV' + i + '" value="'
            + (s.plan.type === 'shorten' ? 2 : 3) + '"></label>'
            + '<label class="m-fld"><span>为什么这样改（必填）</span>'
            + '<input type="text" maxlength="60" id="adjR' + i + '" placeholder="例：最近膝盖有点酸，少做一点"></label>'
            + '<button class="m-btn m-btn-sm" data-adj="' + esc(s.code) + '" data-adj-d="modified" data-adj-i="' + i + '">'
            + DECISION_LABEL.modified + '</button>'
            + '</details>'
          : '')
        + '<div class="m-hint" id="adjMsg-' + esc(s.code) + '"></div>'
        + '</section>';
    }).join('');
  }

  /** 建议卡里那句标题：卡片收起后还要留一行「处理了什么」，从当前 DOM 里取最新渲染的标题 */
  function sugTitleOf(code) {
    var card = document.querySelector('[data-adj-card="' + code + '"] h2');
    return card ? card.textContent : code;
  }

  /** 建议卡的按钮绑定：三处页面共用一套，避免行为漂移 */
  function bindAdjust() {
    var btns = document.querySelectorAll('[data-adj-d]');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        var code = b.getAttribute('data-adj');
        var decision = b.getAttribute('data-adj-d');
        var idx = b.getAttribute('data-adj-i');
        var opt = { today: today() };
        if (decision === 'modified') {
          var v = document.getElementById('adjV' + idx);
          var r = document.getElementById('adjR' + idx);
          if (!r || !String(r.value || '').trim()) {
            adjustMsg(code, '请填一下改动原因，方便以后回看当时为什么这么改。', true);
            return;
          }
          opt.reason = String(r.value || '').trim();
          opt.override = { target_sets: v ? parseInt(v.value, 10) : 3 };
        }
        runBusy(b, decision === 'accepted' ? '正在应用…' : '正在记录…', function () {
          var res = GR.decide(store, ctx.member_id, code, decision, opt);
          if (!res.ok) {
            adjustMsg(code, res.errors ? res.errors[0] : (res.reason || '操作失败'), true);
            return false;
          }
          var txt;
          if (decision !== 'accepted' && decision !== 'modified') {
            txt = '已记录：这次不用它。本周不会再提醒你同一条。';
          } else if (res.blocked) {
            txt = '建议已存档，但没能改动计划——受影响的那周计划受保护（例如教练已确认的安排）。';
          } else {
            txt = '已应用：改了 ' + res.changed.length + ' 处，只影响还没练的部分。';
          }
          persist();
          /* 卡片当场收起：处理完建议还把「要不要接受」摆在屏幕上，是最让人分心的设计。
             同时把结果留在原地一行，会员知道自己刚才做了什么、系统做了什么。 */
          var card = b.closest ? b.closest('[data-adj-card]') : null;
          if (card) {
            card.innerHTML = '<div class="m-card-h"><h2>已处理：' + esc(sugTitleOf(code)) + '</h2></div>'
              + '<p class="m-hint m-ok">' + esc(txt) + '</p>';
          }
          adjustMsg(code, txt, false);
          return true;
        }, '已处理');
      });
    });
  }

  function adjustMsg(code, text, isErr) {
    var el = document.getElementById('adjMsg-' + code);
    if (!el) return;
    el.className = 'm-hint' + (isErr ? ' m-err' : ' m-ok');
    el.textContent = text;
  }

  function pageHome() {
    /* 每日任务 / 每周挑战在这里生成（两个函数都幂等：已存在就跳过）。
       放在渲染前而不是绑定后，是为了让下面统计到的就是当天的完整任务列表。 */
    var mk = XP.ensureDaily(store, ctx.member_id, today());
    var mk2 = XP.ensureWeekly(store, ctx.member_id, PLAN.mondayOf(today()));
    if ((mk && mk.created) || (mk2 && mk2.created)) { persist(); }

    var p = store.find('m_profiles', ctx.member_id) || {};
    var en = IDN.enrollState(store, ctx.member_id, IDN.readCoachMembers(localStorage).members);
    var act = todayAction();
    var pri = priorities();
    var ov = XP.overview(store, ctx.member_id);
    var rhythm = weeklyRhythm();
    var maxN = rhythm.reduce(function (a, r) { return Math.max(a, r.n); }, 1);

    /* 长期目标 + 最近一个未完成阶段 */
    var goals = GOAL.listGoals(store, ctx.member_id);
    var lt = (goals.longTerms || [])[0] || null;
    var stages = lt ? (goals.children[lt.goal_id] || []) : [];
    var nextStage = stages.filter(function (g) { return g.status === 'active'; })[0] || null;

    var daily = store.all('m_challenges').filter(function (c) {
      return c.member_id === ctx.member_id && c.period_type === 'daily' && c.period_key === today();
    });
    var weekly = store.all('m_challenges').filter(function (c) {
      return c.member_id === ctx.member_id && c.period_type === 'weekly'
        && c.period_key === PLAN.mondayOf(today());
    });
    var recs = store.all('m_records').filter(function (r) { return r.member_id === ctx.member_id; })
      .sort(function (a, b) { return String(b.achieved_at).localeCompare(String(a.achieved_at)); })
      .slice(0, 3);

    return ''
      /* 1. 今日主行动 */
      /* 「今天」是全站唯一用柔色底的卡（.m-card-hero）：
         打开应用第一眼要看到的只有「今天练什么」，其余卡片一律白底往后退。 */
      + '<section class="m-card m-card-hero">'
      + '<div class="m-card-h"><h2>今天</h2><span class="m-pill">' + today() + '</span></div>'
      + '<p class="m-p">你好，<b>' + esc(p.name || ctx.member_id) + '</b>'
      + (act.tip ? '，' + esc(act.tip) : '') + '。</p>'
      + (act.kind === 'quick'
        ? '<button class="m-btn m-btn-primary m-btn-lg" id="btnQuickStart">' + act.label + '</button>'
        : '<a class="m-btn m-btn-primary m-btn-lg" href="' + act.href + '">' + act.label + '</a>')
      /* 「已关联教练端」是状态说明，不是「练完」——不再套用 m-ok（现在等于完成态红） */
      + (en.enrolled ? '<p class="m-hint">已关联教练端会员 ' + esc(en.coach_member_id) + '</p>' : '')
      + '</section>'

      /* 2. 需要优先处理 */
      + (pri.length
        ? '<section class="m-card"><div class="m-card-h"><h2>需要你先处理</h2></div>'
          + pri.map(function (x) {
            return '<div class="m-rowitem"><div class="m-rowitem-t">' + esc(x.text) + '</div>'
              + '<a class="m-btn m-btn-sm" href="' + x.href + '">' + esc(x.btn) + '</a></div>';
          }).join('')
          + '</section>'
        : '')

      /* 2.5 本周为什么进度慢（只在真的落后时出现，没依据就整块不渲染） */
      + slowCardHtml()

      /* 3. 每日任务 */
      + '<section class="m-card"><div class="m-card-h"><h2>今日任务</h2>'
      + '<span class="m-pill">' + daily.filter(function (c) { return c.status === 'done'; }).length
      + ' / ' + daily.length + '</span></div>'
      + (daily.length
        ? daily.map(function (c) {
          var v = +c.current_value, t = +c.target_value;
          var pct = t > 0 ? Math.min(100, Math.round(v / t * 100)) : 0;
          return '<div class="m-task' + (c.status === 'done' ? ' m-task-done' : '') + '">'
            + '<div class="m-task-t">' + esc(c.title) + '</div>'
            + '<div class="m-bar"><i style="width:' + pct + '%"></i></div>'
            + '<div class="m-task-v">' + v + ' / ' + t + ' ' + esc(c.unit) + '</div></div>';
        }).join('')
        : '<p class="m-p">今天还没有生成任务，打开首页时会自动生成。</p>')
      + '</section>'

      /* 3.5 今天可以试试：灵感卡（点了要确认才会真的写进背包/计划） */
      + inspireSectionHtml()

      /* 3.6 AI 教练入口（只在有这个文件的布局下出现） */
      + aiCoachEntryHtml()

      /* 4. 每周挑战 */
      + '<section class="m-card"><div class="m-card-h"><h2>本周挑战</h2>'
      + '<a class="m-more" href="#growth">更多</a></div>'
      + (weekly.length
        ? weekly.map(function (c) {
          var v = +c.current_value, t = +c.target_value;
          var pct = t > 0 ? Math.min(100, Math.round(v / t * 100)) : 0;
          return '<div class="m-task' + (c.status === 'done' ? ' m-task-done' : '') + '">'
            + '<div class="m-task-t">' + esc(c.title) + '</div>'
            + '<div class="m-bar"><i style="width:' + pct + '%"></i></div>'
            + '<div class="m-task-v">' + v + ' / ' + t + ' ' + esc(c.unit) + '</div></div>';
        }).join('')
        : '<p class="m-p">本周还没有挑战。</p>')
      + '</section>'

      /* 5. XP / 等级 / 连续 */
      + '<section class="m-card m-card-teal"><div class="m-card-h"><h2>成长</h2>'
      + '<a class="m-more" href="#growth">成长中心</a></div>'
      + '<div class="m-xpline">'
      + '<div class="m-lv">Lv.' + ov.level + '</div>'
      + '<div class="m-lvinfo"><div class="m-lvtitle">' + esc(ov.level_title) + '</div>'
      + '<div class="m-bar"><i style="width:' + (ov.xp_for_level > 0
        ? Math.min(100, Math.round(ov.xp_into_level / ov.xp_for_level * 100)) : 0) + '%"></i></div>'
      + '<div class="m-task-v">' + ov.lifetime_xp + ' XP · 距下一级 '
      + (ov.xp_for_level > 0 ? Math.max(0, ov.xp_for_level - ov.xp_into_level) : '已满级') + '</div></div>'
      + '<div class="m-streak"><b>' + ov.active_days_streak + '</b><span>连续天数</span></div>'
      + '</div>'
      + '<p class="m-hint">休息一天不会断连续，连续两天没练才会重新开始。</p>'
      + '</section>'

      /* 6. 阶段目标 */
      + '<section class="m-card"><div class="m-card-h"><h2>当前目标</h2>'
      + '<a class="m-more" href="#goals">目标管理</a></div>'
      + (lt
        ? '<div class="m-goal-line"><b>' + esc(lt.title) + '</b>'
          + '<span>' + esc(lt.start_value) + ' → ' + esc(lt.target_value) + ' ' + esc(lt.unit) + '</span></div>'
          + (nextStage
            ? '<div class="m-task"><div class="m-task-t">' + esc(nextStage.title) + '</div>'
              + goalBar(nextStage) + '</div>'
            : '<p class="m-p">所有阶段目标都已完成。</p>')
        : '<p class="m-p">还没有设定目标。<a href="#goals">现在去设定</a>，系统会把大目标拆成能一步步做完的小阶段。</p>')
      + '</section>'

      /* 7. 训练节奏图 */
      + '<section class="m-card"><div class="m-card-h"><h2>近 12 周训练节奏</h2></div>'
      + '<div class="m-rhythm">' + rhythm.map(function (r) {
        var lvl = r.n === 0 ? 0 : Math.min(4, Math.ceil(r.n / maxN * 4));
        return '<i class="m-rh l' + lvl + (r.current ? ' m-rh-now' : '') + '" title="'
          + r.week + ' 完成 ' + r.n + ' 次"></i>';
      }).join('') + '</div>'
      + '<p class="m-hint">每格一周，颜色越深完成次数越多；带边框的是本周。</p>'
      + '</section>'

      /* 8. 个人纪录 */
      + '<section class="m-card"><div class="m-card-h"><h2>最近的个人纪录</h2>'
      + '<a class="m-more" href="#history">历史</a></div>'
      + (recs.length
        ? recs.map(function (r) {
          var ex = store.find('m_exercises', r.exercise_id);
          return '<div class="m-rowitem"><div class="m-rowitem-t">'
            + esc(ex ? ex.name : r.exercise_id) + ' · ' + recTypeName(r.record_type)
            + '<em>' + esc(r.value) + '</em></div>'
            + '<div class="m-rowitem-s">' + esc(String(r.achieved_at).slice(0, 10)) + '</div></div>';
        }).join('')
        : '<p class="m-p">还没有纪录。完成训练后会自动记录你的个人最好成绩。</p>')
      + '</section>';
  }

  function recTypeName(t) {
    return { one_rm: '估算 1RM', max_weight: '最大重量', max_reps: '最多次数', max_volume: '单次最大容量' }[t] || t;
  }
  function goalBar(g) {
    var pr = GOAL.progress(store, ctx.member_id, g.goal_id) || {};
    var pct = Math.max(0, Math.min(100, pr.percent || 0));
    return '<div class="m-bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="m-task-v">' + (pr.currentValue == null ? '—' : pr.currentValue)
      + ' / ' + pr.targetValue + ' ' + esc(g.unit) + '（' + pct + '%）'
      + (pr.isOverdue ? ' · 已超过原定日期，可继续或调整' : '') + '</div>';
  }

  function bindHome() {
    var q = $('btnQuickStart');
    if (q) q.addEventListener('click', function () { startQuickSession([]); });
  }

  /* ---------------------------------------------------------------- 页面：自由训练 #quick */

  /**
   * 自由训练入口。
   *
   * 刻意做成一个独立页面，而不是「访问 #quick 就立刻建会话」：
   * 建会话是写操作，写在 render() 里会因为 hashchange 反复触发，
   * 一旦 startQuick 失败还会把用户卡在不停重定向的死循环里。
   */
  function pageQuick() {
    var live = store.all('m_sessions').filter(function (s) {
      return s.member_id === ctx.member_id && SES.isLive(s);
    })[0];
    if (live) {
      return '<section class="m-card m-card-warn"><div class="m-card-h"><h2>还有训练没结束</h2></div>'
        + '<p class="m-p">你有一次训练还没结束，先把它完成或放弃，再开始新的。</p>'
        + '<div class="m-btn-row">'
        + '<a class="m-btn m-btn-primary" href="#workout/' + esc(live.session_id) + '">继续那次训练</a>'
        + '<a class="m-btn m-btn-ghost" href="#home">回首页</a></div></section>';
    }
    var items = todayPlanItems();
    return ''
      + '<section class="m-card m-card-blue"><div class="m-card-h"><h2>自由训练</h2></div>'
      + '<p class="m-p">不依赖任何计划，随时可以开始。每记一组就立刻保存，中途退出也不会丢。</p>'
      + '<p class="m-hint">自由训练同样会进历史、结算 XP。'
      + '因为没有计划做参照，「计划完成度」会显示为 0%。</p></section>'
      + '<section class="m-card"><div class="m-card-h"><h2>怎么开始</h2></div>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn m-btn-primary" id="btnQuickEmpty">直接开始（进去再选动作）</button>'
      + '</div>'
      + (items.length
        ? '<div class="m-btn-row"><button class="m-btn" id="btnQuickPlan">'
          + '用今天的计划内容开始（' + items.length + ' 个动作）</button></div>'
        : '<p class="m-hint">今天没有计划，可以先从「直接开始」练起，'
          + '或先去 <a href="#plan">计划页</a> 排一下本周安排。</p>')
      + '<div class="m-hint" id="qMsg"></div></section>';
  }

  function bindQuick() {
    var a = $('btnQuickEmpty');
    if (a) a.addEventListener('click', function () { startQuickSession([]); });
    var b = $('btnQuickPlan');
    if (b) b.addEventListener('click', function () { startQuickSession(todayPlanItems()); });
  }

  /** 建会话 → 落盘 → 跳执行页。失败只提示，不跳转。 */
  function startQuickSession(items) {
    /* 新会话开始前清掉上一次自选动作的残留，否则会串到这次训练 */
    wExPick = null;
    var r = SES.startQuick(store, ctx.member_id, { items: items });
    if (r.ok === false) {
      toast(r.message || r.reason, 'err', 5000);
      var m = $('qMsg');
      if (m) { m.className = 'm-hint m-err'; m.textContent = r.message || r.reason; }
      return;
    }
    persist();
    go('#workout/' + r.session.session_id);
  }

  function pageNotFound(r) {
    return '<section class="m-card"><div class="m-card-h"><h2>页面不存在</h2></div>'
      + '<p class="m-p">没有找到「' + esc(r.route) + '」这个页面。</p>'
      + '<div class="m-btn-row"><a class="m-btn m-btn-primary" href="#home">回首页</a></div></section>';
  }

  /* ---------------------------------------------------------------- 页面：会员档案 */

  function pageProfile() {
    var p = store.find('m_profiles', ctx.member_id) || {};
    var en = IDN.enrollState(store, ctx.member_id, IDN.readCoachMembers(localStorage).members);
    return ''
      + '<section class="m-card m-card-purple">'
      + '<div class="m-card-h"><h2>训练档案</h2>'
      + '<span class="m-pill">' + (p.onboarding_done === 'Y' ? '已完成引导' : '待完成引导') + '</span></div>'
      + '<div class="m-form">'
      + '<label class="m-fld"><span>姓名或昵称 <b class="m-req">*</b></span>'
      + '<input id="pfName" type="text" maxlength="30" value="' + esc(p.name) + '"></label>'
      + '<label class="m-fld"><span>手机号 <b class="m-req">*</b></span>'
      + '<input id="pfPhone" type="tel" inputmode="numeric" maxlength="11" value="' + esc(p.phone) + '"></label>'
      + '<label class="m-fld"><span>训练基础 <b class="m-req">*</b></span><select id="pfLevel">'
      + opt(['newbie', 'novice', 'intermediate', 'advanced'], ['零基础', '新手', '有一定基础', '资深'], p.experience_level)
      + '</select></label>'
      + '<label class="m-fld"><span>主要目标 <b class="m-req">*</b></span><select id="pfGoal">'
      + opt(['fat_loss', 'muscle_gain', 'strength', 'health', 'posture', 'rehab'],
        ['减脂', '增肌', '力量', '健康体能', '体态改善', '康复'], p.primary_goal)
      + '</select></label>'
      + '<label class="m-fld"><span>每周可训练天数 <b class="m-req">*</b></span>'
      + '<input id="pfDays" type="number" min="1" max="7" value="' + esc(p.available_days_per_week) + '"></label>'
      + '<label class="m-fld"><span>单次时长上限（分钟） <b class="m-req">*</b></span>'
      + '<input id="pfMinutes" type="number" min="15" max="180" value="' + esc(p.session_minutes) + '"></label>'
      + '<label class="m-fld"><span>每周目标次数 <b class="m-req">*</b></span>'
      + '<input id="pfFreq" type="number" min="1" max="7" value="' + esc(p.frequency_goal) + '"></label>'
      + '<label class="m-fld"><span>可用器械（顿号分隔） <b class="m-req">*</b></span>'
      + '<input id="pfEquip" type="text" maxlength="200" value="' + esc(p.available_equipment) + '">'
      + '<em class="m-tip">可用：自重、哑铃、杠铃、器械、绳索、弹力带、壶铃、有氧器械</em></label>'
      + '<label class="m-fld"><span>伤病禁忌标签（顿号分隔）</span>'
      + '<input id="pfLimit" type="text" maxlength="300" value="' + esc(p.limitations) + '">'
      + '<em class="m-tip">填写后会<b>硬过滤</b>动作库：被限制的动作不会出现在列表中。</em></label>'
      + '<label class="m-fld"><span>限制备注</span>'
      + '<input id="pfLimitNote" type="text" maxlength="300" value="' + esc(p.limitation_note) + '"></label>'
      + '</div>'
      + '<div class="m-msg" id="pfMsg"></div>'
      + '<div class="m-btn-row"><button class="m-btn m-btn-primary" id="btnSaveProfile">保存档案</button></div>'
      + '</section>'
      + '<section class="m-card ' + (en.enrolled ? 'm-card-blue' : '') + '">'
      + '<div class="m-card-h"><h2>与教练端的关联</h2></div>'
      + (en.enrolled
        ? '<p class="m-p m-ok">已加入教练端（会员号 <code>' + esc(en.coach_member_id) + '</code>'
          + (en.coach_name ? ' / ' + esc(en.coach_name) : '') + '）。</p>'
          + '<p class="m-hint">关联后在设置页可导出同步文件供教练端导入。</p>'
        : '<p class="m-p">当前<b>未关联</b>教练端。会员端功能不受影响，可正常使用全部训练功能。</p>'
          + '<p class="m-hint">如需关联，请让教练在教练端添加你，且姓名与手机号与此处一致。</p>')
      + '<p class="m-hint">关联状态为<b>只读判定</b>，不会读写教练端数据。</p>'
      + '</section>';
  }

  function bindProfile() {
    var btn = $('btnSaveProfile');
    if (!btn) return;
    btn.addEventListener('click', function () {
      runBusy(btn, '正在保存…', function () {
      var msg = $('pfMsg');
      var patch = {
        name: $('pfName').value.trim(),
        phone: $('pfPhone').value.trim(),
        experience_level: $('pfLevel').value,
        primary_goal: $('pfGoal').value,
        available_days_per_week: $('pfDays').value.trim(),
        session_minutes: $('pfMinutes').value.trim(),
        frequency_goal: $('pfFreq').value.trim(),
        available_equipment: $('pfEquip').value.trim(),
        limitations: $('pfLimit').value.trim(),
        limitation_note: $('pfLimitNote').value.trim(),
        onboarding_done: 'Y',
        updated_at: now()
      };
      /* 必填项缺失 → 明确错误提示，不允许保存空档案。
         覆盖全部必填项，且用中文名报给用户，避免只报字段名或直接抛 schema 原文。 */
      var LABEL = {
        name: '姓名或昵称', phone: '手机号', experience_level: '训练基础',
        primary_goal: '主要目标', available_equipment: '可用器械',
        available_days_per_week: '每周可训练天数', session_minutes: '单次时长上限',
        frequency_goal: '每周目标次数'
      };
      var miss = [];
      Object.keys(LABEL).forEach(function (k) {
        if (!has(patch[k])) miss.push(LABEL[k]);
      });
      if (!miss.length && !IDN.isPhone(patch.phone)) miss.push('手机号（须 11 位且 1 开头）');
      if (!miss.length) {
        [['available_days_per_week', 1, 7], ['session_minutes', 15, 180], ['frequency_goal', 1, 7]]
          .forEach(function (r) {
            var v = Number(patch[r[0]]);
            if (!(v >= r[1] && v <= r[2])) miss.push(LABEL[r[0]] + '（须为 ' + r[1] + '–' + r[2] + '）');
          });
      }
      if (miss.length) {
        msg.className = 'm-msg m-msg-err';
        msg.textContent = '以下项未填写或不合法，已拒绝保存：' + miss.join('、');
        return false;
      }
      var r = store.update('m_profiles', ctx.member_id, patch, { actor: ctx.member_id });
      if (!r.ok) {
        msg.className = 'm-msg m-msg-err';
        msg.textContent = '保存失败：' + (r.errors ? r.errors.map(function (e) { return e.message; }).join('；') : r.reason);
        return false;
      }
      store.save();
      setCtx(ctx.member_id, patch.name, true);
      saveCtx();
      msg.className = 'm-msg m-msg-ok';
      msg.textContent = '已保存。动作库已按你的伤病禁忌重新过滤。';
      renderChrome();
      return true;
      }, '档案已保存');
    });
  }

  /* ---------------------------------------------------------------- 页面：动作库 */

  /** 伤病禁忌硬过滤：任何标签出现在该动作的 contraindications 中即剔除 */
  function filterByLimitations(list, limitations) {
    var tags = dab(limitations).split(/[、,，\s]+/).filter(function (t) { return t.length >= 2; });
    if (!tags.length) return { list: list, blocked: 0 };
    var kept = [], blocked = 0;
    list.forEach(function (ex) {
      var contra = dab(ex.contraindications);
      var hit = tags.some(function (t) { return contra.indexOf(t) >= 0; });
      if (hit) blocked++; else kept.push(ex);
    });
    return { list: kept, blocked: blocked };
  }

  function pageExercises(r) {
    var p = store.find('m_profiles', ctx.member_id) || {};
    var q = r.q || {};
    var all = store.all('m_exercises');
    var fl = filterByLimitations(all, p.limitations);
    var list = fl.list;

    /* 收藏集合必须先算，下面「只看收藏」要用 */
    var favSet = {};
    store.all('m_favorites').forEach(function (f) {
      if (f.member_id === ctx.member_id && f.kind === 'exercise') favSet[f.ref_id] = 1;
    });

    if (q.fav) list = list.filter(function (e) { return !!favSet[e.exercise_id]; });
    if (q.equip) list = list.filter(function (e) { return e.equipment === q.equip; });
    if (q.diff) list = list.filter(function (e) { return e.difficulty === q.diff; });
    if (q.pattern) list = list.filter(function (e) { return e.movement_pattern === q.pattern; });
    if (q.cat) list = list.filter(function (e) { return e.category === q.cat; });
    if (q.muscle) list = list.filter(function (e) { return dab(e.primary_muscles).indexOf(q.muscle) >= 0; });
    if (q.muscle2) list = list.filter(function (e) { return dab(e.secondary_muscles).indexOf(q.muscle2) >= 0; });
    if (q.src) list = list.filter(function (e) { return e.source === q.src; });
    /* AI 监测筛选：等级来自统一配置，这里只比较，不定义等级 */
    if (q.ai) {
      list = list.filter(function (e) {
        var lv = aiCap(e.ai_monitor_type).level;
        return q.ai === 'yes' ? (lv === 'A' || lv === 'B') : lv === q.ai;
      });
    }
    if (q.q) {
      var kw = q.q.toLowerCase();
      list = list.filter(function (e) {
        return (dab(e.name) + dab(e.alias) + dab(e.primary_muscles)).toLowerCase().indexOf(kw) >= 0;
      });
    }
    /* 被停用的一律不显示 */
    list = list.filter(function (e) { return e.deprecated !== 'Y'; });

    return ''
      + '<section class="m-card m-card-blue">'
      + '<div class="m-card-h"><h2>动作库</h2>'
      + '<span class="m-pill" id="exCount">共 ' + list.length + ' 个</span></div>'
      + '<div class="m-filters">'
      + '<select id="fEquip">' + sel('全部器械', [
        ['bodyweight', '自重'], ['dumbbell', '哑铃'], ['barbell', '杠铃'], ['machine', '器械'],
        ['cable', '绳索'], ['band', '弹力带'], ['kettlebell', '壶铃'], ['cardio_machine', '有氧器械'],
        ['other', '其他']
      ], q.equip) + '</select>'
      + '<select id="fDiff">' + sel('全部难度', [
        ['beginner', '入门'], ['novice', '初级'], ['intermediate', '中级'], ['advanced', '高级']
      ], q.diff) + '</select>'
      + '<select id="fPattern">' + sel('全部动作模式', [
        ['squat', '蹲'], ['hinge', '髋铰链'], ['push_horizontal', '水平推'],
        ['push_vertical', '垂直推'], ['pull_horizontal', '水平拉'], ['pull_vertical', '垂直拉'],
        ['carry', '搬运'], ['core', '核心'], ['locomotion', '位移'], ['isolation', '孤立']
      ], q.pattern) + '</select>'
      + '<select id="fSrc">' + sel('全部来源', [
        ['self_authored', '内置'], ['custom', '我自建'], ['gym_owned', '场馆自有']
      ], q.src) + '</select>'
      + '<select id="fCat">' + sel('全部训练目的', [
        ['strength', '力量'], ['cardio', '有氧'], ['mobility', '活动度'],
        ['posture', '体态'], ['rehab', '康复']
      ], q.cat) + '</select>'
      + '<select id="fMuscle">' + sel('全部目标肌群',
        muscleOptions('primary_muscles').map(function (m) { return [m, m]; }), q.muscle) + '</select>'
      + '<select id="fMuscle2">' + sel('全部辅助肌群',
        muscleOptions('secondary_muscles').map(function (m) { return [m, m]; }), q.muscle2) + '</select>'
      /* 选项文案刻意短：手机两列布局下，长文案会被 select 截断成半截 */
      + '<select id="fAi">' + sel('全部 AI 监测', [
        ['yes', '支持监测 (A/B)'], ['A', 'A 级 · 可监测'],
        ['B', 'B 级 · 有限'], ['C', 'C 级 · 不支持']
      ], q.ai) + '</select>'
      + '<input id="fQ" type="search" placeholder="搜索名称 / 别名 / 肌群" value="' + esc(q.q || '') + '">'
      + '<button class="m-btn m-btn-ghost' + (q.fav ? ' m-btn-on' : '')
      + '" id="btnFavOnly">' + (q.fav ? '限收藏（点击取消）' : '只看收藏') + '</button>'
      + '</div>'
      + (fl.blocked
        ? '<p class="m-hint m-warn">按你的伤病禁忌已屏蔽 ' + fl.blocked + ' 个动作。</p>' : '')
      /* 这两颗都是次级操作：主紫实心只留给「开始训练 / 保存计划 / 开始 AI 监测」这类主任务 */
      + '<div class="m-btn-row m-btn-row-2"><button class="m-btn" id="btnResetFilter">重置筛选</button>'
      + '<button class="m-btn" id="btnNewExercise">+ 自建动作</button></div>'
      + '</section>'
      + '<div id="exList" class="m-exlist">'
      + (list.length
        ? list.map(function (e) {
          /* data-kw：搜索框就地过滤用的可搜索文本，口径必须与上面 q.q 的过滤一致
             （名称 + 别名 + 肌群，小写）。别名不在可见 DOM 里，所以只能额外挂一份。 */
          return '<div class="m-exitem" data-ex="' + esc(e.exercise_id) + '"'
            + ' data-kw="' + esc((dab(e.name) + dab(e.alias) + dab(e.primary_muscles)).toLowerCase()) + '">'
            + '<div class="m-exitem-h">'
            + '<button class="m-extitle" data-goto="' + esc(e.exercise_id) + '">' + esc(e.name) + '</button>'
            + '<button class="m-fav' + (favSet[e.exercise_id] ? ' m-fav-on' : '')
            + '" data-fav="' + esc(e.exercise_id) + '"'
            + ' aria-label="收藏">' + (favSet[e.exercise_id] ? '★' : '☆') + '</button>'
            + '</div>'
            + '<div class="m-exmeta">' + esc(e.primary_muscles)
            + ' · ' + EQ[e.equipment] + ' · ' + DIFF[e.difficulty]
            + ' · ' + (e.unilateral === 'Y' ? '单侧' : '双侧') + '</div>'
            /* AI 等级只在 A/B 时打标：C 级是绝大多数动作的默认态，
               全部打标等于没有信息，反而把"少数可监测的"淹掉。 */
            + (function () {
              var c = aiCap(e.ai_monitor_type);
              if (c.level === 'C') return '';
              return '<div class="m-exmeta"><span class="m-aibadge m-aibadge-'
                + c.level + '">' + esc(c.text) + '</span></div>';
            })()
            + '<div class="m-exitem-b">'
            + '<button class="m-btn m-btn-xs" data-bag="' + esc(e.exercise_id) + '">+ 加入背包</button>'
            + '</div>'
            + '</div>';
        }).join('')
        : '<div class="m-empty">' + (q.fav
          ? '你还没有收藏任何动作。点列表里的 ☆ 即可收藏。'
          : '没有符合条件的动作。可以放宽筛选，或者直接清空条件。')
          + '<div class="m-btn-row" style="justify-content:center">'
          + '<button class="m-btn m-btn-ghost" id="btnEmptyReset">清空全部筛选</button></div></div>')
      + '</div>';
  }

  var EQ = {
    bodyweight: '自重', dumbbell: '哑铃', barbell: '杠铃', machine: '器械', cable: '绳索',
    band: '弹力带', kettlebell: '壶铃', cardio_machine: '有氧器械', other: '其他'
  };
  var DIFF = { beginner: '入门', novice: '初级', intermediate: '中级', advanced: '高级' };
  var CAT = { strength: '力量', cardio: '有氧', mobility: '活动度', posture: '体态', rehab: '康复' };
  var PAT = {
    squat: '蹲', hinge: '髋铰链', push_horizontal: '水平推', push_vertical: '垂直推',
    pull_horizontal: '水平拉', pull_vertical: '垂直拉', carry: '搬运', core: '核心',
    locomotion: '位移', isolation: '孤立'
  };

  /* ------------------------------------------------------------------ AI 监测能力 */
  /* 等级只有一个真值：AI 教练的统一配置（03_AI教练/js/aic-config.js 的 getMonitor）。
   * 这里只负责取用和兜底，**不得**在这里另写一套等级文案或判断，
   * 否则动作库和 AI 教练会给出两种互相矛盾的说法。 */
  function aiCfg() {
    return (window.FXP && window.FXP.aicConfig) || null;
  }

  function aiCap(type) {
    var cfg = aiCfg();
    function blank(notList, limitList, text, note) {
      return {
        level: 'C', view: '', mustVisible: [], measurable: [],
        notMeasurable: notList, limitations: limitList, notes: '',
        text: text, note: note
      };
    }
    if (!cfg) {
      /* 配置没加载（例如单独打开某个裁剪过的包）：不明说支持，也不假装没有这一栏 */
      return blank(['未加载到 AI 能力配置'], ['以手动记录为准'], '未加载 AI 配置', '');
    }
    var m = cfg.getMonitor(type) || null;
    if (!m) {
      return blank(['本动作未接入摄像头监测'],
        ['可在动作库查看教学说明，重量 / 次数 / 组数由手动记录'],
        cfg.LEVEL_TEXT.C, cfg.LEVEL_NOTE.C);
    }
    return {
      level: m.level || 'C',
      view: m.view || '',
      mustVisible: m.mustVisible || [],
      measurable: m.measurable || [],
      notMeasurable: m.notMeasurable || [],
      limitations: m.limitations || [],
      notes: m.notes || '',
      text: (cfg.LEVEL_TEXT && cfg.LEVEL_TEXT[m.level]) || m.level,
      note: (cfg.LEVEL_NOTE && cfg.LEVEL_NOTE[m.level]) || ''
    };
  }

  /** 动作库里的「全部肌群」下拉项：从库里现拆，不写死，避免新增动作后选项对不上 */
  function muscleOptions(field) {
    var seen = {}, out = [];
    store.all('m_exercises').forEach(function (e) {
      if (e.deprecated === 'Y') return;
      dab(e[field]).split(/[、,，]/).forEach(function (m) {
        m = m.trim();
        if (m && !seen[m]) { seen[m] = 1; out.push(m); }
      });
    });
    return out.sort();
  }

  function sel(label, pairs, cur) {
    var h = '<option value="">' + label + '</option>';
    pairs.forEach(function (p) {
      h += '<option value="' + p[0] + '"' + (p[0] === cur ? ' selected' : '') + '>' + p[1] + '</option>';
    });
    return h;
  }

  function bindExercises() {
    ['fEquip', 'fDiff', 'fPattern', 'fSrc', 'fCat', 'fMuscle', 'fMuscle2', 'fAi'].forEach(function (id) {
      var el = $(id); if (!el) return;
      el.addEventListener('change', applyFilters);
    });
    var q = $('fQ');
    if (q) {
      /* 搜索框原先只听 change：手机上不打回车就完全没反应。
         **不能**改成「防抖后调 applyFilters()」——那会改 hash → render() 重建 #mApp，
         输入框当场失焦、手机键盘收起来，比原毛病更难受。
         所以：input 事件只做**就地过滤 DOM**（不改 hash、不重渲染、不丢焦点），
         Enter / 失焦（change）时才真正提交到地址栏，保证筛选能跨页面保留。 */
      var qt = null;
      q.addEventListener('input', function () {
        if (qt) clearTimeout(qt);
        qt = setTimeout(function () {
          applySearchInPlace(String(q.value || '').trim().toLowerCase());
        }, 180);
      });
      q.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.keyCode === 13) {
          if (qt) clearTimeout(qt);
          applyFilters();
        }
      });
      q.addEventListener('change', applyFilters);
    }
    var fav = $('btnFavOnly');
    if (fav) fav.addEventListener('click', function () {
      var q = currentQ();
      /* 保留器械/难度/动作模式/来源/搜索词，只翻转收藏开关 */
      if (q.fav) delete q.fav; else q.fav = '1';
      location.hash = hashWithQ(q);
    });
    var reset = $('btnResetFilter');
    if (reset) reset.addEventListener('click', function () { location.hash = '#exercises'; });
    var ne = $('btnNewExercise');
    if (ne) ne.addEventListener('click', function () { openNewExercise(); });
    /* 空状态里的重置按钮：和顶部「重置筛选」同一行为，只是离用户更近，不必滚回页面顶部 */
    var er = $('btnEmptyReset');
    if (er) er.addEventListener('click', function () { location.hash = '#exercises'; });

    var list = $('exList');
    if (list) {
      list.addEventListener('click', function (ev) {
        var t = ev.target.closest('[data-goto]');
        if (t) { go('#exercise/' + t.getAttribute('data-goto')); return; }
        var f = ev.target.closest('[data-fav]');
        if (f) { toggleFav(f.getAttribute('data-fav')); return; }
        var b = ev.target.closest('[data-bag]');
        if (b) { quickAddToBag(b.getAttribute('data-bag')); }
      });
    }
  }

  /**
   * 列表里的「+ 加入背包」快捷入口：按动作自带参考值直接加，不弹表单。
   * 想改组数次数可以到详情页加，或在背包里点「改参数」。
   */
  function quickAddToBag(exId) {
    var ex = store.find('m_exercises', exId);
    if (!ex) { toast('动作不存在：' + exId, 'err'); return; }
    var bag = ensureBag();
    if (!bag) return;
    var sr = parseSetsReps(ex.reference_sets_reps);
    var r = PLAN.addToBag(store, ctx.member_id, bag.bag_id, {
      exercise_id: exId, source: 'library',
      target_sets: sr.sets, target_reps: sr.reps
    });
    if (r.ok === false) { toast(r.message || r.reason, 'err', 5000); return; }
    persist();
    toast('已加入今日背包：' + ex.name, 'ok');
  }

  /* 读取当前筛选控件的值。切换收藏开关时用它保住其余条件，
     否则「只看收藏 + 已选哑铃」会丢掉器械条件。 */
  function currentQ() {
    var q = {}, v;
    v = $('fEquip') && $('fEquip').value; if (v) q.equip = v;
    v = $('fDiff') && $('fDiff').value; if (v) q.diff = v;
    v = $('fPattern') && $('fPattern').value; if (v) q.pattern = v;
    v = $('fSrc') && $('fSrc').value; if (v) q.src = v;
    v = $('fCat') && $('fCat').value; if (v) q.cat = v;
    v = $('fMuscle') && $('fMuscle').value; if (v) q.muscle = v;
    v = $('fMuscle2') && $('fMuscle2').value; if (v) q.muscle2 = v;
    v = $('fAi') && $('fAi').value; if (v) q.ai = v;
    v = $('fQ') && $('fQ').value.trim(); if (v) q.q = v;
    if (location.hash.indexOf('fav=1') >= 0) q.fav = '1';
    return q;
  }

  function hashWithQ(q) {
    var a = [];
    ['equip', 'diff', 'pattern', 'src', 'cat', 'muscle', 'muscle2', 'ai', 'q', 'fav'].forEach(function (k) {
      if (q[k]) a.push(k + '=' + encodeURIComponent(q[k]));
    });
    return a.length ? '#exercises?' + a.join('&') : '#exercises';
  }

  function applyFilters() {
    location.hash = hashWithQ(currentQ());
  }

  /**
   * 搜索框的就地过滤：只显示/隐藏已经渲染出来的行，**不碰 hash、不触发 render()。**
   * 语义上等于「在现有筛选条件之上再取交集」——列表本来就是全量渲染的，
   * 所以隐藏掉不匹配的行，结果和重新走一遍 pageExercises 的过滤是一样的。
   */
  function applySearchInPlace(kw) {
    var box = $('exList');
    if (!box) return;
    var items = box.querySelectorAll('.m-exitem');
    var n = 0, i;
    for (i = 0; i < items.length; i++) {
      var hit = !kw || String(items[i].getAttribute('data-kw') || '').indexOf(kw) >= 0;
      items[i].hidden = !hit;
      if (hit) n++;
    }
    var cnt = $('exCount');
    if (cnt) cnt.textContent = '共 ' + n + ' 个' + (kw ? '（已按关键词筛）' : '');

    var tip = $('exEmptyTip');
    if (n === 0 && kw && items.length) {
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'exEmptyTip';
        tip.className = 'm-empty';
        tip.innerHTML = '<p class="m-p">这个关键词在当前筛选条件下没有匹配。</p>'
          + '<div class="m-btn-row" style="justify-content:center">'
          + '<button class="m-btn m-btn-ghost" id="btnClearKw">清空搜索词</button></div>';
        box.appendChild(tip);
        /* 清空后焦点还给搜索框：手机键盘不收起，可以接着换词 */
        var cb = document.getElementById('btnClearKw');
        if (cb) cb.addEventListener('click', function () {
          var input = $('fQ');
          if (!input) return;
          input.value = '';
          applySearchInPlace('');
          input.focus();
        });
      }
      tip.hidden = false;
    } else if (tip) {
      tip.hidden = true;
    }
  }

  function toggleFav(exId) {
    var favs = store.all('m_favorites');
    for (var i = 0; i < favs.length; i++) {
      var f = favs[i];
      if (f.member_id === ctx.member_id && f.kind === 'exercise' && f.ref_id === exId) {
        store.remove('m_favorites', f.favorite_id, { actor: ctx.member_id });
        store.save(); render(); return;
      }
    }
    store.insert('m_favorites', {
      favorite_id: store.nextId('m_favorites'),
      member_id: ctx.member_id, kind: 'exercise', ref_id: exId, created_at: now()
    }, { actor: ctx.member_id });
    store.save(); render();
  }

  /* ---------------------------------------------------------------- 页面：动作详情 */

  function pageExercise(r) {
    var ex = store.find('m_exercises', r.id);
    if (!ex) {
      return '<section class="m-card"><div class="m-card-h"><h2>动作不存在</h2></div>'
        + '<p class="m-p">未找到动作 <code>' + esc(r.id) + '</code>。</p>'
        + '<div class="m-btn-row"><button class="m-btn" data-nav="exercises">返回动作库</button></div></section>';
    }
    var favs = store.all('m_favorites').filter(function (f) {
      return f.member_id === ctx.member_id && f.kind === 'exercise' && f.ref_id === ex.exercise_id;
    });
    var alts = alternates(ex);
    var sr = parseSetsReps(ex.reference_sets_reps);

    return ''
      + '<section class="m-card">'
      + '<div class="m-card-h"><h2 id="exdName">' + esc(ex.name) + '</h2>'
      + '<span class="m-pill">' + esc(ex.exercise_id) + '</span></div>'
      + '<div class="m-exmeta">' + CAT[ex.category] + ' · ' + PAT[ex.movement_pattern]
      + ' · ' + DIFF[ex.difficulty] + '</div>'
      + '<div class="m-btn-row">'
      + '<button class="m-favbig' + (favs.length ? ' m-fav-on' : '') + '" id="btnFavDetail" data-fav="'
      + esc(ex.exercise_id) + '">' + (favs.length ? '★ 已收藏' : '☆ 收藏') + '</button>'
      + '<button class="m-btn" data-nav="exercises">返回列表</button></div>'
      + '</section>'

      /* 加入背包：验收项「从动作库挑选动作并维护背包」的入口。
         默认组数次数取自动作自带的参考值，减少手填出错。 */
      + '<section class="m-card m-card-blue">'
      + '<div class="m-card-h"><h2>加入今日背包</h2></div>'
      + '<p class="m-p">加进背包只是「打算练」，还要回到背包页点「确认并开始」才会成为一次训练。</p>'
      + '<div class="m-form m-form-row">'
      + '<label class="m-fld"><span>组数</span>'
      + '<input id="bgSets" type="text" inputmode="numeric" value="' + esc(sr.sets) + '"></label>'
      + '<label class="m-fld"><span>每组次数</span>'
      + '<input id="bgReps" type="text" inputmode="numeric" value="' + esc(sr.reps) + '"></label>'
      + '</div>'
      + '<div class="m-form"><label class="m-fld"><span>参考重量（kg）</span>'
      + '<input id="bgWeight" type="text" inputmode="decimal" placeholder="自重动作留空">'
      + '<em class="m-tip">只是给你自己看的参考值，正式记录以训练时填的为准。</em></label></div>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn m-btn-primary" id="btnAddToBag">加入背包</button>'
      + '<a class="m-btn m-btn-ghost" href="#bag">查看背包</a></div>'
      + '<div class="m-hint" id="bgMsg"></div>'
      + '</section>'

      + '<section class="m-card">'
      + '<div class="m-card-h"><h2>动作信息</h2></div>'
      + '<dl class="m-dl">'
      + row('动作名称', ex.name)
      + row('别名', ex.alias || '—')
      + row('目标肌群', ex.primary_muscles)
      + row('协同肌', ex.secondary_muscles || '—')
      + row('器械要求', EQ[ex.equipment])
      + row('可替代器械', ex.equipment_alt || '—')
      + row('难度', DIFF[ex.difficulty])
      + row('单侧 / 双侧', ex.unilateral === 'Y' ? '单侧' : '双侧')
      + '</dl></section>'

      + aiSection(ex)

      + '<section class="m-card">'
      + '<div class="m-card-h"><h2>执行步骤</h2></div>'
      + '<ol class="m-steps" id="exdSteps">'
      + stepsHtml(ex.steps)
      + '</ol></section>'

      + '<section class="m-card">'
      + '<div class="m-card-h"><h2>常见错误与参考</h2></div>'
      + '<dl class="m-dl">'
      + row('常见错误', ex.common_mistakes || '—')
      + row('参考组数次数', ex.reference_sets_reps || '—')
      + row('适用人群', ex.suitable_for || '—')
      + row('适用限制', ex.contraindications || '—')
      + row('安全提示', ex.caution_note || '—')
      + '</dl></section>'

      + '<section class="m-card" id="exdAlt">'
      + '<div class="m-card-h"><h2>替代动作建议</h2></div>'
      + (alts.length
        ? '<div class="m-chiprow">' + alts.map(function (a) {
          return '<button class="m-chip m-chip-btn" data-goto="' + esc(a.exercise_id) + '">'
            + esc(a.name) + '</button>';
        }).join('') + '</div>'
        : '<p class="m-hint">暂无同动作模式的替代品。</p>')
      + '</section>'

      + '<section class="m-card m-card-orange" id="exdSource">'
      + '<div class="m-card-h"><h2>数据来源与版权</h2></div>'
      + '<dl class="m-dl">'
      + row('来源', ex.source === 'self_authored' ? '内置（自有文本）'
        : ex.source === 'custom' ? '会员自建' : ex.source)
      + row('出处与授权说明', ex.source_note || '—')
      + row('内容版本', 'v' + ex.version)
      + row('内容哈希', ex.content_hash || '—')
      + row('媒体引用', ex.media_ref || '（本轮不使用任何媒体）')
      + '</dl>'
      + '<p class="m-hint">本动作库内容为事实性描述，不涉及第三方训练计划的编排结构，不含媒体文件。</p>'
      + '</section>';
  }

  /**
   * 详情页的「AI 监测」区块。
   * 全部内容取自 AI 教练的统一配置：等级、机位、必须可见部位、能算什么、明确不算什么、已知限制。
   * 这里只做渲染，不补一句自己的判断——补了就是"声称了没测过的能力"。
   */
  function aiSection(ex) {
    var c = aiCap(ex.ai_monitor_type);
    function li(arr) {
      if (!arr || !arr.length) return '<li>—</li>';
      return arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    }
    return ''
      + '<section class="m-card m-card-blue" id="exdAi">'
      + '<div class="m-card-h"><h2>AI 监测</h2>'
      + '<span class="m-aibadge m-aibadge-' + c.level + '">' + esc(c.text) + '</span></div>'
      + (c.note ? '<p class="m-hint">' + esc(c.note) + '</p>' : '')
      /* C 级（未接入监测）补一行中性引导：不说医疗建议，只说「还能怎么用」。 */
      + (c.level === 'C'
        ? '<p class="m-hint">这个动作靠摄像头算不准，但一样能练：按平常那样手动记重量 / 次数 / 组数就行；'
          + '如果你想要计数和角度反馈，可以在动作库里挑同肌群、标注为可监测的相近动作。</p>'
        : '')
      + '<dl class="m-dl">'
      + row('监测键', ex.ai_monitor_type || '（未接入）')
      + (c.view ? row('建议机位', c.view) : '')
      + (c.mustVisible.length ? row('必须可见部位', c.mustVisible.join('、')) : '')
      + '</dl>'
      + '<div class="m-airow"><b>能算什么</b><ul class="m-ailist">' + li(c.measurable) + '</ul></div>'
      + '<div class="m-airow"><b>明确不算什么</b><ul class="m-ailist m-ailist-no">'
      + li(c.notMeasurable) + '</ul></div>'
      + '<div class="m-airow"><b>已知限制</b><ul class="m-ailist">' + li(c.limitations) + '</ul></div>'
      + (c.notes ? '<p class="m-hint">' + esc(c.notes) + '</p>' : '')
      + '<p class="m-hint">等级由 AI 教练的统一配置给出；未列出的指标一律不做判断，'
      + '也不识别杠铃 / 哑铃 / 配重，重量需手动填写。</p>'
      + '</section>';
  }

  /**
   * 从「3 组 × 8-12 次」这类参考文本里取默认组数 / 次数。
   * 取不到就用 3 组 × 10 次——宁可给一个保守可用的默认值，也不要让输入框空着让人猜。
   */
  function parseSetsReps(text) {
    var s = dab(text);
    var ms = s.match(/(\d+)\s*组/);
    var mr = s.match(/(\d+)\s*(?:[-~至]\s*\d+\s*)?次/);
    return { sets: ms ? ms[1] : '3', reps: mr ? mr[1] : '10' };
  }

  function stepsHtml(steps) {
    var s = dab(steps);
    var arr = s.split(/(?=\d+\.\s)/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x; });
    if (!arr.length) arr = [s];
    return arr.map(function (x) {
      return '<li>' + esc(x.replace(/^\d+\.\s*/, '')) + '</li>';
    }).join('');
  }

  function row(k, v) {
    return '<div class="m-dlrow"><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>';
  }

  /** 替代动作：同 movement_pattern 且难度差 ≤1 档，排除自己。
   *  必须与动作库走同一套伤病禁忌硬过滤，否则会出现
   *  「列表里被屏蔽的禁忌动作，却在详情页被推荐为替代」的矛盾。 */
  function alternates(ex) {
    var p = store.find('m_profiles', ctx.member_id) || {};
    var rank = { beginner: 1, novice: 2, intermediate: 3, advanced: 4 };
    var my = rank[ex.difficulty] || 0;
    var cand = store.all('m_exercises').filter(function (e) {
      if (e.exercise_id === ex.exercise_id) return false;
      if (e.deprecated === 'Y') return false;
      if (e.movement_pattern !== ex.movement_pattern) return false;
      return Math.abs((rank[e.difficulty] || 0) - my) <= 1;
    });
    return filterByLimitations(cand, p.limitations).list.slice(0, 5);
  }

  function bindExercise(r) {
    var f = $('btnFavDetail');
    if (f) f.addEventListener('click', function () {
      toggleFav(f.getAttribute('data-fav'));
    });
    var app = $('mApp');
    if (app) {
      app.addEventListener('click', function (ev) {
        var t = ev.target.closest && ev.target.closest('[data-goto]');
        if (t) go('#exercise/' + t.getAttribute('data-goto'));
      });
    }

    var ab = $('btnAddToBag');
    if (ab) ab.addEventListener('click', function () {
      var bag = ensureBag();
      if (!bag) return;
      var msg = $('bgMsg');
      var res = PLAN.addToBag(store, ctx.member_id, bag.bag_id, {
        exercise_id: r.id, source: 'library',
        target_sets: $('bgSets').value,
        target_reps: $('bgReps').value,
        target_weight: $('bgWeight').value
      });
      if (res.ok === false) {
        if (msg) { msg.className = 'm-hint m-err'; msg.textContent = res.message || res.reason; }
        toast(res.message || res.reason, 'err', 5000);
        return;
      }
      persist();
      if (msg) {
        msg.className = 'm-hint m-ok';
        msg.textContent = '已加入今日背包，现在共 '
          + bagItems(bag.bag_id).length + ' 个动作。';
      }
      toast('已加入今日背包', 'ok');
    });
  }

  /* ---------------------------------------------------------------- 页面：设置与备份 */

  function pageSettings() {
    return ''
      + '<section class="m-card m-card-blue">'
      + '<div class="m-card-h"><h2>存储状态</h2>'
      + '<span class="m-pill" id="mKeyPill">' + MST.KEY + '</span></div>'
      + '<div class="m-stat-row" id="mStats"></div>'
      + '<div class="m-hint" id="mLoadMsg"></div>'
      + '</section>'

      + '<section class="m-card m-card-blue">'
      + '<div class="m-card-h"><h2>导出</h2></div>'
      + '<p class="m-p">把本机会员端数据导出为 19 个 CSV（Excel 可直接打开）。</p>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn" id="btnExportCsv">导出全部 CSV（19 个）</button>'
      + '<button class="m-btn" id="btnExportJson">导出单文件备份（JSON）</button>'
      + '</div><div class="m-hint" id="mExportMsg"></div>'
      + '</section>'

      + '<section class="m-card m-card-purple">'
      + '<div class="m-card-h"><h2>导入</h2></div>'
      + '<p class="m-p">选择会员端导出的 CSV，先校验后写入。<b>任一行不合法则整份拒收</b>。</p>'
      + '<div class="m-btn-row">'
      + '<input type="file" id="fileInput" accept=".csv,text/csv" multiple hidden>'
      + '<button class="m-btn" id="btnPick">选择 CSV 文件</button>'
      + '<button class="m-btn m-btn-ghost" id="btnImportJson" hidden>导入 JSON 备份</button>'
      + '</div><div class="m-hint" id="mImportMsg"></div>'
      + '</section>'

      + '<section class="m-card">'
      + '<div class="m-card-h"><h2>内置动作库</h2></div>'
      + '<p class="m-p" id="exLibLine">' + exLibLine() + '</p>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn" id="btnReloadSeed">载入 / 补回内置动作</button>'
      + '</div><div class="m-hint" id="seedMsg"></div>'
      + '</section>'

      + '<section class="m-card m-card-orange">'
      + '<div class="m-card-h"><h2>危险操作</h2></div>'
      + '<p class="m-p">清空后回到空白状态，<b>不可恢复</b>。只影响会员端 <code>' + MST.KEY
      + '</code>，不会动教练端数据。</p>'
      + '<div class="m-btn-row"><button class="m-btn m-btn-danger" id="btnClear">清空会员端数据</button></div>'
      + '</section>'

      + '<section class="m-card">'
      + '<div class="m-card-h"><h2>关于与边界</h2></div>'
      + '<ul class="m-list">'
      + '<li>会员端使用独立存储键 <code>' + MST.KEY + '</code>，与教练端 <code>fxp-workspace</code> 隔离。</li>'
      + '<li>与教练端的关联为<b>只读判定</b>，同步一律走导出文件 + 对方导入，绝不直接写入对方存储。</li>'
      + '<li>无服务端，因此没有真实鉴权与跨设备同步；正式能力列在 V3。</li>'
      + '</ul></section>';
  }

  /* ---------------------------------------------------------------- 动作：自建 */

  function openNewExercise() {
    /* 刻意挂在 <body> 而不是 #mApp 里。
       render() 会整体覆写 #mApp 的 innerHTML —— 弹窗挂在里面就会被静默吞掉：
       用户点了「+ 自建动作」，弹窗闪一下就没了，看上去像按钮坏了。
       （#mApp 这个元素本身不会被替换，所以它身上的委托监听不受影响。） */
    document.body.insertAdjacentHTML('beforeend', ''
      + '<div class="m-modal" id="mModal"><div class="m-modal-in">'
      + '<h3>自建动作</h3>'
      + '<div class="m-form">'
      + '<label class="m-fld"><span>名称 <b class="m-req">*</b></span><input id="neName" maxlength="30"></label>'
      + '<label class="m-fld"><span>训练目的 <b class="m-req">*</b></span><select id="neCat">'
      + opt(['strength', 'cardio', 'mobility', 'posture', 'rehab'],
        ['力量', '有氧', '活动度', '体态', '康复'], 'strength') + '</select></label>'
      + '<label class="m-fld"><span>动作模式 <b class="m-req">*</b></span><select id="nePat">'
      + opt(['squat', 'hinge', 'push_horizontal', 'push_vertical', 'pull_horizontal',
        'pull_vertical', 'carry', 'core', 'locomotion', 'isolation'],
        ['蹲', '髋铰链', '水平推', '垂直推', '水平拉', '垂直拉', '搬运', '核心', '位移', '孤立'], 'squat')
      + '</select></label>'
      + '<label class="m-fld"><span>目标肌群 <b class="m-req">*</b></span><input id="neMus" maxlength="100"></label>'
      + '<label class="m-fld"><span>器械 <b class="m-req">*</b></span><select id="neEq">'
      + opt(['bodyweight', 'dumbbell', 'barbell', 'machine', 'cable', 'band', 'kettlebell', 'cardio_machine', 'other'],
        ['自重', '哑铃', '杠铃', '器械', '绳索', '弹力带', '壶铃', '有氧器械', '其他'], 'bodyweight')
      + '</select></label>'
      + '<label class="m-fld"><span>难度 <b class="m-req">*</b></span><select id="neDiff">'
      + opt(['beginner', 'novice', 'intermediate', 'advanced'], ['入门', '初级', '中级', '高级'], 'beginner')
      + '</select></label>'
      + '<label class="m-fld"><span>单侧</span><select id="neUni">'
      + opt(['N', 'Y'], ['双侧', '单侧'], 'N') + '</select></label>'
      + '<label class="m-fld"><span>执行步骤 <b class="m-req">*</b></span>'
      + '<textarea id="neSteps" rows="4" maxlength="800" placeholder="1. … 2. … 3. …"></textarea></label>'
      + '<label class="m-fld"><span>常见错误</span><input id="neMis" maxlength="500"></label>'
      + '<label class="m-fld"><span>适用限制</span><input id="neCon" maxlength="300"></label>'
      + '</div>'
      + '<div class="m-msg" id="neMsg"></div>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn m-btn-primary" id="btnNeSave">保存这个动作</button>'
      + '<button class="m-btn m-btn-ghost" id="btnNeCancel">取消</button></div>'
      + '</div></div>');

    $('btnNeCancel').addEventListener('click', closeModal);
    $('btnNeSave').addEventListener('click', function () {
      var msg = $('neMsg');
      var r = IDN.createExercise(store, {
        name: $('neName').value, category: $('neCat').value,
        movement_pattern: $('nePat').value, primary_muscles: $('neMus').value,
        equipment: $('neEq').value, difficulty: $('neDiff').value,
        unilateral: $('neUni').value, steps: $('neSteps').value,
        common_mistakes: $('neMis').value, contraindications: $('neCon').value
      }, { today: today });
      if (!r.ok) {
        msg.className = 'm-msg m-msg-err';
        msg.innerHTML = '保存失败：<br>' + (r.errors || [r.reason]).map(esc).join('<br>');
        return;
      }
      store.save();
      closeModal();
      render();
    });
  }
  function closeModal() {
    var m = $('mModal');
    if (m) m.parentNode.removeChild(m);
  }

  /* ---------------------------------------------------------------- 页面：目标管理 #goals */

  function pageGoals() {
    var goals = GOAL.listGoals(store, ctx.member_id);
    var lts = goals.longTerms || [];
    return ''
      + '<section class="m-card m-card-blue"><div class="m-card-h"><h2>我的目标</h2>'
      + '<button class="m-btn m-btn-primary m-btn-sm" id="btnGoalNew">新建长期目标</button></div>'
      + '<p class="m-p">先定一个长期目标，系统会按你的训练基础、每周可练时间和历史执行情况，'
      + '把它拆成几个阶段目标。<b>阶段目标只是帮你把大目标变小，不构成医疗建议，也不承诺结果。</b></p>'
      + '</section>'
      + (lts.length ? lts.map(goalCard).join('')
        : '<section class="m-card"><p class="m-p">还没有长期目标。</p>'
          + '<p class="m-hint">例如「3 个月减重 5kg」「深蹲突破 100kg」「每周稳定练 3 次」。</p></section>')
      + '<section class="m-card" id="goalForm" hidden>' + goalFormHtml() + '</section>';
  }

  function goalCard(lt) {
    var stages = (GOAL.listGoals(store, ctx.member_id).children[lt.goal_id]) || [];
    var pr = GOAL.progress(store, ctx.member_id, lt.goal_id) || {};
    var pct = Math.max(0, Math.min(100, pr.percent || 0));
    var head = '<section class="m-card"><div class="m-card-h"><h2>' + esc(lt.title) + '</h2>'
      + '<span class="m-pill">' + statusName(lt.status) + '</span></div>'
      + '<div class="m-bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="m-task-v">' + (pr.currentValue == null ? '—' : pr.currentValue)
      + ' / ' + pr.targetValue + ' ' + esc(lt.unit)
      + ' · ' + esc(lt.start_date) + ' → ' + esc(lt.target_date) + '</div>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn m-btn-sm" data-goal-cur="' + esc(lt.goal_id) + '">更新当前值</button>'
      + (lt.status === 'active'
        ? '<button class="m-btn m-btn-sm" data-goal-drop="' + esc(lt.goal_id) + '">放弃目标</button>' : '')
      + '</div>';

    var stageHtml = stages.length
      ? stages.map(function (g) {
        var sp = GOAL.progress(store, ctx.member_id, g.goal_id) || {};
        var spct = Math.max(0, Math.min(100, sp.percent || 0));
        return '<div class="m-stage' + (g.status === 'achieved' ? ' m-stage-done' : '') + '">'
          + '<div class="m-stage-t">' + esc(g.title) + ' <span class="m-pill">' + statusName(g.status) + '</span></div>'
          + '<div class="m-bar"><i style="width:' + spct + '%"></i></div>'
          + '<div class="m-task-v">目标 ' + esc(g.target_value) + ' ' + esc(g.unit)
          + ' · 截止 ' + esc(g.target_date) + (sp.isOverdue && g.status === 'active' ? '（已超期，可继续或调整）' : '')
          + '</div></div>';
      }).join('')
      : '<div class="m-btn-row"><button class="m-btn" data-goal-split="' + esc(lt.goal_id) + '">按我的情况拆成阶段目标</button></div>';

    return head + '<div class="m-stages">' + stageHtml + '</div></section>';
  }

  function statusName(s) {
    return { active: '进行中', achieved: '已达成', abandoned: '已放弃' }[s] || s;
  }

  function goalFormHtml() {
    return '<div class="m-card-h"><h2>新建长期目标</h2></div>'
      + '<div class="m-form">'
      + '<label class="m-fld"><span>目标名称 <b class="m-req">*</b></span>'
      + '<input id="gTitle" type="text" maxlength="40" placeholder="例如：3 个月减重 5kg"></label>'
      + '<label class="m-fld"><span>目标类型 <b class="m-req">*</b></span><select id="gType">'
      + opt(['weight', 'waist', 'strength_pr', 'frequency', 'custom'],
        ['体重', '腰围', '力量纪录', '训练频率', '自定义'], 'weight')
      + '</select></label>'
      + '<label class="m-fld"><span>方向 <b class="m-req">*</b></span><select id="gDir">'
      + opt(['decrease', 'increase'], ['越小越好（如体重）', '越大越好（如力量）'], 'decrease')
      + '</select></label>'
      + '<label class="m-fld"><span>当前值 <b class="m-req">*</b></span>'
      + '<input id="gStart" type="text" inputmode="decimal" placeholder="例如：70"></label>'
      + '<label class="m-fld"><span>目标值 <b class="m-req">*</b></span>'
      + '<input id="gTarget" type="text" inputmode="decimal" placeholder="例如：65"></label>'
      + '<label class="m-fld"><span>单位 <b class="m-req">*</b></span>'
      + '<input id="gUnit" type="text" maxlength="8" placeholder="kg / cm / 次"></label>'
      + '<label class="m-fld"><span>开始日期</span>'
      + '<input id="gFrom" type="date" value="' + today() + '"></label>'
      + '<label class="m-fld"><span>目标日期</span>'
      + '<input id="gTo" type="date" value="' + GOAL.todayStr(new Date(Date.now() + 84 * 86400000)) + '">'
      + '<em class="m-tip">不填默认按 12 周排期。期限越紧，系统给出的阶段步子越大，也越难坚持。</em></label>'
      + '</div>'
      + '<div class="m-hint" id="gMsg"></div>'
      + '<div class="m-btn-row"><button class="m-btn m-btn-primary" id="btnGoalSave">保存目标</button>'
      + '<button class="m-btn m-btn-ghost" id="btnGoalCancel">取消</button></div>';
  }

  /**
   * 把「新建长期目标」表单复位到初始状态。
   * 表单是常驻在页面里、靠 hidden 开关显示的（不是每次重建），
   * 所以取消时不清值的话，上次填了一半的内容会留到下次打开 ——
   * 看上去像「我明明新建了一个目标，怎么字段里还有上一次的东西」。
   * 保存成功后 render() 会重建表单，那条路径不需要这里复位。
   */
  function resetGoalForm() {
    var set = function (id, v) { var el = $(id); if (el) el.value = v; };
    set('gTitle', '');
    set('gType', 'weight');
    set('gDir', 'decrease');
    set('gStart', '');
    set('gTarget', '');
    set('gUnit', '');
    set('gFrom', today());
    set('gTo', GOAL.todayStr(new Date(Date.now() + 84 * 86400000)));
    var m = $('gMsg');
    if (m) { m.className = 'm-hint'; m.textContent = ''; }
  }

  function bindGoals() {
    var nw = $('btnGoalNew');
    if (nw) nw.addEventListener('click', function () {
      var f = $('goalForm'); if (!f) return;
      resetGoalForm();
      f.hidden = false;
      f.scrollIntoView && f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    var cc = $('btnGoalCancel');
    if (cc) cc.addEventListener('click', function () {
      var f = $('goalForm'); if (!f) return;
      f.hidden = true;
      resetGoalForm();
    });

    var sv = $('btnGoalSave');
    if (sv) sv.addEventListener('click', function () {
      runBusy(sv, '正在建立目标…', function () {
        var msg = $('gMsg');
        var r = GOAL.createLongTerm(store, ctx.member_id, {
          title: $('gTitle').value,
          goal_type: $('gType').value,
          direction: $('gDir').value,
          start_value: $('gStart').value,
          target_value: $('gTarget').value,
          unit: $('gUnit').value,
          start_date: $('gFrom').value,
          target_date: $('gTo').value
        });
        if (r.ok === false) {
          msg.className = 'm-hint m-err';
          msg.innerHTML = '没能保存：<br>' + (r.errors || [r.message || r.reason]).map(esc).join('<br>');
          return false;
        }
        if (run({ ok: true }, '目标已创建，可以拆阶段了')) render();
        return true;
      }, '目标已创建');
    });

    document.querySelectorAll('[data-goal-split]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-goal-split');
        var r = GOAL.acceptStages(store, ctx.member_id, id);
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, '已按你的情况拆出 ' + r.added + ' 个阶段目标');
        render();
      });
    });
    document.querySelectorAll('[data-goal-cur]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-goal-cur');
        var g = GOAL.getGoal(store, ctx.member_id, id);
        var v = W.prompt('更新当前值（' + (g ? g.unit : '') + '）：', g ? String(g.start_value || '') : '');
        if (v === null) return;
        var r = GOAL.updateCurrentValue(store, ctx.member_id, id, v);
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, r.achieved ? '恭喜，这个目标达成了' : '已更新当前值');
        render();
      });
    });
    document.querySelectorAll('[data-goal-drop]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!W.confirm('确定放弃这个目标？历史记录会保留，可以随时重新设定。')) return;
        var r = GOAL.setStatus(store, ctx.member_id, b.getAttribute('data-goal-drop'), 'abandoned');
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, '目标已置为放弃'); render();
      });
    });
  }

  /* ---------------------------------------------------------------- 页面：周计划 #plan */

  function pagePlan(r) {
    var week = r.q.week || PLAN.mondayOf(today());
    var gw = PLAN.getWeekPlan(store, ctx.member_id, week);
    /* getWeekPlan 返回的是 [{plan, items}]，不是计划行本身。
       早期版本在这里把它当成了计划行，结果 plan_id 全是 undefined，
       计划项一个都渲染不出来——页面看着正常，其实是个空壳。 */
    var entries = gw.plans || [];
    var prof = store.find('m_profiles', ctx.member_id) || {};
    var w = XP.weeklyStats(store, ctx.member_id, week);
    var prevWeek = PLAN.addDays(week, -7);
    var nextWeek = PLAN.addDays(week, 7);

    var html = ''
      + '<section class="m-card m-card-blue"><div class="m-card-h"><h2>本周训练计划</h2>'
      + '<span class="m-pill">' + week + ' 起</span></div>'
      + '<div class="m-weeknav">'
      + '<a class="m-btn m-btn-sm" href="#plan?week=' + prevWeek + '">← 上一周</a>'
      + '<a class="m-btn m-btn-sm" href="#plan?week=' + nextWeek + '">下一周 →</a>'
      + '</div>'
      + '<p class="m-p">本周已完成 <b>' + w.completedCount + '</b> / ' + w.frequencyGoal
      + ' 次 · 目标每周 ' + esc(prof.available_days_per_week || '—') + ' 天 · 每次约 '
      + esc(prof.session_minutes || '—') + ' 分钟</p>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn m-btn-primary" id="btnGenPlan">按我的情况生成计划</button>'
      + '<button class="m-btn m-btn-ghost" id="btnCopyPlan">复制上一周</button>'
      + '</div><div class="m-hint" id="planMsg"></div>'
      + '</section>';

    if (!entries.length) {
      html += '<section class="m-card"><p class="m-p">这一周还没有计划。</p>'
        + '<p class="m-hint">生成计划只会用到你在档案里填过的：每周可练天数、每次时长、可用器械、身体限制。</p></section>';
    }

    /* 调整建议放在周视图下面：会员关心的是「这周该怎么排」，这里离数据最近 */
    var pr = GR ? GR.suggest(store, ctx.member_id, { today: today(), max: 2 }) : null;
    html += adjustCardsHtml(pr && pr.suggestions, pr && pr.why);

    entries.forEach(function (ent) {
      var p = ent.plan || {};
      var items = ent.items || [];
      var coach = p.source === 'coach';
      var locked = coach && p.coach_confirmed === 'Y';
      html += '<section class="m-card' + (locked ? ' m-card-locked' : '') + '">'
        + '<div class="m-card-h"><h2>' + (coach ? '教练安排' : '我的安排') + '</h2>'
        + '<span class="m-pill">' + (locked ? '教练已确认 · 只读' : (coach ? '教练建议（未确认）' : planStatusName(p.status))) + '</span></div>'
        + (locked
          ? '<p class="m-hint">这是教练已确认的安排，会员端不能修改。如需调整请联系教练。'
            + '你可以另建一份自己的安排，两者并存、不会互相覆盖。</p>'
          : (p.member_edited === 'Y' ? '<p class="m-hint">你改动过这份教练建议，系统已标记；来源仍记为教练安排。</p>' : ''))
        + '<div class="m-form"><label class="m-fld"><span>本周目标次数</span>'
        + '<input type="number" min="1" max="7" value="' + esc(p.week_target_count)
        + '" data-plan-meta="' + esc(p.plan_id) + '"' + (locked ? ' disabled' : '') + '></label></div>';

      for (var d = 1; d <= 7; d++) {
        var dayList = items.filter(function (it) { return +it.day_of_week === d; })
          .sort(function (a, b) { return (+a.order_index) - (+b.order_index); });
        /* 日头写成「周一」而不是单个字「一」：单字在长列表里扫不出星期几。
           右侧补一个训练日 / 休息日状态词，不只看有没有动作块来猜。 */
        html += '<div class="m-day' + (dayList.length ? '' : ' m-day-rest') + '">'
          + '<div class="m-day-h">周' + dayName(d)
          + (d === jsDayToPlanDay(new Date().getDay()) ? ' <span class="m-pill">今天</span>' : '')
          + ' <span class="m-state ' + (dayList.length ? 'm-state-on' : 'm-state-off') + '">'
          + (dayList.length ? dayList.length + ' 个动作' : '休息') + '</span></div>';
        if (!dayList.length) {
          html += '<div class="m-day-empty">这一天没有排动作（休息）。</div>';
        } else {
          html += dayList.map(function (it) {
            return '<div class="m-planitem">'
              + '<div class="m-planitem-t">' + esc(it.exercise_name_snapshot)
              /* 数字加粗、单位降级：训练参数要能扫读。
                 刻意不重排结构 —— 渲染出的文本仍严格是「N 组 × N 次 · Nkg」。 */
              + '<em><b>' + esc(it.target_sets) + '</b> 组 × <b>' + esc(it.target_reps) + '</b> 次'
              + (it.target_weight ? ' · <b>' + esc(it.target_weight) + '</b>kg' : '') + '</em></div>'
              + (locked ? '' : '<div class="m-planitem-b">'
                + '<button class="m-btn m-btn-xs" data-pi-up="' + esc(it.plan_item_id) + '">↑</button>'
                + '<button class="m-btn m-btn-xs" data-pi-dn="' + esc(it.plan_item_id) + '">↓</button>'
                + '<button class="m-btn m-btn-xs" data-pi-edit="' + esc(it.plan_item_id) + '">改</button>'
                + '<button class="m-btn m-btn-xs" data-pi-del="' + esc(it.plan_item_id) + '">删</button>'
                + '<button class="m-btn m-btn-xs" data-pi-bag="' + esc(it.plan_item_id) + '">加入背包</button>'
                + '</div>')
              + '</div>';
          }).join('');
        }
        html += (locked ? '' : '<div class="m-btn-row"><button class="m-btn m-btn-xs" data-pi-add="'
            + esc(p.plan_id) + '|' + d + '">+ 加动作</button></div>')
          + '</div>';
      }
      html += (locked ? '' : '<div class="m-btn-row">'
          + (p.status === 'draft' ? '<button class="m-btn" data-plan-pub="' + esc(p.plan_id) + '">发布计划</button>' : '')
          + '<button class="m-btn m-btn-ghost" data-plan-del="' + esc(p.plan_id) + '">删除计划</button>'
          + '</div>')
        + '</section>';
    });

    if (gw.conflict) {
      html = '<section class="m-card m-card-warn"><div class="m-card-h"><h2>本周有两个安排</h2></div>'
        + '<p class="m-p">本周同时存在教练安排和你的自主安排，它们<b>互不覆盖</b>，'
        + '你可以自由选择其中一个执行。</p></section>' + html;
    }
    return html;
  }

  function planStatusName(s) {
    return { draft: '草稿', published: '已发布', archived: '已归档' }[s] || s;
  }
  function dayName(d) { return ['一', '二', '三', '四', '五', '六', '日'][d - 1] || d; }

  function bindPlan() {
    var week = parseHash().q.week || PLAN.mondayOf(today());
    var msg = $('planMsg');
    var prof = store.find('m_profiles', ctx.member_id) || {};

    var gen = $('btnGenPlan');
    if (gen) gen.addEventListener('click', function () {
      runBusy(gen, '正在排计划…', function () {
        var r = PLAN.createWeekPlan(store, ctx.member_id, prof, store.all('m_exercises'), { weekStart: week });
        if (r.ok === false) {
          if (msg) { msg.className = 'm-hint m-err'; msg.textContent = r.message || r.reason; }
          toast(r.message || r.reason, 'err', 5000);
          return false;
        }
        var notes = (r.snapshot && r.snapshot.notes) || [];
        if (msg) { msg.className = 'm-hint m-ok'; msg.textContent = '已生成草稿' + (notes.length ? '：' + notes.join('；') : ''); }
        run(r, '已按你的情况生成计划'); render();
        return true;
      }, '计划已生成');
    });

    var cp = $('btnCopyPlan');
    if (cp) cp.addEventListener('click', function () {
      var src = store.all('m_plans').filter(function (p) {
        return p.member_id === ctx.member_id && p.week_start === PLAN.addDays(week, -7)
          && p.source === 'member';
      })[0];
      if (!src) { if (msg) { msg.className = 'm-hint m-warn'; msg.textContent = '上一周没有你自己的计划可以复制。'; } return; }
      var r = PLAN.copyPlan(store, ctx.member_id, src.plan_id, week);
      if (r.ok === false) { if (msg) { msg.className = 'm-hint m-err'; msg.textContent = r.message || r.reason; } return; }
      run(r, '已复制上一周计划'); render();
    });

    document.querySelectorAll('[data-pi-up]').forEach(function (b) {
      b.addEventListener('click', function () { run(PLAN.movePlanItem(store, ctx.member_id, b.getAttribute('data-pi-up'), 'up')) && render(); });
    });
    document.querySelectorAll('[data-pi-dn]').forEach(function (b) {
      b.addEventListener('click', function () { run(PLAN.movePlanItem(store, ctx.member_id, b.getAttribute('data-pi-dn'), 'down')) && render(); });
    });
    document.querySelectorAll('[data-pi-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!W.confirm('从计划里删除这个动作？')) return;
        run(PLAN.removePlanItem(store, ctx.member_id, b.getAttribute('data-pi-del'))) && render();
      });
    });
    document.querySelectorAll('[data-pi-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = store.find('m_plan_items', b.getAttribute('data-pi-edit'));
        if (!it) return;
        var sets = W.prompt('目标组数：', String(it.target_sets));
        if (sets === null) return;
        var reps = W.prompt('每组次数：', String(it.target_reps));
        if (reps === null) return;
        var wgt = W.prompt('参考重量（自重动作留空）：', String(it.target_weight || ''));
        if (wgt === null) return;
        var r = PLAN.updatePlanItem(store, ctx.member_id, it.plan_item_id,
          { target_sets: sets, target_reps: reps, target_weight: wgt });
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, '已更新'); render();
      });
    });
    document.querySelectorAll('[data-pi-bag]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = store.find('m_plan_items', b.getAttribute('data-pi-bag'));
        if (!it) return;
        var bag = ensureBag();
        var r = PLAN.addToBag(store, ctx.member_id, bag.bag_id, {
          exercise_id: it.exercise_id, source: 'plan',
          target_sets: it.target_sets, target_reps: it.target_reps, target_weight: it.target_weight
        });
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, '已加入今日背包（复制，不会改动计划）');
      });
    });
    document.querySelectorAll('[data-pi-add]').forEach(function (b) {
      b.addEventListener('click', function () {
        var parts = b.getAttribute('data-pi-add').split('|');
        var exId = W.prompt('输入要加入的动作编号（可在动作库里查看，如 EX0001）：', 'EX0001');
        if (!exId) return;
        var r = PLAN.addPlanItem(store, ctx.member_id, parts[0], { day_of_week: +parts[1], exercise_id: exId });
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, '已加入计划'); render();
      });
    });
    document.querySelectorAll('[data-plan-pub]').forEach(function (b) {
      b.addEventListener('click', function () {
        run(PLAN.publishPlan(store, ctx.member_id, b.getAttribute('data-plan-pub'))) && render();
      });
    });
    document.querySelectorAll('[data-plan-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!W.confirm('删除这份计划？计划删除后，已经完成的训练记录不受影响。')) return;
        run(PLAN.deletePlan(store, ctx.member_id, b.getAttribute('data-plan-del'))) && render();
      });
    });
    document.querySelectorAll('[data-plan-meta]').forEach(function (i) {
      i.addEventListener('change', function () {
        var r = PLAN.updatePlanMeta(store, ctx.member_id, i.getAttribute('data-plan-meta'), { week_target_count: i.value });
        if (r.ok === false) { toast(r.message || r.reason, 'err'); render(); return; }
        run(r, '已更新本周目标次数');
      });
    });
  }

  /** 取（或建）今日背包。一天最多一个 draft bag。 */
  function ensureBag() {
    var r = PLAN.getTodayBag(store, ctx.member_id);
    if (r.ok === false) { toast(r.message || r.reason, 'err'); return null; }
    persist();
    return r.bag;
  }

  /* ---------------------------------------------------------------- 页面：今日背包 #bag */

  function pageBag() {
    var bag = ensureBag();
    if (!bag) return '<section class="m-card"><p class="m-p">背包初始化失败，请返回首页重试。</p></section>';
    var items = bagItems(bag.bag_id);
    var planItems = todayPlanItems();

    return ''
      + '<section class="m-card m-card-blue"><div class="m-card-h"><h2>今日背包</h2>'
      + '<span class="m-pill">' + today() + '</span></div>'
      + '<p class="m-p">背包是你自己挑的今日训练内容。'
      + '<b>这里的一切都还没成为事实</b>：可以随便改、随便删，不会产生 XP、也不计入统计。</p>'
      + '<div class="m-btn-row">'
      + (items.length
        ? '<button class="m-btn m-btn-primary" id="btnStartBag">确认并开始训练（' + items.length + ' 个动作）</button>'
        : '')
      + '<a class="m-btn m-btn-ghost" href="#exercises">去动作库挑动作</a>'
      + '</div>'
      + (planItems.length ? '<div class="m-btn-row"><button class="m-btn m-btn-ghost" id="btnPlanToBag">'
          + '把今天的计划放进来（' + planItems.length + ' 个，复制不引用）</button></div>' : '')
      + '<div class="m-hint" id="bagMsg"></div>'
      + '</section>'
      + (items.length
        ? '<section class="m-card"><div class="m-card-h"><h2>背包内容</h2></div>'
          + items.map(function (it, i) {
            return '<div class="m-bagitem">'
              + '<div class="m-bagitem-t">' + (i + 1) + '. ' + esc(it.exercise_name_snapshot)
              /* 数字加粗、单位降级：训练参数要能扫读。
                 刻意不重排结构 —— 渲染出的文本仍严格是「N 组 × N 次 · Nkg」。 */
              + '<em><b>' + esc(it.target_sets) + '</b> 组 × <b>' + esc(it.target_reps) + '</b> 次'
              + (it.target_weight ? ' · <b>' + esc(it.target_weight) + '</b>kg' : '') + '</em></div>'
              + '<div class="m-bagitem-b">'
              + '<button class="m-btn m-btn-xs" data-bi-up="' + esc(it.bag_item_id) + '">↑</button>'
              + '<button class="m-btn m-btn-xs" data-bi-dn="' + esc(it.bag_item_id) + '">↓</button>'
              + '<button class="m-btn m-btn-xs" data-bi-edit="' + esc(it.bag_item_id) + '">改参数</button>'
              + '<button class="m-btn m-btn-xs" data-bi-rep="' + esc(it.bag_item_id) + '">替换</button>'
              + '<button class="m-btn m-btn-xs" data-bi-del="' + esc(it.bag_item_id) + '">移除</button>'
              + '</div></div>';
          }).join('')
          + '<div class="m-btn-row"><button class="m-btn m-btn-ghost m-btn-sm" id="btnSaveTpl">存为我的模板</button></div>'
          + '</section>'
        : '<section class="m-card"><p class="m-p">背包还是空的。</p>'
          + '<p class="m-hint">去动作库挑动作，或把今天的计划放进来。</p></section>');
  }

  function bindBag() {
    var bag = todayBag();
    if (!bag) return;
    var bid = bag.bag_id;

    var p2b = $('btnPlanToBag');
    if (p2b) p2b.addEventListener('click', function () {
      var items = todayPlanItems();
      var n = 0;
      items.forEach(function (it) {
        var r = PLAN.addToBag(store, ctx.member_id, bid, {
          exercise_id: it.exercise_id, source: 'plan',
          target_sets: it.target_sets, target_reps: it.target_reps, target_weight: it.target_weight
        });
        if (r.ok) n++;
      });
      run({ ok: true }, '已放入 ' + n + ' 个动作'); render();
    });

    var st = $('btnStartBag');
    if (st) st.addEventListener('click', function () {
      var items = bagItems(bid);
      var r = SES.startFromBag(store, ctx.member_id, bag, items);
      if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
      persist();
      go('#workout/' + r.session.session_id);
    });

    var tpl = $('btnSaveTpl');
    if (tpl) tpl.addEventListener('click', function () {
      var name = W.prompt('给这个模板起个名字：', '我的常用训练');
      if (!name) return;
      var r = PLAN.saveAsTemplate(store, ctx.member_id, bid, name);
      if (r.ok === false && r.reason === 'name_exists') {
        if (!W.confirm('已经有同名模板「' + name + '」，覆盖它？')) return;
        r = PLAN.saveAsTemplate(store, ctx.member_id, bid, name, { overwrite: true });
      }
      if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
      run(r, '已存为模板');
    });

    document.querySelectorAll('[data-bi-up]').forEach(function (b) {
      b.addEventListener('click', function () { run(PLAN.moveBagItem(store, ctx.member_id, b.getAttribute('data-bi-up'), 'up')) && render(); });
    });
    document.querySelectorAll('[data-bi-dn]').forEach(function (b) {
      b.addEventListener('click', function () { run(PLAN.moveBagItem(store, ctx.member_id, b.getAttribute('data-bi-dn'), 'down')) && render(); });
    });
    document.querySelectorAll('[data-bi-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!W.confirm('从背包移除这个动作？')) return;
        run(PLAN.removeFromBag(store, ctx.member_id, b.getAttribute('data-bi-del'))) && render();
      });
    });
    document.querySelectorAll('[data-bi-edit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = store.find('m_bag_items', b.getAttribute('data-bi-edit'));
        if (!it) return;
        var sets = W.prompt('目标组数：', String(it.target_sets));
        if (sets === null) return;
        var reps = W.prompt('每组次数：', String(it.target_reps));
        if (reps === null) return;
        var wgt = W.prompt('参考重量（自重动作留空）：', String(it.target_weight || ''));
        if (wgt === null) return;
        var r = PLAN.updateBagItem(store, ctx.member_id, it.bag_item_id,
          { target_sets: sets, target_reps: reps, target_weight: wgt });
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, '已更新'); render();
      });
    });
    document.querySelectorAll('[data-bi-rep]').forEach(function (b) {
      b.addEventListener('click', function () {
        var item = store.find('m_bag_items', b.getAttribute('data-bi-rep'));
        if (!item) return;
        var target = W.prompt('替换成哪个动作？（填写动作编号，如 EX0004）', '');
        if (!target) return;
        var ex = store.find('m_exercises', target);
        if (!ex) { toast('动作库里没有这个编号：' + target, 'err'); return; }
        /* 用 previewReplace 而不是 replacePreview：后者是纯函数，要调用方自己把
           原动作对象挂到背包项副本上；漏了不会报错，只会安静地返回「无差异」，
           于是确认弹窗会说「两者基本一致」——而实际上器械、难度、肌群全变了。 */
        var pv = PLAN.previewReplace(store, ctx.member_id, item.bag_item_id, target);
        if (pv.ok === false || pv.contraindicationHit) {
          /* 硬拦截：不给确认机会，直接停。 */
          var why = pv.ok === false
            ? (pv.message || pv.reason)
            : (((pv.reasons || [])[0] || {}).text || '该动作与你的身体限制冲突');
          alert('不能替换：' + why);
          return;
        }
        /* 无论有没有差异都要确认。
           规格要求是「替换必须弹确认、未确认就一个字都不改」；
           只在有差异时才问，等于允许系统在无差异时静默改动背包——
           而「背包不许被悄悄优化」是本轮的硬约束。 */
        var warns = (pv.reasons || []).filter(function (x) { return x.level === 'warn'; });
        var txt = '把「' + item.exercise_name_snapshot + '」替换为「' + ex.name + '」？\n\n'
          + (warns.length
            ? '替换差异提醒：\n' + warns.map(function (x) { return '· ' + x.text; }).join('\n')
            : '两者的动作模式、主要肌群和难度基本一致。')
          + '\n\n' + (pv.confirmLabel || '确认替换') + '？';
        if (!W.confirm(txt)) return;        /* 未确认 → 一个字都不改 */
        var r = PLAN.replaceBagItem(store, ctx.member_id, item.bag_item_id, target, { confirmed: true });
        if (r.ok === false) { toast(r.message || r.reason, 'err'); return; }
        run(r, '已替换'); render();
      });
    });
  }

  /* ---------------------------------------------------------------- 页面：训练执行 #workout/:id */

  /** 当前该练哪个动作：第一个「已记录组数 < 目标组数」的计划项 */
  function currentPlanItem(session) {
    var snap = {};
    try { snap = JSON.parse(session.plan_snapshot || '{}'); } catch (e) { snap = { items: [] }; }
    var items = snap.items || [];
    var sets = SES.setsOf(store, session.session_id);
    for (var i = 0; i < items.length; i++) {
      var done = sets.filter(function (s) { return s.exercise_id === items[i].exercise_id; }).length;
      if (done < +items[i].target_sets) return items[i];
    }
    return items.length ? items[items.length - 1] : null;
  }

  /**
   * 自由训练（会话没有计划快照）时用户自选的动作。
   *
   * 必须记在模块级：每次记一组都会触发重渲染，若只在渲染函数内部推导，
   * 用户刚选好的动作会被打回列表第一项。
   */
  var wExPick = null;

  function pageWorkout(r) {
    var s = store.find('m_sessions', r.id);
    if (!s || s.member_id !== ctx.member_id) {
      return '<section class="m-card"><p class="m-p">没有找到这次训练。</p>'
        + '<div class="m-btn-row"><a class="m-btn" href="#home">回首页</a></div></section>';
    }
    if (s.status === 'completed') { go('#summary/' + s.session_id); return ''; }
    if (s.status === 'abandoned') {
      return '<section class="m-card"><p class="m-p">这次训练已经放弃了。</p>'
        + '<div class="m-btn-row"><a class="m-btn" href="#home">回首页</a></div></section>';
    }

    var snap = {};
    try { snap = JSON.parse(s.plan_snapshot || '{}'); } catch (e) { snap = { items: [] }; }
    var items = snap.items || [];
    var cur = currentPlanItem(s);
    var sets = SES.setsOf(store, s.session_id);

    /*
     * 当前正在练的动作。
     *
     * 有计划快照时就是快照里的当前项；自由训练没有快照，原先这里恒为 null，
     * 结果 curSets 永远是空数组 —— 记完 3 组后页面仍显示「已完成 0 组」、
     * 「本动作已记录」整块消失、「复制上一组」按钮也不出现（它靠 prev 判断）。
     * 会员会以为自己记的组丢了。
     *
     * 自由训练下按优先级取：用户显式选的 → 最近一组所属的动作 → 空。
     */
    var activeExId = cur ? cur.exercise_id
      : (wExPick || (sets.length ? sets[sets.length - 1].exercise_id : ''));
    var curSets = activeExId
      ? sets.filter(function (x) { return x.exercise_id === activeExId; }) : [];
    var last = activeExId ? SES.lastSetsFor(store, ctx.member_id, activeExId) : { sets: [] };
    var prev = curSets[curSets.length - 1];
    var activeName = cur ? cur.name : (activeExId
      ? ((store.find('m_exercises', activeExId) || {}).name || '自选动作') : '自选动作');

    /* 训练中只保留必要信息：不展示 XP 进度、成就弹窗、任何推荐（02 §E.1） */
    return ''
      + '<section class="m-card m-card-blue">'
      + '<div class="m-card-h"><h2>训练中</h2>'
      + '<span class="m-pill">' + (s.status === 'paused' ? '已暂停' : '进行中') + '</span></div>'
      + '<div class="m-now"><b>' + esc(activeName) + '</b>'
      + (cur ? '<span>目标 ' + esc(cur.target_sets) + ' 组 × ' + esc(cur.target_reps) + ' 次'
        + (cur.target_weight ? ' · ' + esc(cur.target_weight) + 'kg' : '') + '</span>' : '')
      + '</div>'
      + '<div class="m-setn">已完成 <b>' + curSets.length + '</b> 组'
      + (cur ? ' / ' + esc(cur.target_sets) : '') + ' · 本次共 ' + sets.length + ' 组</div>'
      + '</section>'

      + (cur ? '' : '<section class="m-card"><div class="m-card-h"><h2>选择动作</h2></div>'
        + '<div class="m-form"><label class="m-fld"><span>动作</span><select id="wPickEx">'
        + store.all('m_exercises').map(function (e) {
          /* 回显当前正在练的动作，否则每次重渲染都会跳回列表第一项 */
          return '<option value="' + esc(e.exercise_id) + '"'
            + (e.exercise_id === activeExId ? ' selected' : '') + '>' + esc(e.name) + '</option>';
        }).join('') + '</select></label></div></section>')

      + '<section class="m-card"><div class="m-card-h"><h2>记录这一组</h2></div>'
      + (last.sets.length
        ? '<p class="m-hint">上次（' + esc(last.date) + '）：'
          + last.sets.slice(0, 3).map(function (x) {
            return (x.weight ? x.weight + 'kg × ' : '') + x.reps + ' 次';
          }).join('，') + '</p>'
        : '<p class="m-hint">这个动作还没有历史记录。</p>')
      + '<div class="m-form m-form-row">'
      + '<label class="m-fld"><span>重量（kg）</span>'
      + '<input id="wWeight" type="text" inputmode="decimal" placeholder="自重留空" value="'
      + (prev ? esc(prev.weight) : (cur && cur.target_weight ? esc(cur.target_weight) : '')) + '"></label>'
      + '<label class="m-fld"><span>次数 <b class="m-req">*</b></span>'
      + '<input id="wReps" type="text" inputmode="numeric" placeholder="1-999" value="'
      + (prev ? esc(prev.reps) : (cur ? esc(cur.target_reps) : '')) + '"></label>'
      + '</div>'
      + '<div class="m-btn-row">'
      + '<button class="m-btn m-btn-primary m-btn-lg" id="btnLogSet">完成本组</button>'
      + (prev ? '<button class="m-btn m-btn-ghost" id="btnCopyPrev">复制上一组</button>' : '')
      + (sets.length ? '<button class="m-btn m-btn-ghost" id="btnUndoSet">撤销上一组</button>' : '')
      + '</div><div class="m-hint" id="wMsg"></div>'
      + '</section>'

      + (curSets.length ? '<section class="m-card"><div class="m-card-h"><h2>本动作已记录</h2></div>'
        + curSets.map(function (x, i) {
          return '<div class="m-setrow"><span>第 ' + (i + 1) + ' 组</span><b>'
            + (x.weight ? esc(x.weight) + 'kg × ' : '') + esc(x.reps) + ' 次</b>'
            + '<em>' + esc(String(x.logged_at).slice(11, 16)) + '</em></div>';
        }).join('') + '</section>' : '')

      /* 结束区单独一张卡 + 灰底分区：与上方的「记录这一组」拉开距离，
         避免连记几组后手滑点到「结束并结算」/「放弃这次训练」。 */
      + '<section class="m-card m-finish-zone"><div class="m-card-h"><h2>结束训练</h2></div>'
      + '<div class="m-form"><label class="m-fld"><span>这次练得怎么样 <b class="m-req">*</b></span>'
      + '<select id="wFeeling">'
      + opt(['', 'great', 'good', 'normal', 'tired', 'pain'],
        ['请选择', '很轻松', '还不错', '一般', '有点累', '有疼痛或不适'], '')
      + '</select></label></div>'
      + '<p class="m-hint" id="wPainTip" hidden>如果疼痛持续或加重，请停止训练并咨询医生或教练。'
      + '这里只做安全提示，不做任何诊断。</p>'
      + '<div class="m-btn-row">'
      /* 结束并结算不是「主操作」：主紫实心只留给开练类动作，
         这里用深墨色实心，避免和上方「完成本组」连成一片紫色。 */
      + '<button class="m-btn m-btn-finish" id="btnFinish">结束并结算</button>'
      + (s.status === 'paused'
        ? '<button class="m-btn" id="btnResume">继续计时</button>'
        : '<button class="m-btn m-btn-ghost" id="btnPause">暂停</button>')
      + '<button class="m-btn m-btn-danger" id="btnGiveUp">放弃这次训练</button>'
      + '</div><div class="m-hint" id="wEndMsg"></div>'
      + '</section>';
  }

  function bindWorkout(r) {
    var s = store.find('m_sessions', r.id);
    if (!s) return;
    var msg = $('wMsg'), endMsg = $('wEndMsg');
    var snap = {};
    try { snap = JSON.parse(s.plan_snapshot || '{}'); } catch (e) { snap = { items: [] }; }
    var cur = currentPlanItem(s);

    /* 自由训练下把「选择动作」的变化记住；不记住的话记完一组重渲染就跳回第一项 */
    var pickSel = $('wPickEx');
    if (pickSel) {
      pickSel.addEventListener('change', function () {
        wExPick = pickSel.value;
        render();
      });
    }

    function curExId() {
      if (cur) return cur.exercise_id;
      if (wExPick) return wExPick;
      var sel = $('wPickEx');
      return sel ? sel.value : '';
    }

    var log = $('btnLogSet');
    if (log) log.addEventListener('click', function () {
      var exId = curExId();
      if (!exId) { if (msg) { msg.className = 'm-hint m-err'; msg.textContent = '请先选择动作'; } return; }
      /* 非法输入即时拦截，不允许提交后才发现（02 §E.2） */
      var rr = SES.logSet(store, ctx.member_id, s.session_id, {
        exercise_id: exId,
        weight: $('wWeight') ? $('wWeight').value : '',
        reps: $('wReps') ? $('wReps').value : ''
      }, { persist: persist });
      if (rr.ok === false) {
        if (msg) { msg.className = 'm-hint m-err'; msg.textContent = rr.message || rr.reason; }
        return;
      }
      if (msg) { msg.className = 'm-hint m-ok'; msg.textContent = '第 ' + rr.setIndex + ' 组已记录并保存'; }
      render();
    });

    var cp = $('btnCopyPrev');
    if (cp) cp.addEventListener('click', function () {
      var sets = SES.setsOf(store, s.session_id);
      var prev = sets[sets.length - 1];
      if (!prev) return;
      if ($('wWeight')) $('wWeight').value = prev.weight || '';
      if ($('wReps')) $('wReps').value = prev.reps || '';
      if (msg) { msg.className = 'm-hint'; msg.textContent = '已带入上一组，仍可修改'; }
    });

    var un = $('btnUndoSet');
    if (un) un.addEventListener('click', function () {
      if (!W.confirm('撤销刚记的那一组？')) return;
      var rr = SES.undoLastSet(store, ctx.member_id, s.session_id);
      if (rr.ok === false) { toast(rr.message || rr.reason, 'err'); return; }
      persist(); render();
    });

    var fin = $('btnFinish');
    if (fin) fin.addEventListener('click', function () {
      var f = $('wFeeling') ? $('wFeeling').value : '';
      var rr = SES.complete(store, ctx.member_id, s.session_id, { feeling: f });
      if (rr.ok === false) {
        if (endMsg) { endMsg.className = 'm-hint m-err'; endMsg.textContent = rr.message || rr.reason; }
        return;
      }
      persist();
      var st = XP.settleSession(store, ctx.member_id, s.session_id);
      if (st.ok === false || st.settleFailed) {
        /* 结算失败：会话已 completed 但没发奖，必须让用户看见并允许重试（05 §12） */
        persist();
        toast('本次结算未完成，请回到结算页点「重试结算」', 'err', 8000);
        go('#summary/' + s.session_id);
        return;
      }
      persist();
      /* 练完了但一分没发：多半是今日经验已到上限。不提示的话，用户只会以为结算坏了。
         这里只解释原因，不碰结算的发放逻辑与上限数值。 */
      if (st.capped && !(+st.gained > 0)) {
        toast('训练已结算，但今天的经验已经到上限了 —— 这次不计 XP，次日 0 点恢复', 'warn', 7000);
      }
      go('#summary/' + s.session_id);
    });

    var pz = $('btnPause');
    if (pz) pz.addEventListener('click', function () {
      run(SES.pauseSession(store, ctx.member_id, s.session_id), '已暂停，暂停时间不计入训练时长') && render();
    });
    var rz = $('btnResume');
    if (rz) rz.addEventListener('click', function () {
      run(SES.resumeSession(store, ctx.member_id, s.session_id), '已继续') && render();
    });
    var gv = $('btnGiveUp');
    if (gv) gv.addEventListener('click', function () {
      if (!W.confirm('放弃这次训练？已经记录的组会保留，但不会结算 XP、不进历史。')) return;
      run(SES.abandon(store, ctx.member_id, s.session_id)) && go('#home');
    });

    var feel = $('wFeeling');
    var tip = $('wPainTip');
    if (feel && tip) {
      feel.addEventListener('change', function () { tip.hidden = feel.value !== 'pain'; });
    }
  }

  /* ---------------------------------------------------------------- 页面：结算卡 #summary/:id */

  function pageSummary(r) {
    var s = store.find('m_sessions', r.id);
    if (!s || s.member_id !== ctx.member_id) {
      return '<section class="m-card"><p class="m-p">没有找到这次训练。</p></section>';
    }
    if (s.status !== 'completed') { go('#workout/' + s.session_id); return ''; }

    var sm = SES.summary(store, ctx.member_id, s.session_id);
    var led = XP.ledgerOf(store, ctx.member_id, s.session_id);
    var total = led.reduce(function (a, x) { return a + (+x.points || 0); }, 0);
    var ov = XP.overview(store, ctx.member_id);
    var recs = store.all('m_records').filter(function (x) { return x.session_id === s.session_id; });

    return ''
      + '<section class="m-card m-card-done"><div class="m-card-h"><h2>训练完成</h2>'
      + '<span class="m-pill">' + esc(sm.session_date) + '</span></div>'
      + '<div class="m-sumgrid">'
      + sumCell('训练时长', Math.floor(sm.duration_sec / 60) + ' 分 ' + (sm.duration_sec % 60) + ' 秒')
      + sumCell('动作数', sm.actual_exercise_count + ' / ' + sm.planned_exercise_count)
      + sumCell('完成组数', sm.total_sets + ' / ' + sm.planned_sets)
      + sumCell('总容量', sm.total_volume + ' kg')
      + sumCell('计划完成度', sm.completion_rate + '%')
      + sumCell('训练感受', feelingName(sm.feeling))
      + '</div>'
      + '<p class="m-hint">总容量 = 每一组「重量 × 次数」再求和；自重动作不计重量。</p>'
      + '</section>'

      + (sm.per_exercise.length
        ? '<section class="m-card"><div class="m-card-h"><h2>计划 vs 实际</h2></div>'
          + sm.per_exercise.map(function (x) {
            return '<div class="m-rowitem"><div class="m-rowitem-t">' + esc(x.name)
              + ' <em>' + x.planned_sets + ' → ' + x.actual_sets + ' 组</em></div>'
              + '<div class="m-rowitem-s">' + x.volume + ' kg</div></div>';
          }).join('') + '</section>'
        : '')

      + '<section class="m-card m-card-done"><div class="m-card-h"><h2>本次获得 XP</h2>'
      + '<span class="m-pill">+' + total + '</span></div>'
      + (led.length
        ? led.map(function (x) {
          return '<div class="m-rowitem"><div class="m-rowitem-t">' + esc(x.note || x.rule_code)
            + '<em>' + esc(x.rule_code) + '</em></div>'
            + '<div class="m-rowitem-s">' + (x.points > 0 ? '+' : '') + x.points + '</div></div>';
        }).join('')
        : '<p class="m-p">本次没有发放 XP。</p>')
      + xpCapHint(total)
      + '<p class="m-hint">每一条都对应流水里的一行，可以在设置页导出后逐条核对。</p>'
      + '<div class="m-btn-row"><button class="m-btn m-btn-sm" id="btnRetrySettle">重试结算</button></div>'
      + '</section>'

      + (recs.length
        ? '<section class="m-card"><div class="m-card-h"><h2>本次刷新纪录</h2></div>'
          + recs.map(function (x) {
            var ex = store.find('m_exercises', x.exercise_id);
            return '<div class="m-rowitem"><div class="m-rowitem-t">'
              + esc(ex ? ex.name : x.exercise_id) + ' · ' + recTypeName(x.record_type)
              + (x.previous_value ? ' <em>原 ' + esc(x.previous_value) + '</em>' : '') + '</div>'
              + '<div class="m-rowitem-s">' + esc(x.value) + '</div></div>';
          }).join('') + '</section>'
        : '')

      + '<section class="m-card"><div class="m-card-h"><h2>当前等级</h2></div>'
      + '<div class="m-xpline"><div class="m-lv">Lv.' + ov.level + '</div>'
      + '<div class="m-lvinfo"><div class="m-lvtitle">' + esc(ov.level_title) + '</div>'
      + '<div class="m-task-v">' + ov.lifetime_xp + ' XP · 连续 ' + ov.active_days_streak + ' 天</div></div></div>'
      + '<div class="m-btn-row">'
      + '<a class="m-btn m-btn-primary" href="#home">回到今日</a>'
      + '<a class="m-btn" href="#history">查看历史</a>'
      + '</div></section>';
  }

  function sumCell(label, value) {
    return '<div class="m-sumcell"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }
  function feelingName(f) {
    return { great: '很轻松', good: '还不错', normal: '一般', tired: '有点累', pain: '有疼痛或不适' }[f] || '未填写';
  }

  /* 今日经验上限提示。
     只解释「为什么这次是 0 分」，不改任何结算逻辑与数值：触到单日上限时整条 XP 都不发，
     页面看上去就成了「练完了却没加分」。告诉用户上限已到，比让他以为出错要好。
     上限值从 XP.CONFIG 读，不在页面里写死 300。 */
  function xpCapHint(totalGained) {
    try {
      var lim = XP.CONFIG && XP.CONFIG.limits;
      if (!lim || !lim.perDay) return '';
      if (+totalGained > 0) return '';
      if (XP.dayXp(store, ctx.member_id, today()) < lim.perDay) return '';
    } catch (e) { return ''; }
    return '<p class="m-hint m-warn">今天的经验已经到上限了：这次训练照常记录、照常进历史，'
      + '只是这一天不再发放 XP，次日 0 点恢复。</p>';
  }

  function bindSummary(r) {
    var rs = $('btnRetrySettle');
    if (!rs) return;
    rs.addEventListener('click', function () {
      var st = XP.settleSession(store, ctx.member_id, r.id);
      if (st.ok === false || st.settleFailed) { toast('结算仍未成功：' + (st.message || st.reason), 'err', 6000); return; }
      if (st.duplicate) { toast('这次训练已经结算过了，不会重复发放', 'ok'); return; }
      persist();
      toast('结算完成，+' + st.gained + ' XP', 'ok');
      render();
    });
  }

  /* ---------------------------------------------------------------- 页面：训练历史 #history / #session/:id */

  function pageHistory() {
    var h = SES.history(store, ctx.member_id, { pageSize: 50 });
    var w = XP.weeklyStats(store, ctx.member_id, PLAN.mondayOf(today()));
    return ''
      + '<section class="m-card m-card-blue"><div class="m-card-h"><h2>训练历史</h2>'
      + '<span class="m-pill">共 ' + h.total + ' 次</span></div>'
      + '<p class="m-p">本周已完成 ' + w.completedCount + ' / ' + w.frequencyGoal + ' 次，'
      + '总容量 ' + w.volume + ' kg。</p></section>'
      + (h.items.length
        ? '<section class="m-card">' + h.items.map(function (x) {
          return '<a class="m-hist" href="#session/' + esc(x.session_id) + '">'
            + '<div class="m-hist-d">' + esc(x.session_date) + '</div>'
            + '<div class="m-hist-m">' + Math.floor(x.duration_sec / 60) + ' 分钟 · '
            + x.exercise_count + ' 个动作 · ' + x.total_sets + ' 组 · ' + x.total_volume + ' kg</div>'
            + '<div class="m-hist-f">' + feelingName(x.feeling) + '</div></a>';
        }).join('') + '</section>'
        : '<section class="m-card"><p class="m-p">还没有完成过训练。</p>'
          + '<div class="m-btn-row"><a class="m-btn m-btn-primary" href="#home">去开始第一次</a></div></section>')
      + '<section class="m-card"><div class="m-card-h"><h2>个人纪录</h2>'
      + '<a class="m-more" href="#growth">成长中心</a></div>'
      + personalRecordsHtml() + '</section>';
  }

  function personalRecordsHtml() {
    var recs = store.all('m_records').filter(function (r) { return r.member_id === ctx.member_id; })
      .sort(function (a, b) { return String(b.achieved_at).localeCompare(String(a.achieved_at)); });
    if (!recs.length) return '<p class="m-p">还没有纪录。</p>';
    return recs.map(function (r) {
      var ex = store.find('m_exercises', r.exercise_id);
      return '<div class="m-rowitem"><div class="m-rowitem-t">' + esc(ex ? ex.name : r.exercise_id)
        + ' · ' + recTypeName(r.record_type)
        + (r.previous_value ? ' <em>前值 ' + esc(r.previous_value) + '</em>' : '') + '</div>'
        + '<div class="m-rowitem-s">' + esc(r.value) + ' · ' + esc(String(r.achieved_at).slice(0, 10)) + '</div></div>';
    }).join('');
  }

  function pageSession(r) {
    var s = store.find('m_sessions', r.id);
    if (!s || s.member_id !== ctx.member_id) {
      return '<section class="m-card"><p class="m-p">没有找到这次训练。</p></section>';
    }
    var sm = SES.summary(store, ctx.member_id, s.session_id) || {};
    var sets = SES.setsOf(store, s.session_id);
    var led = XP.ledgerOf(store, ctx.member_id, s.session_id);

    var byEx = {};
    sets.forEach(function (x) {
      if (!byEx[x.exercise_id]) byEx[x.exercise_id] = [];
      byEx[x.exercise_id].push(x);
    });

    return ''
      + '<section class="m-card m-card-blue"><div class="m-card-h"><h2>' + esc(sm.session_date) + ' 的训练</h2>'
      + '<span class="m-pill">' + (s.status === 'completed' ? '已完成' : s.status) + '</span></div>'
      + '<div class="m-sumgrid">'
      + sumCell('时长', Math.floor(sm.duration_sec / 60) + ' 分')
      + sumCell('动作', sm.actual_exercise_count + ' 个')
      + sumCell('组数', sm.total_sets + ' 组')
      + sumCell('容量', sm.total_volume + ' kg')
      + sumCell('完成度', sm.completion_rate + '%')
      + sumCell('感受', feelingName(sm.feeling))
      + '</div></section>'
      + '<section class="m-card"><div class="m-card-h"><h2>逐组数据</h2></div>'
      + (sets.length
        ? Object.keys(byEx).map(function (exId) {
          var rows = byEx[exId];
          return '<div class="m-exblock"><div class="m-exblock-t">'
            + esc(rows[0].exercise_name_snapshot || exId) + '</div>'
            + rows.map(function (x, i) {
              var corr = SES.correctionsOf(store, ctx.member_id, x.set_id);
              return '<div class="m-setrow"><span>第 ' + (i + 1) + ' 组</span><b>'
                + (x.weight ? esc(x.weight) + 'kg × ' : '') + esc(x.reps) + ' 次</b>'
                + (corr.length ? '<em>已修正 ' + corr.length + ' 次</em>' : '')
                + (s.status === 'completed'
                  ? '<button class="m-btn m-btn-xs" data-fix="' + esc(x.set_id) + '">申请修正</button>' : '')
                + '</div>';
            }).join('') + '</div>';
        }).join('')
        : '<p class="m-p">这次训练没有记录任何组。</p>')
      + '</section>'
      + (led.length ? '<section class="m-card"><div class="m-card-h"><h2>本次 XP 明细</h2></div>'
        + led.map(function (x) {
          return '<div class="m-rowitem"><div class="m-rowitem-t">' + esc(x.note || x.rule_code) + '</div>'
            + '<div class="m-rowitem-s">' + (x.points > 0 ? '+' : '') + x.points + '</div></div>';
        }).join('') + '</section>' : '')
      + '<div class="m-btn-row"><a class="m-btn" href="#history">返回历史</a></div>'
      + '<p class="m-hint">已完成的训练是<b>只读</b>的；确实记错了可以走「申请修正」，'
      + '每次修正都会留痕，原值与原因都能在导出文件里查到。</p>';
  }

  function bindSession() {
    document.querySelectorAll('[data-fix]').forEach(function (b) {
      b.addEventListener('click', function () {
        var setId = b.getAttribute('data-fix');
        var row = store.find('m_sets', setId);
        if (!row) return;
        var field = W.prompt('要修正哪个字段？可填：weight / reps / rpe / rest_sec / note', 'weight');
        if (!field) return;
        var nv = W.prompt('新值：', String(row[field] == null ? '' : row[field]));
        if (nv === null) return;
        var why = W.prompt('修正原因（必填，会留痕）：', '');
        if (why === null) return;
        var r = SES.correctSet(store, ctx.member_id, setId, field, nv, why);
        if (r.ok === false) {
          if (r.reason === 'too_many' && W.confirm(r.message + '\n\n仍然要继续修正吗？')) {
            r = SES.correctSet(store, ctx.member_id, setId, field, nv, why, { force: true });
          }
          if (r.ok === false) { toast(r.message || r.reason, 'err', 6000); return; }
        }
        run(r, '已修正并记录原因'); render();
      });
    });
  }

  /* ---------------------------------------------------------------- 页面：成长中心 #growth */

  function pageGrowth(r) {
    var tab = r.q.tab || 'level';
    var ov = XP.overview(store, ctx.member_id);
    var achv = XP.achievementList(store, ctx.member_id);
    var nx = XP.nextLevel(ov.lifetime_xp);

    /* 调整建议与合并时间线都在这里现算：
       两者都是纯读，所以放在渲染前调用是安全的，不会在「只是看一眼」的时候动数据。 */
    var sugRes = GR ? GR.suggest(store, ctx.member_id, { today: today(), max: 2 }) : null;
    var sug = (sugRes && sugRes.suggestions) || [];
    var why = sugRes ? sugRes.why : '';
    var kind = r.q.kind || 'all';
    var tl = GR ? GR.timeline(store, ctx.member_id, {
      today: today(), limit: 60, kinds: kind === 'all' ? null : [kind]
    }) : [];

    var body = '';
    if (tab === 'level') {
      body = '<section class="m-card m-card-teal"><div class="m-card-h"><h2>等级</h2></div>'
        + '<div class="m-xpline"><div class="m-lv">Lv.' + ov.level + '</div>'
        + '<div class="m-lvinfo"><div class="m-lvtitle">' + esc(ov.level_title) + '</div>'
        + '<div class="m-bar"><i style="width:' + (ov.xp_for_level > 0
          ? Math.min(100, Math.round(ov.xp_into_level / ov.xp_for_level * 100)) : 0) + '%"></i></div>'
        + '<div class="m-task-v">' + ov.lifetime_xp + ' XP'
        + (nx ? ' · 距 Lv.' + nx.level + ' 还差 ' + (nx.min - ov.lifetime_xp) : ' · 已满级') + '</div></div></div>'
        + '<p class="m-hint">等级只升不降。即便发生数据修正导致经验减少，已达成的等级也会保留。</p>'
        + '</section>'
        + '<section class="m-card"><div class="m-card-h"><h2>连续训练</h2></div>'
        + '<div class="m-sumgrid">'
        + sumCell('当前连续', ov.active_days_streak + ' 天')
        + sumCell('最长连续', ov.best_days_streak + ' 天')
        + sumCell('连续达标周', ov.weekly_goal_streak + ' 周')
        + '</div>'
        + '<p class="m-hint">休息一天不会断，连续两天没练才会重新开始。'
        + '少练了也不会被扣经验、不会有羞辱性提醒——节奏断了随时可以再开始。</p>'
        + '</section>'
        + exploreEntryHtml();
    } else if (tab === 'achv') {
      body = '<section class="m-card"><div class="m-card-h"><h2>成就</h2></div>'
        + achv.map(function (a) {
          return '<div class="m-achv' + (a.unlocked ? ' m-achv-on' : '') + '">'
            + '<div class="m-achv-n">' + esc(a.name) + (a.tier ? ' <span class="m-pill">第 ' + a.tier + ' 档</span>' : '') + '</div>'
            + '<div class="m-achv-d">' + esc(a.desc) + (a.unlocked ? ' · +' + a.xp + ' XP' : '') + '</div></div>';
        }).join('')
        + '<p class="m-hint">带「??? 」的是隐藏成就，达成后才会揭晓。</p></section>';
    } else if (tab === 'record') {
      body = '<section class="m-card"><div class="m-card-h"><h2>个人纪录</h2></div>'
        + personalRecordsHtml()
        + '<p class="m-hint">纪录全部来自你实际记录的组数据，不需要手动申报。</p></section>';
    } else if (tab === 'adjust') {
      body = '<section class="m-card"><div class="m-card-h"><h2>这一周的建议</h2></div>'
        + '<p class="m-hint">建议只按你实际完成的数据算：上次计划做到多少、连了几周、有没有中断。'
        + '<b>系统不会自己动手改你的计划</b>，只有你点了「就按这个来」才会。</p></section>'
        + adjustCardsHtml(sug, why);
    } else if (tab === 'timeline') {
      body = '<section class="m-card"><div class="m-card-h"><h2>成长时间线</h2></div>'
        + '<div class="m-chips">'
        + [['all', '全部'], ['record', '纪录'], ['achv', '成就'], ['level', '等级'],
           ['explore', '探索'], ['adjust', '调整'], ['streak', '连续']].map(function (k) {
          return '<a class="m-chip-x' + (kind === k[0] ? ' m-chip-x-on' : '')
            + '" href="#growth?tab=timeline&kind=' + k[0] + '">' + k[1] + '</a>';
        }).join('') + '</div>'
        + (tl.length ? tl.map(timelineItemHtml).join('') : '<p class="m-p">这一类还没有事件。</p>')
        + '<p class="m-hint">这些都是已经落地的记录的另一副样子：'
        + '探索解锁来自 m_unlocks、调整来自 m_adjustments，没有再造一份事实。</p>'
        + '</section>';
    } else if (tab === 'trend') {
      /* 近 8 周趋势。GR.trend 领域层早就在算、也有单测，但此前 member.js 里没有一处调用，
         等于功能存在而用户完全看不见——这一版是第一次把它画出来。纯读，放渲染里安全。 */
      body = trendHtml(GR ? GR.trend(store, ctx.member_id, { today: today(), weeks: 8 }) : []);
    }

    return ''
      + '<section class="m-card m-card-blue"><div class="m-card-h"><h2>成长中心</h2></div>'
      + '<div class="m-tabs">'
      + [['level', '等级'], ['achv', '成就'], ['record', '纪录'],
         ['adjust', '调整'], ['timeline', '时间线'], ['trend', '趋势']].map(function (x) {
        return '<a class="m-tab2' + (tab === x[0] ? ' m-tab2-on' : '') + '" href="#growth?tab=' + x[0] + '">'
          + x[1] + '</a>';
      }).join('') + '</div></section>'
      + body;
  }

  /** 把当前选中的 tab 滚进视野。
      .m-tabs 是 nowrap + 横滑的（这是当初修 1px 折行时的结论：结构上不可能出孤行）。
      加到第 6 个「趋势」后，390 宽下总宽超出容器约 38px，最后一个 tab 初始不在视野里——
      用户会以为没有这个页签。解法不是继续调窄内边距（那又回到"靠宽度刚好放得下"的脆弱路子），
      而是让选中的那个自己滚进来：以后再加第 7、第 8 个 tab 也不会失明。
      只改容器的 scrollLeft，不动页面布局，因此不影响「三视口无横向溢出」那条红线。 */
  function centerActiveTab() {
    var box = document.querySelector('.m-tabs');
    if (!box) return;
    var on = box.querySelector('.m-tab2-on');
    if (!on) return;
    var max = box.scrollWidth - box.clientWidth;
    var target = on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2;
    if (target < 0) target = 0;
    if (target > max) target = max;
    box.scrollLeft = target;
  }

  /** 近 8 周趋势：一行一周，条长按本周容量相对最大周的比例。
      刻意不画折线图——零依赖、零构建，用 CSS 条能表达「变多还是变少」就够了，
      而且不引入任何新库，符合小程序化的约束。 */
  function trendHtml(rows) {
    rows = rows || [];
    var maxV = 0, i, any = false;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].volume > maxV) maxV = rows[i].volume;
      if (rows[i].completed || rows[i].sets) any = true;
    }
    if (!any) {
      return '<section class="m-card"><div class="m-card-h"><h2>近 8 周趋势</h2></div>'
        + '<p class="m-p">还没有任何完成的训练，所以这里暂时是空的。</p>'
        + '<p class="m-hint">完成一次训练后，这个页会按周显示你练了多少次、多少组、总容量多少。</p>'
        + '</section>';
    }
    var body = rows.map(function (w) {
      var md = String(w.week_start).slice(5).replace('-', '/');
      var pct = maxV ? Math.round(w.volume / maxV * 100) : 0;
      return '<div class="m-tlitem">'
        + '<div class="m-trendrow-h"><span class="m-tl-t">' + esc(md) + ' 那一周</span>'
        + '<span class="m-task-v">' + w.completed + ' 次 · ' + w.sets + ' 组</span></div>'
        + '<div class="m-bar"><i style="width:' + pct + '%"></i></div>'
        + '<div class="m-tl-s">' + Math.round(w.volume) + ' kg'
        /* 完成率只在那一周真的排了计划时才显示：没排计划的周 rate 也是 0，
           显示成「完成率 0%」会把「没安排」说成「全没做」。 */
        + (w.plan_rate > 0 ? ' · 计划完成 ' + w.plan_rate + '%' : '')
        + (w.rpe_count ? ' · 平均费力 ' + w.rpe_avg + '/10' : '')
        + (w.pr_count ? ' · ' + w.pr_count + ' 个新纪录' : '')
        + '</div></div>';
    }).join('');
    return '<section class="m-card"><div class="m-card-h"><h2>近 8 周趋势</h2></div>'
      + body
      + '<p class="m-hint">条长是这一周的总容量（重量×次数）相对这 8 周里最高那一周的比例，'
      + '只看相对变化，不跟别人比。中途有周是空的也正常，不是退步。</p>'
      + '</section>';
  }

  /** 时间线单条：统一带类型标签，能溯源的点了就跳过去 */
  function timelineItemHtml(t) {
    var href = '';
    if (t.ref_type === 'm_timeline' && String(t.ref_id).slice(0, 2) === 'WS') href = '#session/' + t.ref_id;
    var inner = '<div class="m-tlitem">'
      + '<div class="m-tl-d">' + esc(String(t.at || '').slice(0, 16))
      + (t.approximate ? ' <span class="m-pill">近似</span>' : '') + '</div>'
      + '<div class="m-tl-t">' + KIND_ICON[t.kind] + esc(t.title) + '</div>'
      + (t.detail ? '<div class="m-tl-s">' + esc(t.detail) + '</div>' : '')
      + (t.rule_version ? '<div class="m-tl-s">规则版本 ' + esc(t.rule_version) + '</div>' : '')
      + '</div>';
    return href ? '<a class="m-tllink" href="' + href + '">' + inner + '</a>' : inner;
  }
  var KIND_ICON = { record: '◆ ', achv: '★ ', level: '▲ ', explore: '◎ ', adjust: '✎ ', streak: '⌁ ', week: '✔ ', goal: '▣ ', other: '· ' };

  /* ================================================================
     页面：探索地图 #explore
     领域层是上一批就写好的 fxp-member-explore.js，这里只做视图。
     解锁扫描放在 bindExplore 而不是 pageExplore —— 页面函数保持只读，
     写盘与再渲染都放在绑定阶段，这样「看一眼页面」和「真的落解锁」是两件分开的事。
     ================================================================ */

  var exploreJustUnlocked = [];

  function pageExplore(r) {
    if (!EX) {
      return '<section class="m-card"><div class="m-card-h"><h2>探索地图</h2></div>'
        + '<p class="m-p">探索模块未加载，请确认页面脚本顺序。</p></section>';
    }
    var dim = r.q.dim || '';
    var key = r.q.key || '';

    var ov = EX.dimensions(store, ctx.member_id, {}) || {};
    var sum = ov.summary || {};
    var dims = ov.dimensions || [];

    var head = '<section class="m-card m-card-teal"><div class="m-card-h"><h2>探索地图</h2>'
      + '<span class="m-pill">' + esc(sum.ruleVersion || '') + '</span></div>'
      + '<p class="m-p">你试过的动作越多，下面这些格子点得越亮。'
      + '<b>这只是记录你练过什么，不代表练得好不好</b>，也不构成任何训练建议。</p>'
      + '<div class="m-bar"><i style="width:' + (sum.percent || 0) + '%"></i></div>'
      + '<div class="m-task-v">已试过 ' + (sum.triedExercises || 0) + ' / ' + (sum.totalExercises || 0)
      + ' 个动作 · ' + (sum.percent || 0) + '%</div>'
      + '</section>';

    if (exploreJustUnlocked.length) {
      head = '<section class="m-card m-card-amber"><div class="m-card-h"><h2>刚点亮的格子</h2></div>'
        + '<p class="m-p">这次进来新解锁 ' + exploreJustUnlocked.length + ' 项：</p>'
        + '<div class="m-evi">' + exploreJustUnlocked.map(function (u) {
          return '<span class="m-evi-i"><i>' + esc(EX.DIMENSIONS.filter(function (d) { return d.key === u.dim; })[0]
              ? EX.DIMENSIONS.filter(function (d) { return d.key === u.dim; })[0].label : u.dim) + '</i>'
            + esc(dimKeyLabel(u.dim, u.key)) + ' · Lv.' + u.tier + '</span>';
        }).join('') + '</div>'
        + '<p class="m-hint">解锁只记录事实，不发经验值，也不会替你改任何计划。</p>'
        + '</section>' + head;
    }

    /* 详情页不需要筛选：进去就是看某一格的具体清单，再叠一层筛选只会让人以为内容丢了 */
    if (dim && key) return head + exploreDetailHtml(dim, key);

    var lv = r.q.lv || 'all';
    var visible = 0;
    dims.forEach(function (d) {
      (d.keys || []).forEach(function (k) { if (lvMatch(k, lv)) visible++; });
    });
    var bar = '<section class="m-card"><div class="m-chips">'
      + [['all', '全部'], ['on', '已解锁'], ['off', '未解锁']].map(function (x) {
        return '<a class="m-chip-x' + (lv === x[0] ? ' m-chip-x-on' : '')
          + '" href="#explore?lv=' + x[0] + '">' + x[1] + '</a>';
      }).join('') + '</div>'
      + '<p class="m-hint">「已解锁」= 这一类里你已经练够了动作、点亮了格子。'
      + '筛选只影响这张地图的显示，不会改你的任何记录。</p></section>';
    /* 筛完一个都不剩时要说清楚，否则页面一大片空白看着像坏了 */
    if (!visible) {
      return head + bar + '<section class="m-card"><p class="m-p">'
        + (lv === 'on' ? '还没有点亮的格子——先把「未解锁」里挑一个练一次，这里就会有内容。'
          : '所有格子都已经点亮了，可以换「已解锁」看看你走到哪一步了。')
        + '</p></section>';
    }
    return head + bar + dims.map(function (d) { return exploreDimCardHtml(d, lv); }).join('');
  }

  /** 格子是否命中筛选。level 是领域层算好的解锁层级，0 = 未解锁。 */
  function lvMatch(k, lv) {
    if (lv === 'on') return (k.level || 0) > 0;
    if (lv === 'off') return !(k.level || 0);
    return true;
  }

  /* ================================================================
     首页灵感卡
     三条硬规矩：
       1. 只展示，绝不自动写入 —— 不点按钮不产生任何数据；
       2. 点了也要**先确认**：确认框里写清楚会加几个动作、加到哪里；
       3. 写操作一律 runBusy，成功后给可见结论。
     ================================================================ */

  function inspireSectionHtml() {
    if (!EX) return '';
    var res = EX.inspireCards(store, ctx.member_id, { count: 3, today: today() });
    if (!res || res.ok === false) return '';
    var cards = res.cards || [];

    var head = '<section class="m-card m-card-purple"><div class="m-card-h"><h2>今天可以试试</h2>'
      + '<span class="m-pill">' + esc(res.ruleVersion || '') + '</span></div>';

    if (!cards.length) {
      return head
        + '<p class="m-p">' + esc(res.hint || '今天暂时没有适合你的灵感卡。') + '</p>'
        + '</section>';
    }

    var gw = PLAN.getWeekPlan(store, ctx.member_id, PLAN.mondayOf(today()));
    var hasPlan = (gw.plans || []).length > 0;

    return head
      + '<p class="m-hint">按你的人群（' + esc(personaName(res.persona)) + '）和可用器械挑的，'
      + '同一天刷新不会变。<b>只有你点了下面的按钮、并且确认之后，才会真的加进背包或计划。</b></p>'
      + cards.map(function (c) {
        return '<div class="m-insp" data-insp-card="' + esc(c.code) + '">'
          + '<div class="m-insp-t">' + esc(c.title)
          + ' <span class="m-pill">' + esc(c.minutes) + ' 分钟</span>'
          + (c.source === 'history' ? ' <span class="m-pill">来自你的历史</span>' : '') + '</div>'
          + (c.reason ? '<div class="m-insp-r">' + esc(c.reason) + '</div>' : '')
          + '<div class="m-insp-i">' + (c.items || []).map(function (it) {
            return '<div class="m-insp-li">' + esc(it.name)
              + ' <em>' + esc(it.sets) + ' 组 × ' + esc(it.reps) + ' 次</em></div>';
          }).join('') + '</div>'
          + '<div class="m-btn-row">'
          /* 卡内动作一律用次级样式：灵感卡是「建议」，
             主紫实心只留给首页「今天」那一处，否则一屏会出现 6 个大紫按钮。 */
          + '<button class="m-btn m-btn-sm m-btn-ghost" data-insp="' + esc(c.code)
          + '" data-insp-act="bag">加入今日背包</button>'
          + '<button class="m-btn m-btn-sm" data-insp="' + esc(c.code)
          + '" data-insp-act="plan"' + (hasPlan ? '' : ' disabled') + '>排进今天的计划</button>'
          + '</div>'
          + '</div>';
      }).join('')
      + (hasPlan ? '' : '<p class="m-hint">这一周还没有计划，所以「排进今天的计划」先锁着——'
        + '系统不会替你凭空造一份计划。去<a href="#plan">计划页</a>生成后就能用了。</p>')
      + '</section>';
  }

  /**
   * AI 动作教练是另一个独立页面（有自己的摄像头与姿态识别），这里只放一个入口，
   * 不碰它任何代码。麻烦在于路径：源码里叫 `03_AI教练/`，发布包里改名叫 `ai-coach/`，
   * 而会员端这一份 HTML 要同时能在这两种布局下用 —— 写死任何一个，另一种必然 404。
   * 单文件离线版里根本没有 AI 教练这个文件，所以返回空串让入口整块不渲染。
   */
  function aiCoachHref() {
    var p = String(W.location.pathname || '');
    if (p.indexOf('fitness-xp-member') >= 0) return '';
    if (p.indexOf('/member/') >= 0 || p.indexOf('/dist/') >= 0) return '../ai-coach/index.html';
    return '../03_AI教练/index.html';
  }

  /**
   * AI 入口卡的「能看多少动作」一句话。
   * 动作数与各等级数量**全部从 AI 端配置读出来**，不在这里写死数字：
   * 写死了配置一改文案立刻变成假话，等于在会员端造了第二个真值。
   * 配置没加载成功时只说最基本的那句，不编数字。
   */
  function aiCoachCapLine() {
    var cfg = aiCfg();
    if (!cfg || !cfg.RULE_LIST || !cfg.RULE_LIST.length || typeof cfg.getMonitor !== 'function') {
      return '用摄像头实时看动作姿态。';
    }
    var a = 0, b = 0;
    cfg.RULE_LIST.forEach(function (t) {
      var lv = (cfg.getMonitor(t) || {}).level;
      if (lv === 'A') a++; else if (lv === 'B') b++;
    });
    return '用摄像头实时看动作姿态，目前支持 ' + cfg.RULE_LIST.length + ' 个动作：'
      + a + ' 个可完整监测' + (b ? '、' + b + ' 个有限监测' : '') + '。'
      + '摄像头只读取人体姿态，不识别器械与配重。';
  }

  /** AI 教练入口卡：说清楚它是原型、要摄像头、与本页数据互不干扰 */
  function aiCoachEntryHtml() {
    var href = aiCoachHref();
    if (!href) return '';
    return '<section class="m-card"><div class="m-card-h"><h2>AI 动作教练</h2>'
      + '<span class="m-pill">原型</span></div>'
      + '<p class="m-p">' + esc(aiCoachCapLine()) + '</p>'
      + '<p class="m-hint">需要摄像头权限，且必须在 <b>https 或 localhost</b> 下打开才能调用摄像头；'
      + '直接双击 file:// 打开时，它会提示无法取流，这是浏览器限制，不是故障。'
      + '它与会员端各存各的数据，来回切换不会互相覆盖。</p>'
      + '<div class="m-btn-row"><a class="m-btn m-btn-ghost" target="_blank" rel="noopener" href="'
      + href + '">打开 AI 动作教练</a></div>'
      + '</section>';
  }

  function personaName(t) {
    return { beginner: '刚开始练', unstable: '还在找节奏', veteran: '已经很稳' }[t] || t || '—';
  }

  /** 灵感卡的写操作：先确认，再 runBusy，最后给可见结论 */
  function bindInspire() {
    if (!EX) return;
    var btns = document.querySelectorAll('[data-insp]');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        var code = b.getAttribute('data-insp');
        var act = b.getAttribute('data-insp-act');
        var card = findInspireCard(code);
        if (!card) { toast('这张卡已经不在今天的列表里了，刷新后再试', 'err'); return; }

        var names = (card.items || []).map(function (it) { return it.name; }).join('、');
        var where = act === 'bag' ? '加进「今日背包」' : '排进本周第 '
          + jsDayToPlanDay(new Date().getDay()) + ' 天（今天）的计划';
        var ok = W.confirm('把「' + card.title + '」' + where + '？\n\n'
          + '包含 ' + (card.items || []).length + ' 个动作：' + names + '\n\n'
          + '这一步只在你点确认之后才执行；已经在背包/计划里的同名动作会自动跳过。');
        if (!ok) return;

        runBusy(b, act === 'bag' ? '正在加入背包…' : '正在排进计划…', function () {
          var r = act === 'bag' ? doCardToBag(card) : doCardToPlan(card);
          if (!r || r.ok === false) {
            toast((r && (r.message || r.reason)) || '没有成功', 'err', 5000);
            return false;
          }
          /* 加完把这张卡收成一行结论，避免同一张卡被反复点 */
          var box = document.querySelector('[data-insp-card="' + code + '"]');
          if (box) {
            var skipped = (r.skipped || []).length;
            box.innerHTML = '<div class="m-insp-t">' + esc(card.title) + ' —— 已处理</div>'
              + '<div class="m-insp-r">加入了 ' + (r.added || []).length + ' 个动作'
              + (skipped ? '，' + skipped + ' 个已在里面跳过' : '') + '。</div>';
          }
          toast(act === 'bag' ? '已加入今日背包' : '已排进今天的计划', 'ok');
          return true;
        }, act === 'bag' ? '已加入背包' : '已排进计划');
      });
    });
  }

  /** 灵感卡是「同一天确定性」的，所以重新抽一次就能拿到同一张卡，不必把整张卡塞进 DOM */
  function findInspireCard(code) {
    var res = EX.inspireCards(store, ctx.member_id, { count: 3, today: today() });
    if (!res || !res.cards) return null;
    for (var i = 0; i < res.cards.length; i++) {
      if (res.cards[i].code === code) return res.cards[i];
    }
    return null;
  }

  function doCardToBag(card) {
    var bag = ensureBag();
    if (!bag) return { ok: false, reason: 'no_bag' };
    var r = EX.cardToBag(store, ctx.member_id, bag.bag_id, card, { today: today() });
    if (r && r.ok) persist();
    return r;
  }

  function doCardToPlan(card) {
    var week = PLAN.mondayOf(today());
    var gw = PLAN.getWeekPlan(store, ctx.member_id, week);
    var entries = gw.plans || [];
    /* 教练已确认的计划不能动（planGuard 会挡），这里先把可写的那份挑出来 */
    var target = null;
    for (var i = 0; i < entries.length; i++) {
      var p = entries[i].plan || {};
      if (p.source !== 'coach' || p.coach_confirmed !== 'Y') { target = p; break; }
    }
    if (!target) return { ok: false, reason: 'readonly', message: '这一周只有教练已确认的计划，会员端不能修改。' };
    var r = EX.cardToPlan(store, ctx.member_id, target.plan_id,
      jsDayToPlanDay(new Date().getDay()), card, { today: today() });
    if (r && r.ok) persist();
    return r;
  }

  /** 成长中心里的探索入口：只给一个入口，不在这里算数据（算在 #explore 页里） */
  function exploreEntryHtml() {
    if (!EX) return '';
    var ov = EX.dimensions(store, ctx.member_id, {}) || {};
    var s = ov.summary || {};
    return '<section class="m-card"><div class="m-card-h"><h2>探索地图</h2></div>'
      + '<p class="m-p">按肌群、动作模式、难度三个维度，看看你已经试过哪些动作、还有哪些没试过。</p>'
      + '<div class="m-bar"><i style="width:' + (s.percent || 0) + '%"></i></div>'
      + '<div class="m-task-v">已试过 ' + (s.triedExercises || 0) + ' / ' + (s.totalExercises || 0)
      + ' 个动作</div>'
      + '<div class="m-btn-row"><a class="m-btn m-btn-primary" href="#explore">打开探索地图</a></div>'
      + '</section>';
  }

  function dimKeyLabel(dim, key) {
    if (!EX) return key;
    if (dim === 'pattern') return EX.PATTERN_LABEL[key] || key;
    if (dim === 'difficulty') return EX.DIFF_LABEL[key] || key;
    return key;
  }

  function exploreDimCardHtml(d, lv) {
    var rows = (d.keys || []).filter(function (k) { return lvMatch(k, lv); }).map(function (k) {
      /* 这里的局部名不能也叫 lv：外层参数 lv 是筛选档位，同名会把两个意思糊在一起 */
      var lvNum = k.level || 0;
      /* 未解锁的格子整行降一级灰度：亮起来的自然是本页重点，不必给每格上色 */
      return '<a class="m-tlitem m-exrow' + (lvNum ? '' : ' m-exrow-off') + '" href="#explore?dim=' + encodeURIComponent(d.key)
        + '&key=' + encodeURIComponent(k.key) + '">'
        + '<div class="m-exrow-h"><span class="m-tl-t">' + esc(k.label) + '</span>'
        + '<span class="m-pill' + (lvNum ? ' m-pill-on' : '') + '">'
        + (lvNum ? 'Lv.' + lvNum : '未解锁') + '</span></div>'
        + '<div class="m-bar"><i style="width:' + (k.percent || 0) + '%"></i></div>'
        + '<div class="m-task-v">练过 ' + k.done + ' / ' + k.total + ' 个</div>'
        + '</a>';
    }).join('');
    return '<section class="m-card"><div class="m-card-h"><h2>按' + esc(d.label) + '看</h2></div>'
      + (rows || '<p class="m-hint">这个维度还没有可用的动作。</p>')
      + '</section>';
  }

  function exploreDetailHtml(dim, key) {
    var d = EX.dimensionDetail(store, ctx.member_id, dim, key, { limit: 40 });
    if (!d || d.ok === false) {
      return '<section class="m-card"><p class="m-p">'
        + esc((d && (d.message || d.reason)) || '这个维度看不了') + '</p></section>';
    }
    var doneRows = (d.done || []).map(function (e) {
      return '<div class="m-tlitem"><div class="m-tl-t">' + esc(e.name) + '</div>'
        + '<div class="m-tl-s">' + esc(e.difficultyLabel) + ' · 练过 ' + e.sets + ' 组'
        + (e.lastDate ? ' · 最近 ' + esc(String(e.lastDate).slice(0, 10)) : '') + '</div></div>';
    }).join('');
    var todoRows = (d.todo || []).map(function (e) {
      return '<a class="m-tllink" href="#exercise/' + esc(e.exercise_id) + '">'
        + '<div class="m-tlitem"><div class="m-tl-t">' + esc(e.name) + '</div>'
        + '<div class="m-tl-s">' + esc(e.difficultyLabel)
        + (e.beginnerFriendly ? ' · 新手友好' : '') + '</div></div></a>';
    }).join('');

    return '<section class="m-card"><div class="m-card-h"><h2>' + esc(d.label) + '</h2>'
      + '<a class="m-pill" href="#explore">← 返回全部</a></div>'
      + '<p class="m-hint">解锁门槛：' + esc(unlockGateText(dim)) + '</p></section>'
      + '<section class="m-card"><div class="m-card-h"><h2>练过的（' + d.doneTotal + '）</h2></div>'
      + (doneRows || '<p class="m-hint">这一类还没练过。</p>') + '</section>'
      + '<section class="m-card"><div class="m-card-h"><h2>还没试过的（' + d.todoTotal + '）</h2></div>'
      + (todoRows || '<p class="m-hint">这一类已经全部试过了。</p>')
      + '<p class="m-hint">点名字可以看动作详情，要不要加进背包由你自己决定，这里不会替你加。</p>'
      + '</section>';
  }

  function unlockGateText(dim) {
    var r = (EX && EX.UNLOCK_RULE && EX.UNLOCK_RULE[dim]) || { t1: 1, t2: 3 };
    return '练过 ' + r.t1 + ' 个解锁 Lv.1，练过 ' + r.t2 + ' 个解锁 Lv.2';
  }

  /**
   * 解锁扫描放在绑定阶段，不在 pageExplore 里跑：
   * 页面函数保持只读，写盘与"扫到新解锁后再渲染一次"都在这里，
   * 第二次进来 changed 为空就不会再渲染，不会死循环。
   */
  function bindExplore() {
    if (!EX) return;
    var res = EX.unlockScan(store, ctx.member_id, { today: today() });
    if (res && res.ok && res.changed && res.changed.length) {
      exploreJustUnlocked = res.changed;
      persist();
      render();
    } else {
      exploreJustUnlocked = [];
    }
  }

  /* ---------------------------------------------------------------- 渲染主循环 */

  function render() {
    var req = parseHash();
    var r = targetRoute();
    var app = $('mApp');
    if (!app) return;

    /* 地址栏与真实页面必须一致。
       targetRoute() 会把未核验的请求改判到 #verify，若只改页面不改地址，
       地址栏会停在一个当前根本看不到的路由（#plan），刷新或分享出去都会误导。
       这里统一回写一次，再由 hashchange 走正常的渲染流程。 */
    var want = '#' + r.route + (r.id ? '/' + r.id : '');
    if (r.route !== req.route || r.id !== req.id) {
      if (location.hash !== want) { location.hash = want; return; }
    }

    /* 首次进入且动作库为空 → 自动载入内置动作，保证开箱即用（Q4=A） */
    if (store.count('m_exercises') === 0) { IDN.loadSeed(store); }

    var html = '';
    if (r.route === 'register') html = pageRegister();
    else if (r.route === 'verify') html = pageVerify();
    else if (r.route === 'home') html = pageHome();
    else if (r.route === 'quick') html = pageQuick();
    else if (r.route === 'goals') html = pageGoals();
    else if (r.route === 'plan') html = pagePlan(r);
    else if (r.route === 'bag') html = pageBag();
    else if (r.route === 'workout') html = pageWorkout(r);
    else if (r.route === 'summary') html = pageSummary(r);
    else if (r.route === 'history') html = pageHistory();
    else if (r.route === 'session') html = pageSession(r);
    else if (r.route === 'growth') html = pageGrowth(r);
    else if (r.route === 'explore') html = pageExplore(r);
    else if (r.route === 'profile') html = pageProfile();
    else if (r.route === 'exercises') html = pageExercises(r);
    else if (r.route === 'exercise') html = pageExercise(r);
    else if (r.route === 'settings') html = pageSettings();
    else html = pageNotFound(r);

    app.innerHTML = html;
    renderChrome();

    if (r.route === 'register') bindRegister();
    else if (r.route === 'verify') bindVerify();
    else if (r.route === 'home') { bindHome(); bindAdjust(); bindInspire(); }
    else if (r.route === 'quick') bindQuick();
    else if (r.route === 'goals') bindGoals();
    else if (r.route === 'plan') { bindPlan(); bindAdjust(); }
    else if (r.route === 'bag') bindBag();
    else if (r.route === 'workout') bindWorkout(r);
    else if (r.route === 'summary') bindSummary(r);
    else if (r.route === 'session') bindSession();
    else if (r.route === 'growth') { bindAdjust(); centerActiveTab(); }
    else if (r.route === 'explore') bindExplore();
    else if (r.route === 'profile') bindProfile();
    else if (r.route === 'exercises') bindExercises();
    else if (r.route === 'exercise') bindExercise(r);
    else if (r.route === 'settings') { bindSettings(); updateStats(); }
  }

  /* ---------------------------------------------------------------- 设置页逻辑 */

  function updateStats() {
    var box = $('mStats');
    if (!box) return;
    box.innerHTML = MST.TABLES.map(function (t) {
      var n = store.count(t);
      return '<div class="m-stat' + (n ? ' m-stat-on' : '') + '">'
        + '<div class="m-stat-n">' + n + '</div>'
        + '<div class="m-stat-l">' + t.replace(/^m_/, '') + '</div></div>';
    }).join('');
    var load = $('mLoadMsg');
    if (load) load.textContent = '共 ' + MST.TABLES.length + ' 张表 · 存储键 ' + MST.KEY;
  }

  /* 动作库计数行。单独抽出，便于导入 / 载入后只刷这一行而不整页重渲染。 */
  function exLibLine() {
    var all = store.all('m_exercises');
    return '当前 <b>' + all.length + '</b> 个动作'
      + '（内置 ' + all.filter(function (e) { return e.source === 'self_authored'; }).length
      + ' / 自建 ' + all.filter(function (e) { return e.source === 'custom'; }).length + '）。';
  }

  function refreshExLine() {
    var el = $('exLibLine');
    if (el) el.innerHTML = exLibLine();
  }

  function bindSettings() {
    var pick = $('btnPick');
    if (pick && $('fileInput')) {
      pick.addEventListener('click', function () { $('fileInput').click(); });
      $('fileInput').addEventListener('change', handleFiles);
    }
    var ec = $('btnExportCsv');
    /* 导出 19 张表是真正的重活，且不会触发页面重渲染——
       这两个按钮的成功态用户能完整看到，是最需要 loading 的地方。 */
    if (ec) ec.addEventListener('click', function () {
      runBusy(ec, '正在导出…', function () { exportCsv(); return true; }, '已导出');
    });
    var ej = $('btnExportJson');
    if (ej) ej.addEventListener('click', function () {
      runBusy(ej, '正在打包…', function () { exportJson(); return true; }, '已导出备份');
    });
    var cl = $('btnClear');
    if (cl) cl.addEventListener('click', function () {
      if (!W.confirm('确定清空会员端全部数据？此操作不可恢复，且不会影响教练端。')) return;
      store.clearAll(); clearCtx(); render();
    });
    var rs = $('btnReloadSeed');
    if (rs) rs.addEventListener('click', function () {
      runBusy(rs, '正在载入…', function () {
        var r = IDN.loadSeed(store);
        store.save();
        var m = $('seedMsg');
        if (m) m.textContent = r.ok
          ? '已载入：新增 ' + r.added + ' 个，跳过 ' + r.skipped + ' 个（按 ID 幂等）。'
          : '载入失败：' + r.reason;
        updateStats();
        refreshExLine();
        return !!r.ok;
      }, '动作库已就绪');
    });
  }

  function download(name, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 0);
  }

  function exportCsv() {
    var msg = $('mExportMsg');
    var all = store.exportAll();
    var n = 0;
    Object.keys(all).forEach(function (t) {
      download(t + '.csv', all[t]);
      n++;
    });
    if (msg) msg.textContent = '已导出 ' + n + ' 个 CSV 文件。';
  }

  function exportJson() {
    var msg = $('mExportMsg');
    var b = new Blob([JSON.stringify(store.snapshot(), null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = 'fxp-member-backup.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 0);
    if (msg) msg.textContent = '已导出 JSON 备份。';
  }

  function handleFiles(ev) {
    var files = ev.target.files || [];
    if (!files.length) return;
    var done = 0, okN = 0, bad = [];
    Array.prototype.forEach.call(files, function (f) {
      var fr = new FileReader();
      fr.onload = function () {
        var table = String(f.name).replace(/\.csv$/i, '').replace(/^\d+_/, '');
        var res = store.importText(table, String(fr.result), { mode: 'merge' });
        if (res.ok) { okN++; } else { bad.push(table + '（' + res.reason + '）'); }
        done++;
        if (done === files.length) finish();
      };
      fr.onerror = function () { done++; bad.push(f.name + '（读取失败）'); if (done === files.length) finish(); };
      fr.readAsText(f, 'utf-8');
    });

    /* 注意：这里刻意不调用 render()。
       render() 会重建 #mApp 的 innerHTML，把下面刚写入的提示连同 DOM 一起冲掉，
       结果是「用户点了导入，页面毫无反应」——文件其实已经导入成功了。
       改为就地刷新受影响的三个节点：表状态、动作库计数、导入提示。 */
    function finish() {
      store.save();
      updateStats();
      refreshExLine();
      var el = $('mImportMsg');
      if (!el) return;
      if (bad.length) {
        el.className = 'm-hint ' + (okN ? 'm-warn' : 'm-err');
        el.textContent = (okN ? '导入完成 ' + okN + ' 个文件；' : '')
          + '失败 ' + bad.length + ' 个：' + bad.join('、')
          + '（失败的文件一条都未写入）';
      } else {
        el.className = 'm-hint m-ok';
        el.textContent = '导入完成：' + okN + ' 个文件。';
      }
    }
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    store = MST.createStore({ storage: localStorage });
    gate = IDN.createVerifyGate({
      store: store, maxFail: 5, lockMs: 60000,
      /* 用取值函数：每次核验都重新读教练端只读投影，避免读到过期的在册名单。
         这条链路只读不写，绝不触碰 fxp-workspace。 */
      coachMembers: function () { return IDN.readCoachMembers(localStorage).members; }
    });
    loadCtx();
    var loaded = store.load();
    if (loaded && loaded.ok) {
      var lm = $('mLoadMsg');
    }
    /* 首次使用：自动载入内置动作库，保证功能开箱即用（决策 Q4=A） */
    if (store.count('m_exercises') === 0) { IDN.loadSeed(store); store.save(); }

    render();

    W.addEventListener('hashchange', function () { render(); });

    /* 顶部/底栏的通用导航 */
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-nav]') : null;
      if (t) { go('#' + t.getAttribute('data-nav')); return; }
      if (ev.target.id === 'btnLogout') {
        clearCtx(); go('#verify');
      }
    });

    /* 供 E2E 与调试使用 */
    W.FXPM = {
      store: store,
      ctx: ctx,
      identity: IDN,
      TABLES: MST.TABLES,
      render: render,
      go: go,
      seed: SEED,
      goal: GOAL,
      plan: PLAN,
      session: SES,
      xp: XP
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();

