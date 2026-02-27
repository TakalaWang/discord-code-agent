# Discord Code Agent 規格 v3（Research 驅動）

## 0. 這版解決什麼問題
你要求「先 research 再重設計」，這版目標是：
- 不是憑印象，而是用官方文件 + 參考專案 + 本機 CLI 實測來定規格。
- 直接回答你最在意的三件事：
  - 連線怎麼做（長連線 vs 每次任務短連線）
  - 怎麼續聊（Claude/Codex/Gemini）
  - 不用 DB 時，怎麼做可靠佇列與恢復

---

## 1. Research 結論（可驗證）

### 1.1 Discord 官方限制（影響架構）
1. Interactions 接收方式是二選一：`Gateway (INTERACTION_CREATE)` 或 `outgoing webhook`，兩者互斥。
2. Slash command 必須在 3 秒內先回應（可 deferred），interaction token 可用 15 分鐘。
3. Interaction webhook endpoint 不受一般全域 rate limit bucket 約束（但仍有其端點限制）。
4. 一般 REST API 仍要遵守 rate limit header，遇到 429 需依 `retry_after` 退避。
5. Thread 是正式 channel 型別：可 active/archived；會因 inactivity auto-archive；locked thread 需對應權限才可解鎖。

### 1.2 參考專案可借鏡點（Telegram -> Discord）
1. `claude-code-telegram`
- 強調 project/topic（thread）映射，並做 session persistence。
- 有 strict topic routing（只允許在映射 thread 內操作）。
2. `chatcode`
- 採 polling，證明「個人機器常駐即可跑」的簡化路線可行。
- 有 message batching/queue，Cloudflare Workers 只是 optional（差異展示用途，不是核心 agent 執行鏈路）。

### 1.3 三個 CLI 的「續聊能力」
1. Claude Code（官方 CLI ref + 本機實測）
- `-p` 非互動；`--output-format stream-json` 可串流。
- `-r/--resume <session>`、`-c/--continue` 可續聊。
- stream-json 事件內含 `session_id`（本機已驗證）。
2. Codex CLI（官方 repo + 本機實測）
- `codex exec --json` 非互動 JSONL。
- 首次執行事件會吐 `thread.started` 與 `thread_id`（本機已驗證）。
- `codex exec resume <thread_id> --json` 可續聊（本機已驗證）。
3. Gemini CLI（官方 repo/docs + 本機實測）
- `-p` headless；`--output-format stream-json` 可取得 `init.session_id`。
- `--resume <session_id>`、`--resume latest`、`--resume`（無參數）皆可續聊。
- `--output-format json` 會回傳單一 JSON 物件，且含 `session_id`、`response`、`stats`。
- `--list-sessions` 可列出目前專案範圍內可續聊 session。
- 實測觀察：stdout 可能夾雜非 JSON 行（例如 `Loaded cached credentials.`、重試訊息），不能假設每一行都可 JSON parse。

---

## 2. 架構決策（最終）

### 2.1 部署決策
選擇：**單機部署 Bot + Runner（推薦）**
- 不用 Cloudflare Worker 當中繼。
- 你的機器直接跑 Discord bot + CLI adapter。
- 原因：你是單人使用，這是最少失敗點的路徑。

### 2.2 連線模型
選擇：**Discord 長連線、CLI 短連線**
- Discord gateway 必須常駐（才能即時收事件）。
- 每則 thread 訊息觸發一個 CLI process：`spawn -> stream -> exit`。
- 同 thread 不維持 CLI 常連；任務完成即斷。

### 2.3 Session 模型
- `thread_id` = session 主鍵。
- `project` 是執行模板（`path`、可用工具、預設工具、預設參數）。
- **同一 project 可同時掛多個 thread session**（thread 間各自保存工具側 session key）。
- `/session open <session_id>` 只做「回到原 thread 繼續聊」，不做跨 thread 轉接，避免併發污染。

---

## 3. 不用 DB 的可靠傳輸層（JSON-only）

## 3.1 檔案佈局
- `state/config.json`：設定（project catalog、owner 綁定、執行常數）
- `state/snapshot.json`：當前 sessions/queues 快照
- `state/events.ndjson`：append-only 事件日誌（可靠層核心）

## 3.2 寫入策略
1. 先 append `events.ndjson`（`fsync`）。
2. 每 N 筆事件或每 T 秒生成新 snapshot（temp file + atomic rename）。
3. 啟動時：`snapshot + events replay` 重建記憶體狀態。

這樣仍是 JSON，不是 DB，但可靠性遠高於單檔覆寫。

## 3.3 交付語義
- 入隊：`exactly-once enqueue`（靠 `thread_id:discord_message_id` 去重）。
- 執行：`single-consumer FIFO per thread`（每 thread 同時只跑 1 個 job）。
- 失敗恢復：
  - 若 crash 時 job 正在 running，標記 `unknown_after_crash`（避免盲目重跑造成重複副作用）。
  - 由 owner 用 `/retry` 明確重送。

---

## 4. 續聊設計（跨工具一致）

## 4.1 抽象介面
每個 thread session 保存：
- `tool`（claude/codex/gemini）
- `adapter_state`（工具特定 session key）

## 4.2 Adapter state key
- Claude: `adapter_state.session_id`
- Codex: `adapter_state.thread_id`
- Gemini: `adapter_state.session_id`

## 4.3 實際命令策略
1. Claude
- 新對話：`claude -p --verbose --output-format stream-json "<prompt>"`
- 續聊：`claude -p --verbose --output-format stream-json -r <session_id> "<prompt>"`
- 從事件中擷取 `session_id` 並保存。
- 本機驗證顯示重複直接指定同一 `--session-id` 可能遇到 `Session ID ... is already in use`，因此執行層統一走 `-r`。

2. Codex
- 新對話：`codex exec --json "<prompt>"`
- 續聊：`codex exec resume <thread_id> --json "<prompt>"`
- 從 `thread.started` 擷取 `thread_id` 並保存。

3. Gemini
- 新對話：`gemini -p "<prompt>" --output-format stream-json`
- 續聊：`gemini -p "<prompt>" --output-format stream-json --resume <session_id>`
- 或改用非串流模式：`gemini -p "<prompt>" --output-format json`，直接從回傳 JSON 取 `session_id`。
- `session_id` 取得優先順序：
  1. `stream-json` 的 `type=init` 事件；
  2. `json` 回傳內的 `session_id`；
- 若該輪未取得 `session_id`，直接標記 `failed(E_ADAPTER_SESSION_KEY_MISSING)`，不做猜測性 fallback。
- Parser 規則：僅解析「看起來是 JSON 物件」的行，其餘行當作診斷 log 並保留，不可讓整體任務失敗。

## 4.4 Gemini Adapter 實作契約（補強）
- 輸入：
  - `prompt`, `cwd`, `resumeSessionId?`, `mode(stream|json)`。
- 事件解析：
  1. line-by-line 讀 stdout。
  2. 先做 fast check（`line.trim().startsWith('{') && line.trim().endsWith('}')`）。
  3. 可 parse 才進 JSON 流程，否則寫入 `diagnostic_logs[]`。
  4. `type=init` -> 更新 `adapter_state.session_id`。
  5. `type=message` 且 `role=assistant` -> 累積輸出 delta。
  6. `type=result` 且 `status=success` -> job success；否則 failed。
- 退出判定：
  - process exit code != 0 -> failed。
  - exit code = 0 但沒有 `result` 事件 -> failed(`missing_result_event`)。
- 重試策略：
  - 同一 job 最多 1 次自動重試（只針對可判定的暫時性錯誤，例如 quota/retry 類訊息）。
  - 自動重試仍失敗 -> 交給 `/retry` 人工觸發。

---

## 5. Discord 指令面（Discord-only config）

### 5.1 Owner 指令（單人使用，全部由同一人操作）
- `/project create <name> <path> <tools_csv> <default_tool> [args_json]`：建立可啟動的 project（單一入口模板）
- `/project list`：列出所有 project
- `/project status <project_name>`：顯示 project 層狀態（session 數、running 數、queue 總量、最近錯誤）
- `/start <project_name>`：建立新 thread + 綁定新 session
- `/session list [project_name]`：列出可續接 session（含 thread 連結、最後活動時間、狀態）
- `/session open <session_id>`：打開/解封存對應 thread，並在該 thread 繼續對話
- `/status`：顯示「目前 thread session」的即時狀態
- `/tool <claude|codex|gemini>`：切換該 thread tool
- `/retry <job_id>`：重試 `failed` 或 `unknown_after_crash`
- 執行參數先固定為程式內建常數（例如 queue 長度、CLI timeout），不做指令化；等真的遇到需求再升級。

### 5.2 `/status` 輸出欄位（thread 內）
- `project_name`
- `tool`
- `session_key`（Claude/Gemini 是 `session_id`，Codex 是 `thread_id`）
- `state`（`idle|running|queued|failed|unknown_after_crash`）
- `queue`（`pending` 數與 `running_job_id`）
- `last_job`（成功/失敗、耗時、完成時間）
- `resume_ready`（是否可續聊）
- `retry_hint`（若失敗，直接提示 `/retry <job_id>`）

### 5.3 授權模型（owner-only）
- 啟動時讀取 `DISCORD_OWNER_ID`（必要設定）。
- 僅接受該 `owner_id` 的 slash command 與 thread 訊息，其餘請求直接拒絕。
- 不做角色（role）或 channel 白名單控管，保持最小模型與最低維護成本。

---

## 6. Queue 與執行流程
1. 收到 thread 訊息 -> 去重檢查。
2. 寫入 `JobEnqueued` event。
3. 若 thread 無 running job，啟動 worker。
4. worker 啟 CLI，將進度節流更新同一則 Discord status message。
5. CLI 結束：寫 `JobCompleted`/`JobFailed`，更新 `adapter_state`。
6. 拉下一筆 queue；空則 worker 結束。

---

## 7. 部署建議（你的情境）

### 7.1 先上線方案（建議）
- 一台常開機器（你的電腦即可）
- Node.js 22 + TypeScript + `discord.js`（用 `pnpm` 管理）
- 以 `systemd/pm2/launchd` 常駐 bot 進程
- 版本固定：`pnpm lockfile + CLI 版本 pin`

### 7.2 Discord App 必要設定
- Gateway Intents：`Guilds`、`GuildMessages`、`MessageContent`。
- Bot 權限：`View Channels`、`Send Messages`、`Read Message History`、`Create Public Threads`、`Send Messages in Threads`、`Manage Threads`、`Use Application Commands`。
- Slash commands 先註冊在單一 guild（開發期），穩定後再考慮 global。

### 7.3 暫不建議
- Cloudflare Worker 回呼家中 runner（多一層網路與認證複雜度，對單人無收益）

---

## 8. 風險與保護欄
1. CLI 事件格式版本漂移
- 保護：adapter schema 驗證 + 版本 pin + 啟動自檢。
2. Discord 429
- 保護：per-route bucket + jitter backoff + message edit 節流。
3. 崩潰時 running job 不可知
- 保護：標 `unknown_after_crash`，不自動重跑。
4. 多 thread 共享同一 project 路徑造成上下文污染
- 保護：每 thread 綁獨立 adapter session key，不用「latest」。
5. Gemini stream 混入非 JSON 行
- 保護：line-based parser 先做 JSON 判斷，非 JSON 行寫入 debug log，不中斷 job。

---

## 9. 本機實測摘要（本次 research）
1. `codex exec --json` 會輸出 `thread.started` + `thread_id`。
2. `codex exec resume <thread_id> --json` 可成功延續上一輪上下文。
3. `claude -p --verbose --output-format stream-json` 會輸出 `session_id`。
4. `claude -p ... -r <session_id>` 可成功續聊。
5. `gemini -p ... --output-format stream-json` 會輸出 `init.session_id`，且 `--resume <session_id>` 可續聊成功。
6. `gemini --resume latest` 與 `gemini --resume`（無參數）皆可回到最近 session。
7. `gemini -p ... --output-format json` 回傳單一 JSON（含 `session_id`），適合不需即時串流時使用。
8. Gemini stdout 可能有非 JSON 診斷行（載入憑證、重試訊息），adapter 需容忍混流。

---

## 10. 資料結構（實作契約）

### 10.1 `state/config.json`
```json
{
  "version": 1,
  "owner_id": "123456789012345678",
  "projects": {
    "my-app": {
      "name": "my-app",
      "path": "/Users/takala/code/my-app",
      "enabled_tools": ["gemini", "codex", "claude"],
      "default_tool": "gemini",
      "default_args": {
        "gemini": ["--model", "gemini-2.5-pro"],
        "codex": [],
        "claude": []
      },
      "created_at": "2026-02-26T14:00:00.000Z",
      "updated_at": "2026-02-26T14:00:00.000Z"
    }
  }
}
```

約束：
- `project.name` 僅允許 `[a-z0-9-_]{1,40}`。
- `path` 必須是絕對路徑，且 bot 啟動時必須存在。
- `default_tool` 必須包含在 `enabled_tools`。
- `default_args.<tool>` 必須是字串陣列；執行時一律用 `spawn(argv[])`，不經 shell。

### 10.2 `state/snapshot.json`
```json
{
  "version": 1,
  "sessions": {
    "1359000000000000000": {
      "thread_id": "1359000000000000000",
      "project_name": "my-app",
      "tool": "gemini",
      "adapter_state": { "session_id": "gmn_session_abc" },
      "queue": ["job_20260226_0002"],
      "running_job_id": "job_20260226_0001",
      "last_job_id": "job_20260226_0000",
      "created_at": "2026-02-26T14:20:00.000Z",
      "updated_at": "2026-02-26T14:21:00.000Z",
      "last_activity_at": "2026-02-26T14:21:00.000Z"
    }
  },
  "jobs": {
    "job_20260226_0001": {
      "job_id": "job_20260226_0001",
      "thread_id": "1359000000000000000",
      "discord_message_id": "1359000000000001234",
      "state": "running",
      "prompt": "請幫我修 tests",
      "attempt": 1,
      "tool": "gemini",
      "error_code": null,
      "error_message": null,
      "started_at": "2026-02-26T14:21:00.000Z",
      "finished_at": null,
      "result_excerpt": null
    }
  },
  "dedupe": {
    "1359000000000000000:1359000000000001234": "job_20260226_0001"
  }
}
```

### 10.3 `state/events.ndjson`
每行一個事件，統一 envelope：
```json
{
  "seq": 1024,
  "ts": "2026-02-26T14:21:00.000Z",
  "type": "JobStarted",
  "payload": { "job_id": "job_20260226_0001", "thread_id": "1359..." }
}
```

事件種類（最小集合）：
- `ProjectCreated`
- `ProjectUpdated`
- `SessionCreated`
- `ToolChanged`
- `JobEnqueued`
- `JobStarted`
- `JobProgress`
- `JobCompleted`
- `JobFailed`
- `JobMarkedUnknownAfterCrash`

replay 原則：
- 只信任 `events.ndjson` + 最近 `snapshot`。
- 若 `seq` 不連續，啟動直接 fail-fast（不進入服務），避免 silent corruption。

---

## 11. 指令契約（參數、前置條件、回應）

### 11.1 `/project create`
- 參數：`name`, `path`, `tools_csv`, `default_tool`, `args_json?`
- 驗證：名稱 regex、`path` 存在、`default_tool in tools`
- 成功：寫入 `ProjectCreated`，回覆 project 摘要
- 失敗：`E_PROJECT_EXISTS`、`E_INVALID_PATH`、`E_INVALID_TOOLSET`

### 11.2 `/project list`
- 回傳：project 名稱、預設工具、路徑、啟用工具

### 11.3 `/project status <project_name>`
- 回傳欄位：`session_total`, `running_sessions`, `queued_jobs`, `failed_jobs_24h`, `last_error`
- 建議回應格式：
```text
Project Status: my-app
session_total: 4
running_sessions: 1
queued_jobs: 3
failed_jobs_24h: 0
last_error: n/a
```

### 11.4 `/start <project_name>`
- 前置：呼叫位置需在 guild 文字頻道（非 thread）
- 行為：建立新 thread、建立 `SessionCreated`、綁定 project 與 default tool
- 回傳：thread mention + session_id（即 thread_id）

### 11.5 `/session list [project_name]`
- 回傳：最多 20 筆，按 `last_activity_at desc`
- 欄位：`session_id(thread_id)`, `project_name`, `state`, `last_activity_at`, `thread_link`

### 11.6 `/session open <session_id>`
- 行為：定位原 thread，必要時 unarchive，回覆可點擊 thread link
- 限制：不做跨 thread session 搬移
- 失敗：`E_SESSION_NOT_FOUND`、`E_THREAD_ACCESS_FAILED`

### 11.7 `/status`（僅 thread 內）
- 回傳固定欄位（第 5.2 節）
- 非 managed thread 呼叫：`E_NOT_IN_MANAGED_THREAD`
- 建議回應格式：
```text
Session Status
project: my-app
tool: gemini
session_key: gmn_session_abc
state: running
queue: pending=2, running=job_20260226_0001
last_job: success, 18s, 2026-02-26T14:20:05.000Z
resume_ready: yes
retry_hint: n/a
```

### 11.8 `/tool <claude|codex|gemini>`（僅 thread 內）
- 驗證：目標工具必須在該 project `enabled_tools`
- 行為：寫入 `ToolChanged`；不清空 queue
- 若目前有 running job：新工具從「下一個 job」生效

### 11.9 `/retry <job_id>`
- 只允許 `failed` 或 `unknown_after_crash`
- 行為：建立新 job（新 `job_id`），`attempt = old.attempt + 1`
- 失敗：`E_JOB_NOT_RETRYABLE`

---

## 12. 狀態機與排程規則

### 12.1 Job 狀態機
- `queued -> running -> success`
- `queued -> running -> failed`
- `queued -> running -> unknown_after_crash`
- 不允許直接修改歷史 job；`/retry` 一律產生新 job。

### 12.2 Session 狀態推導（`/status` 用）
- 若 `running_job_id != null` -> `running`
- 否則若 `queue.length > 0` -> `queued`
- 否則若 `last_job.state == unknown_after_crash` -> `unknown_after_crash`
- 否則若 `last_job.state == failed` -> `failed`
- 其餘 -> `idle`

### 12.3 排程規則
- 每個 thread 單工 FIFO（嚴格順序）。
- 全域並行上限固定 `GLOBAL_MAX_RUNNING = 2`（跨 thread 最多兩個 CLI 同時跑）。
- 同一 Discord 訊息只會 enqueue 一次（`thread_id:message_id` 去重）。

---

## 13. 固定執行常數（先不指令化）

- `CLI_TIMEOUT_SEC = 900`
- `MAX_QUEUE_PER_SESSION = 20`
- `GLOBAL_MAX_RUNNING = 2`
- `STATUS_EDIT_MIN_INTERVAL_MS = 1200`
- `SNAPSHOT_EVERY_EVENTS = 50`
- `SNAPSHOT_EVERY_SECONDS = 5`
- `MAX_RESULT_EXCERPT_CHARS = 400`

超限策略：
- queue 滿：直接拒絕新訊息入隊，回覆 `E_QUEUE_FULL`。
- CLI timeout：標記 `failed(E_CLI_TIMEOUT)`。

---

## 14. 錯誤碼與觀測性

### 14.1 錯誤碼（最小集合）
- `E_OWNER_ONLY`
- `E_NOT_IN_MANAGED_THREAD`
- `E_PROJECT_NOT_FOUND`
- `E_PROJECT_EXISTS`
- `E_INVALID_PATH`
- `E_INVALID_TOOLSET`
- `E_TOOL_NOT_ENABLED`
- `E_SESSION_NOT_FOUND`
- `E_THREAD_ACCESS_FAILED`
- `E_QUEUE_FULL`
- `E_JOB_NOT_RETRYABLE`
- `E_CLI_TIMEOUT`
- `E_CLI_EXIT_NONZERO`
- `E_ADAPTER_PARSE`
- `E_ADAPTER_MISSING_RESULT`
- `E_ADAPTER_SESSION_KEY_MISSING`
- `E_DISCORD_RATE_LIMIT`

### 14.2 日誌
- `logs/app.ndjson`：系統級事件（日誌等級、error_code、stack）
- `logs/job/<job_id>.log`：該 job 的 CLI stdout/stderr 原文（含非 JSON 行）
- 任何失敗都必須帶 `error_code`，不可只寫自由文字

---

## 15. 驗收測試矩陣（達標才可宣告可用）

1. Owner gating：非 owner 送任何指令/訊息都被拒絕。
2. `/start`：可建立 thread 並產生可用 session。
3. Thread 內連續 3 則訊息：保證 FIFO、結果順序正確。
4. 多 thread 並行：同 project 下兩個 thread 可同時跑（受 `GLOBAL_MAX_RUNNING` 控制）。
5. `/tool`：切換後只影響新 job，不影響 running job。
6. 崩潰恢復：故意 kill process 後重啟，running job 會變 `unknown_after_crash`。
7. `/retry`：可對 failed job 產生新 job 並成功執行。
8. Gemini 混流：stdout 注入非 JSON 行不會中斷解析。
9. Discord 429：模擬 rate limit 後會退避並最終成功更新訊息。
10. `/session open`：封存 thread 可被打開並繼續對話。
11. `/status`：欄位齊全且值與 snapshot 一致。
12. event replay：刪除 snapshot 僅用 events 重建後，狀態一致。

---

## 16. Implementation-Ready Checklist

- [ ] 指令參數與錯誤碼已凍結（不再改動命名）
- [ ] `config/snapshot/events` JSON 結構已凍結
- [ ] 三個 adapter 的 session key 行為已驗證並寫測試
- [ ] queue/replay/unknown_after_crash 測試案例可重現
- [ ] systemd 或 pm2 部署腳本確定可開機自啟
- [ ] `.env.example` 完整（`DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_OWNER_ID`, `STATE_DIR`, `LOG_DIR`）

當上面 6 項都完成，規格可視為「可直接開始實作」。

---

## 17. 參考來源
- Discord Interactions: https://docs.discord.food/interactions/receiving-and-responding
- Discord Rate Limits: https://docs.discord.food/topics/rate-limits
- Discord Threads: https://docs.discord.food/topics/threads
- Discord Channel resource (thread endpoints): https://docs.discord.food/resources/channel
- Discord Application Commands: https://docs.discord.food/interactions/application-commands
- Discord Gateway + intents: https://docs.discord.food/topics/gateway
- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Claude Code common workflows: https://docs.anthropic.com/en/docs/claude-code/common-workflows
- Codex repository README: https://github.com/openai/codex
- Codex non-interactive docs entry: https://developers.openai.com/codex/noninteractive
- Gemini CLI repository: https://github.com/google-gemini/gemini-cli
- Gemini session management: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
- Gemini checkpointing: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md
- Gemini headless mode: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- 參考專案（Telegram）:
  - https://github.com/RichardAtCT/claude-code-telegram
  - https://github.com/Nickqiaoo/chatcode
