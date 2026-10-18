/* Fitness XP — AI 动作教练：徒手深蹲分析引擎（UMD，纯函数式，无 DOM / 无摄像头依赖）
 *
 * 为什么必须和页面完全分开：任务书第五节要求"动作识别规则必须能够独立测试，
 * 不要直接将所有计算写在页面事件处理函数中"。本文件可在 Node 里用虚拟关键点序列
 * 完整跑一遍，从而区分「单元测试」与「真实摄像头测试」。
 *
 * 输入帧格式：{ tMs: number, landmarks: [{x,y,z,visibility}|null] | null }
 *   - tMs 为单调递增毫秒时间戳；landmarks 为 null 表示该帧没有检测到人。
 *   - 坐标约定归一化为 0~1，y 轴向下（与 MediaPipe 一致）。
 *
 * 输出：
 *   - push(frame) 返回 { classification: {...}, completedRep: {...}|null }
 *   - summary()   返回训练复盘所需的全部统计（不生成自然语言文案）
 *
 * 关键区分：detection（识别置信度）与 quality（动作质量）是两条独立链路，
 * 严禁把"成功检测到人体"的比例当作"动作规范程度"（任务书第八节）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.aicAnalyze = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==================== 几何基础 ==================== */

  function hypot(x, y) { return Math.sqrt(x * x + y * y); }

  /** b 点处的夹角（度）；任一段退化返回 null */
  function angleAt(a, b, c) {
    if (!a || !b || !c) return null;
    var v1x = a.x - b.x, v1y = a.y - b.y;
    var v2x = c.x - b.x, v2y = c.y - b.y;
    var n1 = hypot(v1x, v1y), n2 = hypot(v2x, v2y);
    if (n1 < 1e-9 || n2 < 1e-9) return null;
    var d = (v1x * v2x + v1y * v2y) / (n1 * n2);
    d = d < -1 ? -1 : (d > 1 ? 1 : d);
    return Math.acos(d) * 180 / Math.PI;
  }

  function vis(lm, i) {
    if (!lm || !lm[i]) return 0;
    var v = lm[i].visibility;
    if (typeof v !== 'number' || isNaN(v)) {
      // 某些版本只给 presence 或什么都不给，保守按 0 处理
      v = typeof lm[i].presence === 'number' ? lm[i].presence : 0;
    }
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function minVis(lm, idxs) {
    if (!lm) return 0;
    var m = 1;
    for (var i = 0; i < idxs.length; i++) {
      var v = vis(lm, idxs[i]);
      if (v < m) m = v;
    }
    return m;
  }

  function meanVis(lm, idxs) {
    if (!lm || !idxs.length) return 0;
    var s = 0;
    for (var i = 0; i < idxs.length; i++) s += vis(lm, idxs[i]);
    return s / idxs.length;
  }

  /** 一侧膝屈角：髋-膝-踝 */
  function kneeAngle(lm, hip, knee, ankle) {
    return angleAt(lm[hip], lm[knee], lm[ankle]);
  }

  /** 躯干相对竖直方向的前倾角（以髋中点→肩中点方向计算；正面视角下无意义） */
  function torsoLeanDeg(lm) {
    var sx = (lm[11].x + lm[12].x) / 2, sy = (lm[11].y + lm[12].y) / 2;
    var hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
    var vx = sx - hx, vy = sy - hy;
    var n = hypot(vx, vy);
    if (n < 1e-9) return null;
    // 竖直向上向量在图像坐标下是 (0,-1)
    var d = (-vy) / n;
    d = d < -1 ? -1 : (d > 1 ? 1 : d);
    return Math.acos(d) * 180 / Math.PI;
  }

  /**
   * 粗略估计观察视角：肩宽 / 躯干长。
   * 正面时两肩横向间距接近真实肩宽；侧面时两肩几乎重叠，比值很小。
   * 任一侧肩/髋不可见时返回 'unknown'。
   */
  function estimateView(lm, rules) {
    var need = rules.required.torso;
    if (minVis(lm, need) < rules.view.minVisibility) return 'unknown';
    var shoulderSpan = Math.abs(lm[11].x - lm[12].x);
    var torsoLen = hypot(
      (lm[11].x + lm[12].x) / 2 - (lm[23].x + lm[24].x) / 2,
      (lm[11].y + lm[12].y) / 2 - (lm[23].y + lm[24].y) / 2
    );
    if (torsoLen < 1e-6) return 'unknown';
    var r = shoulderSpan / torsoLen;
    if (r >= rules.view.frontalRatio) return 'frontal';
    if (r <= rules.view.sagittalRatio) return 'sagittal';
    return 'oblique';
  }

  /* ==================== 帧级特征提取 ==================== */

  /** 取 LM 索引：优先用分析器注入的 __LM；直接调用时回落到配置模块 */
  function getLM(rules) {
    if (rules && rules.__LM) return rules.__LM;
    if (typeof module === 'object' && module.exports) return require('./aic-config.js').LM;
    if (typeof self !== 'undefined' && self.FXP && self.FXP.aicConfig) return self.FXP.aicConfig.LM;
    throw new Error('LM_required');
  }

  /**
   * @returns {{reliable:boolean, reason:string, kneeLeft:number|null, kneeRight:number|null,
   *            kneeAvg:number|null, view:string, visibility:number, missing:string[], lean:number|null}}
   */
  function extractFrame(frame, rules) {
    var LM = getLM(rules);
    var lm = frame && frame.landmarks;
    if (!lm) {
      return { reliable: false, reason: 'no_person', kneeLeft: null, kneeRight: null, kneeAvg: null,
               view: 'unknown', visibility: 0, missing: ['all'], lean: null };
    }
    var coreVis = minVis(lm, rules.required.core);
    var missing = [];
    var sides = [
      { idx: [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE], name: 'left' },
      { idx: [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE], name: 'right' }
    ];
    var res = sides.map(function (s) {
      var m = minVis(lm, s.idx);
      if (m < rules.minJointVisibility) { missing.push(s.name); return { v: m, a: null }; }
      return { v: m, a: kneeAngle(lm, s.idx[0], s.idx[1], s.idx[2]) };
    });

    /* 只要有一侧完整可见就继续分析（降级为单侧），而不是整帧判废；
     * 两侧都不可见才真正无法评估。这与"左右 asymmetry 可评估性"的判断是两件事。 */
    var anySide = res[0].a !== null || res[1].a !== null;
    var bestVis = Math.max(res[0].v, res[1].v);
    var canSeeTorso = minVis(lm, rules.required.torso) >= rules.view.minVisibility;
    var lean = canSeeTorso ? torsoLeanDeg(lm) : null;

    return {
      reliable: anySide,
      reason: anySide ? '' : (coreVis < rules.minJointVisibility ? 'low_visibility' : 'no_joint'),
      kneeLeft: res[0].a,
      kneeRight: res[1].a,
      kneeAvg: (res[0].a !== null && res[1].a !== null)
        ? (res[0].a + res[1].a) / 2
        : (res[0].a !== null ? res[0].a : res[1].a),
      view: estimateView(lm, rules),
      visibility: bestVis,
      missing: missing,
      lean: lean
    };
  }

  /* ==================== 评分维度（可解释） ==================== */

  function dim(code, label, score, status, reason, evidence) {
    return { code: code, label: label, score: score, status: status, reason: reason, evidence: evidence || [] };
  }
  function unavailable(code, label, reason) {
    return dim(code, label, null, 'unavailable', reason, []);
  }

  function scoreDepth(rep, rules) {
    var levels = rules.depth.levels;
    for (var i = 0; i < levels.length; i++) {
      if (rep.minKneeAngle <= levels[i].maxAngle) {
        return dim('depth', '动作幅度', levels[i].score, levels[i].level,
          levels[i].label,
          [{ key: '最小膝屈角', value: round1(rep.minKneeAngle) + '°', rule: '≤ ' + levels[i].maxAngle + '°' }]);
      }
    }
    var last = levels[levels.length - 1];
    return dim('depth', '动作幅度', last.score, last.level, last.label,
      [{ key: '最小膝屈角', value: round1(rep.minKneeAngle) + '°', rule: '≤ ' + last.maxAngle + '°' }]);
  }

  function scoreTempo(rep, rules) {
    var t = rules.tempo;
    var ev = [{ key: '下蹲时长', value: Math.round(rep.descendMs) + ' ms', rule: t.minDescendMs + '~' + t.maxDescendMs + ' ms' },
              { key: '下行回弹次数', value: String(rep.reversals), rule: '≤ ' + t.maxReversals }];
    if (rep.descendMs < t.minDescendMs) return dim('tempo', '动作节奏', 55, 'partial', '下蹲过快，过程可能不够受控', ev);
    if (rep.descendMs > t.maxDescendMs) return dim('tempo', '动作节奏', 60, 'partial', '下蹲过慢或中途停顿较久', ev);
    if (rep.reversals > t.maxReversals) return dim('tempo', '动作节奏', 55, 'partial', '下行过程存在明显起伏', ev);
    return dim('tempo', '动作节奏', 100, 'good', '下蹲过程连续、节奏在设定范围内', ev);
  }

  function scoreSymmetry(rep, rules) {
    if (rep.symmetrySamples === 0) {
      return unavailable('symmetry', '左右对称', '左右两侧关键点未同时可见，本次不评估对称性');
    }
    var s = rules.symmetry;
    var d = rep.maxSideDiffDeg;
    var ev = [{ key: '左右膝角最大差', value: round1(d) + '°', rule: '≤ ' + s.excellentDeg + '° 为佳' }];
    if (d <= s.excellentDeg) return dim('symmetry', '左右对称', 100, 'good', '左右两侧表现接近', ev);
    if (d <= s.acceptableDeg) return dim('symmetry', '左右对称', 75, 'ok', '左右存在可见差异', ev);
    if (d <= s.poorDeg) return dim('symmetry', '左右对称', 50, 'partial', '左右差异偏大，建议关注发力是否均衡', ev);
    return dim('symmetry', '左右对称', 30, 'poor', '左右差异明显', ev);
  }

  function scoreTorso(rep, rules) {
    if (rules.torso.evaluableViews.indexOf(rep.viewMode) < 0) {
      return unavailable('torso', '躯干姿态',
        '当前为' + viewLabel(rep.viewMode) + '视角，不足以判断躯干前倾，本次标记为无法评估');
    }
    var t = rules.torso;
    var ev = [{ key: '躯干前倾角', value: round1(rep.maxLeanDeg) + '°', rule: '≤ ' + t.noticeLeanDeg + '°' },
              { key: '过程中前倾变化', value: round1(rep.leanChangeDeg) + '°', rule: '≤ ' + t.changeToleranceDeg + '°' }];
    if (rep.maxLeanDeg > t.maxLeanDeg) return dim('torso', '躯干姿态', 40, 'poor', '躯干前倾超出本次规则设定范围', ev);
    if (rep.maxLeanDeg > t.noticeLeanDeg) return dim('torso', '躯干姿态', 70, 'partial', '躯干前倾偏大', ev);
    if (rep.leanChangeDeg > t.changeToleranceDeg) return dim('torso', '躯干姿态', 70, 'partial', '过程中躯干角度变化较大', ev);
    return dim('torso', '躯干姿态', 100, 'good', '躯干姿态在本次规则设定范围内', ev);
  }

  /** 单次动作综合分：只对可评估维度加权，权重按实际参与维度重新归一 */
  function composeScore(dims, rules) {
    var totalW = 0, acc = 0, count = 0;
    for (var i = 0; i < dims.length; i++) {
      var d = dims[i];
      if (d.status === 'unavailable' || typeof d.score !== 'number') continue;
      var w = rules.weights[d.code] || 0;
      acc += d.score * w;
      totalW += w;
      count++;
    }
    if (totalW <= 0) return { score: null, evaluableDims: 0, reliable: false };
    return {
      score: Math.round(Math.min(rules.scoreCap, acc / totalW)),
      evaluableDims: count,
      reliable: count >= rules.minEvaluableDims
    };
  }

  function gradeRep(rep, rules) {
    var dims = [scoreDepth(rep, rules), scoreTempo(rep, rules), scoreSymmetry(rep, rules), scoreTorso(rep, rules)];
    var comp = composeScore(dims, rules);
    rep.dims = dims;
    rep.score = comp.score;
    rep.evaluableDims = comp.evaluableDims;
    rep.qualityReliable = comp.reliable;
    return rep;
  }

  /* ==================== 动作识别状态机 ==================== */

  function createAnalyzer(opts) {
    opts = opts || {};
    var rules = opts.rules;
    if (!rules) throw new Error('rules_required');
    // 注入 LM 索引，避免引擎二次依赖 config 模块
    var LM = opts.LM || (typeof module === 'object' && module.exports ? require('./aic-config.js').LM : null);
    if (!LM) throw new Error('LM_required');
    var R = {};
    for (var k in rules) if (Object.prototype.hasOwnProperty.call(rules, k)) R[k] = rules[k];
    R.__LM = LM;

    var ph = R.phase;

    var st = {
      phase: 'unknown',
      pendingPhase: null,
      pendingFrames: 0,
      standFrames: 0,
      smoothKnee: null,
      lastTs: null,
      lastReliableTs: null,
      lostMs: 0,
      reps: [],
      partialCycles: 0,
      framesTotal: 0,
      framesReliable: 0,
      framesUnreliable: 0,
      lowConfidenceMs: 0,
      cur: null,               // 进行中的一次动作
      viewMode: 'unknown',
      viewSamples: {},
      visibilitySum: 0,
      visibilityFrames: 0
    };

    function openRep(ts) {
      st.cur = {
        index: st.reps.length + st.partialCycles + 1,
        startTs: ts, endTs: null, bottomTs: null, bottomReached: false,
        minKneeAngle: 999, maxSideDiffDeg: 0, symmetrySamples: 0,
        reversals: 0, descendMs: 0, frames: 0,
        prevKnee: null, descentStartTs: ts,
        maxLeanDeg: 0, minLeanDeg: 999, leanChangeDeg: 0, leanSamples: 0,
        viewMode: 'unknown', visibilitySum: 0, visibilityFrames: 0
      };
    }

    /** 未达标作废：站起来但没到最低点、或打开过久仍未完成 */
    function discardRep() {
      st.cur = null;
      st.phase = 'unknown';
      st.pendingPhase = null;
      st.pendingFrames = 0;
      st.partialCycles++;
    }

    function closeRep(ts, counted) {
      var rep = st.cur;
      st.cur = null;
      if (!rep) return null;
      rep.endTs = ts;
      rep.durationMs = ts - rep.startTs;
      rep.counted = !!counted;

      // 时长过滤：过快多半是抖动，过慢多半是中断
      var tooFast = rep.durationMs < ph.minRepMs;
      var tooSlow = rep.durationMs > ph.maxRepMs;
      if (counted && (tooFast || tooSlow)) {
        st.partialCycles++;
        return null;
      }
      if (!counted) {
        st.partialCycles++;
        return null;
      }

      rep.meanVisibility = rep.visibilityFrames ? rep.visibilitySum / rep.visibilityFrames : 0;
      rep.viewMode = dominant(st.viewSamples) === 'unknown' ? rep.viewMode : (rep.viewMode || dominant(st.viewSamples));
      if (rep.leanSamples > 0) {
        rep.leanChangeDeg = Math.max(0, rep.maxLeanDeg - rep.minLeanDeg);
      } else {
        rep.maxLeanDeg = null; rep.minLeanDeg = null; rep.leanChangeDeg = null;
      }
      // 识别置信度不足 → 仍计数，但不可进行质量评分
      rep.detectionConfidence = +rep.meanVisibility.toFixed(3);
      rep.canGrade = rep.detectionConfidence >= (R.confidence ? R.confidence.minMeanVisibility : 0.55);
      gradeRep(rep, R);
      if (!rep.canGrade) { rep.qualityReliable = false; rep.score = null; }
      st.reps.push(rep);
      return rep;
    }

    function dominant(obj) {
      var best = 'unknown', bestN = 0, k;
      for (k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
        if (obj[k] > bestN) { bestN = obj[k]; best = k; }
      }
      return best;
    }

    function updatePhase(feat, ts) {
      var a = feat.kneeAvg;
      var raw = typeof feat.rawKnee === 'number' ? feat.rawKnee : a;
      if (a === null && raw === null) { st.pendingPhase = null; st.pendingFrames = 0; return st.phase; }

      // 超时保护：候选打开过久仍未完成 → 视作动作中断，作废不计数
      if (st.cur && (ts - st.cur.startTs) > ph.maxRepMs) discardRep();

      // 首次下蹲：用**未平滑**的角度开门，避免漏掉较浅的下蹲
      if (!st.cur && raw !== null && raw < ph.descendEnterAngle) {
        openRep(ts);
        st.phase = 'standing';   // 蹲下去之前必然处于站立，据此作为状态机起点
      }
      if (!st.cur) { st.pendingPhase = null; st.pendingFrames = 0; return st.phase; }

      /* 回到站立即刻结算。
       * 为什么要单独处理而不是走通用去抖：闭合条件是"已从最低点回到站立"，
       * 重复计数的风险由 bottomReached 门控与 minRepMs / maxRepMs 时长约束兜住；
       * 若这里还要等去抖帧数，采样稀疏时会整次动作都不结算。 */
      if (st.phase === 'ascending' && a !== null && a >= ph.standAngle) {
        st.phase = 'standing';
        st.pendingPhase = null;
        st.pendingFrames = 0;
        if (st.cur.bottomReached) closeRep(ts, true);
        else discardRep();
        return st.phase;
      }

      var target = null;
      if (st.phase === 'standing') {
        if (a <= ph.bottomEnterAngle) target = 'bottom';
        else if (a < ph.descendEnterAngle) target = 'descending';
      } else if (st.phase === 'descending') {
        if (a <= ph.bottomEnterAngle) target = 'bottom';
      } else if (st.phase === 'bottom') {
        if (a >= ph.bottomExitAngle) target = 'ascending';
      } else if (st.phase === 'ascending') {
        if (a >= ph.standAngle) target = 'standing';
        else if (a <= ph.bottomEnterAngle) target = 'bottom';   // 到达底部后又蹲了一次
      }

      if (target === null) { st.pendingPhase = null; st.pendingFrames = 0; return st.phase; }
      if (st.pendingPhase === target) {
        st.pendingFrames++;
      } else {
        st.pendingPhase = target;
        st.pendingFrames = 1;
      }
      if (st.pendingFrames < ph.debounceFrames) return st.phase;

      // ---- 确认切换 ----
      st.phase = target;
      st.pendingPhase = null;
      st.pendingFrames = 0;

      if (target === 'bottom' && !st.cur.bottomReached) {
        st.cur.bottomReached = true;
        st.cur.bottomTs = ts;
        st.cur.descendMs = ts - st.cur.descentStartTs;
      }
      // 回到站立即结算：到过最低点才计次，否则记为未完成循环（去重的关键）
      if (target === 'standing') {
        if (st.cur.bottomReached) closeRep(ts, true);
        else discardRep();
      }
      return st.phase;
    }

    function trackRep(feat, ts) {
      var rep = st.cur;
      if (!rep) return;
      rep.frames++;
      rep.visibilitySum += feat.visibility;
      rep.visibilityFrames++;
      if (feat.kneeAvg !== null && feat.kneeAvg < rep.minKneeAngle) rep.minKneeAngle = feat.kneeAvg;
      if (feat.kneeLeft !== null && feat.kneeRight !== null) {
        var diff = Math.abs(feat.kneeLeft - feat.kneeRight);
        if (diff > rep.maxSideDiffDeg) rep.maxSideDiffDeg = diff;
        rep.symmetrySamples++;
      }
      if (feat.lean !== null) {
        if (feat.lean > rep.maxLeanDeg) rep.maxLeanDeg = feat.lean;
        if (feat.lean < rep.minLeanDeg) rep.minLeanDeg = feat.lean;
        rep.leanSamples++;
      }
      if (rep.viewMode === 'unknown' && feat.view !== 'unknown') rep.viewMode = feat.view;
      // 下行回弹：下行阶段出现角度回升超过阈值
      if (st.phase === 'descending' || st.phase === 'bottom') {
        if (rep.prevKnee !== null && feat.kneeAvg !== null) {
          if (feat.kneeAvg - rep.prevKnee >= R.tempo.reversalDeg) rep.reversals++;
        }
      }
      rep.prevKnee = feat.kneeAvg;
    }

    function handleLoss(ts) {
      if (st.lastReliableTs === null) { st.lostMs = 0; return; }
      var gap = ts - st.lastReliableTs;
      if (gap > ph.lossResetMs && st.cur) {
        // 中断过久：放弃进行中的这一次，不计入次数
        st.cur = null;
        st.phase = 'unknown';
        st.pendingPhase = null; st.pendingFrames = 0;
        st.partialCycles++;
      }
    }

    /**
     * 推入一帧。
     * @returns {{phase:string, reliable:boolean, reason:string, missing:string[],
     *            kneeAvg:number|null, view:string, visibility:number,
     *            completedRep:object|null, repAlreadyOpen:boolean}}
     */
    function push(frame) {
      var ts = frame && typeof frame.tMs === 'number' ? frame.tMs : 0;
      st.framesTotal++;
      var feat = extractFrame(frame, R);

      if (!feat.reliable) {
        st.framesUnreliable++;
        st.lostMs = st.lastReliableTs === null ? st.lostMs : (ts - st.lastReliableTs);
        if (st.lastTs !== null) st.lowConfidenceMs += Math.max(0, Math.min(ts - st.lastTs, 1000));
        handleLoss(ts);
        st.lastTs = ts;
        return {
          phase: st.phase, reliable: false, reason: feat.reason, missing: feat.missing,
          kneeAvg: null, view: 'unknown', visibility: feat.visibility,
          completedRep: null, repAlreadyOpen: !!st.cur
        };
      }

      st.framesReliable++;
      st.lastReliableTs = ts;
      st.lostMs = 0;

      // EMA 平滑：抑制单帧抖动，但保留真实趋势
      if (feat.kneeAvg !== null) {
        st.smoothKnee = st.smoothKnee === null ? feat.kneeAvg
          : (ph.smoothAlpha * feat.kneeAvg + (1 - ph.smoothAlpha) * st.smoothKnee);
      }
      var smoothed = {
        kneeAvg: st.smoothKnee,
        /* 原始角度用于"是否开始一次下蹲"的判定：平滑值有滞后，
         * 用它做开门条件会漏掉幅度偏浅的动作（浅蹲恰恰最需要提示）。 */
        rawKnee: feat.kneeAvg,
        kneeLeft: feat.kneeLeft, kneeRight: feat.kneeRight,
        visibility: feat.visibility, lean: feat.lean, view: feat.view, missing: feat.missing
      };
      if (feat.view !== 'unknown') st.viewSamples[feat.view] = (st.viewSamples[feat.view] || 0) + 1;
      st.visibilitySum += feat.visibility; st.visibilityFrames++;

      var before = st.reps.length;
      var phase = updatePhase(smoothed, ts);
      trackRep(smoothed, ts);

      var completed = st.reps.length > before ? st.reps[st.reps.length - 1] : null;
      st.lastTs = ts;
      return {
        phase: phase, reliable: true, reason: '', missing: feat.missing,
        kneeAvg: smoothed.kneeAvg, view: feat.view, visibility: feat.visibility,
        completedRep: completed, repAlreadyOpen: !!st.cur
      };
    }

    /** 结束训练：把进行中的半次动作作废（未完成，不计数） */
    function finish(ts) {
      if (st.cur) {
        st.cur = null;
        st.partialCycles++;
      }
      return true;
    }

    function stdev(arr) {
      if (arr.length < 2) return 0;
      var m = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
      var v = arr.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / arr.length;
      return Math.sqrt(v);
    }

    /**
     * 生成复盘统计。只产出数字与依据，不生成自然语言结论。
     * 样本不足时明确返回 insufficient 标记，禁止页面据此编造结论。
     */
    function summary(input) {
      input = input || {};
      var reps = st.reps;
      var startTs = input.startTs != null ? input.startTs : (reps.length ? reps[0].startTs : 0);
      var endTs = input.endTs != null ? input.endTs : (reps.length ? reps[reps.length - 1].endTs : 0);
      var graded = reps.filter(function (r) { return r.canGrade && r.qualityReliable; });
      var lowConf = reps.filter(function (r) { return !r.canGrade || !r.qualityReliable; });

      var dimCodes = ['depth', 'tempo', 'symmetry', 'torso'];
      var dimStats = dimCodes.map(function (code) {
        var scores = [], unavailableCount = 0, statuses = {};
        reps.forEach(function (r) {
          (r.dims || []).forEach(function (d) {
            if (d.code !== code) return;
            if (d.status === 'unavailable') { unavailableCount++; return; }
            scores.push(d.score);
            statuses[d.status] = (statuses[d.status] || 0) + 1;
          });
        });
        var avg = scores.length ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length) : null;
        return {
          code: code, avgScore: avg, sampleCount: scores.length,
          unavailableCount: unavailableCount, statuses: statuses,
          evaluable: scores.length > 0
        };
      });

      var durations = reps.map(function (r) { return r.durationMs; });
      var repScores = graded.map(function (r) { return r.score; });

      return {
        exerciseType: R.exerciseType,
        exerciseLabel: R.exerciseLabel,
        ruleVersion: R.ruleVersion,
        dataVersion: R.dataVersion,
        startTs: startTs, endTs: endTs,
        durationMs: Math.max(0, endTs - startTs),
        framesTotal: st.framesTotal,
        framesReliable: st.framesReliable,
        framesUnreliable: st.framesUnreliable,
        lowConfidenceMs: Math.round(st.lowConfidenceMs),
        detectionRate: st.framesTotal ? +(st.framesReliable / st.framesTotal).toFixed(3) : 0,
        meanLandmarkVisibility: st.visibilityFrames ? +(st.visibilitySum / st.visibilityFrames).toFixed(3) : 0,
        viewMode: dominant(st.viewSamples),
        repsTotal: reps.length,
        repsValid: graded.length,
        repsLowConfidence: lowConf.length,
        partialCycles: st.partialCycles,
        avgRepDurationMs: durations.length ? Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length) : null,
        repDurationStdMs: durations.length ? Math.round(stdev(durations)) : null,
        qualityScoreAvg: repScores.length ? Math.round(repScores.reduce(function (a, b) { return a + b; }, 0) / repScores.length) : null,
        dims: dimStats,
        reps: reps.map(function (r) {
          return {
            index: r.index, startTs: r.startTs, endTs: r.endTs, durationMs: r.durationMs,
            minKneeAngle: round1(r.minKneeAngle), score: r.score,
            qualityReliable: r.qualityReliable, canGrade: r.canGrade,
            detectionConfidence: r.detectionConfidence, viewMode: r.viewMode,
            dims: r.dims
          };
        }),
        tempoStability: (function () {
          if (durations.length < R.tempo.minSampleReps) return { evaluable: false, reason: '样本数量不足，不做节奏稳定性评价' };
          var sd = stdev(durations);
          var mean = durations.reduce(function (a, b) { return a + b; }, 0) / durations.length;
          return { evaluable: true, ratio: +(sd / mean).toFixed(3), stable: (sd / mean) <= R.tempo.stabilityRatio };
        })(),
        insufficient: {
          noRep: reps.length === 0,
          noGradedRep: graded.length === 0 && reps.length > 0,
          tooShort: reps.length > 0 && reps.length < 3
        }
      };
    }

    return {
      push: push,
      finish: finish,
      summary: summary,
      rules: R,
      state: function () { return st; }
    };
  }

  function round1(n) { return Math.round(n * 10) / 10; }
  function viewLabel(v) {
    if (v === 'frontal') return '正面';
    if (v === 'sagittal') return '侧面';
    if (v === 'oblique') return '斜向';
    return '未知';
  }

  return {
    angleAt: angleAt,
    torsoLeanDeg: torsoLeanDeg,
    estimateView: estimateView,
    kneeAngle: kneeAngle,
    extractFrame: extractFrame,
    minVis: minVis,
    meanVis: meanVis,
    vis: vis,
    scoreDepth: scoreDepth,
    scoreTempo: scoreTempo,
    scoreSymmetry: scoreSymmetry,
    scoreTorso: scoreTorso,
    composeScore: composeScore,
    createAnalyzer: createAnalyzer,
    viewLabel: viewLabel
  };
});
