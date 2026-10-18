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
