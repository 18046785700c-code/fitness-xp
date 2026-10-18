/* Fitness XP 会员端 V2 — 存储层（19 表容器 / CRUD / 归属校验 / 独立键持久化 / 导出导入；UMD）
 *
 * 依赖：fxp-member-schema（契约）、fxp-engine（仅 nextSeqId）、fxp-csv（导入导出）
 * 不依赖：fxp-persist（原因见下）、fxp-validate（不修改它，契约层自行注入）
 *
 * 【与既有模块的关系 —— 重要修正 2026-10-16】
 * 设计文档 06 曾计划复用 P.createPersistence(storage,{key:'fxp-member'})。
 * 实际代码核实后此路不通：fxp-persist.js 的 save()/load() 内部强制调用 validateSnapshot()，
 * 该函数硬编码 TABLES=['coaches','members','sessions','followups','tasks'] 并要求
 * savedAt/queue/xp 结构，会员端 19 表快照必然被拒（reason: bad_table:coaches）。
 * 因此本模块自建持久化，但严格沿用 fxp-persist 的三条设计原则：
 *   1) 拒收优于猜测：结构/版本/记录任一不符 → 整体丢弃回空白态，绝不加载半份；
 *   2) 可逆：提供 clear()；
 *   3) storage 可注入（便于测试与禁用 localStorage 的环境）。
 * 这样既有 fxp-persist.js 保持零改动。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./fxp-member-schema.js'),
      require('./fxp-engine.js'),
      require('./fxp-csv.js')
    );
  } else {
    root.FXP = root.FXP || {};
    /* 注意：fxp-csv.js 在浏览器端是 Object.assign 到 root.FXP（散开，非 .csv 子对象），
       故这里直接传 root.FXP 作为 CSV 依赖。加载顺序必须保证 csv/engine/schema 已在它之前。 */
    root.FXP.memberStore = factory(root.FXP.memberSchema, root.FXP.engine, root.FXP);
  }
})(typeof self !== 'undefined' ? self : this, function (MSCH, E, CSV) {
  'use strict';

  var KEY = 'fxp-member';
  var TABLES = MSCH.TABLES;

  /* 子表 → 父表（用于解析归属；会员端数据必须能追溯到某个会员） */
  var OWNER_PATH = {
    m_sets: ['session_id', 'm_sessions'],
    m_bag_items: ['bag_id', 'm_bags'],
    m_plan_items: ['plan_id', 'm_plans']
  };
  /* 全局表：不属于任何单个会员，不受归属校验 */
  var GLOBAL_TABLES = ['m_exercises'];

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  /**
   * createStore(opts)
   * opts.storage  {getItem,setItem,removeItem}（必填，可注入 mock）
   * opts.today    'YYYY-MM-DD'（快照日期，默认取当天）
   * opts.key      存储键，默认 'fxp-member'
   */
  function createStore(opts) {
    opts = opts || {};
    var storage = opts.storage;
    if (!storage || typeof storage.getItem !== 'function')
      throw new Error('createStore 需要一个 localStorage 兼容的 storage');
    var KEY_ = opts.key || KEY;

    var tables = {}, byId = {};
    TABLES.forEach(function (t) { tables[t] = []; byId[t] = {}; });

    function idField(t) { return MSCH.SCHEMAS[t].idField; }
    function today() {
      if (opts.today) return opts.today;
      var d = new Date();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    /* ---------- 归属解析 ---------- */

    /** 返回该行所属的 member_id；全局表/无法解析时返回 null */
    function resolveOwner(table, row) {
      if (!isObj(row)) return null;
      if (row.member_id) return row.member_id;
      var p = OWNER_PATH[table];
      if (!p) return null;
      var parent = byId[p[1]][row[p[0]]];
      return parent ? parent.member_id : null;
    }

    /**
     * 归属校验：会员 A 不得读写会员 B 的数据。
     * 这是无服务端环境下（决策 Q8=A）的补偿措施之一，校验发生在数据层而非 UI 层。
     */
    function assertOwner(memberId, table, row) {
      if (GLOBAL_TABLES.indexOf(table) >= 0) return { ok: true };
      if (!memberId) return { ok: false, reason: 'no_actor', message: '未指定操作者，拒绝访问' };
      var owner = resolveOwner(table, row);
      if (owner === null) return { ok: false, reason: 'unresolvable', message: '无法解析该记录的归属会员，拒绝访问' };
      if (owner !== memberId)
        return { ok: false, reason: 'not_owner', message: '数据归属校验失败：该记录属于其他会员（' + owner + '）' };
      return { ok: true };
    }

    /* ---------- 读写 ---------- */

    function all(table) { return tables[table]; }

    function find(table, id) { return byId[table][id] || null; }

    function findBy(table, pred) {
      return tables[table].filter(function (r) { return pred(r); });
    }

    /** 带归属校验的单条读取（找不到 / 归属不符都返回 null 并给出原因） */
    function get(table, id, memberId) {
      var row = find(table, id);
      if (!row) return null;
      var a = assertOwner(memberId, table, row);
      return a.ok ? row : null;
    }

    function count(table) { return tables[table].length; }

    function nextId(table) {
      var p = MSCH.ID_PREFIX[table];
      if (!p) return null;   /* 主键即 member_id 的表不自动生成 */
      return E.nextSeqId(tables[table], idField(table), p, 4);
    }

    /** 唯一约束检查；返回冲突提示或 null */
    function uniqueHit(table, row) {
      var rules = MSCH.UNIQUES[table];
      if (!rules) return null;
      for (var i = 0; i < rules.length; i++) {
        var keys = rules[i];
        var dup = tables[table].some(function (r) {
          if (r[idField(table)] === row[idField(table)]) return false;   /* 自身不算冲突 */
          return keys.every(function (k) { return String(r[k] || '') === String(row[k] || ''); });
        });
        if (dup) return '与唯一约束冲突：(' + keys.join(', ') + ') 已存在相同记录';
      }
      return null;
    }

    /**
     * insert(table, rec, opt)
     * opt.actor 会员ID（给出则做归属校验）；opt.skipValidate 跳过行校验（仅内部恢复用）
     * 返回 {ok, row, errors, warnings, reason}
     */
    function insert(table, rec, opt) {
      opt = opt || {};
      if (!MSCH.SCHEMAS[table]) return { ok: false, reason: 'unknown_table' };
      var idf = idField(table);
      var row = {};
      Object.keys(rec).forEach(function (k) { row[k] = rec[k]; });

      if (!row[idf]) {
        var nid = nextId(table);
        if (nid === null) return { ok: false, reason: 'id_required', message: '该表主键需由调用方提供' };
        row[idf] = nid;
      }
      if (find(table, row[idf])) return { ok: false, reason: 'id_exists', message: 'ID 已存在：' + row[idf] };

      if (opt.actor) {
        var a = assertOwner(opt.actor, table, row);
        if (!a.ok) return { ok: false, reason: a.reason, message: a.message };
      }
      if (!opt.skipValidate) {
        var v = MSCH.validateRow(table, Object.assign({ _row: 0 }, row));
        if (v.errors.length) return { ok: false, reason: 'invalid', errors: v.errors, warnings: v.warnings };
      }
      var hit = uniqueHit(table, row);
      if (hit) return { ok: false, reason: 'unique_violation', message: hit };

      tables[table].push(row);
      byId[table][row[idf]] = row;
      return { ok: true, row: row };
    }

    /** update：只允许改非主键字段；归属校验先行 */
    function update(table, id, patch, opt) {
      opt = opt || {};
      var row = find(table, id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (opt.actor) {
        var a = assertOwner(opt.actor, table, row);
        if (!a.ok) return { ok: false, reason: a.reason, message: a.message };
      }
      Object.keys(patch).forEach(function (k) {
        if (k !== idField(table)) row[k] = patch[k];
      });
      if (!opt.skipValidate) {
        var v = MSCH.validateRow(table, Object.assign({ _row: 0 }, row));
        if (v.errors.length) return { ok: false, reason: 'invalid', errors: v.errors };
      }
      return { ok: true, row: row };
    }

    /** remove：计划数据允许真删（计划不是事实）；执行数据调用方应自行禁止 */
    function remove(table, id, opt) {
      opt = opt || {};
      var row = find(table, id);
      if (!row) return { ok: false, reason: 'not_found' };
      if (opt.actor) {
        var a = assertOwner(opt.actor, table, row);
        if (!a.ok) return { ok: false, reason: a.reason, message: a.message };
      }
      tables[table] = tables[table].filter(function (r) { return r !== row; });
      delete byId[table][id];
      return { ok: true };
    }

    /* ---------- 持久化（独立键，不共用 fxp-workspace） ---------- */

    function snapshot() {
      var t = {};
      TABLES.forEach(function (k) { t[k] = tables[k]; });
      return { v: MSCH.MEMBER_VERSION, savedAt: today(), tables: t };
    }

    function save() {
      var snap = snapshot();
      var chk = MSCH.validateMemberSnapshot(snap);
      if (!chk.ok) return { ok: false, reason: chk.reason, message: '快照未通过完整性校验，拒绝保存：' + chk.reason };
      try {
        storage.setItem(KEY_, JSON.stringify(snap));
        return { ok: true };
      } catch (e) {
        return {
          ok: false, reason: 'storage_error',
          message: '本地保存失败（' + (e && e.message ? e.message : '未知') + '），请及时导出 CSV 备份'
        };
      }
    }

    /**
     * load()：整体采纳或整体丢弃，不加载半份。
     * 返回 {ok, reason}；reason: empty / corrupt_json / storage_error / 快照原因
     */
    function load() {
      var text;
      try { text = storage.getItem(KEY_); }
      catch (e) { return { ok: false, reason: 'storage_error' }; }
      if (!text) return { ok: false, reason: 'empty' };
      var s;
      try { s = JSON.parse(text); }
      catch (e) { return { ok: false, reason: 'corrupt_json' }; }
      var chk = MSCH.validateMemberSnapshot(s);
      if (!chk.ok) return { ok: false, reason: chk.reason };
      reset();
      TABLES.forEach(function (t) {
        var src = s.tables[t] || [];
        src.forEach(function (r) {
          if (!isObj(r)) return;
          var row = {};
          Object.keys(r).forEach(function (k) { row[k] = r[k]; });
          tables[t].push(row);
          if (row[idField(t)]) byId[t][row[idField(t)]] = row;
        });
      });
      return { ok: true };
    }

    function clear() {
      try { storage.removeItem(KEY_); return { ok: true }; }
      catch (e) { return { ok: false, reason: 'storage_error' }; }
    }

    function reset() {
      TABLES.forEach(function (t) { tables[t] = []; byId[t] = {}; });
    }

    /** 清空内存与存储（回到空白工作区） */
    function clearAll() { reset(); return clear(); }

    /* ---------- 导出 / 导入 ---------- */

    /** 导出 19 个 CSV（空表也导出表头，保证往返结构一致） */
    function exportAll() {
      return TABLES.map(function (t) {
        return { table: t, text: CSV.toCSV(all(t), MSCH.COLUMNS[t]) };
      });
    }

    /**
     * 导入单表 CSV 文本。
     * opt.mode 'merge'（同 ID 覆盖）| 'replace'（清空后写入）
     * 返回 {ok, added, updated, rejected, errors, warnings}
     */
    function importText(table, text, opt) {
      opt = opt || {};
      if (!MSCH.SCHEMAS[table]) return { ok: false, reason: 'unknown_table' };
      var mode = opt.mode || 'merge';
      var rows = CSV.parseCSV(String(text).replace(/^\uFEFF/, ''));
      var rec = CSV.toRecords(rows);
      if (!rec.header.length) return { ok: false, reason: 'empty_file' };

      var h = MSCH.validateHeader(table, rec.header);
      if (!h.ok) return { ok: false, reason: 'bad_header', message: h.message, errors: [{ row: 0, field: '', message: h.message }] };

      var vres = MSCH.validateTable(table, rec.records);
      if (vres.errors.length) {
        /* 与导入管线一致：任一行有错 → 整份拒收，不写入半个文件 */
        return { ok: false, reason: 'row_invalid', errors: vres.errors, warnings: vres.warnings };
      }

      if (mode === 'replace') {
        tables[table] = []; byId[table] = {};
      }

      var added = 0, updated = 0;
      vres.accepted.forEach(function (r) {
        var row = {};
        Object.keys(r).forEach(function (k) { if (k !== '_row') row[k] = r[k]; });
        var id = row[idField(table)];
        var exist = find(table, id);
        if (exist) {
          Object.keys(row).forEach(function (k) { if (k !== idField(table)) exist[k] = row[k]; });
          updated++;
        } else {
          tables[table].push(row);
          byId[table][id] = row;
          added++;
        }
      });
      return { ok: true, added: added, updated: updated, rejected: 0, errors: [], warnings: vres.warnings };
    }

    return {
      KEY: KEY_,
      TABLES: TABLES,
      tables: tables,
      all: all, find: find, findBy: findBy, get: get, count: count,
      insert: insert, update: update, remove: remove,
      nextId: nextId,
      assertOwner: assertOwner, resolveOwner: resolveOwner,
      save: save, load: load, clear: clear, clearAll: clearAll, reset: reset,
      snapshot: snapshot,
      exportAll: exportAll, importText: importText
    };
  }

  return { KEY: KEY, createStore: createStore, TABLES: TABLES };
});
