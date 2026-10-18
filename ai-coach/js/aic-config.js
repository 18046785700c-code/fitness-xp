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
