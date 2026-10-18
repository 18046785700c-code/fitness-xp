/* Fitness XP — AI 动作教练：摄像头与 MediaPipe 姿态采集（浏览器专用，依赖可注入以便测试）
 *
 * 职责边界：本模块只负责"拿到关键点"，不做任何动作判断。
 * 判断在 aic-analyze.js，提示在 aic-feedback.js —— 三者可分别测试。
 *
 * 安全约束（任务书第四节）：
 *   1) 摄像头必须由用户主动开启；开启前说明用途；
 *   2) 必须检查安全上下文（HTTPS / localhost），非安全上下文不允许调用 getUserMedia；
 *   3) 视频只在本地处理，不上传、不录像、不清空也不写 localStorage；
 *   4) 退出训练 / 关闭页面必须释放摄像头轨道；
 *   5) 模型加载失败、权限被拒、设备不支持都要给出可理解的提示，不能静默失败。
 *
 * 关于 MediaPipe：项目没有 package.json 也没有构建工具（已审计确认），
 * 因此本模块通过动态 import() 从 CDN 加载 @mediapipe/tasks-vision 的 ESM 包。
 * 这意味着**首次使用需要联网**；离线时模型加载会失败并给出明确提示。
 */
(function (root, factory) {
  root.FXP = root.FXP || {};
  root.FXP.aicPose = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  var MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

  /** 环境能力探测：给出人话级 reason */
  function capabilityProbe() {
    var hasMD = typeof navigator !== 'undefined' && navigator.mediaDevices;
    var hasGUM = hasMD && typeof navigator.mediaDevices.getUserMedia === 'function';
    var secure = typeof window !== 'undefined' && typeof window.isSecureContext === 'boolean'
      ? window.isSecureContext : false;
    var hasRTCPeer = typeof window !== 'undefined' && !!(window.RTCPeerConnection || window.webkitRTCPeerConnection);

    var reason = '', level = 'ok';
    if (!secure) {
      reason = '当前不是安全上下文：浏览器只允许 HTTPS 或 localhost 访问摄像头。' +
        '用局域网 IP（如 http://192.168.x.x）打开时手机会直接拒绝摄像头，请改用 HTTPS 或在本机 localhost 打开。';
      level = 'blocked';
    } else if (!hasGUM) {
      reason = '当前浏览器不支持 getUserMedia，无法调用摄像头。';
      level = 'blocked';
    }
    return {
      secureContext: secure,
      hasMediaDevices: !!hasMD,
      hasGetUserMedia: !!hasGUM,
      hasWebRTC: hasRTCPeer,
      level: level,
      reason: reason
    };
  }

  /** 摄像头错误码 → 人话 */
  function cameraErrorMessage(err) {
    var n = err && err.name ? err.name : 'UnknownError';
    switch (n) {
      case 'NotAllowedError':
      case 'SecurityError':
        return { code: 'denied', text: '摄像头权限被拒绝。请在浏览器地址栏的权限设置里允许摄像头后重试。' };
      case 'NotFoundError':
      case 'OverconstrainedError':
        return { code: 'no_device', text: '没有找到可用的摄像头设备。' };
      case 'NotReadableError':
        return { code: 'busy', text: '摄像头被其他程序占用，请关闭后重试。' };
      case 'AbortError':
        return { code: 'abort', text: '摄像头启动被中断，请重试。' };
      default:
        return { code: 'unknown', text: '摄像头启动失败（' + n + '），请重试或更换浏览器。' };
    }
  }

  function createCamera(opts) {
    opts = opts || {};
    var gum = opts.getUserMedia || (typeof navigator !== 'undefined' && navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null);

    var stream = null;

    function start() {
      var probe = capabilityProbe();
      if (probe.level === 'blocked') return Promise.reject({ code: 'insecure', text: probe.reason });
      if (!gum) return Promise.reject({ code: 'unsupported', text: '当前环境不支持摄像头。' });
      return gum({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      }).then(function (s) {
        stream = s;
        var track = s.getVideoTracks && s.getVideoTracks()[0];
        return {
          stream: s,
          label: track ? (track.label || '摄像头') : '摄像头',
          settings: track && track.getSettings ? track.getSettings() : {}
        };
      }).catch(function (e) {
        throw cameraErrorMessage(e);
      });
    }

    /** 释放：停止所有轨道，并把 <video> 的 srcObject 解绑由调用方处理 */
    function stop() {
      if (!stream) return false;
      try {
        stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) { /* 忽略：释放失败不应影响主流程 */ }
      stream = null;
      return true;
    }

    return { start: start, stop: stop, isOpen: function () { return !!stream; }, stream: function () { return stream; } };
  }

  /**
   * MediaPipe 加载器。loader 可注入便于测试失败路径。
   * 失败时统一抛出 { code, text }，不允许静默。
   */
  function createLandmarker(opts) {
    opts = opts || {};
    var importFn = opts.importFn || defaultImport;
    var base = opts.cdnBase || CDN_BASE;
    var modelUrl = opts.modelUrl || MODEL_URL;
    var instance = null;
    var loading = null;

    function defaultImport(url) {
      /* eslint-disable no-new-func */
      return new Function('u', 'return import(u);')(url);
    }

    function load() {
      if (instance) return Promise.resolve(instance);
      if (loading) return loading;

      loading = importFn(base + '/vision_bundle.mjs')
        .catch(function (e) {
          throw { code: 'import_failed', text: '姿态识别模型无法加载（网络不可达或 CDN 被拦截）。' +
            '首次使用需要联网下载模型文件；离线状态下仅能使用本地记录查看功能。' };
        })
        .then(function (mod) {
          var V = mod && mod.PoseLandmarker ? mod : (mod && mod.default ? mod.default : null);
          if (!V || !V.FilesetResolver || !V.PoseLandmarker) {
            throw { code: 'bad_module', text: '加载到的姿态识别包结构异常，请刷新重试。' };
          }
          return V.FilesetResolver.forVisionTasks(base + '/wasm')
            .catch(function () {
              throw { code: 'wasm_failed', text: '姿态识别运行时文件加载失败，请检查网络后重试。' };
            })
            .then(function (fileset) {
              return V.PoseLandmarker.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
                runningMode: 'VIDEO',
                numPoses: 1,
                minPoseDetectionConfidence: 0.5,
                minPosePresenceConfidence: 0.5,
                minTrackingConfidence: 0.5
              }).catch(function () {
                // GPU 不可用时回退 CPU，保证低端设备仍可运行
                return V.PoseLandmarker.createFromOptions(fileset, {
                  baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
                  runningMode: 'VIDEO',
                  numPoses: 1
                });
              });
            });
        })
        .then(function (lm) {
          instance = lm;
          loading = null;
          return lm;
        })
        .catch(function (e) {
          loading = null;
          if (e && e.code) throw e;
          throw { code: 'model_failed', text: '姿态识别模型初始化失败，请检查网络或设备性能后重试。' };
        });

      return loading;
    }

    function close() {
      try { if (instance && instance.close) instance.close(); } catch (e) { /* 忽略 */ }
      instance = null;
      loading = null;
    }

    return { load: load, close: close, ready: function () { return !!instance; }, get: function () { return instance; } };
  }

  /**
   * 逐帧执行器：把 video 帧喂给 landmarker，产出 [{x,y,z,visibility}] 或 null。
   * 时间戳由 MediaPipe 要求单调递增；用 performance.now() 回落 Date.now()。
   */
  function createDetectorRunner(opts) {
    opts = opts || {};
    var nowFn = opts.now || (typeof performance !== 'undefined' && performance.now
      ? function () { return performance.now(); } : function () { return Date.now(); });

    return function detect(landmarker, video, lastTs) {
      var ts = nowFn();
      if (ts <= lastTs) ts = lastTs + 1;
      var res;
      try {
        res = landmarker.detectForVideo(video, ts);
      } catch (e) {
        return { tMs: ts, landmarks: null, error: 'detect_failed' };
      }
      var lm = res && res.landmarks && res.landmarks[0] ? res.landmarks[0] : null;
      // 世界坐标仅在 flagSig 需要时使用；这里只输出归一化图像坐标，避免误解为三维测量
      var out = null;
      if (lm) {
        out = lm.map(function (p) {
          return { x: p.x, y: p.y, z: p.z, visibility: typeof p.visibility === 'number' ? p.visibility : 0 };
        });
      }
      return { tMs: ts, landmarks: out, worlds: res && res.worldLandmarks ? res.worldLandmarks[0] : null };
    };
  }

  return {
    CDN_BASE: CDN_BASE,
    MODEL_URL: MODEL_URL,
    capabilityProbe: capabilityProbe,
    cameraErrorMessage: cameraErrorMessage,
    createCamera: createCamera,
    createLandmarker: createLandmarker,
    createDetectorRunner: createDetectorRunner
  };
});
