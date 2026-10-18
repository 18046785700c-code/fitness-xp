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
