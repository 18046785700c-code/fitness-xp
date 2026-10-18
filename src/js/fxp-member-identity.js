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
