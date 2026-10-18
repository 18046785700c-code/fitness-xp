/* Fitness XP — AI 动作教练：阈值与权重集中配置（UMD）
 *
 * 设计约束（任务书第六节）：
 *   1) 所有阈值/权重集中在本文件，页面与算法都不得硬编码数值；
 *   2) 每个动作一套规则对象，便于后续扩展（弓步/弯举/肩推只需新增 rule 对象）；
 *   3) 阈值是"规则定义的可评估范围"，不是医学或运动安全标准，禁止对外表述为医学建议；
 *   4) ruleVersion 随任何阈值变更递增，训练记录会落库该版本，保证事后可追溯。
 *
 * 为何单独一个文件：让"调参"与"算法"彻底分离。改阈值不该碰逻辑，改逻辑不该碰数值。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.aicConfig = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* MediaPipe Pose Landmarker 的 33 个关键点索引（BlazePose 拓扑）
   * 只声明本阶段徒手深蹲真正用到的，其余保留索引注释便于后续动作扩展。 */
  var LM = {
    NOSE: 0,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    LEFT_HEEL: 29, RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32
  };

  /* ---------- 徒手深蹲规则 ---------- */
  var SQUAT = {
    exerciseType: 'bodyweight_squat',
    exerciseLabel: '徒手深蹲',
    ruleVersion: 'squat-bw-1.0.0',
    mediaSource: 'none',           // 不使用任何第三方图/像素材
    dataVersion: 1,

    /* 观察视角判定：用"肩宽 / 躯干长"的比值粗略区分正面与侧面。
     * 侧面（矢状面）最适合评估下蹲深度与躯干前倾；正面主要看膝内扣与对称性。 */
    view: {
      frontalRatio: 1.10,          // >= 视为正面站位
      sagittalRatio: 0.62,         // <= 视为侧面站位
      minVisibility: 0.5,          // 判定视角所需的最低关键点可见度
      recommended: 'sagittal',     // 推荐站位
      recommendText: '建议侧对摄像头站位，便于判断下蹲深度与躯干姿态'
    },

    /* 参与计数的必看点；任一侧不可用则降级为"该侧不参与" */
    required: {
      core: [LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE],
      torso: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP]
    },
    minJointVisibility: 0.5,       // 低于此值的关键点视为"不可见"

    /* ---------- 动作识别（状态机） ----------
     * 角度均为膝屈角（髋-膝-踝），站立≈170~180°，深蹲最低点≈70~100°。
     * 迟滞设计：进入与退出用不同阈值，避免在阈值边缘反复横跳。 */
    phase: {
      standAngle: 152,             // >= 判定为站立
      descendEnterAngle: 142,      // 从站立往下进此值 → 下蹲中
      bottomEnterAngle: 110,       // <= 到达最低点
      bottomExitAngle: 125,        // 起身离开最低点
      debounceFrames: 3,           // 状态切换需连续帧数，抑制抖动
      smoothAlpha: 0.45,           // 膝角 EMA 平滑系数
      minRepMs: 500,               // 短于此的下-上循环不计为一次（防抖动误计）
      maxRepMs: 10000,             // 长于此视为动作中断，不计数
      lossResetMs: 1200,           // 连续丢失关键点超过此值 → 状态机复位
      standingConfirmFrames: 2     // 回到站立需确认帧数
    },

    /* ---------- 评分维度阈值 ---------- */
    /* 深度：以一次动作中最小的膝屈角衡量 */
    depth: {
      levels: [
        { maxAngle: 95, score: 100, level: 'good', label: '下蹲深度达到设定范围' },
        { maxAngle: 105, score: 82, level: 'ok', label: '深度接近设定范围' },
        { maxAngle: 120, score: 60, level: 'partial', label: '深度不足设定范围' },
        { maxAngle: 999, score: 35, level: 'poor', label: '下蹲幅度明显偏小' }
      ]
    },
    /* 节奏：下蹲时长与下行过程中的"反向次数"（回弹） */
    tempo: {
      minDescendMs: 500,
      maxDescendMs: 3500,
      reversalDeg: 7,              // 反向幅度超过此值才计一次回弹
      maxReversals: 1,
      stabilityRatio: 0.55,        // 相邻动作时长差异容忍度（标准差/均值）
      minSampleReps: 3             // 少于此数量不做稳定性评价
    },
    /* 左右对称：左右膝角差的最大值 */
    symmetry: {
      excellentDeg: 8,
      acceptableDeg: 15,
      poorDeg: 25
    },
    /* 躯干：相对竖直方向的前倾角（仅在侧面视角下评估） */
    torso: {
      maxLeanDeg: 40,              // 超出即提示（不是安全红线，是"与规则预设偏差"）
      noticeLeanDeg: 28,
      changeToleranceDeg: 12,      // 下蹲过程中躯干前倾变化过大 → 稳定性不足
      evaluableViews: ['sagittal'] // 正面视角下不评估此项（标记"无法评估"）
    },
    /* 关键点置信度：此项是"识别置信度"，不等同于动作质量 */
    confidence: {
      minMeanVisibility: 0.55,
      goodMeanVisibility: 0.75
    },

    /* ---------- 权重（无法评估的维度会被剔除后重新归一，不会强行扣分） ---------- */
    weights: {
      depth: 0.35,
      tempo: 0.20,
      symmetry: 0.20,
      torso: 0.25
    },
    minEvaluableDims: 2,           // 可评估维度少于此 → 该次动作标记为"置信度不足"
    scoreCap: 100,

    /* ---------- 提示冷却（毫秒）与去抖帧数 ---------- */
    feedback: {
      defaultCooldownMs: 6000,
      perCode: {
        VIEW_RECOMMEND: 120000,
        REP_COMPLETE: 0,           // 完成提示不冷却，但由页面限流展示
        DEPTH_SHORT: 3000
      },
      consecutiveFrames: 8,        // 连续满足 N 帧才触发，避免关键点瞬时抖动误报
      maxTextLen: 24
    }
  };

  /* 后续动作在此注册：'lunge' | 'bicep_curl' | 'shoulder_press' ... */
  var RULES = {};
  RULES[SQUAT.exerciseType] = SQUAT;

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
    '本评分仅用于训练反馈参考，不能作为专业教练评估或医疗诊断的替代。'
  ].join('');

  /* 一眼可见的"识别"与"质量"区别说明 */
  var METRIC_NOTE = {
    detection: '识别成功率：成功稳定追踪身体的画面占比，只反映"看没看清"。',
    quality: '动作质量评分：在可信画面基础上，按规则给出的评分，已剔除无法可靠判断的维度。'
  };

  return {
    LM: LM,
    RULES: RULES,
    SQUAT: SQUAT,
    getRules: getRules,
    mergeRules: mergeRules,
    DISCLAIMER: DISCLAIMER,
    METRIC_NOTE: METRIC_NOTE
  };
});
