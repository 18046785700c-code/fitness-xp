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

  /** 该会员某周是否存在**会员自己的**计划（source='member'），用于空白计划的不覆盖预检 */
  function findMemberPlan(store, memberId, weekStart) {
    var hit = null;
    store.findBy('m_plans', function (r) {
      return r.member_id === memberId && r.week_start === weekStart && r.source === 'member';
    }).forEach(function (r) { if (!hit) hit = r; });
    return hit;
  }

  /**
   * createEmptyWeekPlan(store, memberId, opt) —— 建一份**当周空白会员计划**（0 动作），供会员自主编排。
   *
   * 与 createWeekPlan 的分工：
   *   createWeekPlan     = 按档案 + 动作库**自动生成**（generatePlan 强依赖 m_profiles）
   *   createEmptyWeekPlan = 只建容器，**不调 generatePlan、不读 m_profiles**（档案不准/不想填也能开工）
   *
   * 两条硬行为：
   *   1. 该周已有 source='member' 的计划 → 返回 already_exists，**绝不覆盖**（也不追加第二份）；
   *   2. 该周已有 coach_confirmed='Y' 的计划 → 返回 coach_week_exists
   *      （与 createWeekPlan / copyPlan 同一口径；教练安排只读，需调整请联系教练）。
   *
   * opt.weekStart / opt.week_start  周起始日（缺省本周一，内部归一到周一）
   * opt.weekTargetCount             本周目标次数（1-7，缺省 3）
   * opt.note                        备注
   *
   * @returns {{ok:true, plan_id, plan, week_start, items:0} | {ok:false, reason, message}}
   */
  function createEmptyWeekPlan(store, memberId, opt) {
    opt = opt || {};
    if (!memberId) return fail('no_actor', '未指定会员，拒绝写计划');
    var week = normWeekStart(opt.weekStart || opt.week_start);

    var dup = findMemberPlan(store, memberId, week);
    if (dup) {
      return {
        ok: false, reason: 'already_exists', plan_id: dup.plan_id,
        message: '这一周你已经有自己的计划了（' + dup.plan_id + '），没有覆盖它。'
          + '想重排请先删除原计划，或直接在原计划里改。'
      };
    }
    if (findCoachConfirmed(store, memberId, week)) {
      return fail('coach_week_exists', '该周已有教练安排，不能新建空白计划');
    }

    var now = opt.now || nowStr();
    var planId = store.nextId('m_plans');
    if (!planId) return fail('id_exhausted', '计划 ID 已用尽');

    /* week_target_count 是必填且限定 1-7 的整数列（schema: I(...,1,[1,7])），
       空白计划也得给一个合法值；不给会从 insert 层被拒，页面只会看到一句笼统的失败。 */
    var target = clampInt(opt.weekTargetCount !== undefined ? opt.weekTargetCount : opt.week_target_count,
      DEFAULT_DAYS, 1, 7);

    var res = store.insert('m_plans', {
      plan_id: planId,
      member_id: memberId,
      week_start: week,
      week_target_count: target,
      source: 'member',
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

    /* items 为空：动作一律由会员后续用 addPlanItem 自行添加（本函数不碰动作库） */
    return { ok: true, plan_id: planId, plan: res.row, week_start: week, items: 0 };
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
    createEmptyWeekPlan: createEmptyWeekPlan,
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