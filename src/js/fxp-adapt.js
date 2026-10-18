/* Fitness XP V1 — CSV 导入兼容适配层（UMD）
 * 背景：外部协作表格导出的 CSV 表头/枚举与系统数据契约（DATA_DICTIONARY）不一致时，
 *       标准 detectTable 会整体拒绝。本层把这些文件按"确定性别名映射 + 显式占位默认值 +
 *       全量留痕警告"转换为规范记录，交给既有校验管线（validateTable）复查后入库。
 * 原则：
 *   1. 不静默改值：每次映射/默认值填充都产生说明（notes）或行级警告（warnings）；
 *   2. 不猜测：无法确定性映射的值走保守分支（如仅必要联系 → 不按拒绝联系处理，仅备注留痕）；
 *   3. 不放宽规则：适配后的记录仍要过 validateTable 全部校验，规则引擎不感知适配层的存在。
 * 调用位置：标准表头识别失败后才启用；规范文件行为完全不变。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.adapt = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TABLES = ['coaches', 'members', 'sessions', 'followups', 'tasks'];

  /* ---------- 源表头 → 规范列名（确定性别名） ---------- */
  var ALIASES = {
    coaches: { coach_name: 'name', employment_status: 'active' },
    members: {
      member_name: 'name', member_status: 'status', contact_preference: 'contact_opt_out',
      /* V1.1 会员档案补充列别名 */
      planned_frequency: 'planned_per_week', plan_weekly: 'planned_per_week', weekly_plan: 'planned_per_week',
      appointment_date: 'next_appointment_date', next_appointment: 'next_appointment_date',
      remaining_sessions: 'pt_sessions_left', pt_left: 'pt_sessions_left', remaining_classes: 'pt_sessions_left',
      package_expiry: 'package_end_date', package_expire_date: 'package_end_date', class_expiry: 'package_end_date',
      pause_from: 'pause_start_date', pause_to: 'pause_end_date',
      data_missing: 'data_incomplete', records_incomplete: 'data_incomplete'
    },
    sessions: {
      session_date: 'date', training_content: 'content', notes: 'next_plan',
      /* V1.1 快捷训练记录别名 */
      training_type: 'session_type', session_category: 'session_type',
      completion_status: 'completion', member_feeling: 'feeling', post_feeling: 'feeling',
      next_training_focus: 'next_focus', focus_next: 'next_focus',
      exercise_records: 'exercises', actions: 'exercises'
    },
    followups: {
      followup_date: 'date', followup_reason: 'content', contact_result: 'result',
      /* V1.1 跟进结果细分别名 */
      result_detail: 'outcome', followup_outcome: 'outcome', contact_outcome: 'outcome'
    },
    tasks: { assigned_coach_id: 'coach_id', task_type: 'title', task_status: 'status', completion_result: 'notes' }
  };

  /* ---------- 列缺失时的显式占位默认值（每条都会生成警告说明） ---------- */
  var PHONE_PLACEHOLDER = '__auto__'; // 会员手机号占位：按会员编号生成唯一占位号，避免触发"手机号重复"误报
  var DEFAULTS = {
    coaches: { role: 'coach', phone: '' },
    members: { phone: PHONE_PLACEHOLDER, membership_end: '2099-12-31', goal: '', notes: '' },
    sessions: { duration_min: '', rating: '' },
    followups: { channel: 'wechat' },
    tasks: { source: 'manual', rule_code: '' }
  };

  /* 占位默认的警告说明（文件级，每次导入出现一次） */
  var DEFAULT_NOTES = {
    coaches: { role: '源无 role 列 → 默认按 coach 导入', phone: '' },
    members: {
      phone: '源无 phone 列 → 按会员编号填充占位号 0000000xxxx（唯一，非真实号码），请试点前补录真实手机号',
      membership_end: '源无 membership_end 列 → 全部填充占位日 2099-12-31（不触发 R4 到期提醒），请补录真实到期日'
    },
    followups: { channel: '源无 channel 列 → 全部默认按 wechat（微信）导入' },
    tasks: { source: '源无 source 列 → 历史任务全部按 manual（手工）导入' }
  };

  /* ---------- 枚举值映射（确定性） ---------- */
  var VALUE_MAPS = {
    coaches: {
      active: { '在职': 'Y', '离职': 'N' },
      /* 角色：外部中文/历史枚举 → 规范枚举（与 fxp-engine addCoach 及页面 UI 一致） */
      role: { '店长': 'manager', '管理员': 'manager', '教练': 'coach', 'admin': 'manager' }
    },
    members: {
      status: { '正常': 'active', '暂停': 'sleeping', '休假': 'sleeping', '已退出': 'expired', '已结束': 'expired' },
      /* V1.1 数据不完整标记（中文/是-否 → Y/N） */
      data_incomplete: { '是': 'Y', '否': 'N', 'Y': 'Y', 'N': 'N' }
    },
    sessions: {
      /* V1.1 训练类型 / 完成情况 / 会员感受（外部中文 → 规范枚举） */
      session_type: { '力量训练': 'strength', '力量': 'strength', '减脂训练': 'fat_loss', '减脂': 'fat_loss', '体能训练': 'conditioning', '体能': 'conditioning', '康复或活动能力训练': 'rehab', '康复训练': 'rehab', '康复': 'rehab', '其他': 'other' },
      completion: { '正常完成': 'full', '完成': 'full', '部分完成': 'partial', '部分': 'partial', '未完成': 'none', '未做': 'none' },
      feeling: { '状态良好': 'good', '良好': 'good', '状态一般': 'normal', '一般': 'normal', '疲劳明显': 'fatigue', '疲劳': 'fatigue', '有疼痛或不适': 'pain', '疼痛': 'pain', '不适': 'pain', '其他': 'other' }
    },
    followups: {
      /* V1.1 结果细分（外部中文 → 规范枚举） */
      outcome: {
        '已联系，会员确认恢复训练计划': 'resumed', '已联系会员确认恢复训练计划': 'resumed', '确认恢复': 'resumed',
        '已联系，需要进一步沟通': 'need_more', '需要进一步沟通': 'need_more',
        '已联系，会员暂时无法训练': 'temporarily_unable', '会员暂时无法训练': 'temporarily_unable',
        '未联系成功': 'unreachable', '联系未成功': 'unreachable',
        '会员明确表示暂停或终止训练': 'paused_or_quit', '暂停或终止训练': 'paused_or_quit',
        '其他': 'other'
      }
    },
    tasks: {
      status: { '待处理': 'open', '逾期': 'open', '已完成': 'done', '已取消': 'cancelled' },
      /* 今日优先处理模块：优先级（外部中文 → 规范枚举） */
      priority: { '高': 'high', '高优先级': 'high', '紧急': 'high', '中': 'normal', '普通': 'normal', '正常': 'normal', '低': 'low', '低优先级': 'low' },
      risk_level: { '高风险': 'high', '中风险': 'medium', '观察': 'watch', '正常': 'normal' }
    }
  };

  /* ---------- V1.1 结果细分 → 规范 result（规则权威）派生表 ---------- */
  var OUTCOME_TO_RESULT = {
    resumed: 'promised',          /* 会员确认恢复训练计划 → 仍只是"承诺"，不等于已恢复（见 BUSINESS_RULES） */
    need_more: 'reached',
    temporarily_unable: 'reached',
    unreachable: 'no_answer',
    paused_or_quit: 'refused',
    other: 'reached'
  };

  /* ---------- 跟进结果自由文本 → 枚举（关键词确定性映射；原文完整保留在 content） ---------- */
  function mapFollowupResult(text) {
    if (/拒绝/.test(text)) return 'refused';
    if (/暂未回复|未接通|无应答|等待.{0,8}(确认|回复|答复)/.test(text)) return 'no_answer';
    if (/已确认下次|确认下次训练|答应|承诺/.test(text)) return 'promised';
    return 'reached'; // 默认分支：已联系上；原始文本保留在 content，可人工核对
  }

  /* ---------- 会员联系偏好 → contact_opt_out ---------- */
  function mapContactPreference(raw) {
    if (raw === '不联系') return { optOut: 'Y', note: '源标记"不联系" → 按拒绝联系（contact_opt_out=Y）导入' };
    if (raw === '仅必要联系') return { optOut: 'N', note: '源标记"仅必要联系" → 不按拒绝联系处理（N），已写入备注，请店长确认口径' };
    if (raw === '微信文字' || raw === '电话' || raw === '') return { optOut: 'N', note: null };
    return { optOut: 'N', note: '联系偏好值"' + raw + '"系统无对应枚举 → 按 N 导入，已写入备注，请人工核对' };
  }

  /* ---------- 表识别：源表头经别名映射后可覆盖全部必填列（含占位默认），且含本表 ID 列 ---------- */
  function requiredFields(schema) {
    return schema.fields.filter(function (f) { return f.required; }).map(function (f) { return f.name; });
  }

  /**
   * 尝试适配。parsed = { header: [...], records: [{...}] }（toRecords 产物）
   * 返回 { ok, table, header, records, notes, warnings } 或 { ok:false, reason }
   */
  function tryAdapt(parsed, validate, opts) {
    opts = opts || {};
    if (!parsed || !parsed.header || !parsed.header.length) return { ok: false, reason: '空文件或无表头' };
    var candidates = [];
    for (var i = 0; i < TABLES.length; i++) {
      var table = TABLES[i];
      var schema = validate.SCHEMAS[table];
      if (!schema) continue;
      var idField = schema.idField;
      if (parsed.header.indexOf(idField) < 0) continue; // 必须含本表 ID 列
      var mapped = {}, used = [];
      parsed.header.forEach(function (h) {
        var canon = ALIASES[table][h] || h;
        if (schema.fields.some(function (f) { return f.name === canon; })) {
          if (!mapped[canon]) { mapped[canon] = h; used.push(canon); }
        }
      });
      var defaults = {};
      requiredFields(schema).forEach(function (rf) {
        if (!mapped[rf] && DEFAULTS[table][rf] !== undefined) defaults[rf] = DEFAULTS[table][rf];
      });
      var missing = requiredFields(schema).filter(function (rf) { return !mapped[rf] && DEFAULTS[table][rf] === undefined; });
      if (missing.length === 0) candidates.push({ table: table, schema: schema, mapped: mapped, defaults: defaults });
    }
    if (candidates.length === 0) return { ok: false, reason: '表头经别名映射后仍缺少必填列：' + parsed.header.join(',') };
    if (candidates.length > 1) return { ok: false, reason: '表头可适配多张表（' + candidates.map(function (c) { return c.table; }).join('/') + '），无法确定，请使用规范表头' };
    return adaptTable(candidates[0], parsed, opts);
  }

  /* ---------- 单表适配执行 ---------- */
  function adaptTable(cand, parsed, opts) {
    var table = cand.table, schema = cand.schema, mapped = cand.mapped, defaults = cand.defaults;
    var today = opts.today || '';
    var notes = [], warnings = [];
    var records = [];
    var valMapSeen = {}; // 值映射说明去重（每次导入只说明一次）

    // 文件级说明：别名映射清单
    var aliasNote = Object.keys(mapped).filter(function (k) { return mapped[k] !== k; })
      .map(function (k) { return mapped[k] + '→' + k; }).join('，');
    if (aliasNote) notes.push('已启用兼容映射：' + aliasNote);

    // 文件级说明：占位默认
    Object.keys(defaults).forEach(function (k) {
      var dn = (DEFAULT_NOTES[table] || {})[k];
      if (dn) notes.push(dn);
    });

    // 文件级说明：忽略的源列
    var ignored = parsed.header.filter(function (h) {
      var canon = ALIASES[table][h] || h;
      return !schema.fields.some(function (f) { return f.name === canon; });
    });
    if (table === 'members' && ignored.indexOf('last_visit_date') >= 0)
      notes.push('忽略源列 last_visit_date：系统按训练记录推导最后到店日期，该列不导入（原文数据保留在源文件）');
    if (table === 'tasks' && mapped.priority)
      notes.push('源列 priority 已按今日优先处理模块映射为规范优先级（高/中/低 → high/normal/low）');
    if (ignored.length) notes.push('未识别列（已忽略）：' + ignored.join(','));

    parsed.records.forEach(function (src) {
      var rec = { _row: src._row };
      // 1) 直接映射 / 别名映射
      schema.fields.forEach(function (f) {
        var srcCol = mapped[f.name];
        var v = srcCol ? (src[srcCol] !== undefined ? String(src[srcCol]).trim() : '') : '';
        rec[f.name] = v;
      });
      // 2) 值映射（枚举，去重留痕）
      var vm = VALUE_MAPS[table];
      if (vm) Object.keys(vm).forEach(function (field) {
        if (rec[field] && vm[field][rec[field]] !== undefined) {
          var to = vm[field][rec[field]];
          if (table === 'tasks' && field === 'status' && rec[field] === '逾期') {
            warnings.push({ table: table, row: rec._row, field: field, message: '源状态"逾期"映射为 open：逾期由系统按 due_date 推导，不落库存储' });
          } else if (to !== rec[field]) {
            valMapSeen[field + ' "' + rec[field] + '"→"' + to + '"'] = true;
          }
          rec[field] = to;
        }
      });
      // 3) 占位默认
      Object.keys(defaults).forEach(function (k) {
        if (rec[k] === '' || rec[k] === undefined) rec[k] = defaults[k];
      });
      // 3b) 会员手机号占位：按会员编号生成唯一占位号，避免整批同号触发"重复会员"误报
      if (table === 'members' && rec.phone === PHONE_PLACEHOLDER) {
        var digits = String(rec.member_id || '').replace(/\D/g, '');
        rec.phone = '0000000' + (digits ? digits.padStart(4, '0') : String(rec._row).padStart(4, '0'));
      }
      // 4) 表级特殊处理
      if (table === 'members' && mapped.contact_opt_out) {
        var rawPref = String(src[mapped.contact_opt_out] || '').trim();
        var pr = mapContactPreference(rawPref);
        rec.contact_opt_out = pr.optOut;
        if (pr.optOut === 'Y') {
          rec.opt_out_date = today; // 源无登记日，按导入日登记（警告留痕）
          rec.opt_out_reason = '导入适配：源数据标记"不联系"';
          warnings.push({ table: table, row: rec._row, field: 'contact_opt_out', message: '会员标记"不联系"：拒绝登记日按导入日 ' + today + ' 填充（源无该日期），请人工核对' });
        } else if (pr.note) {
          rec.notes = (rec.notes ? rec.notes + '；' : '') + '联系偏好：' + rawPref;
          warnings.push({ table: table, row: rec._row, field: 'contact_opt_out', message: pr.note });
        }
      }
      if (table === 'members' && rec.contact_opt_out === '') rec.contact_opt_out = 'N';
      if (table === 'coaches' && rec.active === '') rec.active = 'Y';
      if (table === 'followups') {
        var rawResult = mapped.result ? String(src[mapped.result] || '').trim() : '';
        if (rawResult) {
          rec.result = mapFollowupResult(rawResult);
          var origin = rec.content || '';
          rec.content = origin ? origin + '：' + rawResult : rawResult; // 原文完整保留
          if (rec.result !== 'reached')
            warnings.push({ table: table, row: rec._row, field: 'result', message: '跟进结果"' + rawResult.slice(0, 30) + '"映射为 ' + rec.result + '（关键词确定性映射，原文已保留在 content）' });
        }
        /* V1.1：若源提供细分结果（outcome），据其派生规范 result（规则权威），反之不覆盖 */
        if (rec.outcome) {
          var derived = OUTCOME_TO_RESULT[rec.outcome];
          if (derived && derived !== rec.result) {
            warnings.push({ table: table, row: rec._row, field: 'result', message: '据结果细分"' + rec.outcome + '"派生规范 result=' + derived + '（原文保留在 outcome 列，仅作人工分类，不代表会员已恢复训练）' });
            rec.result = derived;
          }
        }
      }
      /* V1.1：训练记录出现"疼痛/不适"时在导入报告给出人工关注提示（不做医疗判断） */
      if (table === 'sessions' && rec.feeling === 'pain') {
        warnings.push({ table: table, row: rec._row, field: 'feeling', message: '会员感受为"有疼痛或不适"：请教练人工关注并评估，系统不做医疗诊断' });
      }
      if (table === 'tasks') {
        if (rec.status === 'done' && !rec.done_date && rec.due_date) {
          rec.done_date = rec.due_date;
          warnings.push({ table: table, row: rec._row, field: 'done_date', message: '已完成任务源无完成日期 → 按截止日 ' + rec.due_date + ' 填充（推测值），请人工核对' });
        }
        if (rec.status === 'cancelled') {
          if (!rec.cancelled_date && rec.due_date) rec.cancelled_date = rec.due_date;
          if (!rec.cancel_reason) {
            rec.cancel_reason = 'other';
            rec.notes = (rec.notes ? rec.notes + '；' : '') + '导入适配：源无取消原因';
          }
          warnings.push({ table: table, row: rec._row, field: 'cancel_reason', message: '已取消任务的取消日/原因由导入适配填充，请人工核对' });
        }
        if (rec.source === '') rec.source = 'manual';
      }
      records.push(rec);
    });

    Object.keys(valMapSeen).forEach(function (k) { notes.push('值映射（确定性）：' + k); });

    return {
      ok: true, table: table,
      header: schema.fields.map(function (f) { return f.name; }),
      records: records, notes: notes, warnings: warnings
    };
  }

  return { TABLES: TABLES, ALIASES: ALIASES, VALUE_MAPS: VALUE_MAPS, OUTCOME_TO_RESULT: OUTCOME_TO_RESULT, tryAdapt: tryAdapt, mapFollowupResult: mapFollowupResult, mapContactPreference: mapContactPreference };
});
