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
