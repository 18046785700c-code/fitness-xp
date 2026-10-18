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
