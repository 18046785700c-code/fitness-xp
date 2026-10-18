/* Fitness XP V1 — 本地仪表盘应用逻辑
 * 依赖：../src/js/ 下四个 UMD 模块（CSV 解析 / 校验 / 规则引擎 / XP 流水）
 * 运行：file:// 直接打开 index.html，无网络请求、无预置数据、无持久化。
 * 设计文档：docs/UI-DESIGN.md */
'use strict';
(function () {
  var E = FXP.engine;      // 规则引擎
  var V = FXP.validate;    // 字段校验
  var CSVU = FXP;          // CSV 工具（fxp-csv 挂在 FXP 根上）
  var XPM = FXP.xp;        // XP 流水模块
  var ADAPT = FXP.adapt;   // 导入兼容适配层（表头不匹配时启用）
  var PERSIST = FXP.persist; // 本地持久化（localStorage，0.12.0 手机端必需）
  var RISK = FXP.risk;       // 风险评分引擎（今日优先处理模块，0.15.0）
  var TASKM = FXP.task;      // 任务状态机 / 教练分配（今日优先处理模块，0.15.0）
  var STORE = null;        // createPersistence 实例（init 时创建，file:// 下 localStorage 可用）

  var TABLES = ['coaches', 'members', 'sessions', 'followups', 'tasks'];
  var CANCEL_LABEL = { duplicate: '重复任务', member_returned: '会员已到店', escalated: '规则升级', opt_out: '拒绝联系', other: '其他' };
  var RESULT_LABEL = { reached: '已联系上', no_answer: '未接通', promised: '答应到店', refused: '拒绝联系' };
  var CHANNEL_LABEL = { wechat: '微信', phone: '电话', in_person: '到店面谈' };
  var STATUS_LABEL = { active: '正常', sleeping: '沉睡', expired: '已到期' };
  var RISK_LABEL = {
    none: '正常', L1: '7天未到店', L2: '14天未到店',
    excluded_opt_out: '拒绝联系', excluded_expired: '已到期',
    excluded_no_session: '无训练记录', excluded_sleeping: '暂停/沉睡'
  };
  /* 今日优先处理模块（0.15.0）：风险等级 / 优先级 / 下一步动作 文案 */
  var RISK_LEVEL_LABEL = { normal: '正常', watch: '观察', medium: '中风险', high: '高风险', excluded: '已排除' };
  var PRIORITY_LABEL = { high: '高', normal: '中', low: '低' };
  var NEXT_ACTION_LABEL = { none: '无需跟进', follow_up: '继续跟进', schedule: '安排到店' };

  /* ================= V1.1 快捷记录文案与预设（全部本地，无外部服务） ================= */
  var SESSION_TYPE_LABEL = { strength: '力量训练', fat_loss: '减脂训练', conditioning: '体能训练', rehab: '康复/活动能力', other: '其他' };
  var COMPLETION_LABEL = { full: '正常完成', partial: '部分完成', none: '未完成' };
  var FEELING_LABEL = { good: '状态良好', normal: '状态一般', fatigue: '疲劳明显', pain: '有疼痛或不适', other: '其他' };
  var OUTCOME_LABEL = {
    resumed: '已联系·确认恢复训练计划', need_more: '已联系·需进一步沟通',
    temporarily_unable: '已联系·暂时无法训练', unreachable: '未联系成功',
    paused_or_quit: '明确暂停或终止', other: '其他'
  };
  /* 结果细分 → 规范 result（规则权威）。选择任一结果都**不等于**会员已恢复训练。 */
  var OUTCOME_TO_RESULT = { resumed: 'promised', need_more: 'reached', temporarily_unable: 'reached', unreachable: 'no_answer', paused_or_quit: 'refused', other: 'reached' };
  var CHANNEL_OPTS = [['wechat', '微信'], ['phone', '电话'], ['in_person', '当面沟通'], ['other', '其他']];
  var FOCUS_TAGS = ['加强核心', '加强下肢', '上肢力量', '核心稳定', '有氧耐力', '动作纠正', '柔韧放松', '恢复性训练'];
  /* 训练模板：仅填入表单供教练确认修改，绝不当作本次实际训练结果 */
  var SESSION_TEMPLATES = [
    { code: 'strength_upper', name: '力量·上肢', type: 'strength', focus: '上肢力量', ex: [['卧推', '40', '3', '12', ''], ['坐姿划船', '35', '3', '12', ''], ['哑铃肩推', '15', '3', '10', '']] },
    { code: 'strength_lower', name: '力量·下肢', type: 'strength', focus: '加强下肢', ex: [['深蹲', '60', '4', '10', ''], ['硬拉', '60', '3', '8', ''], ['腿举', '80', '3', '12', '']] },
    { code: 'fat_loss_hiit', name: '减脂·循环', type: 'fat_loss', focus: '有氧耐力', ex: [['战绳', '', '4', '30秒', ''], ['划船机', '', '4', '60秒', ''], ['开合跳', '', '4', '40秒', '']] },
    { code: 'rehab_core', name: '康复·核心', type: 'rehab', focus: '恢复性训练', ex: [['死虫式', '', '3', '12', ''], ['鸟狗式', '', '3', '10', ''], ['臀桥', '', '3', '15', '']] }
  ];
  var EX_FIELDS = ['name', 'weight', 'sets', 'reps', 'note'];

  /* ================= 状态 ================= */
  var state = {
    model: null,          // 引擎数据模型（导入后存在）
    rep: null,            // 最近一次规则执行报告
    xp: null,             // XP 流水账（启用后存在）
    queue: { coaches: [], members: [], sessions: [], followups: [], tasks: [] },  // 待导出变更（含手工录入的新教练/新会员）
    exportedAt: null,
    filters: {
      members: { q: '', status: '', risk: '', coach: '' },
      tasks: { coach: '', status: '' }
    },
    /* 今日优先处理模块状态 */
    priority: { filter: 'all', coachId: '', reviewEnabled: false },
    priorityRep: null,    // 最近一次风险任务生成报告
    /* V1.1 快捷记录临时上下文（从任务进入时携带的任务号；不持久化） */
    quick: { sessionTaskId: '', followupTaskId: '' },
    /* V1.1 导入预览上下文（解析完成但尚未确认写入；不持久化） */
    pending: null,
    busy: false
  };

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function weekStart(s) {
    var t = new Date(s + 'T00:00:00Z').getTime();
    var dow = new Date(t).getUTCDay();
    return new Date(t - ((dow + 6) % 7) * 86400000).toISOString().slice(0, 10);
  }
  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(sel) { return document.querySelector(sel); }
  function fmt(v) { return (v === '' || v === undefined || v === null) ? '<span class="muted">—</span>' : esc(v); }
  function queueCount() { return state.queue.coaches.length + state.queue.members.length + state.queue.sessions.length + state.queue.followups.length + state.queue.tasks.length; }
  /** 是否有任何业务数据（五表任一非空，或待导出队列非空）。空白工作区 = false */
  function hasData() {
    if (!state.model) return false;
    var m = state.model;
    return !!(m.coaches.length || m.members.length || m.sessions.length || m.followups.length || m.tasks.length || queueCount());
  }

  /* ================= 本地持久化（0.12.0；原则：恢复与导入同管线，保存只是缓存） ================= */

  function buildSnapshot() {
    var m = state.model;
    return {
      v: PERSIST.VERSION,
      savedAt: todayStr(),
      tables: {
        coaches: m.coaches.slice(), members: m.members.slice(), sessions: m.sessions.slice(),
        followups: m.followups.slice(), tasks: m.tasks.slice()
      },
      queue: {
        coaches: state.queue.coaches.slice(), members: state.queue.members.slice(),
        sessions: state.queue.sessions.slice(), followups: state.queue.followups.slice(), tasks: state.queue.tasks.slice()
      },
      xp: (function () {
        /* report().events 是数字（条数），完整流水需按会员从 listByMember 汇集；
           此处曾误对数字调 .slice() 导致启用 XP 后持久化抛异常（0.14.0 修复） */
        if (!state.xp) return { enabled: false, events: [] };
        var evs = [];
        Object.keys(state.xp.report().totals).forEach(function (id) {
          evs = evs.concat(state.xp.listByMember(id));
        });
        return { enabled: state.xp.isEnabled(), events: evs };
      })(),
      exportedAt: state.exportedAt
    };
  }

  /** 每次状态变更后调用；失败不阻断业务（toast 提醒导出）。空白工作区清存储，保持存储与界面严格一致 */
  function persist() {
    if (!STORE || !state.model) return;
    if (!hasData()) { STORE.clear(); return; }
    var res = STORE.save(buildSnapshot());
    if (!res.ok && res.reason === 'storage_error') toast('⚠ ' + res.message, 'err');
  }

  /** 启动时从 localStorage 恢复；返回 true 表示恢复了数据（含空快照） */
  function restoreFromStorage() {
    if (!STORE) return false;
    var res = STORE.load();
    if (!res.ok) return false;                       // 无快照/损坏/版本不符 → 空白工作区
    var s = res.snapshot;
    var model = E.loadModel(s.tables, { today: todayStr() }); // 恢复与导入同管线（拒收优于猜测）
    state.model = model;
    state.queue = {
      coaches: s.queue.coaches.slice(), members: s.queue.members.slice(),
      sessions: s.queue.sessions.slice(), followups: s.queue.followups.slice(), tasks: s.queue.tasks.slice()
    };
    state.exportedAt = s.exportedAt;
    if (s.xp && s.xp.enabled) {
      state.xp = XPM.createXpLedger({
        enabled: true,
        memberExists: function (id) { return !!(state.model && state.model.byId.members[id]); },
        today: todayStr()
      });
      state.xp.loadEvents(s.xp.events);              // 重建流水（自然键/累计分随装载恢复）
    } else {
      state.xp = null;
    }
    if (model.report.errors.length)
      toast('本地恢复：' + model.report.errors.length + ' 行数据未通过当前校验被拒收，请检查数据', 'err');
    runRulesSilent();                                // 按今天重算逾期/风险/任务
    return true;
  }

  /** 清空工作区：回到空白状态（数据经确认后不可恢复，导出 CSV 是唯一备份） */
  function resetDialog() {
    var n = hasData() ? ('当前有 ' + state.model.members.length + ' 名会员 / ' + state.model.coaches.length +
      ' 名教练 / ' + (state.model.sessions.length + state.model.followups.length + state.model.tasks.length) +
      ' 条记录，待导出 ' + queueCount() + ' 条变更。') : '当前为空白工作区。';
    showModal('清空工作区',
      '<div class="err-line">⚠ 此操作将删除本机浏览器中保存的全部数据，且不可恢复！</div>' +
      '<div style="margin-top:8px">' + n + '</div>' +
      '<div class="hint" style="margin-top:8px">如需保留数据，请先点顶部「导出 CSV」回写协作表格后再清空。</div>' +
      '<div style="text-align:right;margin-top:12px">' +
      '<button type="button" class="mini" onclick="FXPApp.closeModal()">取消</button> ' +
      '<button type="button" class="danger" onclick="FXPApp.doReset()">确认清空</button></div>');
  }
  function doReset() {
    if (STORE) STORE.clear();
    state.model = E.loadModel({}, { today: todayStr() });
    state.rep = null;
    state.xp = null;
    state.queue = { coaches: [], members: [], sessions: [], followups: [], tasks: [] };
    state.exportedAt = null;
    try { sessionStorage.setItem('fxp-pilot-cleared', '1'); } catch (e) {}  // 防止试点数据在清空后自动回灌
    persist();
    updateStatus();
    render();
    closeModal();
    toast('工作区已清空，回到空白状态（本窗口不再自动载入测试数据）', 'ok');
  }

  /* ================= 提示与弹窗 ================= */
  function toast(msg, type) {
    var div = document.createElement('div');
    div.className = 'toast ' + (type || '');
    div.textContent = msg;
    $('#toastWrap').appendChild(div);
    setTimeout(function () { div.remove(); }, 4200);
  }
  function showModal(title, bodyHTML) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHTML;
    $('#modalWrap').hidden = false;
  }
  function closeModal() { $('#modalWrap').hidden = true; }

  /* ================= 状态栏 ================= */
  function updateStatus() {
    var el = $('#dataStatus');
    if (!state.model) { el.textContent = '初始化中'; el.className = 'status'; return; }
    if (!hasData()) {
      el.textContent = '未导入数据 · 空白工作区（可直接手工录入，无需 CSV）';
      el.className = 'status';
      return;
    }
    var m = state.model, T = state.rep ? state.rep.today : todayStr();
    var parts = [
      '已导入：会员 ' + m.members.length + ' / 教练 ' + m.coaches.length +
      ' / 训练 ' + m.sessions.length + ' / 跟进 ' + m.followups.length + ' / 任务 ' + m.tasks.length,
      '基准日 ' + T,
      '校验错误 ' + m.report.errors.length + ' / 警告 ' + m.report.warnings.length
    ];
    if (queueCount() > 0) parts.push('待导出变更 ' + queueCount() + ' 条' + (state.exportedAt ? '（曾于 ' + state.exportedAt + ' 导出）' : ''));
    el.textContent = parts.join(' · ');
    el.className = 'status ' + (m.report.errors.length ? 'warn' : 'ok');
    persist();                                       // 所有状态变更的汇聚点（0.12.0 本地保存）
  }

  /* ================= 队列（待导出变更，按 ID 去重） ================= */
  function queueAdd(table, rec) {
    var idField = V.SCHEMAS[table].idField;
    var list = state.queue[table];
    for (var i = 0; i < list.length; i++) {
      if (list[i][idField] === rec[idField]) { list[i] = rec; return; }
    }
    list.push(rec);
  }

  /* ================= 规则执行 ================= */
  /** 规则核心：既有规则引擎 + 今日优先风险任务生成（防重合并），两者都入导出队列 */
  function runRulesCore() {
    state.rep = E.runRules(state.model, {});
    state.rep.created.forEach(function (t) { queueAdd('tasks', t); });
    state.rep.cancelled.forEach(function (c) {
      var t = state.model.byId.tasks[c.task_id];
      if (t) queueAdd('tasks', t);
    });
    /* 今日优先处理模块：风险评分 → 回访任务生成（未完成同会员回访任务 → 合并风险原因） */
    var rmap = RISK.computeRiskMap(state.model, { today: state.rep.today });
    var gtr = TASKM.generateRiskTasks(state.model, rmap, { today: state.rep.today });
    gtr.created.forEach(function (t) { queueAdd('tasks', t); });
    gtr.merged.forEach(function (mg) {
      var t = state.model.byId.tasks[mg.task_id];
      if (t) queueAdd('tasks', t);
    });
    state.priorityRep = gtr;
    return gtr;
  }
  function runRules(showNotice) {
    if (!state.model) return; /* 模型在启动时即创建，此守卫仅防御异常情况 */
    var gtr = runRulesCore();
    updateStatus();
    render();
    if (showNotice) {
      toast('规则执行完成：新建 ' + state.rep.totals.created + '，自动取消 ' + state.rep.totals.cancelled +
        '，防重跳过 ' + state.rep.totals.skipped + '；今日风险任务 新建 ' + gtr.totals.created + ' / 合并 ' + gtr.totals.merged, 'ok');
    }
  }

  /* ================= 导入 ================= */
  function detectTable(header) {
    var match = null;
    for (var i = 0; i < TABLES.length; i++) {
      if (V.validateHeader(TABLES[i], header).ok) {
        if (match) return { table: null, message: '表头同时匹配多张表，无法识别' };
        match = TABLES[i];
      }
    }
    return match ? { table: match } : { table: null, message: '表头无法匹配任何核心表（缺少必填列）' };
  }

  function handleFiles(fileList) {
    if (state.busy) return;
    state.busy = true; $('#btnImport').disabled = true;
    var files = Array.prototype.slice.call(fileList);
    var raw = {}, fileErrors = [], adaptInfo = [], done = 0;

    function finish() {
      $('#btnImport').disabled = false; state.busy = false; $('#fileInput').value = '';
      if (!Object.keys(raw).length) {
        showModal('导入失败 — 全部文件无法识别',
          '<div class="err-line">' + fileErrors.map(function (e) { return esc(e); }).join('<br>') + '</div>' +
          '<div class="hint" style="margin-top:8px">未写入任何数据，当前工作区保持原样。请修正表头/编码后重试，或点顶部「CSV 模板」下载标准表头。</div>');
        return;
      }
      /* V1.1：先算预演结果，交用户预览+确认后再写入（不再直接覆盖） */
      state.pending = { raw: raw, fileErrors: fileErrors, adaptInfo: adaptInfo, mode: hasData() ? 'merge' : 'replace' };
      showImportPreview();
    }

    if (!files.length) { state.busy = false; $('#btnImport').disabled = false; return; }
    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var buf = reader.result;
          var text = CSVU.decodeBuffer(buf);
          var parsed = CSVU.toRecords(CSVU.parseCSV(text));
          if (!parsed.header.length) { fileErrors.push('[' + file.name + '] 空文件或无表头'); }
          else {
          var det = detectTable(parsed.header);
          if (!det.table) {
            /* 标准表头失败 → 尝试兼容适配（确定性映射，全量留痕） */
            var ad = ADAPT.tryAdapt(parsed, V, { today: todayStr() });
            if (ad.ok) {
              raw[ad.table] = (raw[ad.table] || []).concat(ad.records);
              adaptInfo.push({ table: ad.table, notes: ad.notes, warnings: ad.warnings, rows: ad.records.length });
              if (ad.records.length === 0) fileErrors.push('[' + file.name + '] 适配为 ' + ad.table + ' 表，但无数据行');
            } else {
              fileErrors.push('[' + file.name + '] ' + det.message + '；兼容适配也不可用：' + ad.reason + '（表头：' + parsed.header.join(',') + '）');
            }
          } else {
            raw[det.table] = (raw[det.table] || []).concat(parsed.records);
            if (parsed.records.length === 0) fileErrors.push('[' + file.name + '] 识别为 ' + det.table + ' 表，但无数据行');
          }
          }
        } catch (e) {
          fileErrors.push('[' + file.name + '] 解析异常：' + e.message);
        }
        if (++done === files.length) finish();
      };
      reader.onerror = function () {
        fileErrors.push('[' + file.name + '] 文件读取失败');
        if (++done === files.length) finish();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---- V1.1 导入预览与确认 ---- */
  function idFieldOf(t) { return (V.SCHEMAS[t] && V.SCHEMAS[t].idField) || 'id'; }
  /** 按 ID 合并：现有顺序在前，导入数据同 ID 覆盖、新 ID 追加（绝不产生重复记录） */
  function mergeRaw(base, incoming, idf) {
    var byId = {}, order = [];
    (base || []).forEach(function (r) { var id = r[idf]; if (!(id in byId)) order.push(id); byId[id] = r; });
    (incoming || []).forEach(function (r) { var id = r[idf]; if (!(id in byId)) order.push(id); byId[id] = r; });
    return order.map(function (id) { return byId[id]; });
  }
  /** 按指定模式生成"预演模型"（不落库、不改状态） */
  function computeImportModel(raw, mode) {
    var merged = {};
    TABLES.forEach(function (t) {
      var inc = raw[t] || [];
      if (mode === 'merge' && state.model) merged[t] = mergeRaw(state.model[t], inc, idFieldOf(t));
      else merged[t] = inc;
    });
    return E.loadModel(merged, { today: todayStr() });
  }
  /** 统计各表：导入行数 / 新增 / 覆盖同ID / 文件内重复ID / 拒收 / 警告 / 样例 */
  function previewStats(raw, model) {
    var per = {};
    TABLES.forEach(function (t) {
      var idf = idFieldOf(t);
      var inc = raw[t] || [];
      var existIds = {};
      (state.model ? state.model[t] : []).forEach(function (r) { existIds[r[idf]] = 1; });
      var seen = {}, dupInFile = [], overrides = [];
      inc.forEach(function (r) {
        var id = r[idf];
        if (seen[id]) dupInFile.push(id); else seen[id] = 1;
        if (existIds[id]) overrides.push(id);
      });
      per[t] = {
        incoming: inc.length,
        added: inc.length - overrides.length,
        overrides: overrides.length,
        dupInFile: dupInFile.length, dupIds: dupInFile.slice(0, 5),
        overIds: overrides.slice(0, 5),
        rejected: (model.report.errors || []).filter(function (e) { return e.table === t; }).length,
        warnings: (model.report.warnings || []).filter(function (w) { return w.table === t; }).length,
        sample: inc.slice(0, 3)
      };
    });
    return per;
  }
  function importMode() { return (state.pending && state.pending.mode) || 'merge'; }
  function setImportMode(m) {
    if (!state.pending) return;
    state.pending.mode = m;
    showImportPreview();
  }
  function showImportPreview() {
    var p = state.pending; if (!p) return;
    var m = computeImportModel(p.raw, p.mode);
    var per = previewStats(p.raw, m);
    var nonEmpty = hasData();
    var html = '<div class="hint">本次导入解析完成，尚未写入。请预览下面的结果并确认后再导入；拒收行不会进入系统。</div>';

    /* 写入方式（工作区非空时可选；空工作区无差别） */
    if (nonEmpty) {
      html += '<div class="panel"><h3>写入方式</h3>' +
        '<label class="inline-check"><input type="radio" name="impMode" value="merge"' + (p.mode === 'merge' ? ' checked' : '') +
        ' onchange="FXPApp.setImportMode(\'merge\')"> <b>合并（推荐）</b>：保留工作区现有数据，同一 ID 用新数据覆盖，其余追加；不会重复、不会丢失未涉及的记录</label><br>' +
        '<label class="inline-check"><input type="radio" name="impMode" value="replace"' + (p.mode === 'replace' ? ' checked' : '') +
        ' onchange="FXPApp.setImportMode(\'replace\')"> <b>替换全部</b>：清空工作区，仅保留本次导入的数据（未包含的表将变为空）</label>' +
        (p.mode === 'replace' ? '<div class="err-line" style="margin-top:6px">⚠ 替换将丢弃未包含在本次文件中的现有记录，请确认已先导出备份。</div>' : '') +
        '</div>';
    } else {
      html += '<div class="panel"><div class="hint">当前为空白工作区，将直接写入导入数据。</div></div>';
    }

    /* 各表预览 */
    html += '<div class="panel"><h3>导入预览</h3><div style="overflow-x:auto"><table class="mini-table"><thead><tr>' +
      '<th>表</th><th>导入行</th><th>新增</th><th>' + (p.mode === 'merge' ? '覆盖同ID' : '—') + '</th><th>文件内重复ID</th><th>拒收</th><th>警告</th>' +
      '</tr></thead><tbody>' +
      TABLES.filter(function (t) { return per[t].incoming > 0 || (m.report.errors || []).some(function (e) { return e.table === t; }); }).map(function (t) {
        var s = per[t];
        var dup = s.dupInFile ? '<span class="err-line">' + s.dupInFile + '（' + esc(s.dupIds.join(',')) + '）</span>' : '0';
        return '<tr><td>' + t + '</td><td>' + s.incoming + '</td><td>' + s.added + '</td>' +
          '<td>' + (p.mode === 'merge' ? (s.overrides ? '<span class="warn-line">' + s.overrides + '（' + esc(s.overIds.join(',')) + '）</span>' : '0') : '—') + '</td>' +
          '<td>' + dup + '</td><td>' + (s.rejected ? '<span class="err-line">' + s.rejected + '</span>' : '0') + '</td>' +
          '<td>' + (s.warnings ? '<span class="warn-line">' + s.warnings + '</span>' : '0') + '</td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="hint" style="margin-top:6px">导入后总计：' + m.members.length + ' 会员 / ' + m.coaches.length + ' 教练 / ' +
      (m.sessions.length + m.followups.length) + ' 记录 / ' + m.tasks.length + ' 任务。' +
      (p.mode === 'merge' && nonEmpty ? '（合并模式）' : '') + '</div></div>';

    /* 样例数据 */
    var sampleHtml = TABLES.filter(function (t) { return per[t].incoming > 0; }).map(function (t) {
      var idf = idFieldOf(t);
      return '<details><summary>[' + t + '] 前 ' + Math.min(3, per[t].incoming) + ' 行示例</summary><pre class="summary">' +
        esc(per[t].sample.map(function (r) { return JSON.stringify(r); }).join('\n')) + '</pre></details>';
    }).join('');
    if (sampleHtml) html += '<div class="panel">' + sampleHtml + '</div>';

    /* 文件级问题 / 拒收 / 警告 */
    if (p.fileErrors.length) html += '<div class="panel">' + reportHTML('文件级问题', p.fileErrors.map(function (s) { return { table: '', message: s }; }), 'err-line') + '</div>';
    if (p.adaptInfo && p.adaptInfo.length) {
      html += '<div class="panel">' + p.adaptInfo.map(function (a) {
        return '<h3>[' + a.table + '] 兼容适配（' + a.rows + ' 行）</h3><div class="warn-line">' + (a.notes || []).map(esc).join('<br>') + '</div>';
      }).join('') + '</div>';
    }
    if ((m.report.errors || []).length) html += '<div class="panel">' + reportHTML('拒收（错误，不会写入）', m.report.errors, 'err-line') + '</div>';
    if ((m.report.warnings || []).length) html += '<div class="panel">' + reportHTML('警告（数据已保留，建议核对）', m.report.warnings, 'warn-line') + '</div>';

    var blocked = !(m.members.length || m.coaches.length || m.sessions.length || m.followups.length || m.tasks.length);
    html += '<div style="text-align:right;margin-top:12px">' +
      '<button type="button" class="mini" onclick="FXPApp.cancelImport()">取消导入</button> ' +
      (blocked ? '<span class="err-line">没有可写入的有效数据</span>' :
        '<button type="button" class="primary" onclick="FXPApp.confirmImport()">确认导入（' +
        (per.members.incoming + per.coaches.incoming + per.sessions.incoming + per.followups.incoming + per.tasks.incoming) + ' 行）</button>') +
      '</div>';
    showModal('导入预览与确认', html);
  }
  function doConfirmImport() {
    var p = state.pending; if (!p) return;
    var model = computeImportModel(p.raw, p.mode);
    state.model = model;
    state.rep = null;
    state.xp = null;                                   // XP 需重新绑定会员校验
    state.queue = { coaches: [], members: [], sessions: [], followups: [], tasks: [] };
    state.exportedAt = null;
    var fileErrors = p.fileErrors, adaptInfo = p.adaptInfo;
    (adaptInfo || []).forEach(function (a) {
      (a.warnings || []).forEach(function (w) { model.report.warnings.push(w); });
    });
    state.pending = null;
    runRules(false);
    showImportReport(fileErrors, adaptInfo);
  }
  function doCancelImport() {
    state.pending = null;
    closeModal();
    toast('已取消导入，工作区未发生任何变化', 'ok');
  }

  function reportHTML(title, items, cls) {
    if (!items || !items.length) return '';
    return '<h3>' + title + '（' + items.length + '）</h3><div class="' + cls + '">' +
      items.map(function (e) {
        var where = e.table ? '[' + e.table + (e.row ? ' 第' + e.row + '行' : '') + (e.field ? ' ' + e.field : '') + '] ' : '';
        return esc(where + e.message);
      }).join('<br>') + '</div>';
  }

  function showImportReport(fileErrors, adaptInfo) {
    var m = state.model, rep = state.rep;
    var html = '';
    if (fileErrors.length) html += reportHTML('文件级问题', fileErrors.map(function (s) { return { table: '', message: s }; }), 'err-line');
    if (adaptInfo && adaptInfo.length) {
      var adaptHtml = adaptInfo.map(function (a) {
        return '<h3>[' + a.table + '] 兼容适配（' + a.rows + ' 行，按映射转换后入库）</h3><div class="warn-line">' +
          (a.notes || []).map(function (n) { return esc(n); }).join('<br>') + '</div>';
      }).join('');
      html += '<div class="panel">' + adaptHtml + '</div>';
    }
    html += '<div class="panel"><div class="hint">以下为本次导入结果（基准日 ' + rep.today + '）。拒收行未进入系统，请修正协作表格后重新导入。</div>' +
      reportHTML('拒收（错误）', m.report.errors, 'err-line') +
      reportHTML('警告（数据已保留，建议核对）', m.report.warnings, 'warn-line') +
      '<h3>规则执行摘要</h3><pre class="summary">' + esc(E.summaryText(rep)) + '</pre></div>';
    showModal('导入结果', html);
  }

  /* ================= 导出 ================= */
  function buildExport() {
    var files = [], problems = [];
    [['coaches', state.queue.coaches], ['members', state.queue.members], ['sessions', state.queue.sessions], ['followups', state.queue.followups], ['tasks', state.queue.tasks]].forEach(function (pair) {
      var t = pair[0], recs = pair[1];
      if (!recs.length) return;
      var withRows = recs.map(function (r, i) { var c = Object.assign({}, r); c._row = i + 2; return c; });
      var res = V.validateTable(t, withRows);
      if (res.errors.length) problems.push({ table: t, errors: res.errors });
      else files.push({ table: t, records: recs });
    });
    return { ok: problems.length === 0, files: files, problems: problems };
  }

  function doExport() {
    if (!state.model) return; /* 模型在启动时即创建 */
    if (!queueCount()) { showModal('导出 CSV', '<div class="muted">当前会话没有待导出的变更。</div>'); return; }
    var ex = buildExport();
    if (!ex.ok) {
      var html = '<div class="err-line">字段完整性检查未通过，已阻止导出（不会生成残缺 CSV）：</div><br>' +
        ex.problems.map(function (p) { return reportHTML(p.table + ' 表问题行', p.errors, 'err-line'); }).join('');
      showModal('导出被阻止', html);
      return;
    }
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
      '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    var html = '<div>将导出以下变更文件（UTF-8，可直接粘贴回协作表格）：</div><ul>' +
      ex.files.map(function (f) {
        return '<li>' + f.table + '_' + stamp + '.csv — ' + f.records.length + ' 条</li>';
      }).join('') + '</ul><div class="hint muted">回写协作表格时请追加到对应表末尾，不要覆盖已有行。</div>' +
      '<div style="text-align:right;margin-top:12px"><button id="btnDoDownload" type="button" class="primary">确认下载</button></div>';
    showModal('导出预览', html);
    $('#btnDoDownload').onclick = function () {
      ex.files.forEach(function (f, i) {
        var fields = V.SCHEMAS[f.table].fields.map(function (fd) { return fd.name; });
        var csvText = CSVU.toCSV(f.records, fields);
        setTimeout(function () {
          var blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = f.table + '_' + stamp + '.csv';
          document.body.appendChild(a);
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        }, i * 350);
      });
      state.exportedAt = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      updateStatus();
      closeModal();
      toast('已生成 ' + ex.files.length + ' 个 CSV 文件，请回写协作表格', 'ok');
    };
  }

  /* ================= 视图：空白工作区指引（嵌入经营概览，不阻断任何功能） ================= */
  function quickStartPanel() {
    return '<div class="panel quickstart"><h3>空白工作区 — 从这里开始</h3>' +
      '<div>当前没有任何数据。无需导入 CSV，所有信息均可在页面中直接手工录入：</div>' +
      '<ol><li>先点 <b>新增教练</b> 建立至少 1 名在职教练（会员必须挂靠教练）</li>' +
      '<li>再点 <b>新增会员</b> 建立会员档案</li>' +
      '<li>到「训练与跟进」页录入训练 / 跟进记录，风险规则自动执行并生成待办</li>' +
      '<li>数据自动保存在本机浏览器（刷新不丢）；点顶部「导出 CSV」可回写协作表格或跨设备同步</li></ol>' +
      '<div class="hint muted">已有协作表格数据？点顶部「导入 CSV」批量导入，与手工录入可混用。</div>' +
      '<div style="margin-top:10px"><button type="button" class="primary" onclick="FXPApp.coachDialog()">新增教练</button> ' +
      '<button type="button" class="primary" onclick="FXPApp.memberDialog()">新增会员</button></div></div>';
  }

  /* ================= 视图：经营概览 ================= */
  function metricCard(label, num, cls, hash, icon) {
    return '<div class="card ' + (cls || '') + (hash ? ' click' : '') + '"' + (hash ? ' onclick="location.hash=\'' + hash + '\'"' : '') + '>' +
      (icon ? '<span class="ico">' + icon + '</span>' : '') +
      '<div class="num">' + num + '</div><div class="lbl">' + label + '</div></div>';
  }

  /* ---------- V1.1 服务质量指标（P1；仅在样本充分时给出，缺数据不硬造结论） ---------- */
  function distinctDayCount(m, memberId, from, to) {
    var seen = {}, n = 0;
    m.sessions.forEach(function (s) { if (s.member_id === memberId && s.date >= from && s.date <= to && !seen[s.date]) { seen[s.date] = 1; n++; } });
    return n;
  }
  function pct(n, d) { return d ? Math.round(n / d * 100) : null; }
  function metricRow(label, value, sample, note, cls) {
    return '<tr><td>' + label + '</td><td class="' + (cls || '') + '">' + value + '</td>' +
      '<td class="muted small">' + sample + '</td><td class="muted small">' + note + '</td></tr>';
  }
  function serviceMetricsPanel(m, T) {
    var NA = '<span class="unknown">数据不足</span>';
    /* 1) 训练记录完整率：V1.1 关键字段（类型/完成情况/感受）三项齐全视为完整 */
    var KEY = ['session_type', 'completion', 'feeling'];
    var sTotal = m.sessions.length;
    var sFilled = m.sessions.filter(function (s) { return KEY.every(function (k) { return s[k]; }); }).length;
    var sRate = pct(sFilled, sTotal);
    /* 2) 任务按时完成率：已完成任务中 done_date <= due_date 的占比 */
    var doneTasks = m.tasks.filter(function (t) { return TASKM.stateOf(t) === 'done' && t.done_date && t.due_date; });
    var onTime = doneTasks.filter(function (t) { return t.done_date <= t.due_date; }).length;
    var onTimeRate = pct(onTime, doneTasks.length);
    /* 3) 计划 vs 实际：已设置计划频率的会员里，近 28 天达成率 < 60% 的人数 */
    var withPlan = m.members.filter(function (x) { return Number(x.planned_per_week) > 0; });
    var belowPlan = withPlan.filter(function (x) {
      var actual = distinctDayCount(m, x.member_id, addDays(T, -27), T);
      var expected = Number(x.planned_per_week) * 4;
      return expected > 0 && actual < expected * 0.6;
    }).length;
    /* 4) 风险会员有效跟进率：中/高风险会员中近 14 天内有跟进记录的占比 */
    var riskMap = RISK.computeRiskMap(m, { today: T });
    var atRisk = Object.keys(riskMap).filter(function (id) { var r = riskMap[id]; return r.ok && (r.level === 'medium' || r.level === 'high'); });
    var fuFrom = addDays(T, -13);
    var riskFollowed = atRisk.filter(function (id) {
      return m.followups.some(function (f) { return f.member_id === id && f.date >= fuFrom && f.date <= T; });
    }).length;
    var riskFuRate = pct(riskFollowed, atRisk.length);
    /* 5) 跟进后再到课：近 30 天"已联系上/答应到店/已恢复"的跟进之后 14 天内是否有训练记录 */
    var recentFu = m.followups.filter(function (f) {
      return f.date >= addDays(T, -29) && f.date <= T && ['promised', 'reached', 'resumed'].indexOf(f.result) >= 0;
    });
    var attended = recentFu.filter(function (f) {
      var until = addDays(f.date, 14);
      return m.sessions.some(function (s) { return s.member_id === f.member_id && s.date > f.date && s.date <= until; });
    }).length;
    var attendRate = pct(attended, recentFu.length);
    /* 7) 异常事项（近 30 天） */
    var painN = m.sessions.filter(function (s) { return s.feeling === 'pain' && s.date >= addDays(T, -29); }).length;
    var incompleteN = m.members.filter(function (x) { return x.data_incomplete === 'Y'; }).length;
    var pauseN = m.members.filter(function (x) { return RISK.inPauseWindow(x, T); }).length;
    var noPlanN = m.members.length - withPlan.length;

    var html = '<div class="panel"><h3>服务质量指标 <span class="muted small">（P1 · 仅作观察，样本不足时不给出结论）</span></h3>' +
      '<div style="overflow-x:auto"><table class="mini-table"><thead><tr><th>指标</th><th>数值</th><th>样本</th><th>口径说明</th></tr></thead><tbody>' +
      metricRow('训练记录完整率', sRate === null ? NA : sRate + '%', sFilled + ' / ' + sTotal + ' 条',
        '训练记录填写了类型 + 完成情况 + 感受三项视为完整', sRate !== null && sRate < 60 ? 'warn-line' : '') +
      metricRow('任务按时完成率', onTimeRate === null ? NA : onTimeRate + '%', onTime + ' / ' + doneTasks.length + ' 条',
        '已完成任务中完成日不晚于截止日的占比', onTimeRate !== null && onTimeRate < 60 ? 'warn-line' : '') +
      metricRow('实际低于计划的会员', withPlan.length ? belowPlan + ' / ' + withPlan.length + ' 名' : NA, withPlan.length + ' 名已设计划',
        '近 28 天实际到店 < 计划应到的 60%；未设计划的 ' + noPlanN + ' 名不计入（不等于无训练）', '') +
      metricRow('风险会员有效跟进率', riskFuRate === null ? NA : riskFuRate + '%', riskFollowed + ' / ' + atRisk.length + ' 名',
        '中/高风险会员近 14 天内有跟进记录；跟进完成不等于风险解除', riskFuRate !== null && riskFuRate < 60 ? 'warn-line' : '') +
      metricRow('跟进后再到课', attendRate === null ? NA : attendRate + '%', attended + ' / ' + recentFu.length + ' 次',
        '近 30 天"已联系上/答应到店"的跟进之后 14 天内出现训练记录', '') +
      metricRow('近 30 天疼痛/不适反馈', painN, painN ? '需人工关注' : '无',
        '会员自述疼痛或不适的记录数；系统不做医疗诊断，仅提示人工关注', painN ? 'err-line' : '') +
      metricRow('待核实的数据', (incompleteN + pauseN), '数据不完整 ' + incompleteN + ' 名 · 暂停期内 ' + pauseN + ' 名',
        '这些会员的风险判断已降级/免判，建议先核对记录与状态', '') +
      '</tbody></table></div>' +
      '<div class="hint">提示：以上指标用于发现需要人工跟进的会员与流程缺口，<b>不作为教练绩效排名或处罚依据</b>；样本不足时显示「数据不足」而非 0，避免误读。</div>' +
      '</div>';

    /* 6) 教练工作量（负责会员数 + 未完成任务数；明示为参考，不排名） */
    var coachRows = m.coaches.map(function (c) {
      var memberN = m.members.filter(function (x) { return x.coach_id === c.coach_id && x.status !== 'expired'; }).length;
      var taskN = m.tasks.filter(function (t) { return t.coach_id === c.coach_id && TASKM.isActive(t); }).length;
      var overdueN = m.tasks.filter(function (t) { return t.coach_id === c.coach_id && TASKM.isActive(t) && TASKM.isOverdue(t, T); }).length;
      return { id: c.coach_id, name: c.name, active: c.active !== 'N', memberN: memberN, taskN: taskN, overdueN: overdueN };
    }).filter(function (r) { return r.memberN > 0 || r.taskN > 0 || r.active; });
    if (coachRows.length) {
      html += '<div class="panel"><h3>教练工作量参考 <span class="muted small">（负责会员数 + 未完成任务量，含逾期）</span></h3>' +
        '<div style="overflow-x:auto"><table class="mini-table"><thead><tr><th>教练</th><th>负责会员</th><th>未完成任务</th><th>其中逾期</th><th>在职</th></tr></thead><tbody>' +
        coachRows.map(function (r) {
          return '<tr><td>' + esc(r.name) + ' <span class="muted small">' + esc(r.id) + '</span></td><td>' + r.memberN + '</td><td>' + r.taskN + '</td>' +
            '<td class="' + (r.overdueN ? 'err-line' : '') + '">' + r.overdueN + '</td><td>' + (r.active ? '是' : '<span class="muted">否</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="hint">工作量与会员难度、服务方式相关，<b>不得仅按任务数量对教练排名或考核</b>；短期留存也不应完全归因于教练个人。</div></div>';
    }
    return html;
  }

  function viewOverview() {
    var m = state.model, rep = state.rep || E.runRules(m, {});
    if (!state.rep) state.rep = rep;
    var T = rep.today;
    var risk = rep.risk, cnt = rep.totals.risk;
    var weekFollowups = m.followups.filter(function (f) { return f.date >= weekStart(T) && f.date <= T; }).length;
    var openTasks = m.tasks.filter(function (t) { return t.status === 'open'; });
    var overdue = openTasks.filter(function (t) { return t.due_date < T; }).length;
    var dueToday = openTasks.filter(function (t) { return t.due_date === T; }).length;
    var onCoaches = {}; var onCoachN = 0;
    openTasks.forEach(function (t) { if (!onCoaches[t.coach_id]) { onCoaches[t.coach_id] = 1; onCoachN++; } });
    var activeCoachN = m.coaches.filter(function (c) { return c.active !== 'N'; }).length || m.coaches.length;

    var html = '<h2>经营概览 <span class="muted small">（基准日 ' + T + '）</span></h2>';
    if (!hasData()) html += quickStartPanel();
    html += '<div class="cards">';
    html += metricCard('会员总数', (cnt.none || 0) + (cnt.L1 || 0) + (cnt.L2 || 0) + (cnt.excluded_opt_out || 0) + (cnt.excluded_expired || 0) + (cnt.excluded_no_session || 0) + (cnt.excluded_sleeping || 0), '', '#members', '👥');
    html += metricCard('活跃会员（7天内到店）', cnt.none || 0, 'good', "#members:risk=none", '🏃');
    html += metricCard('7天未到店（关注）', cnt.L1 || 0, 'warn', "#members:risk=L1", '⏰');
    html += metricCard('14天未到店（沉睡风险）', cnt.L2 || 0, 'bad', "#members:risk=L2", '📉');
    html += metricCard('今日到期任务', dueToday, 'info', '#tasks', '📅');
    html += metricCard('待办任务', openTasks.length, 'warn', '#tasks', '📋');
    html += metricCard('逾期任务', overdue, overdue ? 'bad' : '', '#tasks:status=overdue', '🔥');
    html += metricCard('教练在办', onCoachN + ' / ' + activeCoachN + ' 人', 'sys', '#tasks', '🧑‍🏫');
    html += metricCard('本周跟进完成数', weekFollowups, 'good', '#records', '📞');
    html += '</div>';

    html += serviceMetricsPanel(m, T);

    html += '<div class="panel"><div class="hint">最近一次规则执行的完整摘要（每条新建/取消/跳过均可追溯）：</div>' +
      '<pre class="summary">' + esc(E.summaryText(rep)) + '</pre></div>';

    if (rep.suggestCancel.length) {
      html += '<div class="panel"><h3>建议取消（会员已拒绝联系，需人工确认）</h3><div class="warn-line">' +
        rep.suggestCancel.map(function (s) {
          return '任务 ' + esc(s.task_id) + '（会员 ' + esc(s.member_id) + '，规则 ' + esc(s.rule_code) + '）';
        }).join('<br>') + '</div><div class="hint">请到「教练待办」中逐条确认取消，原因选择"拒绝联系"。</div></div>';
    }

    var errN = m.report.errors.length, warnN = m.report.warnings.length;
    html += '<div class="panel"><h3>数据质量</h3>' +
      '<div>导入校验：错误 <b class="' + (errN ? 'err-line' : '') + '">' + errN + '</b> 条 / 警告 <b>' + warnN + '</b> 条 ' +
      '<button class="mini" onclick="FXPApp.showReport()">查看明细</button></div>' +
      (errN ? '<div class="err-line small" style="margin-top:6px">存在错误行：这些行被拒收、未参与统计。请修正协作表格后重新导入。</div>' : '') +
      '</div>';
    return html;
  }

  function showReport() {
    var m = state.model;
    showModal('导入校验报告',
      reportHTML('拒收（错误）', m.report.errors, 'err-line') +
      reportHTML('警告', m.report.warnings, 'warn-line') ||
      '<div class="muted">无错误无警告。</div>');
  }

  /* ================= 视图：会员列表 ================= */
  function riskBadge(r) {
    var cls = (r === 'none') ? 'none' : (r === 'L1' ? 'L1' : r === 'L2' ? 'L2' : 'muted');
    return '<span class="badge ' + cls + '">' + (RISK_LABEL[r] || r) + '</span>';
  }
  function viewMembers() {
    var m = state.model, T = state.rep ? state.rep.today : todayStr();
    var flt = state.filters.members;
    var riskMap = state.rep ? state.rep.risk : E.computeRiskMap(m, { today: T });
    var coaches = m.coaches.slice().sort(function (a, b) { return a.coach_id < b.coach_id ? -1 : 1; });

    var rows = m.members.filter(function (mem) {
      var r = riskMap[mem.member_id];
      if (flt.status && mem.status !== flt.status) return false;
      if (flt.risk && r !== flt.risk) return false;
      if (flt.coach && mem.coach_id !== flt.coach) return false;
      if (flt.q) {
        var q = flt.q.toLowerCase();
        if ((mem.name + '|' + mem.member_id + '|' + mem.phone).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return a.member_id < b.member_id ? -1 : 1; });

    var html = '<h2>会员列表 <span class="muted small">（' + rows.length + ' / ' + m.members.length + '）</span></h2>' +
      '<div class="filters">' +
      '<input type="text" id="fQ" placeholder="搜索姓名 / 会员ID / 手机号" value="' + esc(flt.q) + '">' +
      '<select id="fStatus"><option value="">全部状态</option>' +
      ['active', 'sleeping', 'expired'].map(function (s) {
        return '<option value="' + s + '"' + (flt.status === s ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>';
      }).join('') + '</select>' +
      '<select id="fRisk"><option value="">全部风险</option>' +
      ['none', 'L1', 'L2', 'excluded_opt_out', 'excluded_expired', 'excluded_no_session', 'excluded_sleeping'].map(function (r) {
        return '<option value="' + r + '"' + (flt.risk === r ? ' selected' : '') + '>' + RISK_LABEL[r] + '</option>';
      }).join('') + '</select>' +
      '<select id="fCoach"><option value="">全部教练</option>' +
      coaches.map(function (c) {
        return '<option value="' + esc(c.coach_id) + '"' + (flt.coach === c.coach_id ? ' selected' : '') + '>' +
          esc(c.coach_id + ' ' + c.name + (c.active === 'N' ? '（离职）' : '')) + '</option>';
      }).join('') + '</select>' +
      '<button type="button" class="primary" id="btnAddMember" title="页面手工建档，保存后进入导出队列，回写协作表格后永久生效">新增会员</button>' +
      '<button type="button" id="btnAddCoach" title="页面手工录入新教练，保存后进入导出队列">新增教练</button>' +
      '<button type="button" class="mini" id="btnClearFilters">清除筛选</button></div>';

    html += '<div class="panel"><div class="tbl-wrap"><table class="member-table"><thead><tr>' +
      '<th>会员</th><th>状态</th><th>风险等级</th><th>责任教练</th><th>最后训练</th><th>会籍到期</th><th>未导出变更</th>' +
      '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="7" class="muted">无匹配会员</td></tr>';
    rows.forEach(function (mem) {
      var last = E.lastSessionDate(m, mem.member_id);
      var coach = m.byId.coaches[mem.coach_id];
      var newN = ['sessions', 'followups', 'tasks'].reduce(function (n, t) {
        return n + state.queue[t].filter(function (r) { return r.member_id === mem.member_id; }).length;
      }, 0);
      html += '<tr class="click" onclick="location.hash=\'#member/' + esc(mem.member_id) + '\'">' +
        '<td data-label="会员"><b>' + esc(mem.name) + '</b> <span class="muted small">' + esc(mem.member_id) + '</span></td>' +
        '<td data-label="状态">' + (STATUS_LABEL[mem.status] || esc(mem.status)) + '</td>' +
        '<td data-label="风险">' + riskBadge(riskMap[mem.member_id]) + '</td>' +
        '<td data-label="教练">' + (coach ? esc(coach.name) : fmt('')) + (coach && coach.active === 'N' ? ' <span class="badge muted">离职</span>' : '') + '</td>' +
        '<td data-label="最后训练">' + (last ? esc(last) + ' <span class="muted small">（' + Math.round((new Date(T) - new Date(last)) / 86400000) + '天前）</span>' : fmt('')) + '</td>' +
        '<td data-label="到期">' + esc(mem.membership_end) + '</td>' +
        '<td data-label="未导出">' + (newN ? '<span class="badge man">' + newN + ' 条</span>' : '') + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
  }
  function bindMemberFilters() {
    var map = { fQ: 'q', fStatus: 'status', fRisk: 'risk', fCoach: 'coach' };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
        state.filters.members[map[id]] = el.value.trim();
        render();
        var back = document.getElementById(id);
        if (back && back.tagName === 'INPUT') back.focus();
      });
    });
    var btnM = document.getElementById('btnAddMember');
    if (btnM) btnM.addEventListener('click', memberDialog);
    var btnC = document.getElementById('btnAddCoach');
    if (btnC) btnC.addEventListener('click', coachDialog);
    var btnF = document.getElementById('btnClearFilters');
    if (btnF) btnF.addEventListener('click', function () {
      state.filters.members = { q: '', status: '', risk: '', coach: '' };
      render();
    });
  }

  /* ================= 手工录入：新增教练 / 新增会员 ================= */
  function plusYear(s) {
    var d = new Date(s + 'T00:00:00Z');
    return new Date(d.getTime() + 365 * 86400000).toISOString().slice(0, 10);
  }

  function coachDialog() {
    var nextId = E.nextSeqId(state.model.coaches, 'coach_id', 'C', 3);
    showModal('新增教练', '<form onsubmit="return false">' +
      '<div><label>教练编号（自动生成）</label><input value="' + nextId + '" readonly></div>' +
      '<div><label>姓名 <span class="req">*</span></label><input type="text" id="cName" maxlength="20" placeholder="必填"></div>' +
      '<div><label>手机号</label><input type="text" id="cPhone" maxlength="11" placeholder="11 位数字，可留空"></div>' +
      '<div><label>角色</label><select id="cRole"><option value="coach">教练</option><option value="manager">店长</option></select></div>' +
      '<div><label>在职状态</label><select id="cActive"><option value="Y">在职</option><option value="N">离职</option></select></div>' +
      '<div class="full form-err" id="cErr"></div>' +
      '<div class="full"><button type="button" class="primary" onclick="FXPApp.doAddCoach()">保存教练</button>' +
      ' <span class="muted small">保存后进入导出队列，回写协作表格后永久生效</span></div></form>');
  }

  function doAddCoach() {
    var res = E.addCoach(state.model, {
      name: $('#cName').value, phone: $('#cPhone').value,
      role: $('#cRole').value, active: $('#cActive').value
    });
    if (!res.ok) { $('#cErr').textContent = res.message; return; }
    queueAdd('coaches', res.coach);
    (res.warnings || []).forEach(function (w) { toast('提示：' + w, 'err'); });
    closeModal();
    toast('教练已保存（' + res.coach.coach_id + ' ' + res.coach.name + '），待导出 ' + queueCount() + ' 条', 'ok');
    updateStatus();
    render();
  }

  function memberDialog() {
    var nextId = E.nextSeqId(state.model.members, 'member_id', 'M', 4);
    var T = state.rep ? state.rep.today : todayStr();
    var coachOpts = state.model.coaches.filter(function (c) { return c.active !== 'N'; })
      .map(function (c) { return '<option value="' + esc(c.coach_id) + '">' + esc(c.coach_id + ' ' + c.name) + '</option>'; }).join('');
    if (!coachOpts) coachOpts = '<option value="">（无在职教练，请先新增教练）</option>';
    showModal('新增会员', '<form onsubmit="return false">' +
      '<div><label>会员编号（自动生成）</label><input value="' + nextId + '" readonly></div>' +
      '<div><label>姓名 <span class="req">*</span></label><input type="text" id="mName" maxlength="20" placeholder="必填"></div>' +
      '<div><label>手机号 <span class="req">*</span></label><input type="text" id="mPhone" maxlength="11" placeholder="11 位数字"></div>' +
      '<div><label>责任教练 <span class="req">*</span></label><select id="mCoach">' + coachOpts + '</select></div>' +
      '<div><label>入会日期 <span class="req">*</span></label><input type="date" id="mJoin" value="' + T + '"></div>' +
      '<div><label>会籍到期日 <span class="req">*</span></label><input type="date" id="mEnd" value="' + plusYear(T) + '"></div>' +
      '<div><label>会员状态</label><select id="mStatus"><option value="active">正常</option><option value="sleeping">暂停</option><option value="expired">已退出</option></select></div>' +
      '<div><label>训练目标</label><input type="text" id="mGoal" maxlength="50" placeholder="如：减脂 / 增肌"></div>' +
      '<div><label>计划每周训练次数</label><input type="number" id="mPlan" min="1" max="14" placeholder="未收集可留空"></div>' +
      '<div><label>剩余私教课时</label><input type="number" id="mLeft" min="0" max="999" placeholder="未收集可留空"></div>' +
      '<div><label>课包到期日</label><input type="date" id="mPkg"></div>' +
      '<div class="full"><label>备注</label><input type="text" id="mNotes" maxlength="200"></div>' +
      '<div><label>允许联系</label><select id="mOpt" onchange="document.getElementById(\'mOptBox\').hidden = this.value !== \'Y\'"><option value="N">允许</option><option value="Y">拒绝联系</option></select></div>' +
      '<div id="mOptBox" hidden><label>登记日期 <span class="req">*</span></label><input type="date" id="mOptDate" value="' + T + '"></div>' +
      '<div class="full"><label>拒绝原因（选择"拒绝联系"时填写）</label><input type="text" id="mOptReason" maxlength="100"></div>' +
      '<div class="full form-err" id="mErr"></div>' +
      '<div class="full"><button type="button" class="primary" onclick="FXPApp.doAddMember()">保存会员</button>' +
      ' <span class="muted small">保存后进入导出队列，回写协作表格后永久生效</span></div></form>');
  }

  function doAddMember() {
    var res = E.addMember(state.model, {
      name: $('#mName').value, phone: $('#mPhone').value, coach_id: $('#mCoach').value,
      join_date: $('#mJoin').value, membership_end: $('#mEnd').value, status: $('#mStatus').value,
      contact_opt_out: $('#mOpt').value, opt_out_date: $('#mOptDate').value, opt_out_reason: $('#mOptReason').value,
      goal: $('#mGoal').value, notes: $('#mNotes').value,
      planned_per_week: ($('#mPlan') || {}).value || '',
      pt_sessions_left: ($('#mLeft') || {}).value || '',
      package_end_date: ($('#mPkg') || {}).value || ''
    });
    if (!res.ok) { $('#mErr').textContent = res.message; return; }
    queueAdd('members', res.member);
    (res.warnings || []).forEach(function (w) { toast('提示：' + w, 'err'); });
    closeModal();
    toast('会员已保存（' + res.member.member_id + ' ' + res.member.name + '），待导出 ' + queueCount() + ' 条，已重新执行规则', 'ok');
    runRulesSilent();
  }

  /* ================= 视图：会员详情 ================= */
  /** 会员档案维护（V1.1）：计划频率 / 预约 / 课时 / 课包 / 暂停期，未填 = 未收集（不等于 0） */
  function memberProfileDialog(id) {
    var mem = state.model.byId.members[id];
    if (!mem) return;
    var coachOpts = state.model.coaches.map(function (c) {
      return '<option value="' + esc(c.coach_id) + '"' + (mem.coach_id === c.coach_id ? ' selected' : '') + '>' + esc(c.coach_id + ' ' + c.name + (c.active === 'N' ? '（离职）' : '')) + '</option>';
    }).join('');
    showModal('维护档案：' + mem.name + '（' + mem.member_id + '）',
      '<div class="hint">带 <span class="prov manual">手动</span> 的字段由教练/店长维护；留空表示<b>尚未收集</b>，系统不会当作 0。</div>' +
      '<form onsubmit="return false">' +
      '<div><label>会员状态</label><select id="mpStatus">' +
      ['active:正常', 'sleeping:暂停/休假', 'expired:已结束'].map(function (x) {
        var kv = x.split(':');
        return '<option value="' + kv[0] + '"' + (mem.status === kv[0] ? ' selected' : '') + '>' + kv[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div><label>主负责教练</label><select id="mpCoach">' + coachOpts + '</select></div>' +
      '<div><label>计划每周训练次数</label><input type="number" id="mpPlan" min="1" max="14" placeholder="未收集" value="' + esc(mem.planned_per_week) + '"></div>' +
      '<div><label>下次预约日期</label><input type="date" id="mpAppt" value="' + esc(mem.next_appointment_date) + '"></div>' +
      '<div><label>累计预约未到次数</label><input type="number" id="mpNoShow" min="0" max="99" placeholder="未收集" value="' + esc(mem.no_show_count) + '"></div>' +
      '<div><label>剩余私教课时</label><input type="number" id="mpLeft" min="0" max="999" placeholder="未收集" value="' + esc(mem.pt_sessions_left) + '"></div>' +
      '<div><label>课包到期日</label><input type="date" id="mpPkg" value="' + esc(mem.package_end_date) + '"></div>' +
      '<div><label>暂停开始日</label><input type="date" id="mpPauseS" value="' + esc(mem.pause_start_date) + '"></div>' +
      '<div><label>暂停结束日</label><input type="date" id="mpPauseE" value="' + esc(mem.pause_end_date) + '"></div>' +
      '<div><label>数据不完整标记</label><select id="mpIncomplete"><option value="N"' + (mem.data_incomplete === 'Y' ? '' : ' selected') + '>不标记</option><option value="Y"' + (mem.data_incomplete === 'Y' ? ' selected' : '') + '>标记（如换过系统/记录缺失）</option></select></div>' +
      '<div class="full"><label>训练目标</label><input type="text" id="mpGoal" maxlength="50" value="' + esc(mem.goal) + '"></div>' +
      '<div class="full"><label>备注（含会员主动表达的困难，如"太忙""跟不上"）</label><input type="text" id="mpNotes" maxlength="200" value="' + esc(mem.notes) + '"></div>' +
      '<div class="full form-err" id="mpErr"></div>' +
      '<div class="full" style="text-align:right"><button type="button" class="primary" onclick="FXPApp.doUpdateMember(\'' + esc(id) + '\')">保存档案</button>' +
      ' <span class="muted small">保存后进入导出队列，并重算风险</span></div></form>');
  }
  function doUpdateMember(id) {
    var res = E.updateMember(state.model, id, {
      status: $('#mpStatus').value, coach_id: $('#mpCoach').value,
      planned_per_week: $('#mpPlan').value, next_appointment_date: $('#mpAppt').value,
      no_show_count: $('#mpNoShow').value, pt_sessions_left: $('#mpLeft').value,
      package_end_date: $('#mpPkg').value,
      pause_start_date: $('#mpPauseS').value, pause_end_date: $('#mpPauseE').value,
      data_incomplete: $('#mpIncomplete').value,
      goal: $('#mpGoal').value, notes: $('#mpNotes').value
    });
    if (!res.ok) { $('#mpErr').textContent = res.message; return; }
    queueAdd('members', res.member);
    (res.warnings || []).forEach(function (w) { toast('提示：' + w, 'err'); });
    closeModal();
    toast('档案已保存（' + id + '），已重新计算风险', 'ok');
    runRulesSilent();
  }
  /** 字段来源标注：已收集(手动) / 未收集 */
  function provVal(v, suffix, kind) {
    if (v === '' || v === undefined || v === null) return '<span class="unknown">未收集</span><span class="prov missing">待补录</span>';
    return esc(v) + (suffix || '') + '<span class="prov ' + (kind || 'manual') + '">' + (kind === 'system' ? '系统计算' : '手动录入') + '</span>';
  }
  function viewMemberDetail(id) {
    var m = state.model;
    var mem = m.byId.members[id];
    if (!mem) return '<div class="empty">会员 ' + esc(id) + ' 不存在（可能在校验中被拒收）<br><a href="#members">← 返回会员列表</a></div>';
    var T = state.rep ? state.rep.today : todayStr();
    var ov = E.memberOverview(m, id, { today: T });
    var coach = m.byId.coaches[mem.coach_id];

    var sessions = m.sessions.filter(function (s) { return s.member_id === id; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var followups = m.followups.filter(function (f) { return f.member_id === id; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var openTasks = m.tasks.filter(function (t) { return t.member_id === id && t.status === 'open'; });

    var html = '<h2>' + esc(mem.name) + ' <span class="muted small">' + esc(mem.member_id) + '</span></h2>' +
      '<p><a href="#members">← 返回会员列表</a> <button type="button" class="mini primary" onclick="FXPApp.memberProfileDialog(\'' + esc(id) + '\')">维护档案</button>' +
      ' <a href="#records" onclick="setTimeout(function(){var s=document.getElementById(\'sMember\');if(s){s.value=\'' + esc(id) + '\';FXPApp.onSessionMember(\'s\');}},60)">去录训练</a></p>' +
      '<div class="cards">' +
      metricCard('风险等级', '', '') .replace('<div class="num"></div>', '<div class="num" style="font-size:14px;padding-top:8px">' + riskBadge(ov.risk) + '</div>') +
      metricCard('训练次数', ov.session_count) +
      metricCard('跟进次数', ov.followup_count) +
      metricCard('待办任务', ov.open_tasks) +
      '</div>' +
      '<div class="panel"><b>基本信息</b><table>' +
      '<tr><td>手机号：' + esc(mem.phone) + '</td><td>状态：' + (STATUS_LABEL[mem.status] || mem.status) + '</td></tr>' +
      '<tr><td>责任教练：' + (coach ? esc(coach.name + '（' + coach.coach_id + '）') : '—') + '</td><td>训练目标：' + fmt(mem.goal) + '</td></tr>' +
      '<tr><td>入会日期：' + esc(mem.join_date) + '</td><td>会籍到期：' + esc(mem.membership_end) + '</td></tr>' +
      (mem.contact_opt_out === 'Y'
        ? '<tr><td colspan="2"><span class="badge muted">已拒绝联系</span> 登记日 ' + esc(mem.opt_out_date) + '，原因：' + fmt(mem.opt_out_reason) + '（不生成回访任务）</td></tr>'
        : '') +
      '<tr><td colspan="2">备注：' + fmt(mem.notes) + '</td></tr></table></div>';

    /* V1.1 计划与课时（区分：系统计算 / 手动录入 / 未收集；未知不视为 0） */
    var lastS = sessions[0];
    var actual4w = sessions.filter(function (s) { return (new Date(T) - new Date(s.date)) / 86400000 <= 28; }).length;
    html += '<div class="panel"><b>计划与课时</b><table>' +
      '<tr><td>计划每周训练：' + provVal(mem.planned_per_week, ' 次') + '</td>' +
      '<td>近 28 天实际：' + actual4w + ' 次<span class="prov system">系统计算</span>' +
      (mem.planned_per_week ? '<br><span class="muted small">计划 ' + esc(mem.planned_per_week) + ' 次/周 ≈ 4 周 ' + (parseInt(mem.planned_per_week, 10) * 4) + ' 次，实际 ' + actual4w + ' 次</span>' : '') + '</td></tr>' +
      '<tr><td>最近训练：' + (lastS ? esc(lastS.date) + '<span class="prov system">系统计算</span>' : '<span class="unknown">无训练记录</span>') + '</td>' +
      '<td>下次预约：' + provVal(mem.next_appointment_date, '') + '</td></tr>' +
      '<tr><td>剩余私教课时：' + provVal(mem.pt_sessions_left, ' 节') + '</td>' +
      '<td>课包到期日：' + provVal(mem.package_end_date, '') + '</td></tr>' +
      '<tr><td>累计预约未到：' + provVal(mem.no_show_count, ' 次') + '</td>' +
      '<td>暂停期：' + (mem.pause_start_date || mem.pause_end_date
        ? esc(mem.pause_start_date || '—') + ' 至 ' + esc(mem.pause_end_date || '—') + '<span class="prov manual">手动录入</span>'
        : '<span class="unknown">未收集</span>') + '</td></tr>' +
      (mem.data_incomplete === 'Y' ? '<tr><td colspan="2"><span class="badge muted">数据不完整</span> 该会员标记为记录缺失，风险判断会据此降级提示（不代表真实无训练）</td></tr>' : '') +
      '</table></div>';

    html += '<div class="panel"><h3>待办任务（open）</h3><table><thead><tr><th>任务</th><th>截止日</th><th>负责人</th></tr></thead><tbody>';
    if (!openTasks.length) html += '<tr><td colspan="3" class="muted">无</td></tr>';
    openTasks.forEach(function (t) {
      html += '<tr><td>' + esc(t.title) + (t.rule_code ? ' <span class="badge sys">' + esc(t.rule_code) + '</span>' : '') + '</td>' +
        '<td>' + esc(t.due_date) + (t.due_date < T ? ' <span class="badge overdue">逾期</span>' : '') + '</td>' +
        '<td>' + esc(t.coach_id) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    html += '<div class="two-col">';
    html += '<div class="panel"><h3>训练历史（' + sessions.length + '，倒序）</h3><div class="tbl-wrap"><table><thead><tr><th>日期</th><th>内容</th><th>时长</th><th>评级</th></tr></thead><tbody>';
    if (!sessions.length) html += '<tr><td colspan="4" class="muted">无训练记录</td></tr>';
    sessions.forEach(function (s) {
      html += '<tr><td>' + esc(s.date) + '</td><td>' + esc(s.content) + '</td><td>' + fmt(s.duration_min) + '</td><td>' + fmt(s.rating) + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    html += '<div class="panel"><h3>跟进历史（' + followups.length + '，倒序）</h3><div class="tbl-wrap"><table><thead><tr><th>日期</th><th>渠道</th><th>结果</th><th>内容</th></tr></thead><tbody>';
    if (!followups.length) html += '<tr><td colspan="4" class="muted">无跟进记录</td></tr>';
    followups.forEach(function (f) {
      html += '<tr><td>' + esc(f.date) + '</td><td>' + (CHANNEL_LABEL[f.channel] || esc(f.channel)) + '</td>' +
        '<td>' + (RESULT_LABEL[f.result] || esc(f.result)) + '</td><td>' + fmt(f.content) + '</td></tr>';
    });
    html += '</tbody></table></div></div></div>';
    return html;
  }

  /* ================= 视图：教练待办 ================= */
  function taskStatusBadge(t, T) {
    if (t.status === 'done') return '<span class="badge done">已完成</span>';
    if (t.status === 'cancelled') return '<span class="badge cancelled">已取消</span>';
    if (t.due_date < T) return '<span class="badge overdue">逾期 ' + Math.round((new Date(T) - new Date(t.due_date)) / 86400000) + ' 天</span>';
    return '<span class="badge open">待处理</span>';
  }
  function taskResultCell(t) {
    if (t.status === 'done') return '完成于 ' + esc(t.done_date);
    if (t.status === 'cancelled') return (CANCEL_LABEL[t.cancel_reason] || esc(t.cancel_reason)) + (t.cancelled_date ? '（' + esc(t.cancelled_date) + '）' : '');
    return '<span class="muted">—</span>';
  }
  function viewTasks() {
    var m = state.model, T = state.rep ? state.rep.today : todayStr();
    var flt = state.filters.tasks;
    var coaches = m.coaches.slice().sort(function (a, b) { return a.coach_id < b.coach_id ? -1 : 1; });

    var rows = m.tasks.filter(function (t) {
      if (flt.coach && t.coach_id !== flt.coach) return false;
      if (flt.status) {
        var eff = t.status === 'open' ? (t.due_date < T ? 'overdue' : 'open') : t.status;
        if (eff !== flt.status) return false;
      }
      return true;
    }).sort(function (a, b) {
      var ao = a.status === 'open' ? 0 : 1, bo = b.status === 'open' ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return a.due_date < b.due_date ? -1 : 1;
    });

    var html = '<h2>教练待办 <span class="muted small">（' + rows.length + ' 条）</span></h2>' +
      '<div class="filters">' +
      '<select id="tCoach"><option value="">全部教练</option>' +
      coaches.map(function (c) {
        return '<option value="' + esc(c.coach_id) + '"' + (flt.coach === c.coach_id ? ' selected' : '') + '>' + esc(c.coach_id + ' ' + c.name) + '</option>';
      }).join('') + '</select>' +
      '<select id="tStatus"><option value="">全部状态</option>' +
      ['open', 'overdue', 'done', 'cancelled'].map(function (s) {
        var lb = { open: '待处理', overdue: '逾期', done: '已完成', cancelled: '已取消' }[s];
        return '<option value="' + s + '"' + (flt.status === s ? ' selected' : '') + '>' + lb + '</option>';
      }).join('') + '</select>' +
      '<span class="muted small">状态"逾期"为推导值，不修改表格数据</span></div>';

    html += '<div class="panel"><div class="tbl-wrap"><table><thead><tr>' +
      '<th>责任人</th><th>会员</th><th>任务 / 原因</th><th>截止日</th><th>状态</th><th>结果</th><th>操作</th>' +
      '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="7" class="muted">无匹配任务</td></tr>';
    rows.forEach(function (t) {
      var mem = m.byId.members[t.member_id];
      var coach = m.byId.coaches[t.coach_id];
      var actions = '';
      if (t.status === 'open') {
        actions = '<button class="mini" onclick="FXPApp.completeDialog(\'' + esc(t.task_id) + '\')">完成</button> ' +
          '<button class="mini danger" onclick="FXPApp.cancelDialog(\'' + esc(t.task_id) + '\')">取消</button>';
      }
      html += '<tr><td>' + (coach ? esc(coach.name) : esc(t.coach_id)) + ' <span class="muted small">' + esc(t.coach_id) + '</span></td>' +
        '<td>' + (mem ? esc(mem.name) : esc(t.member_id)) + '</td>' +
        '<td>' + esc(t.title) +
        (t.source === 'system' ? ' <span class="badge sys">' + esc(t.rule_code) + '</span>' : ' <span class="badge man">手工</span>') +
        (t.notes ? '<br><span class="muted small">' + esc(t.notes) + '</span>' : '') + '</td>' +
        '<td>' + esc(t.due_date) + '</td><td>' + taskStatusBadge(t, T) + '</td><td>' + taskResultCell(t) + '</td>' +
        '<td>' + actions + '</td></tr>';
    });
    html += '</tbody></table></div>' +
      '<div class="hint">完成任务后请填写跟进/训练记录（「训练与跟进」页），规则将在记录到店后自动平息相关风险任务。</div></div>';
    return html;
  }
  function bindTaskFilters() {
    var map = { tCoach: 'coach', tStatus: 'status' };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', function () {
        state.filters.tasks[map[id]] = el.value;
        render();
      });
    });
  }

  /* ---- 任务完成/取消弹窗 ---- */
  function completeDialog(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    showModal('完成任务：' + t.title,
      '<form id="formComplete" onsubmit="return false">' +
      '<label>完成日期 <span class="req">*</span></label>' +
      '<input type="date" id="doneDate" value="' + todayStr() + '" max="' + todayStr() + '" required>' +
      '<div class="form-err" id="doneErr"></div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="primary" onclick="FXPApp.doComplete(\'' + esc(taskId) + '\')">确认完成</button></div></form>');
  }
  function doComplete(taskId) {
    var res = E.completeTask(state.model, taskId, $('#doneDate').value);
    if (!res.ok) { $('#doneErr').textContent = res.message; return; }
    queueAdd('tasks', res.task);
    (res.warnings || []).forEach(function (w) { toast('提示：' + w, 'err'); });
    closeModal();
    toast('任务已标记完成，已加入导出队列', 'ok');
    runRulesSilent();
  }
  function cancelDialog(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    var options = Object.keys(CANCEL_LABEL).map(function (k) {
      return '<option value="' + k + '">' + CANCEL_LABEL[k] + '</option>';
    }).join('');
    showModal('取消任务：' + t.title,
      '<form onsubmit="return false">' +
      '<label>取消原因 <span class="req">*</span></label><select id="cancelReason">' + options + '</select>' +
      '<div id="notesWrap" style="margin-top:8px;display:none"><label>原因说明 <span class="req">*</span>（选择"其他"时必填）</label>' +
      '<textarea id="cancelNotes" rows="2" style="width:100%"></textarea></div>' +
      '<div class="form-err" id="cancelErr"></div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="primary" onclick="FXPApp.doCancel(\'' + esc(taskId) + '\')">确认取消</button></div></form>');
    $('#cancelReason').addEventListener('change', function () {
      $('#notesWrap').style.display = this.value === 'other' ? '' : 'none';
    });
  }
  function doCancel(taskId) {
    var reason = $('#cancelReason').value;
    var notes = $('#cancelNotes') ? $('#cancelNotes').value.trim() : '';
    var res = E.cancelTask(state.model, taskId, reason, notes, todayStr());
    if (!res.ok) { $('#cancelErr').textContent = res.message; return; }
    queueAdd('tasks', res.task);
    closeModal();
    toast('任务已取消（' + CANCEL_LABEL[reason] + '），已加入导出队列', 'ok');
    runRulesSilent();
  }
  function runRulesSilent() {
    runRulesCore();
    updateStatus();
    render();
  }

  /* ================= 视图：今日优先处理（0.15.0） ================= */
  function riskLevelBadge(lvl) {
    if (!lvl) return '<span class="badge muted">—</span>';
    return '<span class="badge r-' + lvl + '">' + (RISK_LEVEL_LABEL[lvl] || lvl) + '</span>';
  }
  /* 风险原因逐条渲染（可解释）。计分项与 0 分说明分开呈现。 */
  function riskReasonLines(r) {
    return r.reasons.filter(function (x) { return x.points > 0; })
      .map(function (x) { return '<li><b>' + esc(x.label) + '</b>（+' + x.points + '）：' + esc(x.detail) + '</li>'; }).join('');
  }
  function riskNoteLines(r) {
    return r.reasons.filter(function (x) { return x.points === 0 && x.code !== 'insufficient_history'; })
      .map(function (x) { return '<li class="muted">' + esc(x.label) + '：' + esc(x.detail) + '</li>'; }).join('');
  }
  /** 需关注会员清单（中/高风险，附触发原因）+ 已自动降级/免判说明（暂停、数据不完整、预约未到期） */
  function riskMemberPanel(riskMap, sum) {
    var hi = [], med = [], adv = [];
    Object.keys(riskMap).forEach(function (id) {
      var r = riskMap[id];
      if (!r || !r.ok) return;
      if (r.level === 'high') hi.push(r);
      else if (r.level === 'medium') med.push(r);
      else if (r.pauseActive || r.dataIncomplete || r.insufficient || (r.appointmentDays !== null && r.appointmentDays >= 0)) adv.push(r);
    });
    function byScore(a, b) { return b.score - a.score; }
    hi.sort(byScore); med.sort(byScore);

    function memberRow(r) {
      return '<div class="risk-mrow">' +
        '<div class="risk-mhead"><b>' + esc(r.name) + '</b> <span class="muted small">' + esc(r.member_id) + '</span> ' +
        riskLevelBadge(r.level) + ' <span class="muted small">分数 ' + r.score + '</span>' +
        (r.absenceDays !== null ? ' <span class="muted small">· 缺席 ' + r.absenceDays + ' 天</span>' : '') +
        ' <a class="mini" href="#member/' + esc(r.member_id) + '">查看会员</a></div>' +
        '<ul class="risk-mlist">' + (riskReasonLines(r) || '<li class="muted">无计分信号</li>') + riskNoteLines(r) + '</ul></div>';
    }
    function advRow(r) {
      var why = [];
      if (r.pauseActive) why.push('暂停期内');
      if (r.dataIncomplete) why.push('数据不完整');
      if (r.insufficient) why.push('无训练记录（数据不足）');
      if (r.appointmentDays !== null && r.appointmentDays >= 0) why.push('已预约未到期');
      return '<li><b>' + esc(r.name) + '</b> <span class="muted small">' + esc(r.member_id) + '</span> — ' +
        esc(why.join('、')) + '<div class="muted small">' + (riskNoteLines(r) ? '<ul class="risk-mlist">' + riskNoteLines(r) + '</ul>' : '') + '</div></li>';
    }

    var html = '<div class="panel"><h3>需关注会员 <span class="muted small">（中/高风险 ' + sum.attentionMembers + ' 名 · 点击可查看触发原因）</span></h3>';
    if (!hi.length && !med.length) {
      html += '<div class="muted">当前没有需要重点关注的会员。</div>';
    } else {
      if (hi.length) html += '<div class="risk-mgroup"><div class="risk-mlabel"><span class="badge r-high">高风险</span> ' + hi.length + ' 名</div>' + hi.map(memberRow).join('') + '</div>';
      if (med.length) html += '<div class="risk-mgroup"><div class="risk-mlabel"><span class="badge r-medium">中风险</span> ' + med.length + ' 名</div>' + med.map(memberRow).join('') + '</div>';
    }
    if (adv.length) {
      html += '<details class="risk-adv"><summary>已自动降级 / 免判说明（' + adv.length + ' 名）——暂停、数据不完整、预约未到期等不会被误判为高风险</summary><ul class="risk-mlist">' + adv.map(advRow).join('') + '</ul></details>';
    }
    html += '<div class="muted small" style="margin-top:6px">' + esc(RISK.CAVEAT) + '</div></div>';
    return html;
  }
  function taskStateBadge(t, T) {
    if (TASKM.isOverdue(t, T)) return '<span class="badge overdue">已逾期 ' + Math.round((new Date(T) - new Date(t.due_date)) / 86400000) + ' 天</span>';
    var s = TASKM.stateOf(t);
    return '<span class="badge st-' + s + '">' + TASKM.STATE_LABEL[s] + '</span>';
  }
  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }
  /** 默认排序（第八节）：① 已逾期且高优先级 ② 高风险且尚未联系 ③ 今天到期 ④ 中风险 ⑤ 普通回访 */
  function priorityRank(t, riskMap, T) {
    if (!TASKM.isActive(t)) return 9;
    var rl = t.risk_level || (riskMap[t.member_id] && riskMap[t.member_id].level) || 'normal';
    var st = TASKM.stateOf(t);
    if (TASKM.isOverdue(t, T) && t.priority === 'high') return 1;
    if (rl === 'high' && (st === 'unassigned' || st === 'pending')) return 2;
    if (t.due_date === T) return 3;
    if (rl === 'medium') return 4;
    return 5;
  }
  function viewPriority() {
    var m = state.model, T = todayStr();
    var riskMap = RISK.computeRiskMap(m, { today: T });
    var sum = RISK.summarize(riskMap);
    var activeCoaches = m.coaches.filter(function (c) { return c.active !== 'N'; });
    var viewCoach = state.priority.coachId || (activeCoaches[0] ? activeCoaches[0].coach_id : '');
    var flt = state.priority.filter;

    var allTasks = m.tasks.slice();
    var active = allTasks.filter(function (t) { return TASKM.isActive(t); });
    var overdueN = active.filter(function (t) { return TASKM.isOverdue(t, T); }).length;
    var highPriN = active.filter(function (t) { return t.priority === 'high'; }).length;
    var dueTodayN = active.filter(function (t) { return t.due_date <= T; }).length;
    var doneTodayN = allTasks.filter(function (t) { return TASKM.stateOf(t) === 'done' && t.done_date === T; }).length;
    var unassignedN = active.filter(function (t) { return TASKM.stateOf(t) === 'unassigned'; }).length;
    var memberDedup = uniq(active.map(function (t) { return t.member_id; })).length;

    var html = '<h2>今日优先处理 <span class="muted small">（基准日 ' + T + '）</span></h2>';

    if (!hasData()) {
      html += '<div class="panel quickstart"><h3>还没有任何数据</h3>' +
        '<div>今日优先处理按"会员数据 → 风险计算 → 任务生成 → 教练分配 → 联系会员 → 记录结果 → 安排下次跟进"闭环工作。当前为空，请先建立数据：</div>' +
        '<div style="margin-top:10px">' +
        '<button type="button" class="primary" onclick="location.hash=\'#members\'">去新增教练 / 会员</button> ' +
        '<button type="button" onclick="FXPApp.pTemplates()">查看 CSV 模板</button> ' +
        '<button type="button" onclick="document.getElementById(\'fileInput\').click()">导入数据</button></div></div>';
      return html;
    }

    html += '<div class="cards">' +
      metricCard('高优先级任务', highPriN, highPriN ? 'bad' : '', '#priority', '🔥') +
      metricCard('今日待办', dueTodayN, dueTodayN ? 'warn' : '', '#priority', '📋') +
      metricCard('今日已完成', doneTodayN, 'good', '#priority', '✅') +
      metricCard('逾期任务', overdueN, overdueN ? 'bad' : '', '#priority', '⏰') +
      metricCard('待分配', unassignedN, unassignedN ? 'sys' : '', '#priority', '👤') +
      '</div>';
    html += '<div class="panel"><div class="hint">任务 ' + active.length + ' 条 · 涉及会员（去重）' + memberDedup +
      ' 名 · 需关注会员（中/高风险）' + sum.attentionMembers + ' 名（共 ' + sum.total + ' 名）· ' +
      '排除 ' + sum.excluded + ' 名（暂停/休假/拒绝联系）· 数据不足 ' + sum.insufficient + ' 名' +
      (sum.dataIncomplete ? ' · 数据不完整 ' + sum.dataIncomplete + ' 名' : '') +
      (sum.pauseActive ? ' · 暂停期内 ' + sum.pauseActive + ' 名' : '') + '</div>';

    /* 工具栏：筛选 + 教练视角 + 待复核开关 + 生成 */
    var FILTERS = [
      ['all', '全部任务'], ['highrisk', '高风险会员'], ['soon', '即将逾期'],
      ['mine', '我的任务'], ['unassigned', '待分配任务']
    ];
    html += '<div class="filters">';
    FILTERS.forEach(function (f) {
      html += '<button type="button" class="mini tab' + (flt === f[0] ? ' active' : '') + '" onclick="FXPApp.pFilter(\'' + f[0] + '\')">' + f[1] + '</button>';
    });
    html += '<label class="inline-check"><input type="checkbox" id="pReview"' + (state.priority.reviewEnabled ? ' checked' : '') + ' onchange="FXPApp.pToggleReview(this.checked)"> 启用待复核</label>';
    html += '</div>';

    html += '<div class="filters">' +
      '<span class="muted small">教练视角</span><select id="pCoach">' +
      (activeCoaches.length ? activeCoaches.map(function (c) {
        return '<option value="' + esc(c.coach_id) + '"' + (viewCoach === c.coach_id ? ' selected' : '') + '>' + esc(c.coach_id + ' ' + c.name) + '</option>';
      }).join('') : '<option value="">（无在职教练）</option>') + '</select>' +
      '<button type="button" class="primary" onclick="FXPApp.pGenTasks()">生成 / 刷新今日任务</button>' +
      '<span class="muted small">按截止时间与风险排序；逾期为动态推导，不修改表格数据</span></div>';

    /* 过滤 */
    var rows = allTasks.filter(function (t) {
      var rl = t.risk_level || (riskMap[t.member_id] && riskMap[t.member_id].level);
      if (flt === 'highrisk') return (rl === 'high' || rl === 'medium') && TASKM.isActive(t);
      if (flt === 'soon') return TASKM.isActive(t) && !TASKM.isOverdue(t, T) && t.due_date <= addDays(T, 2);
      if (flt === 'mine') return TASKM.isActive(t) && t.coach_id === viewCoach;
      if (flt === 'unassigned') return TASKM.stateOf(t) === 'unassigned';
      return true; /* all */
    }).sort(function (a, b) {
      var ra = priorityRank(a, riskMap, T), rb = priorityRank(b, riskMap, T);
      if (ra !== rb) return ra - rb;
      if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
      return a.task_id < b.task_id ? -1 : 1;
    });

    if (!rows.length) {
      html += '<div class="panel empty"><div class="big">🎉</div><h3>当前筛选下没有待处理任务</h3>' +
        '<div class="muted">可以切换筛选、放宽条件，或先生成今日任务。</div>' +
        '<div style="margin-top:10px">' +
        '<button type="button" onclick="FXPApp.pFilter(\'all\')">查看全部任务</button> ' +
        '<button type="button" class="primary" onclick="FXPApp.pGenTasks()">生成今日任务</button> ' +
        '<button type="button" onclick="FXPApp.pTemplates()">查看 CSV 模板</button></div></div>';
      return html;
    }

    rows.forEach(function (t) { html += priorityTaskCard(t, T, riskMap, m); });
    html += '</div>';
    html += riskMemberPanel(riskMap, sum);
    return html;
  }

  function addDays(s, n) { return new Date(new Date(s + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10); }

  function priorityTaskCard(t, T, riskMap, m) {
    var mem = m.byId.members[t.member_id];
    var coach = m.byId.coaches[t.coach_id];
    var rl = t.risk_level || (riskMap[t.member_id] && riskMap[t.member_id].level) || '';
    var st = TASKM.stateOf(t);
    var tid = esc(t.task_id);
    var actions = '';
    if (st === 'unassigned') {
      actions = '<button class="mini primary" onclick="FXPApp.pAssign(\'' + tid + '\')">分配教练</button> ' +
        '<button class="mini" onclick="location.hash=\'#member/' + esc(t.member_id) + '\'">查看会员</button>';
    } else if (st === 'pending') {
      actions = '<button class="mini" onclick="FXPApp.pContact(\'' + tid + '\')">记录跟进</button> ' +
        '<button class="mini" onclick="FXPApp.pTrain(\'' + tid + '\')">录训练</button> ' +
        '<button class="mini primary" onclick="FXPApp.pStart(\'' + tid + '\')">开始处理</button> ' +
        '<button class="mini" onclick="FXPApp.pDue(\'' + tid + '\')">调整截止</button> ' +
        '<button class="mini" onclick="FXPApp.pReassign(\'' + tid + '\')">重新分配</button>';
    } else if (st === 'in_progress') {
      actions = '<button class="mini primary" onclick="FXPApp.pContact(\'' + tid + '\')">记录联系结果</button> ' +
        '<button class="mini" onclick="FXPApp.pTrain(\'' + tid + '\')">录训练</button> ' +
        '<button class="mini" onclick="FXPApp.pHold(\'' + tid + '\')">暂缓处理</button>';
    } else if (st === 'review') {
      actions = '<button class="mini primary" onclick="FXPApp.pApprove(\'' + tid + '\')">审核通过</button> ' +
        '<button class="mini danger" onclick="FXPApp.pReject(\'' + tid + '\')">退回补充</button>';
    } else if (st === 'done') {
      actions = '<button class="mini" onclick="FXPApp.pViewRecord(\'' + tid + '\')">查看记录</button> ' +
        '<button class="mini primary" onclick="FXPApp.pFollowUp(\'' + tid + '\')">创建后续任务</button>';
    } else if (st === 'cancelled') {
      actions = '<button class="mini" onclick="FXPApp.pViewCancel(\'' + tid + '\')">查看取消原因</button>';
    }
    if (TASKM.isActive(t)) actions += ' <button class="mini danger" onclick="FXPApp.pCancelTask(\'' + tid + '\')">取消任务</button>';

    var pr = t.priority || 'normal';
    return '<div class="panel ptask' + (TASKM.isOverdue(t, T) ? ' od' : '') + '">' +
      '<div class="ptask-head">' +
      '<div><b>' + (mem ? esc(mem.name) : esc(t.member_id)) + '</b> <span class="muted small">' + esc(t.member_id) + '</span> ' +
      riskLevelBadge(rl) + ' ' + taskStateBadge(t, T) + '</div>' +
      '<div class="ptask-actions">' + actions + '</div></div>' +
      '<div class="ptask-meta">' +
      '<span>任务：' + esc(TASKM.TASK_TYPE_LABEL[TASKM.taskTypeOf(t)] || t.task_type || '其他') + (t.rule_code ? '（' + esc(t.rule_code) + '）' : '') + '</span>' +
      '<span>负责人：' + (coach ? esc(coach.name + '（' + coach.coach_id + '）') : '<span class="err-line">待分配</span>') + '</span>' +
      '<span>截止：' + esc(t.due_date) + (t.due_date < T ? ' <span class="err-line">（已过期）</span>' : (t.due_date === T ? '（今日）' : '')) + '</span>' +
      '<span>优先级：' + (PRIORITY_LABEL[pr] || pr) + '</span>' +
      '</div>' +
      (t.risk_reason ? '<div class="ptask-reason"><b>风险原因：</b>' + esc(t.risk_reason) + '</div>' : '') +
      (t.notes ? '<div class="muted small">备注：' + esc(t.notes) + '</div>' : '') +
      '</div>';
  }

  /* ---- 今日优先：交互处理函数 ---- */
  function pRefresh(msg, type) { updateStatus(); render(); if (msg) toast(msg, type || 'ok'); }
  function pFilter(f) { state.priority.filter = f; render(); }
  function pToggleReview(on) { state.priority.reviewEnabled = !!on; render(); }
  function pGenTasks() {
    if (!state.model) return;
    var gtr = runRulesCore();
    updateStatus(); render();
    toast('今日任务已生成：新建 ' + gtr.totals.created + ' / 合并风险原因 ' + gtr.totals.merged +
      (gtr.totals.unassigned ? ' / 待分配 ' + gtr.totals.unassigned : ''), 'ok');
  }
  function pStart(taskId) {
    var t = state.model.byId.tasks[taskId];
    var actor = t.coach_id || state.priority.coachId || '';
    var res = TASKM.startTask(state.model, t, { today: todayStr(), actor: actor });
    if (!res.ok) { toast(res.message, 'err'); return; }
    queueAdd('tasks', t);
    pRefresh('任务 ' + taskId + ' 已开始处理', 'ok');
  }
  function pDue(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    showModal('调整截止时间：' + t.title,
      '<form onsubmit="return false"><label>新截止日期 <span class="req">*</span></label>' +
      '<input type="date" id="pDueDate" value="' + esc(t.due_date) + '">' +
      '<div class="form-err" id="pDueErr"></div>' +
      '<div class="hint muted">调整截止时间会记录在任务备注中，便于追溯。</div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="primary" onclick="FXPApp.doPDue(\'' + esc(taskId) + '\')">保存</button></div></form>');
  }
  function doPDue(taskId) {
    var t = state.model.byId.tasks[taskId];
    var d = $('#pDueDate').value;
    if (!V.isValidDate(d)) { $('#pDueErr').textContent = '日期格式非法（需 YYYY-MM-DD）'; return; }
    t.notes = ((t.notes ? t.notes + '；' : '') + '截止时间由 ' + t.due_date + ' 调整为 ' + d).slice(0, 200);
    t.due_date = d;
    t.updated_at = todayStr();
    queueAdd('tasks', t);
    closeModal();
    pRefresh('截止时间已调整为 ' + d, 'ok');
  }
  function coachSelectHTML(sel) {
    return state.model.coaches.slice().sort(function (a, b) { return a.coach_id < b.coach_id ? -1 : 1; })
      .map(function (c) {
        return '<option value="' + esc(c.coach_id) + '"' + (sel === c.coach_id ? ' selected' : '') + '>' +
          esc(c.coach_id + ' ' + c.name + (c.active === 'N' ? '（离职）' : '')) + '</option>';
      }).join('');
  }
  function pAssign(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    var load = TASKM.coachLoad(state.model);
    var loadHTML = load.map(function (c) { return c.coach_id + '（在办 ' + c.active_tasks + ' / 逾期 ' + c.overdue + '）'; }).join('、');
    showModal('分配教练：' + t.title,
      '<form onsubmit="return false"><label>选择教练 <span class="req">*</span></label>' +
      '<select id="pCoachSel"><option value="">（选择教练）</option>' + coachSelectHTML('') + '</select>' +
      '<div class="hint muted" style="margin-top:6px">教练负载：' + esc(loadHTML || '无可用教练') + '</div>' +
      '<div class="form-err" id="pAssignErr"></div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="mini" onclick="FXPApp.doPAuto(\'' + esc(taskId) + '\')">按规则自动分配</button> ' +
      '<button type="button" class="primary" onclick="FXPApp.doPAssign(\'' + esc(taskId) + '\')">确认分配</button></div></form>');
  }
  function doPAssign(taskId) {
    var t = state.model.byId.tasks[taskId];
    var cid = $('#pCoachSel').value;
    if (!cid) { $('#pAssignErr').textContent = '请选择教练'; return; }
    var res = TASKM.assign(state.model, t, cid, { today: todayStr(), actor: 'manager', reason: '待分配队列人工分配' });
    if (!res.ok) { $('#pAssignErr').textContent = res.message; return; }
    queueAdd('tasks', t);
    closeModal();
    pRefresh('任务已分配给 ' + cid, 'ok');
  }
  function doPAuto(taskId) {
    var t = state.model.byId.tasks[taskId];
    var res = TASKM.autoAssign(state.model, t, { today: todayStr(), actor: 'system' });
    queueAdd('tasks', t);
    closeModal();
    if (res.unassigned) toast('无可用在职教练，任务仍为待分配', 'err');
    else pRefresh('已按规则自动分配给 ' + t.coach_id, 'ok');
  }
  function pReassign(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    showModal('重新分配：' + t.title,
      '<form onsubmit="return false">' +
      '<div><label>当前负责人</label><input value="' + esc(t.coach_id || '（待分配）') + '" readonly></div>' +
      '<div><label>新负责人 <span class="req">*</span></label><select id="pReCoach">' + coachSelectHTML(t.coach_id) + '</select></div>' +
      '<div class="full"><label>重新分配原因 <span class="req">*</span></label><input type="text" id="pReReason" maxlength="100" placeholder="如：原教练休假"></div>' +
      '<div class="full form-err" id="pReErr"></div>' +
      '<div class="full" style="text-align:right"><button type="button" class="primary" onclick="FXPApp.doPReassign(\'' + esc(taskId) + '\')">确认重新分配</button></div></form>');
  }
  function doPReassign(taskId) {
    var t = state.model.byId.tasks[taskId];
    var cid = $('#pReCoach').value, reason = $('#pReReason').value.trim();
    if (!reason) { $('#pReErr').textContent = '请填写重新分配原因'; return; }
    var res = TASKM.reassign(state.model, t, cid, { today: todayStr(), actor: 'manager', reason: reason });
    if (!res.ok) { $('#pReErr').textContent = res.message; return; }
    queueAdd('tasks', t);
    closeModal();
    pRefresh('已重新分配给 ' + cid + '（原因：' + reason + '）', 'ok');
  }
  function pHold(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    showModal('暂缓处理：' + t.title,
      '<form onsubmit="return false"><label>暂缓原因 <span class="req">*</span></label>' +
      '<input type="text" id="pHoldReason" maxlength="100" placeholder="如：会员出差，约定下周再联系">' +
      '<div class="form-err" id="pHoldErr"></div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="primary" onclick="FXPApp.doPHold(\'' + esc(taskId) + '\')">确认暂缓</button></div></form>');
  }
  function doPHold(taskId) {
    var t = state.model.byId.tasks[taskId];
    var reason = $('#pHoldReason').value.trim();
    var res = TASKM.holdTask(state.model, t, reason, { today: todayStr() });
    if (!res.ok) { $('#pHoldErr').textContent = res.message; return; }
    queueAdd('tasks', t);
    closeModal();
    pRefresh('任务已暂缓（回到待处理）', 'ok');
  }
  function pContact(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    var mem = state.model.byId.members[t.member_id];
    state.quick.followupTaskId = taskId;
    showModal('记录联系结果：' + (mem ? mem.name : t.member_id),
      '<div class="hint">任务 ' + esc(taskId) + '：' + esc(t.title || '') +
      (t.risk_reason ? '<br>风险原因：' + esc(t.risk_reason) : '') +
      '<br><span class="muted">保存后自动更新该任务状态；有后续动作会自动创建下次跟进任务。</span></div>' +
      followupFormHTML('mf', {
        member_id: t.member_id, coach_id: t.coach_id || (mem && mem.coach_id) || '',
        task_id: taskId, next_followup_date: addDays(todayStr(), 3)
      }));
    onFollowupMember('mf');
  }
  function pTrain(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    var mem = state.model.byId.members[t.member_id];
    state.quick.sessionTaskId = taskId;
    showModal('记录训练：' + (mem ? mem.name : t.member_id),
      '<div class="hint">任务 ' + esc(taskId) + '：' + esc(t.title || '') +
      '<br><span class="muted">保存训练记录后自动关联并完成该任务。</span></div>' +
      sessionFormHTML('ms', { member_id: t.member_id, coach_id: t.coach_id || (mem && mem.coach_id) || '' }));
    onSessionMember('ms');
  }
  function pApprove(taskId) {
    var t = state.model.byId.tasks[taskId];
    var res = TASKM.approveReview(state.model, t, { today: todayStr() });
    if (!res.ok) { toast(res.message, 'err'); return; }
    queueAdd('tasks', t);
    pRefresh('审核通过，任务已完成', 'ok');
  }
  function pReject(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    showModal('退回补充：' + t.title,
      '<form onsubmit="return false"><label>退回原因 <span class="req">*</span></label>' +
      '<input type="text" id="pRjReason" maxlength="100" placeholder="如：缺少下次跟进安排">' +
      '<div class="form-err" id="pRjErr"></div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="primary" onclick="FXPApp.doPReject(\'' + esc(taskId) + '\')">确认退回</button></div></form>');
  }
  function doPReject(taskId) {
    var t = state.model.byId.tasks[taskId];
    var reason = $('#pRjReason').value.trim();
    var res = TASKM.rejectReview(state.model, t, reason, { today: todayStr() });
    if (!res.ok) { $('#pRjErr').textContent = res.message; return; }
    queueAdd('tasks', t);
    closeModal();
    pRefresh('已退回补充（回到处理中）', 'ok');
  }
  function pViewRecord(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    var fus = state.model.followups.filter(function (f) { return f.task_id === taskId; });
    var html = '<div><b>任务：</b>' + esc(t.title) + '（' + esc(t.task_id) + '）</div>' +
      '<div><b>状态：</b>' + TASKM.STATE_LABEL[TASKM.stateOf(t)] + '　<b>执行结果：</b>' + fmt(t.result_code) + '</div>' +
      '<div><b>完成时间：</b>' + esc(t.done_date || '—') + '　<b>完成人：</b>' + fmt(t.completed_by) + '　<b>下次跟进：</b>' + fmt(t.next_followup_at) + '</div>' +
      '<h3>关联跟进记录（' + fus.length + '）</h3>';
    if (!fus.length) html += '<div class="muted">无（该任务完成时未记录联系结果）</div>';
    else html += '<table><thead><tr><th>记录ID</th><th>日期</th><th>方式</th><th>结果</th><th>会员反馈</th><th>下一步</th></tr></thead><tbody>' +
      fus.map(function (f) {
        return '<tr><td>' + esc(f.followup_id) + '</td><td>' + esc(f.date) + '</td><td>' + (CHANNEL_LABEL[f.channel] || esc(f.channel)) +
          '</td><td>' + (RESULT_LABEL[f.result] || esc(f.result)) + '</td><td>' + fmt(f.member_feedback || f.content) +
          '</td><td>' + (NEXT_ACTION_LABEL[f.next_action] || '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
    showModal('任务记录', html);
  }
  function pFollowUp(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    showModal('创建后续任务：' + t.title,
      '<form onsubmit="return false"><label>后续任务截止日 <span class="req">*</span></label>' +
      '<input type="date" id="pFuDate" value="' + addDays(todayStr(), 3) + '">' +
      '<div class="form-err" id="pFuErr"></div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="primary" onclick="FXPApp.doPFollowUp(\'' + esc(taskId) + '\')">创建</button></div></form>');
  }
  function doPFollowUp(taskId) {
    var t = state.model.byId.tasks[taskId];
    var d = $('#pFuDate').value;
    if (!V.isValidDate(d)) { $('#pFuErr').textContent = '日期格式非法'; return; }
    var res = TASKM.createFollowUpTask(state.model, t, { today: todayStr(), due_date: d, actor: 'manager' });
    if (!res.ok) { $('#pFuErr').textContent = res.message; return; }
    queueAdd('tasks', res.task);
    closeModal();
    runRulesSilent();
    toast(res.created ? ('已创建后续任务 ' + res.task.task_id) : '已存在未完成的后续任务，未重复创建', res.created ? 'ok' : 'err');
  }
  function pViewCancel(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    showModal('取消原因', '<div><b>任务：</b>' + esc(t.title) + '（' + esc(t.task_id) + '）</div>' +
      '<div><b>取消原因：</b>' + (CANCEL_LABEL[t.cancel_reason] || fmt(t.cancel_reason)) + '（' + esc(t.cancel_reason || '') + '）</div>' +
      '<div><b>取消日期：</b>' + esc(t.cancelled_date || '—') + '</div>' +
      '<div><b>备注：</b>' + fmt(t.notes) + '</div>' +
      ((t._history && t._history.length) ? '<h3>历史轨迹</h3><div class="muted small">' + t._history.map(function (h) { return esc(h.at + ' ' + h.action + ' ' + h.detail); }).join('<br>') + '</div>' : ''));
  }
  function pCancelTask(taskId) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return;
    var options = Object.keys(CANCEL_LABEL).map(function (k) { return '<option value="' + k + '">' + CANCEL_LABEL[k] + '</option>'; }).join('');
    showModal('取消任务：' + t.title,
      '<form onsubmit="return false"><label>取消原因 <span class="req">*</span></label><select id="pcCancelReason">' + options + '</select>' +
      '<div id="pcNotesWrap" style="margin-top:8px;display:none"><label>原因说明 <span class="req">*</span>（选择"其他"时必填）</label>' +
      '<textarea id="pcCancelNotes" rows="2" style="width:100%"></textarea></div>' +
      '<div class="form-err" id="pcCancelErr"></div>' +
      '<div class="hint muted">取消不物理删除，保留完整历史与原因，可随时查看。</div>' +
      '<div style="text-align:right;margin-top:10px"><button type="button" class="danger" onclick="FXPApp.doPCancelTask(\'' + esc(taskId) + '\')">确认取消</button></div></form>');
    $('#pcCancelReason').addEventListener('change', function () {
      $('#pcNotesWrap').style.display = this.value === 'other' ? '' : 'none';
    });
  }
  function doPCancelTask(taskId) {
    var t = state.model.byId.tasks[taskId];
    var reason = $('#pcCancelReason').value;
    var notes = $('#pcCancelNotes') ? $('#pcCancelNotes').value.trim() : '';
    if (reason === 'other' && !notes) { $('#pcCancelErr').textContent = '选择"其他"时必须填写原因说明'; return; }
    var res = TASKM.transition(state.model, t, 'cancelled', { today: todayStr(), date: todayStr(), reason: reason, notes: notes });
    if (!res.ok) { $('#pcCancelErr').textContent = res.message; return; }
    queueAdd('tasks', t);
    closeModal();
    pRefresh('任务已取消（' + CANCEL_LABEL[reason] + '），可随时查看取消原因与历史', 'ok');
  }
  function pTemplates() {
    var list = ['coaches.csv（教练表）', 'members.csv（会员表）', 'sessions.csv（训练记录）', 'followups.csv（跟进记录）', 'tasks.csv（待办任务）', 'xp_events.csv（积分，延后启用）'];
    showModal('CSV 模板',
      '<div class="hint">模板位于项目 <code>data/templates/</code>；列顺序无关，按<b>表头名</b>匹配。今日优先处理模块新增列均为<b>可选</b>，旧格式文件可直接导入。</div>' +
      '<ul>' + list.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<div class="hint muted">也可在页面直接手工录入教练 / 会员 / 训练 / 跟进，无需 CSV。</div>');
  }
  function bindPriority() {
    var sel = document.getElementById('pCoach');
    if (sel) sel.addEventListener('change', function () { state.priority.coachId = sel.value; render(); });
  }

  /* ================= 视图：训练与跟进记录 ================= */
  /* ================= V1.1 快捷表单通用组件 ================= */

  /** 快捷标签块（单选/多选），背后是一个 hidden input；点击由 chipPick 处理 */
  function chipsHTML(id, options, selected, multi) {
    var sel = multi ? String(selected || '').split(',').filter(Boolean) : [selected || ''];
    return '<div class="chips' + (multi ? ' multi' : '') + '" data-target="' + esc(id) + '">' +
      options.map(function (o) {
        return '<button type="button" class="chip' + (sel.indexOf(o[0]) >= 0 ? ' active' : '') + '" data-val="' + esc(o[0]) + '" onclick="FXPApp.chipPick(this)">' + esc(o[1]) + '</button>';
      }).join('') + '</div><input type="hidden" id="' + esc(id) + '" value="' + esc(selected || '') + '">';
  }
  function objOptions(map) { return Object.keys(map).map(function (k) { return [k, map[k]]; }); }

  /* ---- 动作行（可选精简模式：名称/重量/组数/次数/备注） ---- */
  function exRowHTML(v) {
    v = v || ['', '', '', '', ''];
    return '<div class="ex-row">' +
      '<input class="ex-name" type="text" placeholder="动作名称" maxlength="20" value="' + esc(v[0]) + '">' +
      '<input class="ex-w" type="text" inputmode="decimal" placeholder="重量" maxlength="8" value="' + esc(v[1]) + '">' +
      '<input class="ex-s" type="text" inputmode="numeric" placeholder="组" maxlength="4" value="' + esc(v[2]) + '">' +
      '<input class="ex-r" type="text" inputmode="numeric" placeholder="次" maxlength="6" value="' + esc(v[3]) + '">' +
      '<input class="ex-note" type="text" placeholder="备注" maxlength="20" value="' + esc(v[4]) + '">' +
      '<button type="button" class="ex-del" title="删除本行" onclick="FXPApp.removeExRow(this)">×</button></div>';
  }
  function exRowsHTML(list, open) {
    list = list || [];
    if (!list.length) list = [['', '', '', '', '']];
    return '<div class="ex-box"' + (open ? '' : ' hidden') + ' id="__EXBOX_tmp__">' + // id 由调用方包装
      list.map(exRowHTML).join('') + '</div>';
  }
  function parseExercises(str) {
    if (!str) return [];
    return String(str).split(';').map(function (seg) {
      if (!seg) return null;
      var f = seg.split('|');
      return [f[0] || '', f[1] || '', f[2] || '', f[3] || '', f[4] || ''];
    }).filter(function (r) { return r && (r[0] || r[1] || r[2] || r[3] || r[4]); });
  }
  function serializeExercises(prefix) {
    var box = document.getElementById(prefix + 'ExRows');
    if (!box) return '';
    var out = [];
    Array.prototype.forEach.call(box.querySelectorAll('.ex-row'), function (row) {
      var v = EX_FIELDS.map(function (f) { return (row.querySelector('.ex-' + f) || {}).value || ''; });
      if (v[0] || v[1] || v[2] || v[3] || v[4]) out.push(v.join('|'));
    });
    return out.join(';');
  }
  function addExRow(prefix) {
    var box = document.getElementById(prefix + 'ExRows');
    if (!box) return;
    box.insertAdjacentHTML('beforeend', exRowHTML());
  }
  function removeExRow(btn) {
    var row = btn.parentNode;
    var box = row.parentNode;
    row.parentNode.removeChild(row);
    if (!box.querySelector('.ex-row')) box.insertAdjacentHTML('beforeend', exRowHTML());
  }
  function toggleEx(prefix, open) {
    var box = document.getElementById(prefix + 'ExBox');
    if (box) box.hidden = !open;
    if (open) {
      var rows = document.getElementById(prefix + 'ExRows');
      if (rows && !rows.querySelector('.ex-row')) rows.insertAdjacentHTML('beforeend', exRowHTML());
      var lbl = document.getElementById(prefix + 'ExToggle');
      if (lbl) lbl.textContent = '收起动作记录';
    }
  }

  /** 动作记录折叠块 */
  function exBlockHTML(prefix, list) {
    list = list || [];
    return '<div class="full"><button type="button" class="mini" id="' + prefix + 'ExToggle" onclick="FXPApp.toggleEx(\'' + prefix + '\', true)">+ 记录关键动作（可选）</button>' +
      '<div class="ex-box" id="' + prefix + 'ExBox" hidden>' +
      '<div id="' + prefix + 'ExRows">' + (list.length ? list.map(exRowHTML).join('') : exRowHTML()) + '</div>' +
      '<div class="row-gap"><button type="button" class="mini" onclick="FXPApp.addExRow(\'' + prefix + '\')">添加动作</button>' +
      '<span class="muted small">重量/组数/次数可留空；不适用的字段可跳过</span></div></div></div>';
  }

  /* ================= V1.1 快捷训练记录表单 ================= */
  function sessionFormHTML(prefix, pre) {
    prefix = prefix || 's';
    pre = pre || {};
    var T = todayStr();
    var html = '<form id="' + prefix + 'FormSession" onsubmit="return false">';

    /* ① 会员（先选人）+ 最近训练信息 */
    html += '<div class="full"><label>会员 <span class="req">*</span></label>' +
      '<select id="' + prefix + 'Member" onchange="FXPApp.onSessionMember(\'' + prefix + '\')">' + memberOptions(pre.member_id) + '</select>' +
      '<div class="qtip muted small" id="' + prefix + 'LastInfo"></div></div>';

    /* ② 教练（自动带出主教练）+ 日期 */
    html += '<div><label>带练教练 <span class="req">*</span></label><select id="' + prefix + 'Coach">' + coachOptions(pre.coach_id) + '</select></div>' +
      '<div><label>训练日期 <span class="req">*</span></label><input type="date" id="' + prefix + 'Date" value="' + esc(pre.date || T) + '" max="' + T + '"></div>';

    /* ③ 一键：训练模板 / 复制上次（仅填入待确认，不等于本次结果） */
    html += '<div class="full quick-row"><label>快速填充（可修改）</label><div class="row-gap">' +
      '<select id="' + prefix + 'Tpl" onchange="FXPApp.applyTemplate(\'' + prefix + '\')"><option value="">选择训练模板</option>' +
      SESSION_TEMPLATES.map(function (t) { return '<option value="' + t.code + '">' + esc(t.name) + '</option>'; }).join('') + '</select>' +
      '<button type="button" class="mini" onclick="FXPApp.copyLastSession(\'' + prefix + '\')">复制上次训练</button></div>' +
      '<div class="muted small" id="' + prefix + 'CopyHint"></div></div>';

    /* ④ 三个单选快捷组 */
    html += '<div class="full"><label>训练类型</label>' + chipsHTML(prefix + 'Type', objOptions(SESSION_TYPE_LABEL), pre.session_type || '') + '</div>';
    html += '<div class="full"><label>完成情况</label>' + chipsHTML(prefix + 'Completion', objOptions(COMPLETION_LABEL), pre.completion || '') + '</div>';
    html += '<div class="full"><label>会员感受</label>' + chipsHTML(prefix + 'Feeling', objOptions(FEELING_LABEL), pre.feeling || '') +
      '<div class="alert-pain" id="' + prefix + 'PainTip" hidden>⚠️ 会员反馈疼痛或不适：请教练人工关注并评估训练内容，<b>系统不做医疗诊断</b>。</div></div>';

    /* ⑤ 下次训练重点（多选标签 + 文字补充） */
    html += '<div class="full"><label>下次训练重点</label>' + chipsHTML(prefix + 'Focus', FOCUS_TAGS.map(function (t) { return [t, t]; }), pre.focus_tags || '', true) +
      '<input type="text" id="' + prefix + 'FocusText" maxlength="60" placeholder="补充说明（可选）" value="' + esc(pre.focus_text || '') + '"></div>';

    /* ⑥ 可选补充：训练内容 / 时长 */
    html += '<div><label>时长（分钟，可留空）</label><input type="number" id="' + prefix + 'Duration" min="15" max="300" placeholder="60" value="' + esc(pre.duration_min || '') + '"></div>' +
      '<div><label>训练内容（可留空，自动按类型生成）</label><input type="text" id="' + prefix + 'Content" maxlength="120" placeholder="如：胸背力量训练" value="' + esc(pre.content || '') + '"></div>';

    /* ⑦ 动作记录（可选，默认折叠） */
    html += exBlockHTML(prefix, parseExercises(pre.exercises));

    html += '<div class="full form-err" id="' + prefix + 'Err"></div>' +
      '<div class="full"><button type="button" class="primary big" onclick="FXPApp.submitQuickSession(\'' + prefix + '\')">保存训练记录</button>' +
      '<span class="muted small" id="' + prefix + 'SaveHint"></span></div>' +
      '<div class="full" id="' + prefix + 'After"></div></form>';
    return html;
  }

  /* ================= V1.1 快捷跟进表单 ================= */
  function followupFormHTML(prefix, pre) {
    prefix = prefix || 'f';
    pre = pre || {};
    var T = todayStr();
    var html = '<form id="' + prefix + 'FormFollowup" onsubmit="return false">';
    html += '<div class="full"><label>会员 <span class="req">*</span></label>' +
      '<select id="' + prefix + 'Member" onchange="FXPApp.onFollowupMember(\'' + prefix + '\')">' + memberOptions(pre.member_id) + '</select>' +
      '<div class="qtip muted small" id="' + prefix + 'LastInfo"></div></div>';
    html += '<div><label>执行教练 <span class="req">*</span></label><select id="' + prefix + 'Coach">' + coachOptions(pre.coach_id) + '</select></div>' +
      '<div><label>跟进日期 <span class="req">*</span></label><input type="date" id="' + prefix + 'Date" value="' + esc(pre.date || T) + '" max="' + T + '"></div>';

    html += '<div class="full"><label>联系方式</label>' + chipsHTML(prefix + 'Channel', CHANNEL_OPTS, pre.channel || 'wechat') + '</div>';
    html += '<div class="full"><label>联系结果 <span class="req">*</span></label>' +
      chipsHTML(prefix + 'Outcome', objOptions(OUTCOME_LABEL), pre.outcome || '') +
      '<div class="muted small">以上仅为记录分类，<b>选择"确认恢复"不等于会员已恢复训练</b>，风险仍按后续训练行为重算。</div></div>';

    html += '<div class="full"><label>会员反馈（可选）</label><input type="text" id="' + prefix + 'Feedback" maxlength="120" placeholder="如：最近加班多，周六争取到店" value="' + esc(pre.member_feedback || '') + '"></div>';
    html += '<div class="full"><label>下一步动作</label>' + chipsHTML(prefix + 'NextAction', objOptions(NEXT_ACTION_LABEL), pre.next_action || '') + '</div>';
    html += '<div class="full" id="' + prefix + 'NextFollowBox" hidden><label>下次跟进时间 <span class="req">*</span></label><input type="date" id="' + prefix + 'NextFollow" value="' + esc(pre.next_followup_date || '') + '"></div>';
    html += '<div class="full"><label>备注（可选）</label><input type="text" id="' + prefix + 'Content" maxlength="120" placeholder="内容摘要" value="' + esc(pre.content || '') + '"></div>';
    html += '<input type="hidden" id="' + prefix + 'Task" value="' + esc(pre.task_id || '') + '">' +
      '<div class="full" id="' + prefix + 'TaskInfo"></div>';
    html += '<div class="full form-err" id="' + prefix + 'Err"></div>' +
      '<div class="full"><button type="button" class="primary big" onclick="FXPApp.submitQuickFollowup(\'' + prefix + '\')">保存跟进记录</button>' +
      '<span class="muted small" id="' + prefix + 'SaveHint"></span></div>' +
      '<div class="full" id="' + prefix + 'After"></div></form>';
    return html;
  }

  function memberOptions(sel) {
    var list = state.model.members.slice()
      .sort(function (a, b) { return a.member_id < b.member_id ? -1 : 1; });
    if (!list.length) return '<option value="">（暂无会员，请先到「会员列表」新增）</option>';
    return list.map(function (mem) {
      return '<option value="' + esc(mem.member_id) + '"' + (sel === mem.member_id ? ' selected' : '') + '>' +
        esc(mem.member_id + ' ' + mem.name) + '</option>';
    }).join('');
  }
  function coachOptions(sel) {
    var list = state.model.coaches.slice()
      .sort(function (a, b) { return a.coach_id < b.coach_id ? -1 : 1; });
    if (!list.length) return '<option value="">（暂无教练，请先到「会员列表」新增）</option>';
    return list.map(function (c) {
      return '<option value="' + esc(c.coach_id) + '"' + (sel === c.coach_id ? ' selected' : '') + '>' +
        esc(c.coach_id + ' ' + c.name + (c.active === 'N' ? '（离职）' : '')) + '</option>';
    }).join('');
  }
  function viewRecords() {
    var html = '<h2>训练与跟进 <span class="muted small">快捷录入（先选会员 → 点标签 → 保存）</span></h2>';
    html += '<div class="panel"><h3>快速训练记录 <span class="muted small">目标 30–60 秒</span></h3>' + sessionFormHTML('s', {}) + '</div>';
    html += '<div class="panel"><h3>快速跟进记录 <span class="muted small">目标约 30 秒</span></h3>' + followupFormHTML('f', {}) + '</div>';
    html += '<div class="panel" id="qPreview"></div>';
    return html;
  }

  /** 本会话新增记录预览（保存后原地刷新，不触发整页重渲染，避免丢失表单上下文） */
  function refreshQueuePreview() {
    var box = document.getElementById('qPreview');
    if (!box) return;
    var qs = state.queue.sessions, qf = state.queue.followups;
    var html = '<h3>本会话新增记录（待导出）</h3>' +
      '<div class="hint">训练 ' + qs.length + ' 条 · 跟进 ' + qf.length + ' 条。保存后规则已自动执行，相关任务变化可在「经营概览」摘要中追溯。</div>';
    if (qs.length || qf.length) {
      html += '<div class="tbl-wrap"><table><thead><tr><th>类型</th><th>记录ID</th><th>会员</th><th>日期</th><th>摘要</th></tr></thead><tbody>';
      qs.forEach(function (s) {
        var extra = [SESSION_TYPE_LABEL[s.session_type] || '', COMPLETION_LABEL[s.completion] || '', FEELING_LABEL[s.feeling] || ''].filter(Boolean).join('·');
        html += '<tr><td><span class="badge man">训练</span></td><td>' + esc(s.session_id) + '</td><td>' + esc(s.member_id) + '</td><td>' + esc(s.date) + '</td><td>' + esc(s.content) + (extra ? ' <span class="muted small">(' + esc(extra) + ')</span>' : '') + '</td></tr>';
      });
      qf.forEach(function (f) {
        html += '<tr><td><span class="badge done">跟进</span></td><td>' + esc(f.followup_id) + '</td><td>' + esc(f.member_id) + '</td><td>' + esc(f.date) + '</td><td>' + (CHANNEL_LABEL[f.channel] || '') + ' · ' + (OUTCOME_LABEL[f.outcome] || RESULT_LABEL[f.result] || '') + ' ' + esc(f.content) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    box.innerHTML = html;
  }

  /* ---- V1.1 快捷记录：交互（标签 / 动作行 / 模板 / 复制上次 / 保存后入口） ---- */
  function chipPick(btn) {
    var group = btn.parentNode;
    var id = group.getAttribute('data-target');
    var multi = group.classList.contains('multi');
    var hidden = document.getElementById(id);
    if (!hidden) return;
    if (multi) {
      btn.classList.toggle('active');
      hidden.value = Array.prototype.filter.call(group.querySelectorAll('.chip.active'), function (c) { return true; })
        .map(function (c) { return c.getAttribute('data-val'); }).join(',');
    } else {
      Array.prototype.forEach.call(group.querySelectorAll('.chip'), function (c) { c.classList.remove('active'); });
      btn.classList.add('active');
      hidden.value = btn.getAttribute('data-val');
    }
    onChipChange(id, hidden.value);
  }
  function onChipChange(id, val) {
    if (/Feeling$/.test(id)) {
      var tip = document.getElementById(id.replace(/Feeling$/, 'PainTip'));
      if (tip) tip.hidden = String(val).split(',').indexOf('pain') < 0;
    }
    if (/NextAction$/.test(id)) {
      var box = document.getElementById(id.replace(/NextAction$/, 'NextFollowBox'));
      if (box) box.hidden = (!val || val === 'none');
    }
  }
  function setChip(id, val) {
    var hidden = document.getElementById(id);
    if (!hidden) return;
    var group = hidden.previousElementSibling;
    if (group && group.classList && group.classList.contains('chips')) {
      Array.prototype.forEach.call(group.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('active', c.getAttribute('data-val') === val);
      });
    }
    hidden.value = val || '';
    onChipChange(id, hidden.value);
  }
  function autoCoach(prefix, memberId) {
    var mem = state.model.byId.members[memberId];
    var sel = document.getElementById(prefix + 'Coach');
    if (mem && sel && mem.coach_id && state.model.byId.coaches[mem.coach_id]) sel.value = mem.coach_id;
  }
  function lastSessionOf(memberId) {
    return state.model.sessions.filter(function (s) { return s.member_id === memberId; })
      .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.session_id < b.session_id ? 1 : -1)); })[0];
  }
  function onSessionMember(prefix) {
    prefix = prefix || 's';
    var el = document.getElementById(prefix + 'Member');
    var mid = el ? el.value : '';
    autoCoach(prefix, mid);
    var info = document.getElementById(prefix + 'LastInfo');
    if (!info) return;
    if (!mid) { info.textContent = ''; return; }
    var s = lastSessionOf(mid);
    if (!s) { info.textContent = '该会员暂无历史训练（首次记录，可直接选类型保存）'; return; }
    var gap = Math.round((new Date(todayStr()) - new Date(s.date)) / 86400000);
    info.textContent = '最近训练：' + s.date + '（' + gap + ' 天前）' + (s.next_focus ? ' · 上次约定重点：' + s.next_focus : (s.content ? ' · ' + s.content : ''));
  }
  function onFollowupMember(prefix) {
    prefix = prefix || 'f';
    var el = document.getElementById(prefix + 'Member');
    var mid = el ? el.value : '';
    autoCoach(prefix, mid);
    var info = document.getElementById(prefix + 'LastInfo');
    var taskBox = document.getElementById(prefix + 'TaskInfo');
    if (!info) return;
    if (!mid) { info.textContent = ''; if (taskBox) taskBox.innerHTML = ''; return; }
    var todo = state.model.tasks.filter(function (t) { return t.member_id === mid && t.status === 'open'; });
    var fs = state.model.followups.filter(function (f) { return f.member_id === mid; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    info.textContent = (fs.length ? '上次跟进：' + fs[0].date + ' · ' + (OUTCOME_LABEL[fs[0].outcome] || RESULT_LABEL[fs[0].result] || '') : '暂无跟进历史') +
      (todo.length ? ' ｜ 该会员有 ' + todo.length + ' 条未完成任务' : '');
    if (taskBox) {
      var cur = (document.getElementById(prefix + 'Task') || {}).value || '';
      if (cur) {
        var t = state.model.byId.tasks[cur];
        taskBox.innerHTML = '<div class="qtip">本次跟进将关联任务 <b>' + esc(cur) + '</b>' + (t ? '（' + esc(t.title || '') + '）' : '') + '，保存后自动更新任务状态。</div>';
      } else if (todo.length) {
        taskBox.innerHTML = '<label>关联未完成任务（可选）</label><select id="' + prefix + 'TaskPick" onchange="document.getElementById(\'' + prefix + 'Task\').value=this.value">' +
          '<option value="">不关联</option>' + todo.map(function (t) { return '<option value="' + esc(t.task_id) + '">' + esc(t.task_id + ' ' + (t.title || '')) + '</option>'; }).join('') + '</select>';
      } else {
        taskBox.innerHTML = '';
      }
    }
  }
  function applyTemplate(prefix) {
    var sel = document.getElementById(prefix + 'Tpl');
    var hint = document.getElementById(prefix + 'CopyHint');
    if (!sel || !sel.value) return;
    var t = SESSION_TEMPLATES.filter(function (x) { return x.code === sel.value; })[0];
    if (!t) return;
    setChip(prefix + 'Type', t.type);
    var rows = document.getElementById(prefix + 'ExRows');
    if (rows) rows.innerHTML = t.ex.map(exRowHTML).join('');
    toggleEx(prefix, true);
    if (hint) hint.textContent = '已套用模板「' + t.name + '」，请按实际情况修改后再保存（模板仅是草稿，非本次实际训练结果）';
  }
  function copyLastSession(prefix) {
    var hint = document.getElementById(prefix + 'CopyHint');
    var mid = (document.getElementById(prefix + 'Member') || {}).value;
    if (!mid) { if (hint) hint.textContent = '请先选择会员'; return; }
    var s = lastSessionOf(mid);
    if (!s) { if (hint) hint.textContent = '该会员暂无历史训练，无法复制'; return; }
    if (s.session_type) setChip(prefix + 'Type', s.session_type);
    var ft = document.getElementById(prefix + 'FocusText');
    if (ft) ft.value = s.next_focus || s.next_plan || '';
    var contentEl = document.getElementById(prefix + 'Content');
    if (contentEl && !contentEl.value) contentEl.value = s.content || '';
    var ex = parseExercises(s.exercises);
    if (ex.length) {
      var rows = document.getElementById(prefix + 'ExRows');
      if (rows) rows.innerHTML = ex.map(exRowHTML).join('');
      toggleEx(prefix, true);
    }
    if (hint) hint.textContent = '已复制 ' + s.date + ' 的记录作为草稿，请确认修改后再保存（不会自动当作本次结果）';
  }
  function feelingToRating(feeling) {
    if (feeling === 'good') return 'good';
    if (feeling === 'fatigue' || feeling === 'pain') return 'poor';
    if (feeling === 'normal') return 'normal';
    return '';
  }
  function showAfterSave(prefix, kind, memberId, recId) {
    var el = document.getElementById(prefix + 'After');
    if (!el) return;
    el.innerHTML = '<div class="after-save"><b>✓ 已保存</b> <span class="muted small">' + esc(recId) + '</span>' +
      '<div class="row-gap" style="margin-top:6px">' +
      '<button type="button" class="mini" onclick="location.hash=\'#member/' + esc(memberId) + '\'">查看会员</button>' +
      '<button type="button" class="mini primary" onclick="FXPApp.continueRecord(\'' + prefix + '\')">继续记录一条</button>' +
      '<button type="button" class="mini" onclick="FXPApp.endRecord(\'' + prefix + '\')">结束</button></div></div>';
  }
  function clearFields(prefix, keys) {
    keys.forEach(function (k) {
      var el = document.getElementById(prefix + k);
      if (!el) return;
      if (el.classList && el.classList.contains('chips')) return;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT') el.value = (el.type === 'hidden' ? '' : '');
    });
    /* 清理 chips 选中态 */
    Array.prototype.forEach.call(document.querySelectorAll('[data-target^="' + prefix + '"]'), function (g) {
      Array.prototype.forEach.call(g.querySelectorAll('.chip'), function (c) { c.classList.remove('active'); });
    });
    /* 清理动作行 */
    var rows = document.getElementById(prefix + 'ExRows');
    if (rows) rows.innerHTML = exRowHTML();
    var box = document.getElementById(prefix + 'ExBox');
    if (box) box.hidden = true;
    var tips = ['PainTip', 'NextFollowBox', 'Err', 'After', 'CopyHint'];
    tips.forEach(function (t) { var el = document.getElementById(prefix + t); if (el) { if (el.tagName === 'DIV' && t !== 'After') { if (t === 'NextFollowBox') el.hidden = true; else if (t === 'PainTip') el.hidden = true; else el.textContent = ''; } } });
  }
  function continueRecord(prefix) {
    var kind = prefix === 'f' || prefix === 'mf' ? 'followup' : 'session';
    var keys = kind === 'session'
      ? ['Type', 'Completion', 'Feeling', 'Focus', 'FocusText', 'Content', 'Duration', 'Tpl']
      : ['Channel', 'Outcome', 'Feedback', 'NextAction', 'NextFollow', 'Content', 'Task'];
    clearFields(prefix, keys);
    var el = document.getElementById(prefix + 'Member') || document.getElementById(prefix + 'FormSession') || document.getElementById(prefix + 'FormFollowup');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    toast('已清空，可继续录入下一条（会员保持已选）', 'ok');
  }
  function endRecord(prefix) {
    clearFields(prefix, ['Type', 'Completion', 'Feeling', 'Focus', 'FocusText', 'Content', 'Duration', 'Tpl',
      'Channel', 'Outcome', 'Feedback', 'NextAction', 'NextFollow', 'Task']);
    toast('已结束本次录入', 'ok');
  }

  /** 智能完成任务：自动补齐 unassigned→pending→in_progress 前置步骤（不绕过状态机的合法路径）
   *  注意：状态机 transition/completeTask 读取的是 opts.date（完成日期），此处统一入口。 */
  function completeTaskSmart(taskId, opts) {
    var t = state.model.byId.tasks[taskId];
    if (!t) return { ok: false, error: 'task_not_found', message: '任务不存在：' + taskId };
    var date = opts.date || todayStr();
    var st = TASKM.stateOf(t);
    if (st === 'unassigned') {
      if (!opts.actor) return { ok: false, error: 'need_coach', message: '任务未分配，无法完成（请先分配教练）' };
      var as = TASKM.assign(state.model, t, opts.actor, { today: date, actor: opts.actor, reason: '记录时自动接管' });
      if (!as.ok) return as;
    }
    st = TASKM.stateOf(t);
    if (st === 'pending') {
      var tr = TASKM.transition(state.model, t, 'in_progress', { today: date, actor: opts.actor });
      if (!tr.ok) return tr;
    }
    return TASKM.completeTask(state.model, t, {
      today: opts.today || date, date: date, actor: opts.actor,
      result_code: opts.result_code, next_action: opts.next_action || 'none',
      next_followup_at: opts.next_followup_at || '', reviewEnabled: opts.reviewEnabled
    });
  }

  /* ---- 保存：训练记录 ---- */
  function submitQuickSession(prefix, opts) {
    prefix = prefix || 's';
    opts = opts || {};
    var errEl = document.getElementById(prefix + 'Err');
    var g = function (k) { var e = document.getElementById(prefix + k); return e ? e.value : ''; };
    var memberId = g('Member'), coachId = g('Coach'), date = g('Date');
    /* 前置校验：失败不重渲染，保留已填内容 */
    var msg = !memberId ? '请选择会员' : (!coachId ? '请选择带练教练' : (!date ? '请选择训练日期' : ''));
    if (msg) { if (errEl) errEl.textContent = msg; return; }
    if (errEl) errEl.textContent = '';
    var type = g('Type'), completion = g('Completion'), feeling = g('Feeling');
    var focusTags = g('Focus'), focusText = (g('FocusText') || '').trim();
    var focus = [focusTags ? focusTags.split(',').join('、') : '', focusText].filter(Boolean).join('；');
    var content = (g('Content') || '').trim() ||
      ([SESSION_TYPE_LABEL[type] || '', focus].filter(Boolean).join(' · ') || '训练记录');
    var res = E.addSession(state.model, {
      member_id: memberId, coach_id: coachId, date: date, duration_min: g('Duration'),
      content: content, rating: feelingToRating(feeling), next_plan: focus,
      session_type: type, completion: completion, feeling: feeling,
      next_focus: focus, exercises: serializeExercises(prefix)
    });
    if (!res.ok) { if (errEl) errEl.textContent = '保存失败：' + res.message + '（已填写内容已保留，请修改后重试）'; return; }
    queueAdd('sessions', res.session);
    runRulesCore(); updateStatus();
    /* 从任务进入 → 自动关联并完成任务 */
    var taskId = opts.taskId || state.quick.sessionTaskId || '';
    var taskMsg = '';
    if (taskId && state.model.byId.tasks[taskId]) {
      var cr = completeTaskSmart(taskId, {
        date: date, result_code: 'reached', actor: coachId,
        next_action: 'none', reviewEnabled: state.priority.reviewEnabled, today: todayStr()
      });
      if (cr.ok) { queueAdd('tasks', cr.task); taskMsg = '，已关联并完成 ' + taskId; }
      else { taskMsg = '（任务 ' + taskId + ' 未更新：' + (cr.message || cr.error) + '）'; }
    }
    state.quick.sessionTaskId = '';
    if (feeling === 'pain') toast('已保存训练记录，会员反馈疼痛/不适：请教练人工关注（系统不做医疗诊断）', 'err');
    else toast('训练记录已保存（' + res.session.session_id + '）' + taskMsg, 'ok');
    showAfterSave(prefix, 'session', memberId, res.session.session_id);
    refreshQueuePreview();
    /* 结束操作：清空非会员字段，会员/教练/日期保留 */
    ['Type', 'Completion', 'Feeling', 'Focus', 'FocusText', 'Content', 'Tpl'].forEach(function (k) { var e = document.getElementById(prefix + k); if (e) e.value = ''; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-target^="' + prefix + 'Type"],[data-target^="' + prefix + 'Completion"],[data-target^="' + prefix + 'Feeling"],[data-target^="' + prefix + 'Focus"]'), function (grp) {
      Array.prototype.forEach.call(grp.querySelectorAll('.chip'), function (c) { c.classList.remove('active'); });
    });
    var tip = document.getElementById(prefix + 'PainTip'); if (tip) tip.hidden = true;
    var rows = document.getElementById(prefix + 'ExRows'); if (rows) rows.innerHTML = exRowHTML();
    var exBox = document.getElementById(prefix + 'ExBox'); if (exBox) exBox.hidden = true;
    onSessionMember(prefix);
    /* 从任务卡弹窗进入：关闭弹窗并刷新任务页 */
    if (opts.modal) { closeModal(); pRefresh('训练记录已保存（' + res.session.session_id + '）' + taskMsg, 'ok'); }
  }

  /* ---- 保存：跟进记录 ---- */
  function submitQuickFollowup(prefix, opts) {
    prefix = prefix || 'f';
    opts = opts || {};
    var errEl = document.getElementById(prefix + 'Err');
    var g = function (k) { var e = document.getElementById(prefix + k); return e ? e.value : ''; };
    var memberId = g('Member'), coachId = g('Coach'), date = g('Date');
    var outcome = g('Outcome'), nextAction = g('NextAction'), nextFollow = g('NextFollow');
    var msg = !memberId ? '请选择会员' : (!coachId ? '请选择执行教练' : (!date ? '请选择跟进日期' : (!outcome ? '请选择联系结果' : '')));
    if (!msg && nextAction && nextAction !== 'none' && !nextFollow) msg = '选择「' + (NEXT_ACTION_LABEL[nextAction] || nextAction) + '」时必须填写下次跟进时间';
    if (msg) { if (errEl) errEl.textContent = msg; return; }
    if (errEl) errEl.textContent = '';
    var taskId = opts.taskId || g('Task') || state.quick.followupTaskId || '';
    var result = OUTCOME_TO_RESULT[outcome] || 'reached';
    var res = E.addFollowup(state.model, {
      member_id: memberId, coach_id: coachId, date: date,
      channel: g('Channel') || 'wechat', result: result,
      content: (g('Content') || '').trim(), next_followup_date: (nextAction && nextAction !== 'none') ? nextFollow : '',
      task_id: taskId, member_feedback: (g('Feedback') || '').trim(),
      next_action: nextAction || '', outcome: outcome
    });
    if (!res.ok) { if (errEl) errEl.textContent = '保存失败：' + res.message + '（已填写内容已保留，请修改后重试）'; return; }
    queueAdd('followups', res.followup);
    (res.warnings || []).forEach(function (w) { toast('提示：' + w, 'err'); });
    runRulesCore(); updateStatus();
    /* 关联任务：完成任务 + 按需创建下次跟进任务 */
    var taskMsg = '';
    if (taskId && state.model.byId.tasks[taskId]) {
      var cr = completeTaskSmart(taskId, {
        date: date, result_code: result, actor: coachId,
        next_action: nextAction || 'none', next_followup_at: nextFollow,
        reviewEnabled: state.priority.reviewEnabled, today: todayStr()
      });
      if (cr.ok) { queueAdd('tasks', cr.task); taskMsg = '，已更新任务 ' + taskId; }
      else { taskMsg = '（任务 ' + taskId + ' 未更新：' + (cr.message || cr.error) + '）'; }
    } else if (nextAction && nextAction !== 'none' && nextFollow) {
      var memName = state.model.byId.members[memberId] ? state.model.byId.members[memberId].name : memberId;
      var ft = TASKM.createTask(state.model, {
        member_id: memberId, task_type: 'followup', rule_code: 'R-FN',
        title: '后续跟进 [' + memName + ']', due_date: nextFollow, source: 'system',
        priority: 'normal', notes: '由跟进记录 ' + res.followup.followup_id + ' 约定'
      }, { today: todayStr() });
      if (ft.created) {
        TASKM.autoAssign(state.model, ft.task, { today: todayStr(), actor: coachId });
        queueAdd('tasks', ft.task);
        taskMsg = '，已创建下次跟进任务 ' + ft.task.task_id;
      } else if (ft.task) {
        queueAdd('tasks', ft.task);
        taskMsg = '（已有未完成的同类跟进任务 ' + ft.task.task_id + '，按防重规则合并，未重复创建）';
      }
    }
    state.quick.followupTaskId = '';
    if (result === 'refused') toast('已记录「明确暂停或终止」：请提醒店长在 members 表将其 contact_opt_out 置为 Y（页面不会自动改表，也不发送任何消息）', 'err');
    else toast('跟进记录已保存（' + res.followup.followup_id + '）' + taskMsg, 'ok');
    showAfterSave(prefix, 'followup', memberId, res.followup.followup_id);
    refreshQueuePreview();
    ['Outcome', 'Feedback', 'NextAction', 'NextFollow', 'Content', 'Task'].forEach(function (k) { var e = document.getElementById(prefix + k); if (e) e.value = ''; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-target^="' + prefix + 'Outcome"],[data-target^="' + prefix + 'NextAction"]'), function (grp) {
      Array.prototype.forEach.call(grp.querySelectorAll('.chip'), function (c) { c.classList.remove('active'); });
    });
    var nf = document.getElementById(prefix + 'NextFollowBox'); if (nf) nf.hidden = true;
    var pi = document.getElementById(prefix + 'TaskPick'); if (pi) pi.value = '';
    onFollowupMember(prefix);
    /* 从任务卡弹窗进入：关闭弹窗并刷新任务页 */
    if (opts.modal) { closeModal(); pRefresh('跟进记录已保存（' + res.followup.followup_id + '）' + taskMsg, 'ok'); }
  }
  /* 旧接口保留（向后兼容第三方脚本调用） */
  function submitSession() { return submitQuickSession('s', {}); }
  function submitFollowup() { return submitQuickFollowup('f', {}); }

  /* ================= 视图：XP 流水 ================= */
  function viewXP() {
    var html = '<h2>XP 积分流水 <span class="muted small">（延后启用模块）</span></h2>';
    if (!state.xp) {
      html += '<div class="panel"><div class="hint">XP 模块默认停用。它与会员风险识别、待办生成完全隔离：停用/启用/数据损坏均不影响核心功能（见 docs/BUSINESS_RULES.md 第 10 节）。</div>' +
        '<button class="primary" onclick="FXPApp.enableXP()">启用 XP 模块</button></div>';
      return html;
    }
    var rep = state.xp.report();
    html += '<div class="panel"><b>状态：已启用</b> ' +
      '<button class="mini" onclick="FXPApp.disableXP()">停用</button> ' +
      '<button class="mini" onclick="FXPApp.importXP()">导入 xp_events.csv</button>' +
      '<input type="file" id="xpFile" accept=".csv" hidden>' +
      '<span class="muted small" style="margin-left:8px">流水 ' + rep.events + ' 条 · 拒收 ' + rep.errors.length + ' · 防重提示 ' + rep.warnings.length + '</span></div>';

    if (rep.errors.length || rep.warnings.length) {
      html += '<div class="panel">' + reportHTML('XP 拒收', rep.errors, 'err-line') + reportHTML('XP 防重提示', rep.warnings, 'warn-line') + '</div>';
    }
    html += '<div class="panel"><h3>手工积分调整</h3>' +
      '<form onsubmit="return false" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">' +
      '<div><label>会员</label><select id="xMember">' + memberOptions() + '</select></div>' +
      '<div><label>分值（-100～100，非 0）</label><input type="number" id="xDelta" placeholder="-5"></div>' +
      '<div><label>调整日期</label><input type="date" id="xDate" value="' + todayStr() + '"></div>' +
      '<div class="full"><label>调整原因 <span class="req">*</span>（必填，永久保留在流水中）</label><input type="text" id="xReason" maxlength="200" placeholder="如：重复计分纠错"></div>' +
      '<div class="full form-err" id="xErr"></div>' +
      '<div class="full"><button type="button" class="primary" onclick="FXPApp.submitAdjust()">提交调整</button></div></form></div>';

    var totals = rep.totals;
    var ids = Object.keys(totals).sort();
    var maxPt = 1;
    ids.forEach(function (id) { if (totals[id] > maxPt) maxPt = totals[id]; });
    function xpLevel(pt) {
      if (pt >= 1000) return '💎 铂金';
      if (pt >= 600) return '🥇 黄金';
      if (pt >= 300) return '🥈 白银';
      if (pt >= 100) return '🥉 青铜';
      return '🌱 新秀';
    }
    html += '<div class="panel"><h3>会员积分汇总</h3><div class="hint">等级阈值（100/300/600/1000）为展示层默认占位，未参与任何业务规则计算，可由业务方随时调整。</div><table><thead><tr><th>会员</th><th>等级</th><th class="num">累计积分</th></tr></thead><tbody>';
    if (!ids.length) html += '<tr><td colspan="3" class="muted">暂无积分数据</td></tr>';
    ids.forEach(function (id) {
      var mem = state.model.byId.members[id];
      var pct = Math.max(2, Math.round(totals[id] / maxPt * 100));
      html += '<tr><td>' + (mem ? esc(mem.name + '（' + id + '）') : esc(id)) + '</td>' +
        '<td><span class="xp-level">' + xpLevel(totals[id]) + '</span> <span class="xp-bar"><i style="width:' + pct + '%"></i></span></td>' +
        '<td class="num"><b>' + totals[id] + '</b></td></tr>';
    });
    html += '</tbody></table></div>';

    html += '<div class="panel"><h3>积分流水</h3><div class="tbl-wrap"><table><thead><tr><th>事件ID</th><th>会员</th><th>类型</th><th class="num">分值</th><th>日期</th><th>说明</th></tr></thead><tbody>';
    var evts = state.xp.listByMember ? null : null;
    var all = [];
    ids.forEach(function (id) { all = all.concat(state.xp.listByMember(id)); });
    all.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    if (!all.length) html += '<tr><td colspan="6" class="muted">暂无流水</td></tr>';
    all.forEach(function (e) {
      var mem = state.model.byId.members[e.member_id];
      html += '<tr><td>' + esc(e.event_id) + '</td><td>' + (mem ? esc(mem.name) : esc(e.member_id)) + '</td>' +
        '<td>' + esc(e.event_type) + '</td><td class="num">' + e.points + '</td><td>' + esc(e.date) + '</td><td>' + fmt(e.note) + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
  }
  function enableXP() {
    state.xp = XPM.createXpLedger({
      enabled: true,
      memberExists: function (id) { return !!(state.model && state.model.byId.members[id]); },
      today: todayStr()
    });
    toast('XP 模块已启用（核心功能不受任何影响）', 'ok');
    persist();
    render();
  }
  function disableXP() {
    state.xp = null;
    toast('XP 模块已停用（流水数据随清空消失，核心数据不变）');
    persist();
    render();
  }
  function importXP() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.csv';
    inp.onchange = function () {
      var file = inp.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var parsed = CSVU.toRecords(CSVU.parseCSV(CSVU.decodeBuffer(reader.result)));
        var head = V.validateHeader('xp_events', parsed.header);
        if (!head.ok) { showModal('XP 导入失败', '<div class="err-line">' + esc(head.message) + '</div>'); return; }
        var res = state.xp.loadEvents(parsed.records);
        toast('XP 导入：接受 ' + res.accepted + ' / 拒收 ' + res.rejected + ' / 防重跳过 ' + res.deduped, res.rejected ? 'err' : 'ok');
        persist();
        render();
      };
      reader.readAsArrayBuffer(file);
    };
    inp.click();
  }
  function submitAdjust() {
    var res = state.xp.adjust($('#xMember').value, parseInt($('#xDelta').value, 10), $('#xReason').value.trim(), $('#xDate').value);
    if (!res.ok) { $('#xErr').textContent = res.message; return; }
    $('#xErr').textContent = ''; $('#xDelta').value = ''; $('#xReason').value = '';
    toast('积分调整已入账（' + res.event.event_id + '），原因已保留', 'ok');
    persist();
    render();
  }

  /* ================= 路由与渲染 ================= */
  function parseHash() {
    var h = location.hash.replace(/^#/, '') || 'priority';
    var parts = h.split('/');
    var view = parts[0];
    if (view === 'member' && parts[1]) return { view: 'member', id: parts[1] };
    // 支持 #members:risk=L1 快捷过滤
    if (parts[0].indexOf(':') >= 0) {
      var seg = parts[0].split(':');
      view = seg[0];
      var kv = seg[1].split('=');
      if (view === 'members') state.filters.members[kv[0]] = kv[1];
      if (view === 'tasks') state.filters.tasks[kv[0]] = kv[1];
      location.hash = '#' + view;
    }
    if (['priority', 'overview', 'members', 'tasks', 'records', 'xp'].indexOf(view) < 0) view = 'priority';
    return { view: view };
  }

  function render() {
    var r = parseHash();
    var nav = $('#nav');
    Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) {
      a.classList.toggle('active', a.dataset.view === r.view || (r.view === 'member' && a.dataset.view === 'members'));
    });
    var html;
    if (r.view === 'priority') html = viewPriority();
    else if (r.view === 'members') html = viewMembers();
    else if (r.view === 'member') html = viewMemberDetail(r.id);
    else if (r.view === 'tasks') html = viewTasks();
    else if (r.view === 'records') html = viewRecords();
    else if (r.view === 'xp') html = viewXP();
    else html = viewOverview();
    $('#view').innerHTML = html;
    $('#view').setAttribute('data-view', r.view);
    if (r.view === 'priority') bindPriority();
    if (r.view === 'members') bindMemberFilters();
    if (r.view === 'tasks') bindTaskFilters();
    if (r.view === 'records') bindRecords();
  }
  /** 训练与跟进页初始化：带出会员近况、默认教练、下次跟进开关 */
  function bindRecords() {
    onSessionMember('s');
    onFollowupMember('f');
  }

  /* ================= 初始化 ================= */
  document.addEventListener('DOMContentLoaded', function () {
    /* 空白工作区：启动即创建空模型（与 CSV 导入同一套校验/引擎），
       保证零 CSV 状态下所有视图与手工录入功能完整可用 */
    state.model = E.loadModel({}, { today: todayStr() });
    try { STORE = PERSIST.createPersistence(localStorage); } catch (e) { STORE = null; }
    /* 试点数据清除标记（本窗口）优先：清除后不得从本地快照回灌，也不再自动载入测试数据 */
    var pilotCleared = false;
    try { pilotCleared = sessionStorage.getItem('fxp-pilot-cleared') === '1'; } catch (e) {}
    if (pilotCleared) { if (STORE) STORE.clear(); }
    else if (restoreFromStorage()) {
      toast('已恢复本机保存的工作区数据（' + todayStr() + ' 保存）', 'ok');
    }
    $('#btnImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', function () { handleFiles(this.files); });
    $('#btnExport').addEventListener('click', doExport);
    $('#btnRunRules').addEventListener('click', function () { runRules(true); });
    var btnClear = $('#btnClear');
    if (btnClear) btnClear.addEventListener('click', resetDialog);
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalWrap').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    window.addEventListener('hashchange', render);
    updateStatus();
    render();
  });

  /* 暴露给 onclick 的公开接口 */
  window.FXPApp = {
    hasData: hasData,
    closeModal: closeModal,
    resetDialog: resetDialog, doReset: doReset,
    showReport: showReport,
    completeDialog: completeDialog, doComplete: doComplete,
    cancelDialog: cancelDialog, doCancel: doCancel,
    submitSession: submitSession, submitFollowup: submitFollowup,
    memberDialog: memberDialog, doAddMember: doAddMember,
    coachDialog: coachDialog, doAddCoach: doAddCoach,
    enableXP: enableXP, disableXP: disableXP, importXP: importXP, submitAdjust: submitAdjust,
    /* 今日优先处理（0.15.0） */
    pFilter: pFilter, pToggleReview: pToggleReview, pGenTasks: pGenTasks,
    pStart: pStart, pDue: pDue, doPDue: doPDue,
    pAssign: pAssign, doPAssign: doPAssign, doPAuto: doPAuto,
    pReassign: pReassign, doPReassign: doPReassign,
    pHold: pHold, doPHold: doPHold,
    pContact: pContact, pTrain: pTrain,
    pApprove: pApprove, pReject: pReject, doPReject: doPReject,
    pViewRecord: pViewRecord, pFollowUp: pFollowUp, doPFollowUp: doPFollowUp,
    pViewCancel: pViewCancel, pCancelTask: pCancelTask, doPCancelTask: doPCancelTask,
    pTemplates: pTemplates,
    /* V1.1 快捷记录 */
    chipPick: chipPick, setChip: setChip,
    addExRow: addExRow, removeExRow: removeExRow, toggleEx: toggleEx,
    onSessionMember: onSessionMember, onFollowupMember: onFollowupMember,
    applyTemplate: applyTemplate, copyLastSession: copyLastSession,
    submitQuickSession: submitQuickSession, submitQuickFollowup: submitQuickFollowup,
    continueRecord: continueRecord, endRecord: endRecord,
    memberProfileDialog: memberProfileDialog, doUpdateMember: doUpdateMember,
    /* V1.1 导入预览与确认 */
    setImportMode: setImportMode, confirmImport: doConfirmImport, cancelImport: doCancelImport
  };
})();
