/* Fitness XP — AI 动作教练：训练复盘（UMD，纯逻辑）
 *
 * 设计约束（任务书第八节）：
 *   1) 严格区分"识别成功率"与"动作质量"——前者是看清了多少，后者是做得怎么样；
 *   2) 样本不足必须明确显示"样本不足"，不得输出看似精确但缺依据的结论；
 *   3) 每一条改进建议都必须能追溯到具体维度的具体数值；
 *   4) 必须输出本次评估的局限性说明。
 *
 * 本模块不做任何自然语言润色（那是本地模板或 AI 适配器的职责），只产出结构化事实。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.aicReview = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIM_LABEL = {
    depth: '动作幅度',
    tempo: '动作节奏',
    symmetry: '左右对称',
    torso: '躯干姿态'
  };

  /* 每个维度给出"下一步做什么"的建议模板。深蹲专属文案作为兜底，
   * 有 rules.advice 时一律用动作自带的（卧推不该出现"下蹲"字样）。 */
  var NEXT_STEP = {
    depth: '试着在一次练习里把下蹲幅度做得比上次稍深一点，找到能稳定控制的深度后再放慢节奏。',
    tempo: '用心里数数的方式固定下蹲与起身节奏（例如下行 2 秒、起身 2 秒），减少中途停顿。',
    symmetry: '双脚站距与脚尖方向左右对齐，下蹲时留意两侧膝盖是否同步弯曲。',
    torso: '下蹲时保持视线与躯干方向一致，避免躯干过度前倾或角度突变。'
  };

  function nextStepOf(rules, code) {
    var a = rules && rules.advice;
    if (a && typeof a[code] === 'string' && a[code]) return a[code];
    return NEXT_STEP[code] || '';
  }

  /**
   * @param s analyzer.summary() 的输出
   * @param rules 当前动作规则（用于取阈值做依据展示）
   * @returns 结构化复盘对象
   */
  function buildReview(s, rules) {
    rules = rules || {};
    var out = {
      exerciseType: s.exerciseType,
      exerciseLabel: s.exerciseLabel,
      ruleVersion: s.ruleVersion,
      dataVersion: s.dataVersion,
      durationMs: s.durationMs,

      counts: {
        framesTotal: s.framesTotal,
        framesReliable: s.framesReliable,
        framesUnreliable: s.framesUnreliable,
        lowConfidenceMs: s.lowConfidenceMs,
        repsTotal: s.repsTotal,
        repsValid: s.repsValid,
        repsLowConfidence: s.repsLowConfidence,
        partialCycles: s.partialCycles
      },

      /* ---- 两类指标分开呈现，禁止混为一谈 ---- */
      detection: {
        rate: s.detectionRate,
        meanLandmarkVisibility: s.meanLandmarkVisibility,
        viewMode: s.viewMode,
        threshold: rules.confidence ? rules.confidence.minMeanVisibility : null,
        note: '识别成功率只反映画面能否看清人体，不代表动作是否规范。'
      },
      quality: {
        scoreAvg: s.qualityScoreAvg,
        evaluable: s.repsValid > 0,
        sampleCount: s.repsValid,
        note: s.repsValid > 0
          ? '动作质量评分已剔除无法可靠判断的维度。'
          : '没有可用于评分的有效样本。'
      },

      dimensions: [],
      improvements: [],
      nextSteps: [],
      limitations: [],
      sufficient: false,
      caveat: ''
    };

    /* ---- 逐维度统计 ---- */
    (s.dims || []).forEach(function (d) {
      out.dimensions.push({
        code: d.code,
        label: DIM_LABEL[d.code] || d.code,
        avgScore: d.avgScore,
        sampleCount: d.sampleCount,
        unavailableCount: d.unavailableCount,
        evaluable: d.evaluable,
        display: d.evaluable
          ? (d.avgScore + ' 分（有效样本 ' + d.sampleCount + ' 次' +
             (d.unavailableCount ? '，' + d.unavailableCount + ' 次无法评估' : '') + '）')
          : '无法评估（' + d.unavailableCount + ' 次样本中该维度不可用）'
      });
    });

    /* ---- 样本不足判定：明确不下结论 ---- */
    if (s.repsTotal === 0) {
      out.caveat = '本次未识别到完整的「' + (s.exerciseLabel || '目标') + '」动作，样本不足，不生成动作质量结论。';
      out.limitations.push('未完成任何一次可被识别的完整动作，无法评估动作质量。');
      if (s.framesUnreliable > 0) {
        out.limitations.push('有 ' + s.framesUnreliable + ' 帧未能可靠识别人体（合计约 ' +
          Math.round(s.lowConfidenceMs / 100) / 10 + ' 秒），请确认站位、光线与摄像头角度。');
      }
      return out;
    }

    out.sufficient = s.repsValid >= 3;

    if (s.repsValid === 0) {
      out.caveat = '识别到 ' + s.repsTotal + ' 次动作，但画面置信度均低于设定阈值，无法确定性地给出评分。';
      out.limitations.push('全部 ' + s.repsTotal + ' 次动作的关键点置信度低于 ' +
        (rules.confidence ? rules.confidence.minMeanVisibility : '-') + '，不参与质量评分。');
      return out;
    }

    /* ---- 改进点：取平均分最低的、且真正评测过的维度，最多 3 条 ---- */
    var ranked = out.dimensions.filter(function (d) { return d.evaluable; })
      .slice().sort(function (a, b) { return a.avgScore - b.avgScore; });
    out.improvements = ranked.slice(0, 3).map(function (d) {
      return {
        code: d.code,
        label: d.label,
        avgScore: d.avgScore,
        text: d.label + '平均 ' + d.avgScore + ' 分，是本次最值得关注的方面。'
      };
    });

    /* ---- 下一步建议：来自改进点，最多 3 条 ---- */
    out.nextSteps = out.improvements.map(function (i) {
      return { code: i.code, text: nextStepOf(rules, i.code) || '保持当前节奏继续练习。' };
    });

    /* ---- 局限性：逐条列真实证据 ---- */
    out.limitations.push('本次识别出 ' + s.repsTotal + ' 次动作，其中 ' + s.repsValid +
      ' 次画面置信度满足评分条件，' + s.repsLowConfidence + ' 次因置信度不足未参与评分。');
    if (s.partialCycles > 0) {
      var w = (rules.tempo && rules.tempo.workingLabel) || '动作';
      out.limitations.push('另有 ' + s.partialCycles + ' 次' + w + '未达到设定的最低点阈值或时长异常，已按规则不计入次数。');
    }
    out.dimensions.forEach(function (d) {
      if (d.unavailableCount > 0) {
        out.limitations.push('「' + d.label + '」有 ' + d.unavailableCount + ' 次无法评估（多为关键点不可见或视角不支持），未强行扣分。');
      }
    });
    if (s.viewMode === 'frontal') {
      out.limitations.push('本次主要为正面视角，躯干前倾相关指标不可靠，已在评分中标记为无法评估。');
    }
    if (!out.sufficient) {
      out.limitations.push('有效样本少于 3 次，统计结果参考价值有限。');
      out.caveat = '有效样本不足 3 次（本次 ' + s.repsValid + ' 次），以下结论仅供参考，不建议据此调整训练计划。';
    }

    return out;
  }

  /**
   * 生成本地自然语言复盘（不调用任何云端模型）。
   * 所有数字都来自 review 对象本身，不做推断、不补空白。
   */
  function localNarrative(review) {
    var lines = [];
    lines.push('本次' + review.exerciseLabel + '共 ' + review.counts.repsTotal + ' 次完整动作，' +
      '其中 ' + review.counts.repsValid + ' 次达到评分条件。');
    if (review.quality.evaluable) {
      lines.push('动作质量平均分 ' + review.quality.scoreAvg + ' 分（基于 ' + review.quality.sampleCount + ' 次有效样本）。');
    } else {
      lines.push('没有满足评分条件的样本，本次不给出动作质量评分。');
    }
    lines.push('识别成功率 ' + Math.round(review.detection.rate * 100) + '%（' +
      review.counts.framesReliable + '/' + review.counts.framesTotal + ' 帧可靠）。');
    if (review.improvements.length) {
      lines.push('最值得改进：' + review.improvements.map(function (i) { return i.label + '（' + i.avgScore + ' 分）'; }).join('、') + '。');
    }
    if (review.caveat) lines.push(review.caveat);
    return lines.join('\n');
  }

  return { buildReview: buildReview, localNarrative: localNarrative, DIM_LABEL: DIM_LABEL, NEXT_STEP: NEXT_STEP };
});
