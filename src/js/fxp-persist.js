/* Fitness XP V1 — 浏览器本地持久化模块（localStorage；UMD）
 * 背景（0.12.0）：手机端使用需要刷新/切后台不丢数据；此前"数据仅存当前页面会话"为桌面试点期约束。
 * 设计原则（与项目一致）：
 * 1) 拒收优于猜测：快照结构/版本/记录字段任一不符 → 整体丢弃，回到空白工作区，绝不加载半份数据；
 * 2) 与导入同管线：恢复时把五表记录重新走 loadModel（行级校验/外键/未来日期/内容去重），
 *    不做"信任已保存数据"的旁路——保存只是缓存，校验永远在引擎层；
 * 3) 跨端不互通：localStorage 按设备/浏览器隔离，跨设备同步唯一通道仍是 CSV → 协作表格；
 * 4) 可逆：提供 clear()，一键回到空白工作区。
 * 快照结构 v1：{ v, savedAt, tables:{五表}, queue:{五表}, xp:{enabled, events}, exportedAt } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FXP = root.FXP || {}; root.FXP.persist = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var TABLES = ['coaches', 'members', 'sessions', 'followups', 'tasks'];

  function isArr(x) { return Object.prototype.toString.call(x) === '[object Array]'; }
  function isObj(x) { return x !== null && typeof x === 'object' && !isArr(x); }
  function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

  /* 记录级最低完整性：必须是对象且带该表的 id 字段（深层校验交给 loadModel） */
  var ID_FIELDS = {
    coaches: 'coach_id', members: 'member_id', sessions: 'session_id',
    followups: 'followup_id', tasks: 'task_id'
  };

  function validateTableRecords(arr, idField) {
    if (!isArr(arr)) return false;
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!isObj(r)) return false;
      var id = r[idField];
      if (typeof id !== 'string' || !id) return false;
    }
    return true;
  }

  function validateSnapshot(s) {
    if (!isObj(s)) return { ok: false, reason: 'bad_shape' };
    if (s.v !== VERSION) return { ok: false, reason: 'version_mismatch' };
    if (!isDateStr(s.savedAt)) return { ok: false, reason: 'bad_savedAt' };
    if (!isObj(s.tables)) return { ok: false, reason: 'bad_tables' };
    if (!isObj(s.queue)) return { ok: false, reason: 'bad_queue' };
    for (var i = 0; i < TABLES.length; i++) {
      var t = TABLES[i];
      if (!validateTableRecords(s.tables[t], ID_FIELDS[t])) return { ok: false, reason: 'bad_table:' + t };
      if (!validateTableRecords(s.queue[t], ID_FIELDS[t])) return { ok: false, reason: 'bad_queue:' + t };
    }
    if (!isObj(s.xp)) return { ok: false, reason: 'bad_xp' };
    if (typeof s.xp.enabled !== 'boolean') return { ok: false, reason: 'bad_xp_enabled' };
    if (!isArr(s.xp.events)) return { ok: false, reason: 'bad_xp_events' };
    if (s.exportedAt !== null && typeof s.exportedAt !== 'string') return { ok: false, reason: 'bad_exportedAt' };
    return { ok: true };
  }

  /**
   * createPersistence(storage, opts)
   * storage: localStorage 兼容对象（{getItem,setItem,removeItem}），可注入 mock 供测试
   * opts: { key: 'fxp-workspace' }（默认值见下）
   */
  function createPersistence(storage, opts) {
    opts = opts || {};
    var KEY = opts.key || 'fxp-workspace';

    function save(snapshot) {
      var check = validateSnapshot(snapshot);
      if (!check.ok) return { ok: false, reason: check.reason, message: '快照未通过完整性校验，拒绝保存：' + check.reason };
      try {
        storage.setItem(KEY, JSON.stringify(snapshot));
        return { ok: true };
      } catch (e) {
        /* 配额溢出/隐私模式/被禁用：不中断业务，提醒导出 */
        return { ok: false, reason: 'storage_error', message: '本地保存失败（' + (e && e.message ? e.message : '未知') + '），请及时导出 CSV' };
      }
    }

    function load() {
      var text;
      try { text = storage.getItem(KEY); } catch (e) { return { ok: false, reason: 'storage_error' }; }
      if (!text) return { ok: false, reason: 'empty' };
      var s;
      try { s = JSON.parse(text); }
      catch (e) { return { ok: false, reason: 'corrupt_json' }; }
      var check = validateSnapshot(s);
      if (!check.ok) return { ok: false, reason: check.reason };
      return { ok: true, snapshot: s };
    }

    function clear() {
      try { storage.removeItem(KEY); return { ok: true }; }
      catch (e) { return { ok: false, reason: 'storage_error' }; }
    }

    return { VERSION: VERSION, KEY: KEY, save: save, load: load, clear: clear };
  }

  return { createPersistence: createPersistence, validateSnapshot: validateSnapshot, VERSION: VERSION };
});
