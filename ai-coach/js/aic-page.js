/* Fitness XP — AI 动作教练 页面控制层
 *
 * 职责：只做"编排与渲染"。任何几何计算、评分、冷却判断都在下层模块里，本文件不含业务规则。
 * 对外暴露 window.FXPAICoach，便于浏览器 E2E 在无摄像头环境下验证逻辑与降级路径。
 */
(function () {
  'use strict';

  var C = window.FXP.aicConfig;
  var A = window.FXP.aicAnalyze;
  var FB = window.FXP.aicFeedback;
  var RV = window.FXP.aicReview;
  var AIM = window.FXP.aicAI;
  var ST = window.FXP.aicStore;
  var PZ = window.FXP.aicPose;

  var LM = C.LM;

  /* 当前动作。任务书要求：先由训练者明确选择动作，不能靠"自动猜测"分类。
   * 所有阈值/等级/机位说明都从这一份 rules 里取，页面不另存一套。 */
  var currentType = (C.RULE_LIST && C.RULE_LIST[0]) || 'bodyweight_squat';
  var rules = C.getRules(currentType);

  function useExercise(type) {
    var r = C.getRules(type);
    if (!r) return false;
    currentType = type;
    rules = r;
    return true;
  }

  /* MediaPipe 官方骨架连线（躯干 + 下肢 + 上肢，随三大项与手臂动作启用） */
  var CONNECTIONS = [
    [11, 12], [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28],
    [27, 31], [28, 32], [27, 29], [28, 30],
    [11, 13], [13, 15], [12, 14], [14, 16]
  ];

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    video: $('aicVideo'), canvas: $('aicCanvas'), stage: $('stage'), overlay: $('stageOverlay'),
    ovTitle: $('ovTitle'), ovText: $('ovText'), ovActions: $('ovActions'),
    toast: $('stageToast'), metrics: $('stageMetrics'),
    mTotal: $('mTotal'), mValid: $('mValid'), mScore: $('mScore'), mPhase: $('mPhase'),
    pillCam: $('pillCam'), pillModel: $('pillModel'), pillSession: $('pillSession'),
    stageHint: $('stageHint'), notice: $('camNotice'),
    btnCam: $('btnCam'), btnStart: $('btnStart'), btnEnd: $('btnEnd'), btnStopCam: $('btnStopCam'),
    selMember: $('selMember'), selSound: $('selSound'),
    selExercise: $('selExercise'), inpWeight: $('inpWeight'), monitorBox: $('monitorBox'),
    inpEndpoint: $('inpEndpoint'), inpModel: $('inpModel'), chkAI: $('chkAI'),
    btnSaveAI: $('btnSaveAI'), aiState: $('aiState'),
    cardReview: $('cardReview'), reviewBody: $('reviewBody'), aiBlock: $('aiBlock'),
    btnAIReview: $('btnAIReview'), btnSaveRecord: $('btnSaveRecord'),
    recordsBody: $('recordsBody'), btnExport: $('btnExport'), btnClear: $('btnClear'),
    devOut: $('devOut'), btnDevRun: $('btnDevRun'), devReps: $('devReps'), devAngle: $('devAngle'),
    devAngleLab: $('devAngleLab'), devLowVis: $('devLowVis'),
    disclaimer: $('disclaimer')
  };

  var ctx = els.canvas.getContext('2d');
  var store = ST.createStore({ storage: safeStorage() });
  var adapter = AIM.createAdapter({ storage: safeStorage() });
  var camera = PZ.createCamera({});
  var landmarkerBox = PZ.createLandmarker({});
  var detectFrame = PZ.createDetectorRunner({});

  var app = {
    cameraOpen: false, modelReady: false, training: false,
    analyzer: null, fb: null, raf: null, lastVideoTs: 0, lastDetectMs: 0,
    sessionStart: 0, sessionEnd: 0, lastSummary: null, lastReview: null,
    feedbackLog: [], lastSummarySnapshot: null, saved: false, aiResult: null
  };

  function safeStorage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  /* ==================== 初始化 ==================== */

  function init() {
    els.disclaimer.innerHTML =
      '<strong>关于本原型的说明：</strong><br>' +
      C.DISCLAIMER.replace(/。/g, '。<br>') +
      '<br><br>' + C.METRIC_NOTE.detection + '<br>' + C.METRIC_NOTE.quality +
      '<br>本页数据与教练端仪表盘<strong>相互独立、不会自动同步</strong>；AI 复盘需要你自己的服务端代理，' +
      '未配置时显示「AI 复盘尚未启用」。';

    renderExercises();
    renderMonitor();
    renderMembers();
    renderAIState();
    renderRecords();
    probeAndHint();
    bindEvents();
    setOverlay('尚未开启摄像头',
      '开启后，画面只在本机浏览器内处理，不录制、不上传、不写入磁盘。实时骨架仅用于辅助确认是否站进画面。',
      [{ label: '开启摄像头', cls: 'primary', fn: startCamera }]);
  }

  function probeAndHint() {
    var p = PZ.capabilityProbe();
    if (p.level === 'blocked') {
      setNotice('error', p.reason);
      els.btnCam.disabled = true;
      setPill(els.pillCam, 'off', '摄像头：不可用');
    } else if (!p.hasGetUserMedia) {
      setNotice('error', p.reason);
      els.btnCam.disabled = true;
    }
  }

  function bindEvents() {
    if (els.selExercise) els.selExercise.addEventListener('change', onChangeExercise);
    els.btnCam.addEventListener('click', startCamera);
    els.btnStopCam.addEventListener('click', stopCamera);
    els.btnStart.addEventListener('click', startSession);
    els.btnEnd.addEventListener('click', endSession);
    els.btnSaveAI.addEventListener('click', saveAISettings);
    els.btnAIReview.addEventListener('click', requestAI);
    els.btnSaveRecord.addEventListener('click', saveRecord);
    els.btnExport.addEventListener('click', exportCSV);
    els.btnClear.addEventListener('click', clearRecords);
    els.btnDevRun.addEventListener('click', runSynthetic);

    /* 离开页面 / 切后台：必须释放摄像头 */
    window.addEventListener('pagehide', function () { hardRelease(); });
    window.addEventListener('beforeunload', function () { hardRelease(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && app.training) endSession('离开页面');
    });
    window.addEventListener('resize', fitCanvas);
  }

  function hardRelease() {
    stopLoop();
    try { if (landmarkerBox) landmarkerBox.close(); } catch (e) { /* ignore */ }
    try { camera.stop(); } catch (e) { /* ignore */ }
    app.cameraOpen = false; app.modelReady = false;
  }

  /* ==================== 摄像头 ==================== */

  function startCamera() {
    setBusy('正在请求摄像头权限…');
    camera.start().then(function (info) {
      app.cameraOpen = true;
      els.video.srcObject = info.stream;
      els.video.hidden = false;
      var p = els.video.play();
      if (p && p.catch) p.catch(function () { /* autoplay 被拦截时由用户手势再次触发 */ });
      els.btnCam.disabled = true;
      els.btnStopCam.disabled = false;
      els.overlay.hidden = true;
      setPill(els.pillCam, 'ok', '摄像头：已开启');
      setNotice('info', '摄像头已开启。画面只在本机处理，不会被录像或上传。建议侧对镜头站立、让全身进入画面。');
      els.stageHint.textContent = '模型加载中…';
      fitCanvas();
      return loadModel();
    }).then(function () {
      app.modelReady = true;
      els.btnStart.disabled = false;
      els.stageHint.textContent = '可以开始训练';
      setPill(els.pillModel, 'ok', '姿态识别：就绪');
      startLoop();           // 预览模式下也跑识别，便于确认站位
    }).catch(function (e) {
      setNotice('error', (e && e.text) ? e.text : String(e));
      setPill(els.pillCam, 'error', '摄像头：失败');
      els.btnCam.disabled = false;
      setOverlay('摄像头无法开启', (e && e.text) ? e.text : '请检查浏览器权限设置。',
        [{ label: '重试', cls: 'primary', fn: startCamera }]);
    });
  }

  function loadModel() {
    setPill(els.pillModel, 'warn', '姿态识别：加载中');
    return landmarkerBox.load().then(function () { return true; })
      .catch(function (e) {
        setPill(els.pillModel, 'error', '姿态识别：失败');
        setNotice('error', (e && e.text) ? e.text : '模型加载失败。');
        throw e;
      });
  }

  function stopCamera() {
    stopLoop();
    endSessionIfTraining('摄像头已关闭');
    try { camera.stop(); } catch (e) { /* ignore */ }
    try { landmarkerBox.close(); } catch (e) { /* ignore */ }
    app.cameraOpen = false; app.modelReady = false;
    els.video.srcObject = null; els.video.hidden = true;
    clearCanvas();
    els.btnCam.disabled = false;
    els.btnStopCam.disabled = true;
    els.btnStart.disabled = true;
    els.metrics.hidden = true;
    setPill(els.pillCam, 'off', '摄像头：未开启');
    setPill(els.pillModel, 'off', '姿态识别：未加载');
    setNotice('info', '摄像头已关闭，媒体轨道已释放。');
    setOverlay('摄像头已关闭', '需要时可再次开启。画面不会被保存。',
      [{ label: '重新开启', cls: 'primary', fn: startCamera }]);
  }

  /* ==================== 训练会话 ==================== */

  function startSession() {
    if (!app.modelReady || !app.cameraOpen) return;
    app.analyzer = A.createAnalyzer({ rules: rules, LM: LM });
    app.fb = FB.createFeedbackEngine({ rules: rules });
    app.feedbackLog = [];
    app.training = true;
    app.saved = false;
    app.aiResult = null;
    app.sessionStart = Date.now();
    els.metrics.hidden = false;
    els.btnStart.disabled = true;
    els.btnEnd.disabled = false;
    els.cardReview.hidden = true;
    els.aiBlock.hidden = true;
    setPill(els.pillSession, 'ok', '训练：进行中');
    updateMetrics(0, 0, null, '待识别');
  }

  function endIfTrainingWrap() { /* kept for clarity */ }

  function endSessionIfTraining(reason) {
    if (!app.training) return;
    endSession(reason);
  }

  function endSession(reason) {
    if (!app.training) return;
    app.training = false;
    app.sessionEnd = Date.now();
    if (app.analyzer) app.analyzer.finish(Date.now());
    els.btnEnd.disabled = true;
    els.btnStart.disabled = !app.modelReady;
    setPill(els.pillSession, 'warn', '训练：已结束');
    hideToast();
    var s = app.analyzer.summary({ startTs: app.sessionStart, endTs: app.sessionEnd });
    app.lastSummary = s;
    app.lastReview = RV.buildReview(s, rules);
    renderReview(app.lastReview, s);
    if (reason) setNotice('info', '训练已结束（' + reason + '），本次统计已生成。');
  }

  /* ==================== 主循环 ==================== */

  function startLoop() {
    if (app.raf) return;
    var step = function () {
      if (!app.cameraOpen) { app.raf = null; return; }
      try { tick(); } catch (e) { /* 单帧异常不应中断训练 */ }
      app.raf = requestAnimationFrame(step);
    };
    app.raf = requestAnimationFrame(step);
  }

  function stopLoop() {
    if (app.raf) cancelAnimationFrame(app.raf);
    app.raf = null;
  }

  function tick() {
    var v = els.video;
    if (!v || v.readyState < 2 || !landmarkerBox.ready()) return;
    var nowMs = Date.now();
    if (nowMs - app.lastDetectMs < 33) { drawLast(); return; }   // 约 30fps 足够
    app.lastDetectMs = nowMs;

    var inst = landmarkerBox.ready() ? landmarkerBox.get() : null;
    if (!inst) return;
    var res = detectFrame(inst, v, app.lastVideoTs);
    if (!res) return;
    app.lastVideoTs = res.tMs;
    var frame = { tMs: res.tMs, landmarks: res.landmarks };
    app.lastLandmarks = res.landmarks;
    drawSkeleton(res.landmarks);

    if (!app.training || !app.analyzer) return;

    var r = app.analyzer.push(frame);
    onFrameResult(r, frame);
  }

  function landmarkerInstance() {
    // landmarkerBox 内部持有实例；page 层通过 ready() 判断是否可用
    return null;
  }

  function drawLast() { drawSkeleton(app.lastLandmarks); }

  function onFrameResult(r, frame) {
    var st = app.analyzer.state();
    var reps = st.reps;
    var validCount = reps.filter(function (x) { return x.canGrade && x.qualityReliable; }).length;
    var last = reps.length ? reps[reps.length - 1] : null;

    // 身体是否完整入框：关键点是否落在画面安全区内
    var inFrame = frame.landmarks ? bodyInFrame(frame.landmarks) : null;

    updateMetrics(reps.length, validCount,
      last ? (last.canGrade && last.qualityReliable ? last.score : null) : null,
      phaseLabel(r.phase));

    /* 画面不可靠时：不输出质量结论，只说"无法可靠评估" */
    if (!r.reliable) {
      showToast('warn', inFrame === false ? '请调整站位，确保全身进入画面' : '当前关键点不可见，暂时无法评估');
      return;
    }

    var fbRes = app.fb.update({
      reliable: r.reliable, reason: r.reason, missing: r.missing, view: r.view,
      inFrame: inFrame, phase: r.phase, completedRep: r.completedRep,
      partialCycle: detectPartial(st), trackLost: false
    });

    if (r.completedRep) {
      pushFeedback('rep', r.completedRep.index, r.completedRep.canGrade && r.completedRep.qualityReliable ? r.completedRep.score : null);
      if (els.selSound.value === 'on') beep(r.completedRep.canGrade && r.completedRep.qualityReliable);
    }
    if (fbRes) {
      pushFeedback(fbRes.code, null, null);
      showToast(fbRes.level, fbRes.text);
    }
  }

  /** 检测"下去了但没到最低点就回来"的情况：通过 partialCycles 增量判断 */
  var lastPartialCount = 0;
  function detectPartial(st) {
    var n = st.partialCycles;
    var changed = n > lastPartialCount;
    lastPartialCount = n;
    return changed;
  }

  /* ==================== 渲染 ==================== */

  /** 阶段名按当前动作取：卧推不再显示"下蹲中" */
  function phaseLabel(p) {
    if (p === 'unknown') return '待识别';
    var m = (rules && rules.phaseLabels) || {};
    return m[p] || p;
  }

  function bodyInFrame(lm) {
    // 允许 6% 边距；检查范围取当前动作的必看点（上肢动作不要求脚踝入框）
    var m = 0.04;
    var need = (rules && rules.required && rules.required.core) ||
      [LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE];
    for (var i = 0; i < need.length; i++) {
      var p = lm[need[i]];
      if (!p) return null;
      if (p.x < m || p.x > 1 - m || p.y < m || p.y > 1 - m) return false;
    }
    return true;
  }

  function updateMetrics(total, valid, score, phase) {
    els.mTotal.textContent = total;
    els.mValid.textContent = valid;
    els.mScore.textContent = (score === null || score === undefined) ? '—' : String(score);
    els.mPhase.textContent = phase;
  }

  function fitCanvas() {
    var rect = els.stage.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    els.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    els.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function clearCanvas() {
    if (!ctx) return;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  }

  /* object-fit: cover 的映射：把归一化的视频坐标换算到画布像素 */
  function projector() {
    var v = els.video;
    var vw = v.videoWidth || 640, vh = v.videoHeight || 480;
    var cw = els.canvas.width, ch = els.canvas.height;
    var scale = Math.max(cw / vw, ch / vh);
    var dw = vw * scale, dh = vh * scale;
    var ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    return function (p) { return { x: ox + p.x * dw, y: oy + p.y * dh }; };
  }

  function drawSkeleton(lm) {
    if (!ctx) return;
    clearCanvas();
    if (!lm || !lm.length) return;
    var map = projector();
    var pts = lm.map(function (p) { return map(p); });

    ctx.lineWidth = Math.max(2, (window.devicePixelRatio || 1) * 2.5);
    ctx.strokeStyle = 'rgba(94,234,212,.95)';
    ctx.beginPath();
    CONNECTIONS.forEach(function (c) {
      var a = pts[c[0]], b = pts[c[1]];
      if (!a || !b) return;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    });
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,.95)';
    var focus = [LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE];
    focus.forEach(function (i) {
      var p = pts[i];
      if (!p) return;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, (window.devicePixelRatio || 1) * 3.5), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  var toastTimer = null;
  function showToast(level, text) {
    els.toast.textContent = text;
    els.toast.setAttribute('data-level', level);
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 3200);
  }
  function hideToast() { els.toast.hidden = true; }

  function setPill(el, level, text) { el.setAttribute('data-level', level); el.textContent = text; }

  function setNotice(cls, html) {
    els.notice.hidden = false;
    els.notice.className = 'notice ' + cls;
    els.notice.innerHTML = html;
  }

  function setBusy(text) { els.stageHint.textContent = text; }

  function setOverlay(title, text, actions) {
    els.overlay.hidden = false;
    els.ovTitle.textContent = title;
    els.ovText.innerHTML = text;
    els.ovActions.innerHTML = '';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ' + (a.cls || ''); b.textContent = a.label;
      b.addEventListener('click', a.fn);
      els.ovActions.appendChild(b);
    });
  }

  /* ==================== 复盘渲染 ==================== */

  function renderReview(review, s) {
    els.cardReview.hidden = false;
    var h = '';
    h += '<div class="review-grid">';
    h += box('t-blue', '识别次数', review.counts.repsTotal + ' 次');
    h += box('t-teal', '有效次数', review.counts.repsValid + ' 次');
    h += box('t-orange', '置信度不足', review.counts.repsLowConfidence + ' 次');
    h += box('t-purple', '动作质量', review.quality.evaluable ? review.quality.scoreAvg + ' 分' : '无法评估');
    h += box('', '识别成功率', Math.round(review.detection.rate * 100) + '%');
    h += box('', '训练时长', Math.round(review.durationMs / 1000) + ' 秒');
    h += '</div>';

    h += '<div class="tip">' + review.detection.note + '　' + review.quality.note + '</div>';

    h += '<p class="review-sub">各维度表现</p>';
    review.dimensions.forEach(function (d) {
      var pct = d.avgScore === null ? 0 : Math.max(0, Math.min(100, d.avgScore));
      var level = d.avgScore === null ? 'unknown' : (pct >= 85 ? 'good' : pct >= 70 ? 'ok' : pct >= 55 ? 'partial' : 'poor');
      h += '<div class="dim-row">' +
        '<span class="dim-name">' + esc(d.label) + '</span>' +
        '<span class="dim-bar" data-level="' + level + '"><i style="width:' + pct + '%"></i></span>' +
        '<span class="dim-val">' + esc(d.display) + '</span>' +
        '</div>';
    });

    h += '<p class="review-sub">本次最值得改进</p>';
    h += review.improvements.length
      ? '<ol class="review-list">' + review.improvements.map(function (i) { return '<li>' + esc(i.text) + '</li>'; }).join('') + '</ol>'
      : '<p class="empty">有效样本不足，暂不给出改进结论。</p>';

    h += '<p class="review-sub">下一次训练建议</p>';
    h += review.nextSteps.length
      ? '<ul class="review-list">' + review.nextSteps.map(function (n) { return '<li>' + esc(n.text) + '</li>'; }).join('') + '</ul>'
      : '<p class="empty">继续按当前方式练习，累计更多有效样本后再看趋势。</p>';

    h += '<p class="review-sub">本次评估的局限性</p>';
    h += '<ul class="review-list">' + review.limitations.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';

    if (review.caveat) h += '<p class="tip"><strong>' + esc(review.caveat) + '</strong></p>';
    h += '<p class="tip">规则版本 ' + esc(review.ruleVersion) + ' · 数据版本 ' + review.dataVersion + '</p>';

    els.reviewBody.innerHTML = h;
    els.cardReview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function box(cls, lab, val) {
    return '<div class="rbox ' + cls + '"><div class="rb-lab">' + esc(lab) + '</div><div class="rb-val">' + esc(val) + '</div></div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ==================== 动作选择与监测能力说明 ==================== */

  function renderExercises() {
    if (!els.selExercise) return;
    var list = C.RULE_LIST || Object.keys(C.RULES);
    var h = '';
    list.forEach(function (t) {
      var r = C.RULES[t];
      if (!r) return;
      var lv = (r.monitor && r.monitor.level) || 'C';
      h += '<option value="' + esc(t) + '"' + (t === currentType ? ' selected' : '') + '>'
        + esc(r.exerciseLabel) + '（' + lv + ' 级：' + C.LEVEL_TEXT[lv] + '）</option>';
    });
    els.selExercise.innerHTML = h;
    /* 未配置的动作一律不出现在菜单里 —— 不在菜单 = 不宣称支持 */
    var extra = Object.keys(C.RULES).filter(function (t) { return list.indexOf(t) < 0; });
    extra.forEach(function (t) {
      var r = C.RULES[t];
      els.selExercise.appendChild((function () {
        var o = document.createElement('option');
        o.value = t; o.textContent = r.exerciseLabel;
        return o;
      })());
    });
  }

  /** 监测能力说明：等级 / 机位 / 必须可见 / 能算什么 / 明确不算什么 / 限制 */
  function renderMonitor() {
    if (!els.monitorBox) return;
    var m = C.getMonitor(currentType);
    var lv = m.level;
    var h = ''
      + '<div class="mon-head">'
      + '<span class="mon-level ' + lv + '">' + lv + ' 级 · ' + esc(C.LEVEL_TEXT[lv]) + '</span>'
      + '<span class="mon-title">' + esc(rules ? rules.exerciseLabel : currentType) + '</span>'
      + '</div>'
      + '<div class="mon-note">' + esc(C.LEVEL_NOTE[lv]) + '</div>'
      + '<div class="mon-rows">';
    if (m.view) h += '<div><b>建议机位：</b>' + esc(m.view) + '</div>';
    if (m.mustVisible && m.mustVisible.length) {
      h += '<div><b>必须可见：</b>' + esc(m.mustVisible.join('、')) + '</div>';
    }
    h += '<div><b>本动作可以算出：</b></div><ul class="mon-list">'
      + (m.measurable || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('')
      + '</ul>';
    h += '<div><b>明确不算（不会给出结论）：</b></div><ul class="mon-list">'
      + (m.notMeasurable || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('')
      + '</ul>';
    if (m.limitations && m.limitations.length) {
      h += '<div><b>已知限制：</b></div><ul class="mon-list">'
        + m.limitations.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('')
        + '</ul>';
    }
    if (m.notes) h += '<div class="mon-note">' + esc(m.notes) + '</div>';
    h += '</div>';
    els.monitorBox.innerHTML = h;
    syncDevAngleField();
  }

  /* 合成数据的目标角度输入框要跟着动作走：主角度从膝角变成肘角/肩角/髋角，
   * 标签和默认值都变了。不改的话，切到臀桥还让用户填「最深膝角 85°」，
   * 跑出来 0 次 —— 用户会以为是算法不认这个动作。 */
  function syncDevAngleField() {
    if (!els.devAngle) return;
    var isMax = !!(rules && rules.depth && rules.depth.mode === 'max');
    var label = (rules && rules.metric && rules.metric.label) || '主角度';
    if (els.devAngleLab) els.devAngleLab.textContent = '目标' + label;
    /* 默认给一个"刚好到位"的角度：两种口径的到位端都在 bottomEnterAngle 那一侧 */
    var p = (rules && rules.phase) || {};
    var def = isMax
      ? Math.min(178, (p.bottomEnterAngle || 90) + 8)
      : Math.max(8, (p.bottomEnterAngle || 95) - 8);
    els.devAngle.value = String(Math.round(def));
  }

  function onChangeExercise() {
    if (app.training) {
      /* 训练中换动作会让已计数的那一段失去规则归属，直接拒绝并回显原值 */
      els.selExercise.value = currentType;
      setNotice('warn', '训练进行中不能切换动作。请先结束训练，再切换。');
      return;
    }
    if (useExercise(els.selExercise.value)) {
      renderMonitor();
      setNotice('info', '已切换到「' + rules.exerciseLabel + '」，规则版本 ' + rules.ruleVersion + '。'
        + (rules.monitor && rules.monitor.view ? ' 建议机位：' + rules.monitor.view : ''));
    }
  }

  /* ==================== AI 复盘 ==================== */

  function renderAIState() {
    var st = adapter.getStatus();
    var cls = st.status === 'ready' ? 'ok' : (st.status === 'disabled' ? 'warn' : 'bad');
    els.aiState.className = 'adv-state ' + cls;
    els.aiState.textContent = st.message;
  }

  function saveAISettings() {
    var endpoint = els.inpEndpoint.value.trim();
    var r = adapter.configure({ enabled: els.chkAI.checked, endpoint: endpoint, model: els.inpModel.value.trim() || 'deepseek-chat' });
    renderAIState();
    if (r.ok) setNotice('info', 'AI 代理设置已保存（不含任何密钥信息）。');
    else setNotice('error', '设置保存失败：' + (r.message || r.reason));
    var st = adapter.getStatus();
    els.chkAI.checked = st.status === 'ready';
    renderAIState();
  }

  function requestAI() {
    if (!app.lastReview) return;
    var st = adapter.getStatus();
    els.aiBlock.hidden = false;
    if (st.status !== 'ready') {
      els.aiBlock.innerHTML = '<div class="ai-tag">AI 复盘</div>' + esc(st.message) +
        '<br><span class="tip">本地评分与训练记录不受影响。</span>';
      app.aiResult = { ok: false, status: st.status };
      return;
    }
    els.aiBlock.innerHTML = '<div class="ai-tag">AI 复盘</div>正在请求代理…';
    adapter.review(app.lastReview, currentMemberContext()).then(function (res) {
      app.aiResult = res;
      if (!res.ok) {
        els.aiBlock.innerHTML = '<div class="ai-tag">AI 复盘</div>' + esc(res.message || ('失败：' + res.reason)) +
          '<br><span class="tip">本地复盘结果仍然有效。</span>';
        return;
      }
      var t = res.text;
      var html = '<div class="ai-tag">AI 复盘（基于本地已计算的数据）</div>';
      if (t.summary) html += esc(t.summary);
      if (t.suggestions && t.suggestions.length) {
        html += '<ul class="review-list">' + t.suggestions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
      }
      if (t.note) html += '<span class="tip">' + esc(t.note) + '</span>';
      html += '<div class="tip">以上为模型对本地数据的文字解读；所有次数、角度、评分均取自本地规则计算的结果。</div>';
      els.aiBlock.innerHTML = html;
    });
  }

  function currentMemberContext() {
    // 只允许非敏感上下文；不选手机号等身份信息
    var sel = els.selMember.value;
    if (!sel || sel.indexOf('test:') === 0) return { anonymous: true, note: '测试用户' };
    var opt = els.selMember.options[els.selMember.selectedIndex];
    return { member_id: sel, goal: opt.getAttribute('data-goal') || '' };
  }

  /* ==================== 记录 ==================== */

  /** 读取手填重量：非法/留空一律返回 null（记为自重），绝不猜一个值 */
  function readWeightKg() {
    if (!els.inpWeight) return null;
    var v = parseFloat(els.inpWeight.value);
    if (!isFinite(v) || v < 0) return null;
    return Math.round(v * 10) / 10;
  }

  function saveRecord() {
    if (!app.lastReview) return;
    var aiStatus = !app.aiResult ? 'disabled' : (app.aiResult.ok ? 'done' : (app.aiResult.status || 'failed'));
    var r = store.saveSession(app.lastReview, {
      memberRef: els.selMember.value || 'test:local',
      aiStatus: app.aiResult ? aiStatus : 'unavailable',
      aiText: (app.aiResult && app.aiResult.ok && app.aiResult.text) ? (app.aiResult.text.summary || '') : '',
      aiError: (app.aiResult && !app.aiResult.ok) ? (app.aiResult.reason || '') : '',
      startTs: app.sessionStart, endTs: app.sessionEnd,
      feedbackSummary: app.feedbackLog.slice(-20),
      /* 重量是会员手填的，不是识别出来的：留空就是自重 */
      weightKg: readWeightKg()
    });
    if (r.ok) {
      app.saved = true;
      setNotice('info', '已保存本次 AI 训练记录（' + r.record.ai_session_id + '）。当前共 ' + r.count + ' 条。');
      renderRecords();
    } else {
      setNotice('error', r.message || ('保存失败：' + r.reason));
    }
  }

  function renderRecords() {
    var r = store.list();
    var recs = r.ok ? r.records : [];
    if (!r.ok) {
      els.recordsBody.innerHTML = '<p class="empty">读取记录失败：' + esc(r.reason) + '</p>';
      return;
    }
    if (!recs.length) {
      els.recordsBody.innerHTML = '<p class="empty">还没有记录。完成一次训练并点击「保存本次记录」后会出现在这里。</p>';
      return;
    }
    els.recordsBody.innerHTML = recs.slice(0, 30).map(function (x) {
      return '<div class="rec">' +
        '<div class="rec-head"><span class="rec-id">' + esc(x.ai_session_id) + '</span>' +
        '<span>' + esc(x.exercise_label || x.exercise_type) + '</span>' +
        '<span class="rec-sub">' + esc(String(x.created_at).slice(0, 19).replace('T', ' ')) + '</span></div>' +
        '<div class="rec-sub">识别 ' + x.reps_total + ' 次 · 有效 ' + x.reps_valid + ' 次 · 置信度不足 ' + x.reps_low_confidence +
        ' 次 · 识别成功率 ' + Math.round(x.detection_rate * 100) + '% · 质量 ' +
        (x.quality_score_avg === null ? '无法评估' : x.quality_score_avg + ' 分') +
        ' · AI ' + esc(x.ai_status) + ' · 规则 ' + esc(x.rule_version) + '</div>' +
        '</div>';
    }).join('');
  }

  function exportCSV() {
    var r = store.list();
    if (!r.ok || !r.records.length) { setNotice('warn', '没有可导出的记录。'); return; }
    var csv = store.toCSV(r.records);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fxp-ai-coach-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    setNotice('info', '已导出 ' + r.records.length + ' 条 AI 训练记录（仅摘要，不含视频或关键点序列）。');
  }

  function clearRecords() {
    if (!window.confirm('确定清空本机所有 AI 训练记录？此操作不可恢复，建议先导出 CSV。')) return;
    store.clearAll();
    renderRecords();
    setNotice('info', '已清空 AI 训练记录。');
  }

  function renderMembers() {
    var list = store.readCoachMembers();
    list.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.member_id;
      o.textContent = m.member_id + ' · ' + (m.name || '未命名');
      o.setAttribute('data-goal', m.goal || '');
      els.selMember.appendChild(o);
    });
  }

  function beep(good) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ac = beep._ac || (beep._ac = new AC());
      var o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = good ? 880 : 520;
      g.gain.value = 0.05;
      o.connect(g); g.connect(ac.destination);
      o.start(); setTimeout(function () { o.stop(); }, 90);
    } catch (e) { /* 声音不可用时忽略 */ }
  }

  function pushFeedback(code, repIndex, score) {
    app.feedbackLog.push({ ts: Date.now(), code: code, rep: repIndex || null, score: score === undefined ? null : score });
    if (app.feedbackLog.length > 200) app.feedbackLog.shift();
  }

  /* ==================== 合成数据（仅开发验证） ==================== */

  /**
   * 构造一段虚拟关键点序列：起始位 → 做到 targetAngle → 回起始位，重复 reps 次。
   * 方向由当前动作口径决定：min 口径往角度小的方向做（深蹲/卧推），
   * max 口径往角度大的方向做（臀桥顶髋/侧平举抬起）。
   * 明确用于在没有摄像头时验证算法；不代表真实识别效果。
   */
  function synthFrames(reps, targetAngle, lowVis) {
    var frames = [];
    var t = 0;
    var visibility = lowVis ? 0.25 : 0.92;
    var up = (rules.depth && rules.depth.mode === 'max');
    /* 起始位在"不做功"的一端：min 口径是角度大的一侧，max 口径是角度小的一侧 */
    var top = up ? Math.max(8, (rules.phase.standAngle || 152) - 18)
                 : Math.min(178, (rules.phase.standAngle || 152) + 18);
    function ramp(from, to, step) {                 // 含端点的等差序列，方向自适应
      var out = [], a;
      if (to >= from) { for (a = from; a <= to; a += step) out.push(a); }
      else { for (a = from; a >= to; a -= step) out.push(a); }
      return out;
    }
    /* 采样步长 3°/帧、60ms/帧、底部停 4 帧——刻意对齐 tests/aic-rules-test.js 的口径。
     * 早前这里用 8°/帧，结果 13 个动作里有 6 个在合成数据下计 0 次：不是规则坏了，
     * 是采样太稀。角度走 EMA 平滑（alpha≈0.45）后有滞后，每帧跨度过大时平滑值
     * 根本没越过阈值。页面是给人看的，点「跑一遍」出 0 次会让人以为动作没接进去，
     * 所以两边必须同口径。 */
    frames.push(mk(top, t += 60, visibility));
    for (var i = 0; i < reps; i++) {
      ramp(top, targetAngle, 3).forEach(function (a) { frames.push(mk(a, t += 60, visibility)); });
      for (var k = 0; k < 4; k++) frames.push(mk(targetAngle, t += 60, visibility));   // 底部停留
      ramp(targetAngle, top, 3).forEach(function (b) { frames.push(mk(b, t += 60, visibility)); });
      for (var k2 = 0; k2 < 2; k2++) frames.push(mk(top, t += 60, visibility));
    }
    return frames;
  }

  /* 几何模型（对每个动作都成立）：
   *   取当前动作的主角度三点 (A, B, C)，角在 B 处。
   *   令 B→C 竖直向下、|B→C| = L；A 相对 B 的方向为 (sinθ, cosθ)·L，
   *   则 angleAt(A, B, C) 精确等于 θ（θ=180 时三点成一条竖直线）。
   * 深蹲是(髋,膝,踝)、卧推/弯举是(肩,肘,腕)、硬拉/臀桥是(肩,髋,膝)、侧平举是(髋,肩,肘)，
   * 都按同一套几何构造——合成数据因此不再绑定某一个动作。 */
  var LIMB = 0.16;

  function mk(deg, tMs, visibility) {
    var rad = deg * Math.PI / 180;
    var mj = (rules.metric && rules.metric.joints) || { left: [23, 25, 27], right: [24, 26, 28] };
    var bx = 0.5, by = 0.55;
    var cx = bx, cy = by + LIMB;                                   // C 在 B 正下方
    var axp = bx + LIMB * Math.sin(rad), ayp = by + LIMB * Math.cos(rad);

    var lm = [];
    for (var i = 0; i < 33; i++) lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 0 });
    function set(i, x, y) { lm[i] = { x: x, y: y, z: 0, visibility: visibility }; }
    // 左右各平移 ±0.02，使两侧三角形全等（对称性基线为 0 的样本）
    set(mj.left[0], axp - 0.02, ayp);  set(mj.right[0], axp + 0.02, ayp);
    set(mj.left[1], bx - 0.02, by);    set(mj.right[1], bx + 0.02, by);
    set(mj.left[2], cx - 0.02, cy);    set(mj.right[2], cx + 0.02, cy);

    // 躯干两点若不在主角度里，补一组：肩窄、躯干长 → 侧面视角（与深蹲口径一致）
    if (lm[LM.LEFT_SHOULDER].visibility === 0) {
      var hy = lm[LM.LEFT_HIP].visibility === 0 ? by - 0.1 : lm[LM.LEFT_HIP].y;
      set(LM.LEFT_SHOULDER, bx - 0.03, hy - 0.18); set(LM.RIGHT_SHOULDER, bx + 0.03, hy - 0.18);
    }
    if (lm[LM.LEFT_HIP].visibility === 0) {
      set(LM.LEFT_HIP, bx - 0.02, lm[LM.LEFT_SHOULDER].y + 0.18);
      set(LM.RIGHT_HIP, bx + 0.02, lm[LM.RIGHT_SHOULDER].y + 0.18);
    }
    if (lm[LM.NOSE].visibility === 0) set(LM.NOSE, bx, lm[LM.LEFT_SHOULDER].y - 0.06);
    return { tMs: tMs, landmarks: lm };
  }

  function runSynthetic() {
    var reps = Math.max(1, Math.min(20, parseInt(els.devReps.value, 10) || 3));
    var isMax = !!(rules.depth && rules.depth.mode === 'max');
    var angle = Math.max(20, Math.min(178, parseInt(els.devAngle.value, 10) || (isMax ? 165 : 85)));
    var lowVis = els.devLowVis.checked;
    var frames = synthFrames(reps, angle, lowVis);

    var an = A.createAnalyzer({ rules: rules, LM: LM });
    frames.forEach(function (f) { an.push(f); });
    an.finish(frames[frames.length - 1].tMs);
    var s = an.summary({ startTs: frames[0].tMs, endTs: frames[frames.length - 1].tMs });
    var review = RV.buildReview(s, rules);

    var lines = [];
    var mlab = (rules.metric && rules.metric.label) || '主角度';
    lines.push('【合成数据】' + rules.exerciseLabel + ' · ' + reps + ' 次，目标' +
      (isMax ? '最大' : '最小') + mlab + ' ' + angle + '°，低置信度=' + (lowVis ? '是' : '否'));
    lines.push('识别次数 ' + review.counts.repsTotal + ' / 有效 ' + review.counts.repsValid +
      ' / 置信度不足 ' + review.counts.repsLowConfidence + ' / 未完成 ' + review.counts.partialCycles);
    lines.push('识别成功率 ' + Math.round(review.detection.rate * 100) + '%　平均质量 ' +
      (review.quality.evaluable ? review.quality.scoreAvg + ' 分' : '无法评估'));
    review.dimensions.forEach(function (d) { lines.push('  · ' + d.label + '：' + d.display); });
    if (review.caveat) lines.push('⚠ ' + review.caveat);
    els.devOut.textContent = lines.join('\n');
    // 同时把结果灌入复盘区，便于肉眼检查（明确标注来源）
    app.lastSummary = s; app.lastReview = review; app.sessionStart = frames[0].tMs; app.sessionEnd = frames[frames.length - 1].tMs;
    renderReview(review, s);
    els.stageHint.textContent = '已用合成数据渲染复盘（非真实摄像头）';
    return s;
  }

  /* ==================== 对外测试钩子 ==================== */
  window.FXPAICoach = {
    app: app,
    /* rules 是随时间切换的：E2E 要读当前规则请用 getCurrent()，别抓这个快照 */
    rules: rules,
    getCurrent: function () { return { type: currentType, rules: rules }; },
    setExercise: function (t) {
      var ok = useExercise(t);
      if (ok) { if (els.selExercise) els.selExercise.value = t; renderMonitor(); }
      return ok;
    },
    listExercises: function () { return (C.RULE_LIST || Object.keys(C.RULES)).slice(); },
    monitorOf: function (t) { return C.getMonitor(t); },
    startSession: startSession,
    endSession: endSession,
    stopCamera: stopCamera,
    startCamera: startCamera,
    saveRecord: saveRecord,
    requestAI: requestAI,
    runSynthetic: runSynthetic,
    synthFrames: synthFrames,
    mkFrame: mk,
    getReview: function () { return app.lastReview; },
    getSummary: function () { return app.lastSummary; },
    exportCSVText: function () { return store.toCSV(store.list().records || []); },
    adapterStatus: function () { return adapter.getStatus(); },
    configureAI: function (p) { var r = adapter.configure(p); renderAIState(); els.chkAI.checked = !!(p && p.enabled); return r; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
