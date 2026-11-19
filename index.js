// src/sidecar.ts
import { spawn as spawn2 } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/types.ts
var DEFAULT_CONFIG = {
  pythonCommand: "",
  launcherPath: void 0,
  dbPath: "",
  embedModel: "intfloat/multilingual-e5-small",
  embedMode: "real",
  rpcTimeoutMs: 3e4,
  initTimeoutMs: 12e4,
  indexTimeoutMs: 3e5,
  maxRestarts: 3,
  defaultTopK: 5,
  maxTopK: 15,
  defaultMinScore: 0.3,
  mode: "inject",
  failOpen: true,
  selfCheckOnStart: true,
  catalogMode: "registry",
  externalCatalogPath: "",
  // 产品安全默认：mcp 执行器未实现时会显式返回 EXECUTOR_UNAVAILABLE，
  // 避免 external 形态静默走 mock（mock 仅供评测，需显式配置）。
  externalExecutor: "mcp",
  externalLimit: 1e3
};

// src/detect.ts
import { spawn } from "node:child_process";
var BASE_PACKAGES = ["httpx", "numpy", "pydantic"];
var EMBED_PACKAGE = "sentence_transformers";
var PROBE_CODE = [
  "import json, platform, importlib.util as u;",
  "names = ('httpx', 'numpy', 'pydantic', 'sentence_transformers');",
  "pkgs = {n: u.find_spec(n) is not None for n in names};",
  "print(json.dumps({'version': platform.python_version(), 'packages': pkgs}))"
].join("");
function candidateInterpreters(env = process.env) {
  const fromEnv = (env.YOUMI_PYTHON ?? "").trim();
  if (fromEnv) return [[fromEnv]];
  if (process.platform === "win32") return [["py", "-3"], ["python"], ["python3"]];
  return [["python3"], ["python"]];
}
function toArgv(pythonCommand) {
  return pythonCommand.trim().split(/\s+/).filter(Boolean);
}
function probeInterpreter(argv, timeoutMs = 3e4) {
  const info = {
    argv: argv.join(" "),
    found: false,
    version: null,
    packages: {},
    error: null
  };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), "-c", PROBE_CODE], {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      info.error = String(err);
      resolve(info);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(info);
    };
    const timer = setTimeout(() => {
      info.error = `probe timed out after ${timeoutMs}ms`;
      child.kill();
      finish();
    }, timeoutMs);
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      info.error = `${err.name}: ${err.message}`;
      finish();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = (stderr.trim() || stdout.trim()).split("\n").pop() ?? "";
        info.error = `exit ${code}: ${tail}`;
        finish();
        return;
      }
      const last = stdout.trim().split("\n").pop() ?? "";
      try {
        const payload = JSON.parse(last);
        info.found = true;
        info.version = payload.version ?? null;
        info.packages = payload.packages ?? {};
      } catch (err) {
        info.error = `unparseable probe output: ${String(err)}`;
      }
      finish();
    });
  });
}
function hasAll(packages, names) {
  return names.every((name2) => packages[name2] === true);
}
async function detectInterpreter(embedMode = "real", candidates = candidateInterpreters()) {
  const probes = [];
  let fallback = null;
  let fallbackReason = "";
  for (const argv of candidates) {
    const probe = await probeInterpreter(argv);
    probes.push(probe);
    if (!probe.found) continue;
    if (!hasAll(probe.packages, BASE_PACKAGES)) {
      if (fallback === null) {
        fallback = argv;
        fallbackReason = `missing base deps (${BASE_PACKAGES.filter((p) => probe.packages[p] !== true).join(", ")}) in ${probe.argv}`;
      }
      continue;
    }
    if (embedMode === "real" && probe.packages[EMBED_PACKAGE] !== true) {
      if (fallback === null) {
        fallback = argv;
        fallbackReason = `no ${EMBED_PACKAGE} in ${probe.argv}; embedMode=real will fail loudly`;
      }
      continue;
    }
    return {
      argv,
      reason: `selected ${probe.argv} (Python ${probe.version})`,
      probes
    };
  }
  if (fallback !== null) {
    return { argv: fallback, reason: fallbackReason, probes };
  }
  return {
    argv: null,
    reason: `no usable Python interpreter among: ${probes.map((p) => p.argv).join(", ") || "(no candidates)"}`,
    probes
  };
}

// src/sidecar.ts
var LAUNCHER_MISSING = "sidecar launcher.py not found in the bundle";
function moduleDirs() {
  const here = typeof import.meta.url === "string" ? fileURLToPath(import.meta.url).replace(/[\\/][^\\/]+$/, "") : process.cwd();
  const dirs = [];
  let current = here;
  for (let i = 0; i < 4; i++) {
    dirs.push(current);
    const parent = current.replace(/[\\/][^\\/]+$/, "");
    if (parent === current || parent === "") break;
    current = parent;
  }
  return dirs;
}
var Sidecar = class extends EventEmitter {
  _process = null;
  _config;
  _nextId = 1;
  _pending = /* @__PURE__ */ new Map();
  _restartCount = 0;
  _buffer = "";
  _ready = false;
  _info = {
    command: "",
    interpreter: null,
    interpreterVersion: null,
    detectReason: null,
    probes: [],
    pid: null,
    lastError: null
  };
  constructor(config = {}) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...config };
  }
  /** sidecar 是否已启动并就绪 */
  get ready() {
    return this._ready && this._process !== null && !this._process.killed;
  }
  /** 可诊断事实（只读快照） */
  get info() {
    return { ...this._info, probes: [...this._info.probes] };
  }
  /** initialize 的返回值（embedMode / vectorChannel / dimensions / indexed） */
  get initResult() {
    return this._initResult;
  }
  _initResult = null;
  /** 启动 sidecar 进程 */
  async start() {
    if (this._process !== null) {
      return;
    }
    const launcher = this._resolveLauncherPath();
    if (launcher === null) {
      const err = `${LAUNCHER_MISSING}: ${this._config.launcherPath ?? "(unresolved)"}`;
      this._info.lastError = err;
      throw new Error(err);
    }
    let detected;
    if (this._config.pythonCommand.trim() !== "") {
      const argv = toArgv(this._config.pythonCommand);
      detected = { argv, reason: `explicit pythonCommand: ${argv.join(" ")}`, probes: [] };
    } else {
      detected = await detectInterpreter(this._config.embedMode, candidateInterpreters());
    }
    this._info.interpreter = detected.argv?.join(" ") ?? null;
    this._info.detectReason = detected.reason;
    this._info.probes = detected.probes;
    const probed = detected.probes.find((p) => p.argv === detected.argv?.join(" "));
    this._info.interpreterVersion = probed?.version ?? null;
    if (detected.argv === null) {
      const err = `no usable Python interpreter (${detected.reason})`;
      this._info.lastError = err;
      throw new Error(err);
    }
    const args = [
      launcher,
      "--db-path",
      this._config.dbPath,
      "--embed-model",
      this._config.embedModel,
      "--embed-mode",
      this._config.embedMode
    ];
    const [cmd, ...cmdArgs] = detected.argv;
    this._info.command = [...detected.argv, ...args].join(" ");
    this._process = spawn2(cmd, [...cmdArgs, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" }
    });
    this._info.pid = this._process.pid ?? null;
    this._process.stdout.setEncoding("utf-8");
    this._process.stdout.on("data", (chunk) => this._onStdout(chunk));
    this._process.stderr.setEncoding("utf-8");
    this._process.stderr.on("data", (chunk) => {
      console.debug(`[sidecar:stderr] ${chunk.trimEnd()}`);
    });
    this._process.on("exit", (code) => this._onExit(code));
    this._process.on("error", (err) => this._onError(err));
    const mode = this._config.catalogMode ?? "registry";
    const initParams = mode === "external" ? {
      catalogMode: "external",
      externalCatalogPath: this._config.externalCatalogPath,
      externalLimit: this._config.externalLimit
    } : {};
    this._initResult = await this._callWithRetry(
      "initialize",
      initParams,
      2,
      this._config.initTimeoutMs
    );
    this._ready = true;
    this.emit("ready");
  }
  /** 停止 sidecar 进程 */
  async stop() {
    this._ready = false;
    if (this._process === null) {
      return;
    }
    try {
      await this.call("shutdown", {});
    } catch {
    }
    this._process.kill("SIGTERM");
    this._process = null;
    this._info.pid = null;
    this._rejectAllPending("sidecar stopped");
  }
  /** 通用 RPC 调用（timeoutMs 缺省用 rpcTimeoutMs） */
  async call(method, params, timeoutMs) {
    if (!this._process || this._process.killed) {
      throw new Error("sidecar not running");
    }
    const limit = timeoutMs ?? this._config.rpcTimeoutMs;
    const id = this._nextId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._noteError(`RPC timeout: ${method} (${limit}ms)`);
        reject(new Error(`RPC timeout: ${method} (${limit}ms)`));
      }, limit);
      this._pending.set(id, {
        resolve,
        reject,
        timer
      });
      const line = JSON.stringify(request) + "\n";
      this._process.stdin.write(line);
    });
  }
  // -- 高层方法 --
  /** 增量索引工具（首次全量 embed 很慢，用 indexTimeoutMs） */
  async indexTools(items) {
    return this.call("index_tools", { items }, this._config.indexTimeoutMs);
  }
  /** 语义检索 */
  async search(query, topK, minScore, exclude) {
    return this.call("search", {
      query,
      top_k: topK ?? this._config.defaultTopK,
      min_score: minScore ?? this._config.defaultMinScore,
      exclude
    });
  }
  /** 移除工具 */
  async removeTools(names) {
    return this.call("remove_tools", { names });
  }
  /** 全部已索引工具名（invoke 元工具拼写建议候选池） */
  async listToolNames() {
    return this.call("list_tool_names", {});
  }
  /** 从 JSONL 载入外部目录（F11.1；与 initialize 自动载入同一条 RPC 路径） */
  async loadExternalCatalog(path, limit) {
    return this.call("load_external_catalog", {
      path,
      limit: limit ?? this._config.externalLimit
    }, this._config.indexTimeoutMs);
  }
  /** 已载入的外部目录工具名（F11.2：检索侧保留 ext_* 的依据） */
  async listExternalNames() {
    return this.call("list_external_names", {});
  }
  /** 按名回读完整条目（含参数 schema）；不存在时 sidecar 返回 null（F11.2） */
  async getTool(name2) {
    return this.call("get_tool", { name: name2 });
  }
  /** 获取统计信息 */
  async stats() {
    return this.call("stats", {});
  }
  // -- 内部方法 --
  /** 随包解析 launcher.py（构建产物 index.js 与 src/*.ts 都能定位到 bundle 根） */
  _resolveLauncherPath() {
    if (this._config.launcherPath) {
      return existsSync(this._config.launcherPath) ? this._config.launcherPath : null;
    }
    for (const base of moduleDirs()) {
      const cand = `${base}/sidecar/launcher.py`;
      if (existsSync(cand)) return cand;
    }
    return null;
  }
  _noteError(reason) {
    this._info.lastError = reason;
  }
  async _callWithRetry(method, params, retries, timeoutMs) {
    let lastError = null;
    for (let i = 0; i <= retries; i++) {
      try {
        return await this.call(method, params, timeoutMs);
      } catch (err) {
        lastError = err;
        this._noteError(`${method}: ${String(err)}`);
        if (i < retries) {
          await new Promise((r) => setTimeout(r, 1e3 * (i + 1)));
        }
      }
    }
    throw lastError;
  }
  _onStdout(chunk) {
    this._buffer += chunk;
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        this._handleResponse(response);
      } catch (err) {
        console.warn("[sidecar] failed to parse response:", line, err);
      }
    }
  }
  _handleResponse(response) {
    const id = response.id;
    if (id === null || id === void 0) {
      return;
    }
    const pending = this._pending.get(id);
    if (!pending) {
      return;
    }
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (response.error) {
      this._noteError(`RPC ${response.error.code}: ${response.error.message}`);
      pending.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }
  _onExit(code) {
    this._ready = false;
    this._process = null;
    this._info.pid = null;
    this._noteError(`sidecar exited with code ${code}`);
    this._rejectAllPending(`sidecar exited with code ${code}`);
    this.emit("exit", code);
    if (code !== 0 && this._restartCount < this._config.maxRestarts) {
      this._restartCount++;
      this.emit("restart", this._restartCount);
      setTimeout(() => this.start().catch((err) => this._noteError(`restart failed: ${String(err)}`)), 2e3);
    }
  }
  _onError(err) {
    this._noteError(`spawn error: ${err.message}`);
    this.emit("error", err);
  }
  _rejectAllPending(reason) {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }
};

// src/indexer.ts
var DEFAULT_INDEXER_OPTIONS = {
  debounceMs: 200,
  batchSize: 100
};
var Indexer = class {
  _sidecar;
  _options;
  _pending = /* @__PURE__ */ new Map();
  _timer = null;
  _totalIndexed = 0;
  _totalSkipped = 0;
  _totalErrors = 0;
  constructor(sidecar, options = {}) {
    this._sidecar = sidecar;
    this._options = { ...DEFAULT_INDEXER_OPTIONS, ...options };
  }
  /** 累计索引统计 */
  get stats() {
    return {
      indexed: this._totalIndexed,
      skipped: this._totalSkipped,
      errors: this._totalErrors
    };
  }
  /**
   * 通知工具变更（新增 / 更新）
   *
   * 调用后不会立即索引，而是加入 pending 队列，debounce 后批量发送。
   */
  notifyChange(item) {
    this._pending.set(item.name, item);
    this._scheduleFlush();
  }
  /**
   * 通知多个工具变更
   */
  notifyChanges(items) {
    for (const item of items) {
      this._pending.set(item.name, item);
    }
    this._scheduleFlush();
  }
  /**
   * 通知工具移除
   */
  async notifyRemove(names) {
    if (names.length === 0) return;
    try {
      await this._sidecar.removeTools(names);
    } catch (err) {
      console.warn("[indexer] remove failed:", err);
    }
  }
  /**
   * 立即 flush pending 队列（跳过 debounce）
   */
  async flush() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this._doFlush();
  }
  _scheduleFlush() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => {
      this._timer = null;
      this._doFlush().catch((err) => {
        console.warn("[indexer] flush failed:", err);
      });
    }, this._options.debounceMs);
  }
  async _doFlush() {
    if (this._pending.size === 0) {
      return null;
    }
    const allItems = Array.from(this._pending.values());
    this._pending.clear();
    let totalResult = { indexed: 0, skipped: 0, errors: 0 };
    for (let i = 0; i < allItems.length; i += this._options.batchSize) {
      const batch = allItems.slice(i, i + this._options.batchSize);
      try {
        const result = await this._sidecar.indexTools(batch);
        totalResult.indexed += result.indexed;
        totalResult.skipped += result.skipped;
        totalResult.errors += result.errors;
      } catch (err) {
        console.warn("[indexer] batch index failed:", err);
        totalResult.errors += batch.length;
      }
    }
    this._totalIndexed += totalResult.indexed;
    this._totalSkipped += totalResult.skipped;
    this._totalErrors += totalResult.errors;
    return totalResult;
  }
};

// src/state.ts
var DEFAULT_STATE_OPTIONS = {
  turnCacheTtlMs: 3e4
};
var SessionState = class {
  _options;
  _activated = /* @__PURE__ */ new Set();
  _pinned = /* @__PURE__ */ new Set();
  _turnCache = /* @__PURE__ */ new Map();
  _currentTurn = 0;
  constructor(options = {}) {
    this._options = { ...DEFAULT_STATE_OPTIONS, ...options };
  }
  // -- activated 集 --
  /** 获取当前激活集（只读视图） */
  get activated() {
    return this._activated;
  }
  /** 激活工具（单调递增，不会移除） */
  activate(names) {
    for (const name2 of names) {
      this._activated.add(name2);
    }
  }
  /** 检查工具是否已激活 */
  isActivated(name2) {
    return this._activated.has(name2);
  }
  // -- pinned 集 --
  /** 获取 pinned 集（只读视图） */
  get pinned() {
    return this._pinned;
  }
  /** 设置 pinned 工具 */
  setPinned(names) {
    this._pinned = new Set(names);
  }
  /** 添加工具到 pinned */
  pin(name2) {
    this._pinned.add(name2);
  }
  /** 从 pinned 移除工具 */
  unpin(name2) {
    this._pinned.delete(name2);
  }
  // -- turn 管理 --
  /** 推进到下一个 turn（清空 turn 缓存） */
  nextTurn() {
    this._currentTurn++;
    this._turnCache.clear();
  }
  /** 当前 turn 编号 */
  get currentTurn() {
    return this._currentTurn;
  }
  // -- turn 缓存 --
  /** 生成缓存 key */
  _cacheKey(key) {
    return JSON.stringify({
      q: key.query,
      k: key.topK,
      s: key.minScore,
      e: key.exclude.sort()
    });
  }
  /** 查询 turn 缓存 */
  getCached(key) {
    const k = this._cacheKey(key);
    const entry = this._turnCache.get(k);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._options.turnCacheTtlMs) {
      this._turnCache.delete(k);
      return null;
    }
    return entry.results;
  }
  /** 写入 turn 缓存 */
  setCached(key, results) {
    const k = this._cacheKey(key);
    this._turnCache.set(k, {
      results,
      timestamp: Date.now()
    });
  }
  // -- 统计 --
  /** 返回状态摘要 */
  stats() {
    return {
      activated: this._activated.size,
      pinned: this._pinned.size,
      turnCacheSize: this._turnCache.size,
      currentTurn: this._currentTurn
    };
  }
  /** 重置状态（新 session） */
  reset() {
    this._activated.clear();
    this._pinned.clear();
    this._turnCache.clear();
    this._currentTurn = 0;
  }
};

// src/selector.ts
var DEFAULT_SELECTOR_OPTIONS = {
  maxResults: 5,
  minScore: 0.3,
  includePinned: true,
  includeActivated: true
};
function selectTools(searchResults, pinned, activated, options = {}) {
  const opts = { ...DEFAULT_SELECTOR_OPTIONS, ...options };
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  if (opts.includePinned) {
    for (const name2 of pinned) {
      if (!seen.has(name2)) {
        seen.add(name2);
        result.push(name2);
      }
    }
  }
  if (opts.includeActivated) {
    for (const name2 of activated) {
      if (!seen.has(name2) && !pinned.has(name2)) {
        seen.add(name2);
        result.push(name2);
      }
    }
  }
  const filtered = searchResults.filter((r) => r.score >= opts.minScore).sort((a, b) => b.score - a.score);
  let added = 0;
  for (const r of filtered) {
    if (added >= opts.maxResults) {
      break;
    }
    if (!seen.has(r.tool_name)) {
      seen.add(r.tool_name);
      result.push(r.tool_name);
      added++;
    }
  }
  return result;
}
function extractToolNames(results, minScore = 0.3) {
  return new Set(
    results.filter((r) => r.score >= minScore).map((r) => r.tool_name)
  );
}
function diffActivated(results, activated, minScore = 0.3) {
  return results.filter((r) => r.score >= minScore && !activated.has(r.tool_name)).map((r) => r.tool_name);
}

// src/search-tool.ts
var MAX_SIGNATURE_PARAMS = 8;
var MAX_SIGNATURE_LEN = 160;
var TYPE_ABBR = {
  string: "str",
  integer: "int",
  number: "num",
  boolean: "bool",
  array: "arr",
  object: "obj"
};
function shortType(type) {
  return TYPE_ABBR[type] ?? type;
}
function renderParam(p) {
  return `${p.required ? p.name : `${p.name}?`}: ${shortType(p.type)}`;
}
function renderSignature(result) {
  const params = result.parameters;
  if (!params || params.length === 0) {
    return result.signature ?? `${result.tool_name}()`;
  }
  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const ordered = [...required, ...optional];
  const truncated = ordered.length > MAX_SIGNATURE_PARAMS;
  const shown = ordered.slice(0, MAX_SIGNATURE_PARAMS).map(renderParam);
  let rendered = shown.join(", ");
  if (truncated) {
    rendered = rendered ? `${rendered}, \u2026` : "\u2026";
  }
  let sig = `${result.tool_name}(${rendered})`;
  if (sig.length > MAX_SIGNATURE_LEN) {
    sig = sig.slice(0, MAX_SIGNATURE_LEN - 1) + "\u2026";
  }
  return sig;
}
function oneSentence(text) {
  const match = text.match(/^.[^。.!?]*[。.!?]?/);
  const first = (match ? match[0] : text).replace(/[。.!?]$/, "").trim();
  const body = first || text.trim();
  return body.length > 60 ? body.slice(0, 59) + "\u2026" : body;
}
function formatSearchResults(results, catalogTotal, note) {
  if (results.length === 0) {
    return "No matching tools. Try a broader query or different wording.";
  }
  const totalSuffix = catalogTotal !== void 0 ? ` / ${catalogTotal} in catalog` : "";
  const lines = results.map((r, i) => {
    const brief = oneSentence(r.summary || r.description);
    const tail = brief ? ` \u2014 ${brief}` : "";
    return `${i + 1}. ${renderSignature(r)}${tail}; risk=${r.risk_level}`;
  });
  const header = `Found ${results.length} tool(s)${totalSuffix}:`;
  return (note !== void 0 && note !== "" ? `${header}
${note}` : header) + `
${lines.join("\n")}`;
}
function getSearchToolSchema() {
  return {
    type: "function",
    function: {
      name: "search_tools",
      description: "Search the tool catalog using natural language. Returns relevant tools with semantic similarity scores. Use this to discover tools available for a task.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language description of what you want to do"
          },
          top_k: {
            type: "integer",
            description: "Maximum number of results to return (default: 5)",
            default: 5
          },
          min_score: {
            type: "number",
            description: "Minimum similarity score threshold (default: 0.3)",
            default: 0.3
          }
        },
        required: ["query"]
      }
    }
  };
}

// src/invoke-tool.ts
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[b.length];
}
function suggestNames(name2, pool, maxDistance = 2, maxResults = 3) {
  const scored = [];
  for (const cand of pool) {
    if (cand === name2) continue;
    const dist = editDistance(name2, cand);
    if (dist <= maxDistance) scored.push({ name: cand, dist });
  }
  scored.sort((x, y) => x.dist - y.dist || x.name.localeCompare(y.name));
  return scored.slice(0, maxResults).map((s) => s.name);
}
var PRIMITIVE_TYPES = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "array", "object"]);
function briefsFromSchema(schema) {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(props).map(([name2, p]) => ({
    name: name2,
    type: typeof p.type === "string" ? p.type : "json",
    required: required.has(name2),
    enum: Array.isArray(p.enum) ? p.enum.filter((v) => typeof v === "string") : null
  }));
}
function signatureFor(name2, schema) {
  return renderSignature({
    tool_name: name2,
    description: "",
    score: 0,
    summary: "",
    risk_level: "low",
    required_permissions: [],
    parameters: briefsFromSchema(schema)
  });
}
function validateAgainstSchema(schema, args) {
  if (!schema || schema.type !== "object" || !schema.properties) return [];
  const props = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const violations = [];
  for (const key of required) {
    if (!(key in args) || args[key] === void 0 || args[key] === null) {
      violations.push(`missing required argument: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === void 0 || value === null) continue;
    const p = props[key];
    if (!p) continue;
    const expected = p.type;
    if (typeof expected === "string" && PRIMITIVE_TYPES.has(expected)) {
      const actual = Array.isArray(value) ? "array" : typeof value;
      const ok = expected === "integer" ? actual === "number" && Number.isInteger(value) : actual === expected;
      if (!ok) violations.push(`argument "${key}" must be of type ${expected}`);
    }
    if (Array.isArray(p.enum) && !p.enum.includes(value)) {
      violations.push(`argument "${key}" must be one of [${p.enum.join(", ")}]`);
    }
  }
  return violations;
}
var UNKNOWN_TOOL = "UNKNOWN_TOOL";
var INVALID_ARGS = "INVALID_ARGS";
var NOT_ADMITTED = "NOT_ADMITTED";
async function dispatchInvoke(raw, deps, exec) {
  const name2 = typeof raw.tool === "string" ? raw.tool.trim() : "";
  if (!name2) {
    return `${INVALID_ARGS}: "tool" must be a non-empty string. Use search_tools first to find a tool name.`;
  }
  const def = deps.getTool(name2, exec);
  if (def === void 0) {
    if (deps.isInCatalog(name2)) {
      return `${NOT_ADMITTED}: ${name2} is indexed but not callable in the current view. Do not retry it; call search_tools for an alternative.`;
    }
    const suggestions = suggestNames(name2, deps.knownNames());
    const hint = suggestions.length > 0 ? `
Did you mean: ${suggestions.join(", ")}?` : "";
    return `${UNKNOWN_TOOL}: ${name2}${hint}
Use search_tools to discover available tools.`;
  }
  if (deps.isAdmitted && !deps.isAdmitted(name2)) {
    return `${NOT_ADMITTED}: ${name2} is not admitted for the current step. Do not retry it; call search_tools for an alternative.`;
  }
  const args = raw.arguments !== void 0 && raw.arguments !== null ? raw.arguments : {};
  if (typeof raw.arguments !== "object" || raw.arguments === null || Array.isArray(raw.arguments)) {
    return `${INVALID_ARGS}: "arguments" must be an object mapping parameter names to values.
Expected signature: ${signatureFor(name2, def.parameters)}`;
  }
  const violations = validateAgainstSchema(def.parameters, args);
  if (violations.length > 0) {
    return `${INVALID_ARGS}: ${violations.join("; ")}
Expected signature: ${signatureFor(name2, def.parameters)}`;
  }
  exec.signal.throwIfAborted();
  const outcome = await deps.forward(name2, args, exec);
  if (!outcome.ok) {
    return outcome.text;
  }
  return outcome.text;
}
function createInvokeTool(deps) {
  return {
    name: "invoke",
    description: "Call a catalog tool by name. Arguments are validated against the tool schema; on failure the correct signature is returned.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Exact tool name from search_tools results."
        },
        arguments: {
          type: "object",
          description: "Arguments object for the target tool: keys are parameter names, values follow each parameter type."
        }
      },
      required: ["tool", "arguments"]
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    execute: (args, exec) => dispatchInvoke(args, deps, exec)
  };
}
function flattenOutcome(result) {
  const text = result.content.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : `[${block.type} content]`).join("\n");
  if (!result.isError) return { ok: true, text };
  const message = text.length > 0 ? text : result.error?.message ?? "";
  return { ok: false, text: message.length > 0 ? message : `TOOL_ERROR: failed with empty content` };
}
function buildInvokeDeps(tools, catalog) {
  return {
    // 透传外层 toolSet / agent：带 `when` 的注册只有步骤准入集里才可执行
    getTool: (name2, exec) => tools.get(name2, exec?.agent, exec?.toolSet),
    isInCatalog: (name2) => catalog.has(name2),
    knownNames: () => catalog.names(),
    async forward(name2, args, exec) {
      const callId = exec.callId !== void 0 ? `${exec.callId}:invoke` : `invoke-${Date.now()}`;
      const batch = await tools.execute({
        calls: [{
          type: "tool-call",
          id: callId,
          name: name2,
          // 批量入参要求原始 JSON 字符串（batch.ts 内 parseArguments 再解析）
          arguments: JSON.stringify(args)
        }],
        signal: exec.signal,
        ...exec.agent !== void 0 ? { agent: exec.agent } : {},
        ...exec.toolSet !== void 0 ? { toolSet: exec.toolSet } : {}
      });
      const settled = batch.results.find((r) => r.callId === callId) ?? batch.results[0];
      if (settled === void 0) {
        return { ok: false, text: `TOOL_ERROR: ${name2} returned no batch result` };
      }
      return flattenOutcome(settled.result);
    }
  };
}

// src/status.ts
function embedderFixCommand(interpreter) {
  const py = interpreter && interpreter.length > 0 ? interpreter : "python";
  return `${py} -m pip install sentence-transformers`;
}
var StatusTracker = class {
  _readiness = "starting";
  _selfCheckState = "not-run";
  _steps = [];
  _startedAt = null;
  _finishedAt = null;
  _durationMs = null;
  _reason = null;
  _problems = [];
  _interpreter = null;
  _registered = 0;
  _restrictCalls = 0;
  _lastStats = null;
  /** 最近一次索引的作用域范围；F10.3 后 per-agent 同步写入 `union`（并集不删） */
  _syncScope = "global_only";
  /** 已知作用域数（由 snapshot 入参刷新） */
  _scopeCount = null;
  /** 记录最近一次同步的作用域范围（selfCheck 标 global_only，ensureIndexed 标 union） */
  noteScope(scope) {
    this._syncScope = scope;
  }
  get readiness() {
    return this._readiness;
  }
  get selfCheckState() {
    return this._selfCheckState;
  }
  /** 最近一次可读的失败/降级原因（search_tools 的 CATALOG_UNAVAILABLE 用它） */
  get reason() {
    return this._reason;
  }
  /**
   * 组合失败文本：自检 reason + 附加 problems，供 snapshot().sidecar.lastError 兜底。
   * 无失败、无 problem 时返回 null。
   */
  get failureText() {
    const parts = [];
    if (this._reason !== null) parts.push(this._reason);
    for (const p of this._problems) {
      if (!parts.includes(p)) parts.push(p);
    }
    return parts.length > 0 ? parts.join("; ") : null;
  }
  /**
   * embedder 缺失时的修复命令（仅 embedMode=real 且侧车报未加载时给出）。
   * 这就是「不静默降级」的落点：失败文本里直接带可执行命令。
   */
  get embedderFix() {
    const stats = this._lastStats;
    if (stats === null) return null;
    if (stats.embed_mode !== "real" || stats.embedder_loaded !== false) return null;
    return embedderFixCommand(this._interpreter);
  }
  /** 记录选中的解释器 argv（供 embedder 缺失时拼修复命令） */
  setInterpreter(interpreter) {
    this._interpreter = interpreter;
  }
  get registeredTools() {
    return this._registered;
  }
  /**
   * 登记一条降级事实（不覆盖自检原因，也不清 readiness）。
   * 用于「自检成功但工具名被占用」这类并存问题，避免后到的状态抹掉先到的。
   */
  annotate(problem) {
    if (!this._problems.includes(problem)) this._problems.push(problem);
  }
  get problems() {
    return this._problems;
  }
  startSelfCheck() {
    this._selfCheckState = "running";
    this._steps = [];
    this._startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this._finishedAt = null;
    this._durationMs = null;
    this._reason = null;
  }
  markStep(step) {
    if (!this._steps.includes(step)) this._steps.push(step);
  }
  passSelfCheck() {
    this._selfCheckState = "passed";
    this._readiness = "ready";
    this._reason = null;
    this._finish();
  }
  /** 任一步失败：置 degraded + 记录原因，**不抛错、不阻塞 DSH**（红线 4） */
  failSelfCheck(reason) {
    this._selfCheckState = "failed";
    this._readiness = "degraded";
    this._reason = reason;
    this._finish();
  }
  _finish() {
    this._finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (this._startedAt !== null) {
      const ms = Date.parse(this._finishedAt) - Date.parse(this._startedAt);
      this._durationMs = Number.isFinite(ms) ? ms : null;
    }
  }
  /** 记录本插件成功注册到注册表的工具数 */
  setRegistered(count) {
    this._registered = count;
  }
  /** declare 模式下每调用一次 restrict 记一次（inject 模式恒为 0） */
  noteRestrict() {
    this._restrictCalls += 1;
  }
  /** 缓存最近一次 stats（snapshot() 拿不到实时数据时兜底） */
  noteStats(stats) {
    this._lastStats = stats;
  }
  /**
   * 组装一次完整快照。
   *
   * @param sidecarInfo 拉起事实（解释器、pid、lastError）
   * @param stats 实时 stats（sidecar 未就绪时传 null，回退缓存）
   * @param dsh 版本 / profile 探测结果
   * @param registryTools 注册表可见工具数
   * @param knownScopes 已知作用域数（F10.3 并集同步观测，可选）
   * @param embedMode 配置的向量通道模式
   * @param presentationMode 配置的呈现模式（inject / declare）
   * @param catalogMode F11 目录形态（registry / external）
   */
  snapshot(args) {
    const stats = args.stats ?? this._lastStats;
    const info = args.sidecarInfo;
    if (typeof args.knownScopes === "number") this._scopeCount = args.knownScopes;
    const alive = args.stats !== null || info?.pid != null && this._readiness === "ready";
    const loaded = stats ? stats.embedder_loaded ?? null : null;
    const embedError = stats?.embedder_error ?? null;
    const needsFix = args.embedMode === "real" && stats !== null && loaded === false;
    return {
      ok: this._readiness === "ready",
      readiness: this._readiness,
      sidecar: {
        alive,
        command: info?.command ?? null,
        interpreter: info?.interpreter ?? null,
        interpreterVersion: info?.interpreterVersion ?? null,
        detectReason: info?.detectReason ?? null,
        pid: info?.pid ?? null,
        lastError: info?.lastError ?? this.failureText
      },
      embedder: {
        mode: stats?.embed_mode ?? args.embedMode,
        model: stats?.embed_model ?? null,
        dimensions: stats?.embedder_dimensions ?? null,
        loaded,
        vectorChannel: stats?.vector_channel ?? null,
        error: embedError,
        ...needsFix ? { fix: embedderFixCommand(info?.interpreter ?? null) } : {}
      },
      catalog: {
        dbPath: stats?.db_path ?? null,
        indexed: stats?.fingerprints ?? null,
        lastIndexedAt: stats?.last_indexed_at ?? null,
        syncScope: this._syncScope,
        scopeCount: this._scopeCount,
        catalogMode: args.catalogMode ?? "registry",
        externalCount: stats?.external_count ?? null,
        registryCount: stats?.registry_count ?? null
      },
      protocol: {
        mode: args.presentationMode,
        toolsRegistered: this._registered,
        registryTools: args.registryTools,
        restrictCalls: this._restrictCalls
      },
      dsh: {
        version: args.dsh.version,
        profile: args.dsh.profile,
        source: args.dsh.source
      },
      selfCheck: {
        state: this._selfCheckState,
        steps: [...this._steps],
        startedAt: this._startedAt,
        finishedAt: this._finishedAt,
        durationMs: this._durationMs,
        reason: this._reason,
        problems: [...this._problems]
      }
    };
  }
};
function summarizeStatus(status) {
  const { sidecar, embedder, catalog, selfCheck } = status;
  const parts = [
    `readiness=${status.ok ? "ready" : status.readiness}`,
    `sidecar=${sidecar.alive ? `alive(pid=${sidecar.pid ?? "?"})` : "down"}`,
    `interpreter=${sidecar.interpreter ?? "unknown"}`,
    `embed=${embedder.mode}/${embedder.loaded === true ? "loaded" : "not-loaded"}`,
    `indexed=${catalog.indexed ?? "?"}`,
    `registry=${status.protocol.registryTools}`
  ];
  if (catalog.catalogMode === "external") {
    parts.push(`mode=external(ext=${catalog.externalCount ?? "?"},registry=${catalog.registryCount ?? "?"})`);
  }
  if (selfCheck.state === "failed" && selfCheck.reason !== null) {
    parts.push(`reason=${selfCheck.reason}`);
  }
  return parts.join(" | ");
}

// src/dsh-info.ts
import { readFileSync, existsSync as existsSync2 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function thisModuleDir() {
  return fileURLToPath2(import.meta.url).replace(/[\\/][^\\/]+$/, "");
}
function profileFromCwd(cwd) {
  const normalized = cwd.replace(/\\/g, "/");
  const match = /(?:^|\/)profiles\/([^/]+)\/?$/.exec(normalized);
  return match !== null ? match[1] : null;
}
function runtimeVersion(fromDir) {
  let dir = fromDir;
  for (let i = 0; i < 8; i++) {
    const cand = `${dir}/node_modules/@deepseek-ai/dsh/package.json`;
    if (existsSync2(cand)) {
      try {
        const pkg = JSON.parse(readFileSync(cand, "utf-8"));
        if (typeof pkg.version === "string") return pkg.version;
      } catch {
        return null;
      }
    }
    const parent = dir.replace(/[\\/][^\\/]+$/, "");
    if (parent === dir || parent === "") break;
    dir = parent;
  }
  return null;
}
function detectDshInfo(env = process.env, cwd = process.cwd(), moduleDir = thisModuleDir()) {
  const sources = [];
  let profile = (env.DSH_PROFILE ?? "").trim();
  if (profile !== "") {
    sources.push("profile=$DSH_PROFILE");
  } else {
    profile = profileFromCwd(cwd) ?? "unknown";
    sources.push(profile === "unknown" ? "profile=unknown(cwd not under <DSH_HOME>/profiles/)" : "profile=from cwd");
  }
  const version = env.DSH_VERSION?.trim() || runtimeVersion(moduleDir) || "unknown";
  sources.push(
    version === "unknown" ? "version=unknown(host package.json not resolvable)" : env.DSH_VERSION !== void 0 && env.DSH_VERSION.trim() !== "" ? "version=$DSH_VERSION" : "version=@deepseek-ai/dsh package.json"
  );
  return { version, profile, source: sources.join("; ") };
}
function defaultDbPath(env = process.env) {
  const home = (env.DSH_HOME ?? "").trim() || (env.HOME ? `${env.HOME.replace(/\/+$/, "")}/.dsh` : "") || (env.USERPROFILE ? `${env.USERPROFILE.replace(/\\+$/, "")}/.dsh` : "") || ".dsh";
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home}${sep}youmi-catalog${sep}dsh-tools.db`;
}

// src/plugin-tools.ts
var SEARCH_TOOL_NAME = "search_tools";
var INVOKE_TOOL_NAME = "invoke";
var STATUS_TOOL_NAME = "catalog_status";
var OWN_TOOL_NAMES = [
  SEARCH_TOOL_NAME,
  INVOKE_TOOL_NAME,
  STATUS_TOOL_NAME
];
function renderText(_args, value) {
  return [{ type: "text", text: value }];
}
function buildInvokeDefinition(deps) {
  const tool = createInvokeTool(deps);
  return tool;
}
function buildSearchDefinition(catalog) {
  return {
    name: SEARCH_TOOL_NAME,
    description: "Search the tool catalog by natural language to find a tool you can call with `invoke`. Returns numbered lines like `name(param: str, opt?: int) \u2014 what it does; risk=low`. Use it when the tools already in this request cannot do the task.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you want to accomplish, in a few words"
        },
        top_k: {
          type: "integer",
          description: "Maximum number of results to return (default: 5)"
        },
        min_score: {
          type: "number",
          description: "Minimum similarity threshold (default: 0.3)"
        }
      },
      required: ["query"]
    },
    output: { schema: { type: "string" }, render: renderText },
    execute: async (args, exec) => {
      const raw = args ?? {};
      const query = typeof raw.query === "string" ? raw.query.trim() : "";
      if (query === "") {
        return 'INVALID_ARGS: "query" must be a non-empty string.';
      }
      const rawTopK = typeof raw.top_k === "number" && Number.isFinite(raw.top_k) && raw.top_k > 0 ? Math.floor(raw.top_k) : void 0;
      if (catalog.status.readiness !== "ready") {
        return unavailableText(catalog);
      }
      await catalog.ensureIndexed(exec?.agent, exec?.toolSet);
      let outcome;
      try {
        outcome = await catalog.search(
          query,
          rawTopK,
          typeof raw.min_score === "number" ? raw.min_score : void 0,
          { scope: exec?.agent, toolSet: exec?.toolSet }
        );
      } catch (err) {
        return unavailableText(catalog, String(err));
      }
      const results = outcome.results;
      if (results.length === 0 && catalog.indexedCount() === 0) {
        return "CATALOG_EMPTY: no tools indexed yet. The registry is usually still empty at session start; call search_tools again after tools have been registered.";
      }
      const cappedAt = outcome.cappedAt ?? null;
      const note = cappedAt !== null && rawTopK !== void 0 && cappedAt < rawTopK ? `Note: requested top_k=${rawTopK} exceeds the catalog cap; returning at most ${cappedAt}.` : void 0;
      return formatSearchResults(results, catalog.indexedCount(), note);
    }
  };
}
function buildInvokeToolDefinition(catalog) {
  const deps = catalog.invokeDeps();
  const def = buildInvokeDefinition({
    ...deps,
    // sidecar/目录未就绪时，转发本身没有意义：给可自愈的提示而非静默失败
    forward: (name2, args, exec) => {
      if (catalog.status.readiness !== "ready") {
        return Promise.resolve({ ok: false, text: unavailableText(catalog) });
      }
      return deps.forward(name2, args, exec);
    }
  });
  const inner = def.execute.bind(def);
  return {
    ...def,
    execute: async (args, exec) => {
      if (catalog.status.readiness === "ready") {
        const raw = args ?? {};
        const toolName = typeof raw.tool === "string" ? raw.tool : "";
        if (toolName !== "" && catalog.isExternalTool?.(toolName) === true && catalog.invokeExternal !== void 0) {
          return catalog.invokeExternal(toolName, raw.arguments ?? {});
        }
        await catalog.ensureIndexed(exec?.agent, exec?.toolSet);
      }
      return await inner(args, exec);
    }
  };
}
function buildStatusDefinition(catalog) {
  return {
    name: STATUS_TOOL_NAME,
    description: "Report tool-catalog health: sidecar process, Python interpreter, embedder channel, index size, presentation mode and the start-up self-check. Use it when search_tools keeps failing to decide whether the catalog is usable.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "string" },
      render: renderText
    },
    execute: async (_args, exec) => {
      await catalog.ensureIndexed(exec?.agent, exec?.toolSet);
      const status = await catalog.statusSnapshot(exec?.agent, exec?.toolSet);
      return `${summarizeStatus(status)}
${JSON.stringify(status, null, 2)}`;
    }
  };
}
function unavailableText(catalog, detail) {
  const tracker = catalog.status;
  const reason = detail ?? tracker.reason ?? "sidecar not ready";
  const fix = tracker.embedderFix;
  return `CATALOG_UNAVAILABLE: ${reason}` + (fix !== null ? `
Fix: ${fix}` : "") + "\nTool search is disabled while the catalog is unavailable; it does NOT fall back to keyword matching. Call catalog_status for full diagnostics and continue without catalog tools.";
}

// src/external.ts
var MOCK_EXECUTOR_NOTE = "mock executor (evaluation only)";
var EXECUTOR_UNAVAILABLE = "EXECUTOR_UNAVAILABLE";
function briefsFromEntry(params) {
  return (params ?? []).map((p) => ({
    name: p.name,
    type: typeof p.type === "string" ? p.type : "string",
    required: p.required === true,
    enum: Array.isArray(p.enum) ? p.enum.filter((v) => typeof v === "string") : null
  }));
}
function signatureForEntry(entry) {
  return renderSignature({
    tool_name: entry.name,
    description: "",
    score: 0,
    summary: "",
    risk_level: entry.risk_level ?? "low",
    required_permissions: [],
    parameters: briefsFromEntry(entry.parameters)
  });
}
function schemaFromEntry(entry) {
  const properties = {};
  const required = [];
  for (const p of entry.parameters ?? []) {
    const spec = { type: p.type ?? "string" };
    if (typeof p.description === "string" && p.description !== "") spec.description = p.description;
    if (Array.isArray(p.enum) && p.enum.length > 0) spec.enum = p.enum;
    properties[p.name] = spec;
    if (p.required === true) required.push(p.name);
  }
  return { type: "object", properties, ...required.length > 0 ? { required } : {} };
}
function mockExecute(name2, args) {
  return JSON.stringify({
    ok: true,
    tool: name2,
    args_echo: args,
    note: MOCK_EXECUTOR_NOTE
  });
}
async function dispatchExternal(name2, rawArgs, deps) {
  const entry = await deps.getEntry(name2);
  if (entry === null) {
    return `UNKNOWN_TOOL: ${name2}
Use search_tools to discover available tools.`;
  }
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return `INVALID_ARGS: "arguments" must be an object mapping parameter names to values.
Expected signature: ${signatureForEntry(entry)}`;
  }
  const args = rawArgs ?? {};
  const violations = validateAgainstSchema(schemaFromEntry(entry), args);
  if (violations.length > 0) {
    return `INVALID_ARGS: ${violations.join("; ")}
Expected signature: ${signatureForEntry(entry)}`;
  }
  if (deps.executor() !== "mock") {
    return `${EXECUTOR_UNAVAILABLE}: externalExecutor="${deps.executor()}" is not implemented (real MCP/HTTP forwarding is out of F11 scope; use "mock" for evaluation).`;
  }
  return mockExecute(name2, args);
}

// src/index.ts
function paramsFromSchema(schema) {
  const props = schema?.properties;
  if (props === null || typeof props !== "object") return [];
  const required = new Set(
    Array.isArray(schema?.required) ? schema.required.map(String) : []
  );
  return Object.entries(props).map(([name2, p]) => ({
    name: name2,
    type: typeof p.type === "string" ? p.type : "json",
    description: typeof p.description === "string" ? p.description : void 0,
    required: required.has(name2),
    ...Array.isArray(p.enum) ? { enum: p.enum.filter((v) => typeof v === "string") } : {}
  }));
}
function summaryOf(description) {
  const match = /^[^.!?]*[.!?]?/.exec(description.trim());
  const body = (match ? match[0] : description).replace(/[.!?]$/, "").trim();
  const text = body.length > 0 ? body : description.trim();
  return text.length > 120 ? `${text.slice(0, 119)}\u2026` : text;
}
var GLOBAL_SCOPE = Symbol("youmi-tool-catalog:global-scope");
var YoumiCatalogPlugin = class {
  _sidecar;
  _indexer;
  _state;
  _config;
  /** 目录内工具名缓存（invoke 拼写建议候选池），search 命中与显式刷新时更新 */
  _catalogNames = /* @__PURE__ */ new Set();
  /**
   * F11.2：`catalogMode=external` 时载入的外部目录工具名（`ext_*`）。
   * registry 模式恒为空。检索侧的 exclude 裁剪必须保留这些名字——它们永远
   * 不在注册表可见集里，但它们**可派发**，删掉就破坏「检索视野 ≡ 派发视野」。
   */
  _externalNames = /* @__PURE__ */ new Set();
  /** F11.2：外部条目 `get_tool` 回读缓存（sidecar 重启/重载入时失效） */
  _externalEntries = /* @__PURE__ */ new Map();
  /** 健康状态（T10.3）：自检结果 + catalog_status 载荷的唯一来源 */
  _status = new StatusTracker();
  /** DSH `ctx.tools`（注册表读 + 转发），由 apply() 注入 */
  _tools = null;
  /** 日志器（由 apply() 注入；单测下缺省用 console） */
  _log = null;
  /** 不索引进目录的工具名（插件自身元工具等，避免自我检索） */
  _exclude;
  /**
   * 每个 scope（agent 对象 / GLOBAL_SCOPE 哨兵）最近一次成功同步时的 epoch。
   * 与 `_syncEpoch` 相等 → 该 scope 目录新鲜；否则标脏，下个检索请求重扫（F9.2.3）。
   */
  _scopeEpochs = /* @__PURE__ */ new Map();
  /** 全局脏标记：`tools/change` 时自增，使所有 scope 的新鲜度失效 */
  _syncEpoch = 0;
  /**
   * 每个已索引名字的“归属视图”（F10.3）：`global` = 曾在全局视图（无 scope）
   * 出现过，`agent` = 只在某个 agent 作用域出现过。删除只对 `global` 归属
   * 的名字生效——agent 视野里看不到某个工具 ≠ 它从注册表彻底消失。
   */
  _toolOrigins = /* @__PURE__ */ new Map();
  /** 已知作用域计数（F10.3，含 GLOBAL_SCOPE）：catalog_status.catalog.scopeCount */
  _knownScopes = /* @__PURE__ */ new Set();
  /** 同一 scope 并发检索共享的在飞同步 promise（避免重复索引） */
  _syncInFlight = /* @__PURE__ */ new Map();
  constructor(config = {}, excludeNames = []) {
    this._config = config;
    this._sidecar = new Sidecar(config);
    this._indexer = new Indexer(this._sidecar);
    this._state = new SessionState();
    this._exclude = new Set(excludeNames);
  }
  /** 健康状态跟踪器（plugin-tools 读 readiness / reason） */
  get status() {
    return this._status;
  }
  /** 注入 DSH 注册表服务与日志器（`apply()` 里调用） */
  attach(tools, log) {
    this._tools = tools;
    if (log !== void 0) this._log = log;
  }
  _info(message) {
    if (this._log !== null) this._log.info(message);
    else console.info(`[youmi-tool-catalog] ${message}`);
  }
  _warn(message) {
    if (this._log !== null) this._log.warn(message);
    else console.warn(`[youmi-tool-catalog] ${message}`);
  }
  /** sidecar 是否就绪 */
  get ready() {
    return this._sidecar.ready;
  }
  /** 获取 session 状态 */
  get state() {
    return this._state;
  }
  /** 获取 indexer */
  get indexer() {
    return this._indexer;
  }
  // -- 生命周期 --
  /** 启动插件（spawn sidecar） */
  async start() {
    await this._sidecar.start();
  }
  /** 停止插件 */
  async stop() {
    await this._sidecar.stop();
  }
  // -- 索引 --
  /** 索引单个工具 */
  indexTool(item) {
    this._catalogNames.add(item.name);
    this._indexer.notifyChange(item);
  }
  /** 批量索引工具 */
  indexTools(items) {
    for (const item of items) this._catalogNames.add(item.name);
    this._indexer.notifyChanges(items);
  }
  /** 立即 flush 索引队列 */
  async flushIndex() {
    return this._indexer.flush();
  }
  /** 移除工具 */
  async removeTools(names) {
    for (const name2 of names) this._catalogNames.delete(name2);
    await this._indexer.notifyRemove(names);
  }
  /** 从 sidecar 刷新目录名缓存（invoke 拼写建议候选池） */
  async refreshToolNames() {
    const names = await this._sidecar.listToolNames();
    this._catalogNames = new Set(names);
    for (const n of names) {
      if (!this._toolOrigins.has(n)) this._toolOrigins.set(n, "agent");
    }
  }
  // -- 检索 --
  /**
   * 搜索工具（带 turn 缓存；F10.2 尊重 top_k，F10.3 按 scope 过滤）
   *
   * @param query - 自然语言查询
   * @param topK - 返回数量（硬上限；超过 maxTopK 按 maxTopK 处理并在结果里标注）
   * @param minScore - 最低分数
   * @param opts - scope 可见集过滤（F10.3 第 2 层）：传入调用方 agent / toolSet
   *   时，用其可见集对结果做真正裁剪（不是只记日志）
   * @returns 搜索结果 + 是否被 maxTopK 封顶
   */
  async search(query, topK, minScore, opts) {
    const requestedTopK = Math.max(1, Math.round(topK ?? this._config.defaultTopK ?? 5));
    const cap = this._config.maxTopK ?? DEFAULT_CONFIG.maxTopK;
    const effectiveTopK = Math.min(requestedTopK, cap);
    const cappedAt = requestedTopK > cap ? cap : null;
    let exclude = [];
    if (opts !== void 0 && this._tools !== null && this._sidecar.ready) {
      const visible = new Set(
        this._tools.definitions(opts.scope, opts.toolSet).map((def) => def.name)
      );
      exclude = [...this._catalogNames].filter((name2) => !visible.has(name2) && !this._externalNames.has(name2)).sort();
    }
    const cacheKey = {
      query,
      topK: effectiveTopK,
      minScore: minScore ?? this._config.defaultMinScore ?? 0.3,
      exclude
    };
    const cached = this._state.getCached(cacheKey);
    if (cached !== null) {
      return { results: cached, cappedAt };
    }
    const results = await this._sidecar.search(
      query,
      cacheKey.topK,
      cacheKey.minScore,
      exclude
    );
    this._state.setCached(cacheKey, results);
    for (const r of results) {
      this._catalogNames.add(r.tool_name);
    }
    const clipped = results.length > effectiveTopK ? results.slice(0, effectiveTopK) : results;
    return { results: clipped, cappedAt };
  }
  /**
   * 搜索并选择工具（合并 pinned + activated + results）
   *
   * @param query - 自然语言查询
   * @param topK - 返回数量
   * @returns 选中的工具名列表
   */
  async selectTools(query, topK) {
    const { results } = await this.search(query, topK);
    const toActivate = diffActivated(results, this._state.activated);
    this._state.activate(toActivate);
    return selectTools(
      results,
      this._state.pinned,
      this._state.activated,
      { maxResults: topK }
    );
  }
  // -- 状态管理 --
  /** 推进到下一个 turn（清空缓存） */
  nextTurn() {
    this._state.nextTurn();
  }
  /** 设置 pinned 工具 */
  setPinned(names) {
    this._state.setPinned(names);
  }
  /** 激活工具 */
  activate(names) {
    this._state.activate(names);
  }
  // -- 可见性同步（T5） --
  /**
   * 按配置 mode 同步注册表可见性。
   *
   * - `inject`（默认）：**空操作**——激活只更新 SessionState，不调 restrict、
   *   不改注册表，请求头恒定（缓存不变量 1）
   * - `declare`（A/B 对照）：对未激活且未 pinned 的注册表工具执行
   *   `restrict({ deny })`，复现旧行为。restrict 必须在 agent 作用域调用
   *   （全局调用抛错，见 docs/notes/dsh-capability-probe.md）
   *
   * @param target - DSH `ctx.tools`（agent.ctx 作用域）的 restrict 入口
   * @param registryNames - 当前注册表全量工具名
   * @returns 是否实际调用了 restrict（inject 模式恒为 false）
   */
  syncVisibility(target, registryNames) {
    if ((this._config.mode ?? "inject") !== "declare") {
      return false;
    }
    const deny = [...registryNames].filter(
      (name2) => !this._state.activated.has(name2) && !this._state.pinned.has(name2)
    );
    target.restrict({ deny });
    this._status.noteRestrict();
    return true;
  }
  // -- 诊断 --
  /** 获取统计信息 */
  async stats() {
    const [catalog, state] = await Promise.all([
      this._sidecar.stats(),
      Promise.resolve(this._state.stats())
    ]);
    return {
      catalog,
      indexer: this._indexer.stats,
      state
    };
  }
  /** 格式化搜索结果为文本 */
  formatResults(results, catalogTotal) {
    return formatSearchResults(results, catalogTotal);
  }
  /** 获取 search_tools 工具 schema */
  getSearchToolSchema() {
    return getSearchToolSchema();
  }
  // -- invoke 元工具（T4，路径 B 核心） --
  /**
   * 构造 invoke 依赖：把 DSH `ctx.tools` 适配到本插件的目录名缓存。
   *
   * @param tools - DSH 的 `ctx.tools`（ToolRuntime 的 get/execute 子集）
   */
  buildInvokeDeps(tools) {
    return buildInvokeDeps(tools, {
      has: (name2) => this._catalogNames.has(name2),
      names: () => this._catalogNames
    });
  }
  /**
   * 构造 DSH 注册表就绪的 `invoke` 工具定义。
   * 用法（在 agent 作用域）：`ctx.tools.register(plugin.buildInvokeTool(ctx.tools))`
   */
  buildInvokeTool(tools) {
    return createInvokeTool(this.buildInvokeDeps(tools));
  }
  // -- 外部目录派发（F11.2，catalogMode=external） --
  /** 名字是否属于外部目录（`ext_*`）；registry 模式恒为 false */
  isExternalTool(toolName) {
    return this._externalNames.has(toolName);
  }
  /** 外部目录工具名集合（只读快照；registry 模式恒为空集） */
  get externalToolNames() {
    return this._externalNames;
  }
  /** 当前生效的目录形态（catalog_status / 报告口径用） */
  get catalogMode() {
    return this._config.catalogMode ?? "registry";
  }
  /**
   * 把一次 `invoke` 派发到外部工具：sidecar `get_tool` 回读条目 → schema 校验
   * → `externalExecutor` 执行（mock 为评测期唯一实现，F11.2）。
   *
   * 失败语义与注册表路径一致：`UNKNOWN_TOOL` / `INVALID_ARGS` /（executor=mcp
   * 未实现时）`EXECUTOR_UNAVAILABLE`。ext_* 不进注册表、不发 restrict，
   * 请求头里永远看不到它们（红线 3）。
   */
  async invokeExternal(toolName, rawArgs) {
    return dispatchExternal(toolName, rawArgs, {
      getEntry: async (name2) => {
        if (this._externalEntries.has(name2)) return this._externalEntries.get(name2) ?? null;
        const entry = await this._sidecar.getTool(name2);
        this._externalEntries.set(name2, entry);
        return entry;
      },
      executor: () => this._config.externalExecutor ?? "mock",
      // 拼写建议候选池：外部条目名也在 _catalogNames 里（list_tool_names 返回全量）
      knownNames: () => this._catalogNames
    });
  }
  // -- 注册表同步（T10.1：把 DSH 可见工具增量索引进目录） --
  /**
   * 全量对账一次注册表：新增/变更走指纹增量索引。
   *
   * F10.3 第 1 层：**带 scope 的同步只增不删**——某 agent 视野里看不到某个
   * 工具（未开 Team Mode 看不到 `team_task_*`）不等于它从注册表消失，早期
   * 实现据此删除会让索引在作用域之间抖动、embedding 反复重算。删除只在
   * 全局视图（`scope` 省略）且 `removeMissing` 显式打开时执行（启动对账）。
   *
   * sidecar 侧按指纹去重，重复调用只会 skipped；插件自身的元工具
   * （search_tools / invoke / catalog_status）不进了目录，避免自我检索。
   *
   * F9.1：枚举按作用域参数化——`scope` 传入 agent 时取其可见集（含内置工具），
   * 省略时保持全局视图行为（向后兼容）。`definitions(scope)` 的语义由 DSH
   * 宿主保证；本插件只负责把 scope 透传下去，**不硬编码工具名**（红线 1）。
   */
  async syncRegistry(scope, toolSet, opts) {
    const tools = this._tools;
    if (tools === null) throw new Error("plugin not attached to ctx.tools");
    if (!this._sidecar.ready) throw new Error("sidecar not ready");
    const isGlobalScope = scope === void 0;
    const defs = tools.definitions(scope, toolSet);
    const items = [];
    const current = /* @__PURE__ */ new Set();
    for (const def of defs) {
      if (this._exclude.has(def.name)) continue;
      current.add(def.name);
      items.push({
        name: def.name,
        description: def.description,
        summary: summaryOf(def.description),
        parameters: paramsFromSchema(def.parameters)
      });
    }
    if (isGlobalScope && opts?.removeMissing === true) {
      const justIndexed = new Set(items.map((item) => item.name));
      const removed = [...this._catalogNames].filter(
        (name2) => !current.has(name2) && !justIndexed.has(name2) && !this._exclude.has(name2) && this._toolOrigins.get(name2) === "global"
      );
      if (removed.length > 0) {
        try {
          await this._sidecar.removeTools(removed);
          for (const name2 of removed) {
            this._catalogNames.delete(name2);
            this._toolOrigins.delete(name2);
          }
        } catch (err) {
          this._warn(`catalog remove failed for ${removed.length} tool(s): ${String(err)}`);
        }
      }
    }
    const total = { indexed: 0, skipped: 0, errors: 0 };
    const BATCH = 100;
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      try {
        const r = await this._sidecar.indexTools(batch);
        total.indexed += r.indexed;
        total.skipped += r.skipped;
        total.errors += r.errors;
        for (const item of batch) {
          this._catalogNames.add(item.name);
          if (isGlobalScope) this._toolOrigins.set(item.name, "global");
          else if (!this._toolOrigins.has(item.name)) this._toolOrigins.set(item.name, "agent");
        }
      } catch (err) {
        total.errors += batch.length;
        this._warn(`batch index failed (${batch.length} tools): ${String(err)}`);
      }
    }
    return total;
  }
  /**
   * `tools/change` 入口：只标脏，不立刻全扫（F9.2.3）。
   *
   * 注册表变更不带细节，无法判断影响了哪些 scope；把全局 epoch 自增使所有
   * scope 的新鲜度失效，下一个检索请求经 `ensureIndexed` 按自己的 scope 重扫。
   */
  onRegistryChanged() {
    this._syncEpoch += 1;
  }
  /**
   * 按需把某个作用域的工具补索引（F9.2 关键）。
   *
   * 由 `search_tools` / `invoke` / `catalog_status` 的 execute 在派发前调用，
   * 传入 `exec.agent`：
   * - 该 scope 已同步且未标脏 → 直接返回（廉价）；
   * - 否则 `syncRegistry(agent)`；首次会多花几秒 embed 增量工具，之后靠幂等 skipped。
   *
   * fail-open（红线 3）：同步失败**不抛出**，只记日志；检索照常返回旧目录或
   * `CATALOG_UNAVAILABLE`，绝不让 `search_tools` 因补索引失败而崩。
   */
  async ensureIndexed(scope, toolSet) {
    if (this._tools === null || !this._sidecar.ready) return;
    const key = scope ?? GLOBAL_SCOPE;
    this._knownScopes.add(key);
    if (this._scopeEpochs.get(key) === this._syncEpoch) return;
    const inFlight = this._syncInFlight.get(key);
    if (inFlight !== void 0) {
      await inFlight;
      return;
    }
    const pending = (async () => {
      try {
        await this.syncRegistry(scope, toolSet);
        this._scopeEpochs.set(key, this._syncEpoch);
        this._status.noteScope("union");
      } catch (err) {
        this._warn(`ensureIndexed failed (fail-open, search unaffected): ${String(err)}`);
      } finally {
        this._syncInFlight.delete(key);
      }
    })();
    this._syncInFlight.set(key, pending);
    await pending;
  }
  /** 注册表当前可见工具数（catalog_status.protocol.registryTools）；按 scope 取可见集 */
  registryToolCount(scope, toolSet) {
    return this._tools?.definitions(scope, toolSet).length ?? 0;
  }
  /** 已知作用域数（含全局视图哨兵）：catalog_status.catalog.scopeCount */
  get knownScopeCount() {
    return this._knownScopes.size;
  }
  // -- CatalogApi（plugin-tools 需要的能力面） --
  /** 目录内工具总数（search 结果尾部的 "/ N in catalog"） */
  indexedCount() {
    return this._catalogNames.size;
  }
  /** invoke 转发依赖（必须已 attach ctx.tools） */
  invokeDeps() {
    const tools = this._tools;
    if (tools === null) throw new Error("plugin not attached to ctx.tools");
    return this.buildInvokeDeps(tools);
  }
  /**
   * 组装 catalog_status 快照（T10.3.2）。
   *
   * sidecar 活着时会现发一次 `stats` —— 这本身就是活性探测；拉不到就用
   * 上一次缓存并标记来源，不编造实时数据。
   */
  async statusSnapshot(scope, toolSet) {
    let stats = null;
    if (this._sidecar.ready) {
      try {
        stats = await this._sidecar.stats();
      } catch (err) {
        this._warn(`stats failed: ${String(err)}`);
      }
    }
    if (stats !== null) this._status.noteStats(stats);
    const dsh = detectDshInfo();
    return this._status.snapshot({
      sidecarInfo: this._sidecar.info,
      stats,
      dsh,
      registryTools: this.registryToolCount(scope, toolSet),
      knownScopes: this._knownScopes.size,
      embedMode: this._config.embedMode ?? "real",
      presentationMode: this._config.mode ?? "inject",
      catalogMode: this.catalogMode
    });
  }
  // -- 启动自检（T10.3.1） --
  /**
   * 依次：spawn sidecar → initialize → stats → 全量索引注册表 → 刷新名字缓存。
   *
   * 任一步失败 → `degraded` + 原因（**不阻塞 DSH**，红线 4）；
   * `failOpen=false` 时重新抛出（只给单测用）。
   */
  async selfCheck() {
    if (this._selfChecking) {
      return { ok: this._status.readiness === "ready", indexed: this._catalogNames.size, reason: this._status.reason };
    }
    this._selfChecking = true;
    this._status.startSelfCheck();
    let indexed = 0;
    try {
      await this._sidecar.start();
      this._status.markStep("spawn+initialize");
      this._status.setInterpreter(this._sidecar.info.interpreter);
      const stats = await this._sidecar.stats();
      this._status.noteStats(stats);
      this._status.markStep("stats");
      const res = await this.syncRegistry(void 0, void 0, { removeMissing: true });
      this._status.noteScope("global_only");
      this._status.markStep("index_registry");
      indexed = res.indexed + res.skipped;
      const names = await this._sidecar.listToolNames();
      this._catalogNames = new Set(names);
      for (const n of names) {
        if (!this._toolOrigins.has(n)) this._toolOrigins.set(n, "agent");
      }
      this._status.markStep("list_tool_names");
      if (this.catalogMode === "external") {
        this._externalNames = new Set(await this._sidecar.listExternalNames());
        this._externalEntries.clear();
        this._status.markStep("list_external_names");
      }
      this._status.passSelfCheck();
      const summary = `self-check ok: indexed=${indexed} catalog=${this._catalogNames.size} interpreter=${this._sidecar.info.interpreter ?? "unknown"} embedMode=${stats.embed_mode ?? "?"} vectorChannel=${stats.vector_channel ?? "?"}` + (this._externalNames.size > 0 ? ` external=${this._externalNames.size}` : "");
      this._info(summary);
      return { ok: true, indexed, reason: null };
    } catch (err) {
      if (this._config.failOpen === false) throw err;
      const sidecarError = this._sidecar.info.lastError;
      const message = err instanceof Error ? err.message : String(err);
      const reason = (message.length > 0 ? message : sidecarError ?? "self-check failed without a message") + (this._status.embedderFix !== null ? ` | fix: ${this._status.embedderFix}` : "");
      this._status.failSelfCheck(reason);
      this._warn(`self-check failed (fail-open, DSH unaffected): ${reason}`);
      return { ok: false, indexed, reason };
    } finally {
      this._selfChecking = false;
    }
  }
  _selfChecking = false;
};
var name = "youmi-tool-catalog";
var inject = ["tools"];
var CONFIG_FIELDS = {
  pythonCommand: { defaults: "", kind: "string" },
  dbPath: { defaults: "", kind: "string" },
  embedModel: { defaults: DEFAULT_CONFIG.embedModel, kind: "string" },
  embedMode: { defaults: "real", kind: "enum", enum: ["real", "keyword"] },
  mode: { defaults: "inject", kind: "enum", enum: ["inject", "declare"] },
  topK: { defaults: 5, kind: "number" },
  minScore: { defaults: 0.3, kind: "number" },
  failOpen: { defaults: true, kind: "boolean" },
  selfCheckOnStart: { defaults: true, kind: "boolean" },
  catalogMode: { defaults: "registry", kind: "enum", enum: ["registry", "external"] },
  externalCatalogPath: { defaults: "", kind: "string" },
  externalExecutor: { defaults: "mock", kind: "enum", enum: ["mock", "mcp"] },
  externalLimit: { defaults: 1e3, kind: "number" }
};
var CONFIG_KEYS = Object.keys(CONFIG_FIELDS);
var Config = {
  "~standard": {
    version: 1,
    vendor: "youmi-tool-catalog",
    validate(value) {
      const raw = value ?? {};
      const issues = [];
      const out = {};
      const unknownKeys = [];
      for (const key of Object.keys(raw)) {
        if (!CONFIG_KEYS.includes(key)) unknownKeys.push(key);
      }
      for (const key of CONFIG_KEYS) {
        const spec = CONFIG_FIELDS[key];
        const given = raw[key];
        if (given === void 0 || given === null) {
          out[key] = spec.defaults;
          continue;
        }
        if (spec.kind === "string") {
          if (typeof given !== "string") {
            issues.push({ message: `config.${key} must be a string (got ${typeof given})`, path: [key] });
            out[key] = spec.defaults;
          } else {
            out[key] = given.trim();
          }
          continue;
        }
        if (spec.kind === "number") {
          if (typeof given !== "number" || !Number.isFinite(given)) {
            issues.push({ message: `config.${key} must be a finite number (got ${JSON.stringify(given)})`, path: [key] });
            out[key] = spec.defaults;
          } else {
            out[key] = given;
          }
          continue;
        }
        if (spec.kind === "boolean") {
          if (typeof given !== "boolean") {
            issues.push({ message: `config.${key} must be a boolean (got ${JSON.stringify(given)})`, path: [key] });
            out[key] = spec.defaults;
          } else {
            out[key] = given;
          }
          continue;
        }
        if (!spec.enum.includes(given)) {
          issues.push({
            message: `config.${key} must be one of [${spec.enum?.join(", ")}] (got ${JSON.stringify(given)})`,
            path: [key]
          });
          out[key] = spec.defaults;
        } else {
          out[key] = given;
        }
      }
      if (typeof out.topK === "number" && (!Number.isInteger(out.topK) || out.topK < 1)) {
        issues.push({ message: "config.topK must be a positive integer", path: ["topK"] });
        out.topK = CONFIG_FIELDS.topK.defaults;
      }
      if (typeof out.minScore === "number" && (out.minScore < 0 || out.minScore > 1)) {
        issues.push({ message: "config.minScore must be within [0, 1]", path: ["minScore"] });
        out.minScore = CONFIG_FIELDS.minScore.defaults;
      }
      if (typeof out.externalLimit === "number" && (!Number.isInteger(out.externalLimit) || out.externalLimit < 1)) {
        issues.push({ message: "config.externalLimit must be a positive integer", path: ["externalLimit"] });
        out.externalLimit = CONFIG_FIELDS.externalLimit.defaults;
      }
      if (out.catalogMode === "external" && (typeof out.externalCatalogPath !== "string" || out.externalCatalogPath === "")) {
        issues.push({
          message: 'config.externalCatalogPath is required when catalogMode="external"',
          path: ["externalCatalogPath"]
        });
      }
      if (issues.length > 0) {
        return { issues: [...issues, ...unknownKeys.map((key) => ({ message: `unknown config key "${key}" (ignored by the plugin; check the spelling)`, path: [key] }))] };
      }
      if (unknownKeys.length > 0) out["~unknownKeys"] = unknownKeys;
      return { value: out };
    }
  }
};
function apply(ctx, config) {
  const catalogConfig = {
    pythonCommand: config.pythonCommand ?? "",
    dbPath: config.dbPath.trim() !== "" ? config.dbPath.trim() : defaultDbPath(),
    embedModel: config.embedModel,
    embedMode: config.embedMode,
    mode: config.mode,
    defaultTopK: config.topK,
    defaultMinScore: config.minScore,
    failOpen: config.failOpen,
    selfCheckOnStart: config.selfCheckOnStart,
    catalogMode: config.catalogMode,
    externalCatalogPath: config.externalCatalogPath,
    externalExecutor: config.externalExecutor,
    externalLimit: config.externalLimit
  };
  const plugin = new YoumiCatalogPlugin(catalogConfig, OWN_TOOL_NAMES);
  plugin.attach(ctx.tools, ctx.logger(name));
  const registered = [
    buildSearchDefinition(plugin),
    buildInvokeToolDefinition(plugin),
    buildStatusDefinition(plugin)
  ];
  ctx.effect(() => {
    void plugin.selfCheck().catch((err) => {
      ctx.logger(name).error(`self-check escaped its own guard: ${String(err)}`);
    });
    return () => {
      void plugin.stop();
    };
  }, "youmi-tool-catalog: lifecycle");
  let ok = 0;
  for (const definition of registered) {
    try {
      ctx.effect(() => ctx.tools.register(definition), `tools.register(${definition.name})`);
      ok += 1;
    } catch (err) {
      plugin.status.failSelfCheck(`cannot register ${definition.name}: ${String(err)}`);
      ctx.logger(name).warn(`register ${definition.name} skipped (fail-open): ${String(err)}`);
    }
  }
  plugin.status.setRegistered(ok);
  if (ok < registered.length) return;
  ctx.effect(
    () => {
      ctx.on("tools/change", () => plugin.onRegistryChanged());
    },
    'ctx.on("tools/change")'
  );
}
function textBlock(text) {
  return [{ type: "text", text }];
}
export {
  Config,
  EXECUTOR_UNAVAILABLE,
  INVOKE_TOOL_NAME,
  Indexer,
  MOCK_EXECUTOR_NOTE,
  OWN_TOOL_NAMES,
  SEARCH_TOOL_NAME,
  STATUS_TOOL_NAME,
  SessionState,
  Sidecar,
  StatusTracker,
  YoumiCatalogPlugin,
  apply,
  briefsFromEntry,
  buildInvokeDefinition,
  buildInvokeDeps,
  buildInvokeToolDefinition,
  buildSearchDefinition,
  buildStatusDefinition,
  candidateInterpreters,
  createInvokeTool,
  defaultDbPath,
  detectDshInfo,
  detectInterpreter,
  diffActivated,
  dispatchExternal,
  dispatchInvoke,
  editDistance,
  embedderFixCommand,
  extractToolNames,
  formatSearchResults,
  getSearchToolSchema,
  inject,
  mockExecute,
  name,
  probeInterpreter,
  renderSignature,
  schemaFromEntry,
  selectTools,
  signatureFor,
  signatureForEntry,
  suggestNames,
  summarizeStatus,
  textBlock,
  toArgv,
  unavailableText,
  validateAgainstSchema
};
