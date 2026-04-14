# Long Run Mission Keeper

一个包在 `codex` CLI 外层的 **terminal-first 长程执行控制器**。
它的目标不是单次对话，而是把：

- 任务目标
- 完成标准
- 澄清问答
- task graph
- verifier / reviewer gate
- 断点续跑状态

全部落盘，让 Codex 在真实环境里以 **manager-led native-agent / exec-backed 多 agent 语义** 持续推进，而不是只靠聊天上下文硬跑。

---

## 当前实现到哪了

当前仓库已经有两条执行面：

### `engine=v1`
传统的单 worker 长跑模式：

- 基于 `codex exec` / `codex exec resume`
- 每轮有审计
- 支持 pause / resume / approval

### `engine=v2`
面向多 agent 的新控制内核：

- manager 先澄清，再规划/分派
- child agents 按 role 隔离
- clarification / question / verification / review 都有持久化对象
- verifier / reviewer / manager acceptance 有 gate
- 支持 `--auto-bootstrap`

> 注意：v2 现在已经能在**真实 Codex CLI 环境**下跑 manager bootstrap、clarification、planner/runtime gate、timeout recovery 等路径；
> 但“真实 live 全链路成功到 completed”仍在继续硬化中。

---

## 运行要求

- Node `>=20`
- 已安装并登录 `codex` CLI
- 当前工作目录就是要持续执行的 Git 仓库

可选但推荐：

- 先跑一遍测试

```bash
npm test
```

---

## 目录结构

每个 run 会落到：

```text
.longrun/runs/<run_id>/
  mission.lock.json
  plan.json
  run.json
  events.jsonl
  controller.json                 # v2
  task-graph.json                 # v2
  clarifications/
  questions/
  answers/
  verifications/
  reviews/
  tasks/
  agents/
  artifacts/
```

---

## 最常用命令

CLI 入口：

```bash
node ./src/cli.js --help
```

当前支持：

```text
longrun start --goal "..." --done "..." [--engine v1|v2] [--auto-bootstrap]
longrun status [run_id]
longrun resume [run_id] [--auto-bootstrap]
longrun approve [run_id] [--note "..."] [--no-resume] [--auto-bootstrap]
longrun answer [run_id] --clarification-id "..." --answer "..." [--auto-bootstrap]
longrun stop [run_id] [--reason "..."]
longrun logs [run_id] [--tail 30]
```

---

## v1：单 worker 长跑

### 启动

```bash
node ./src/cli.js start \
  --engine v1 \
  --goal "搭建一个长期稳定运行的任务监督系统" \
  --done "系统可以持续执行并在目标完成时停止" \
  --done "发现偏航或高风险时会暂停并等待确认"
```

### 查看状态

```bash
node ./src/cli.js status
```

### 恢复

```bash
node ./src/cli.js resume
```

### 批准后继续

```bash
node ./src/cli.js approve --note "继续执行"
```

### 停止

```bash
node ./src/cli.js stop --reason "人工停止"
```

### 查看最近事件

```bash
node ./src/cli.js logs --tail 30
```

---

## v2：manager-led native-agent / exec-backed 多 agent 控制面

### 什么时候用 `--auto-bootstrap`

如果你希望 v2 在启动后**立刻让 manager 进入澄清/规划/分派循环**，就显式加：

```bash
--auto-bootstrap
```

如果不加，v2 只初始化 run / controller state，不会自动开始 manager loop。

---

## v2 最小用法

### 1) 启动一个 v2 run

```bash
node ./src/cli.js start \
  --engine v2 \
  --auto-bootstrap \
  --goal "把当前仓库里的 long-run v2 多 agent 控制链继续推进" \
  --done "manager 能先澄清，再把 bounded first-wave task graph 派发出来"
```

可能结果有两种：

#### A. manager 直接提出 clarification
这时状态通常会变成 `paused`，并在 `pending_approval` 或 clarifications 里写明原因。

先看状态：

```bash
node ./src/cli.js status <run_id>
```

然后到 `.longrun/runs/<run_id>/clarifications/` 找 clarification id，或者直接读状态文件。

### 2) 回答 clarification

```bash
node ./src/cli.js answer <run_id> \
  --clarification-id "<clarification_id>" \
  --answer "你的澄清答案" \
  --auto-bootstrap
```

如果加了 `--auto-bootstrap`，answer 后会立即继续 manager/planner/dispatch loop，而不是只写答案停在那里。

### 3) 手动 resume

如果你不想在 `answer` 时自动推进，也可以稍后再：

```bash
node ./src/cli.js resume <run_id> --auto-bootstrap
```

### 4) approve 后继续

某些 gate 会要求 approval。
这时可以：

```bash
node ./src/cli.js approve <run_id> \
  --note "继续执行" \
  --auto-bootstrap
```

如果你只想记录批准但不立刻继续：

```bash
node ./src/cli.js approve <run_id> \
  --note "继续执行" \
  --no-resume
```

---

## v2 当前行为要点

### 1) clarification-first
manager 会先澄清，再规划。
如果 manager bootstrap blocked / timeout，不会偷偷继续 planner。

### 2) bounded first wave
planner 产出的第一波 task proposal 会被限制在：

- 小而可执行
- 明确 `readRoots`
- 明确 `allowedFiles` / `forbiddenFiles`
- 在单写手规则下，`executor` 仍然最多 1 个

### 3) protocol hard gates
controller 现在会硬性拒绝：

- manager 一次问超过 3 个 blocking clarification
- planner 提了某个 role 的 task，但 `staffingPlan` 没覆盖该 role
- executor 没给 self-test evidence 就想进 verifier
- reviewer / verifier provenance 不成立却想过 gate

---

## 真实环境下的 timeout / recovery

为了防止真实 `codex exec` 首拍无限挂起，adapter 已支持 role-aware timeout。

### 全局超时

```bash
LONGRUN_NATIVE_AGENT_TIMEOUT_MS=30000 node ./src/cli.js ...
```

### 按角色超时

例如单独把 manager 缩短到 5 秒：

```bash
LONGRUN_NATIVE_AGENT_TIMEOUT_MANAGER_MS=5000 node ./src/cli.js start --engine v2 --auto-bootstrap ...
```

当前默认值：

- `manager/planner/observer/verifier/reviewer`: `90000ms`
- `executor`: `900000ms`

如果超时，会：

- 终止对应 `codex exec`
- 记录 stdout/stderr artifact
- 把 run 收敛成可恢复的 `paused`

---

## artifacts 在哪看

v2 child-agent 的真实运行 artifact 会落到：

```text
.longrun/runs/<run_id>/artifacts/native-exec/<agent_id>/task-<timestamp>/
  prompt.txt
  system-prompt.txt
  codex-stdout.log
  codex-stderr.log
  last-message.json
```

这几个文件是排查真实环境问题时最重要的证据。

---

## 当前已知边界

当前 README 不会夸大实现，已知边界如下：

1. **v2 仍然是 Codex-exec-backed isolated agent sessions**
   - 很接近 native-agent 语义
   - 但不是单会话内的自由 peer orchestration

2. **细粒度 read scope 仍然是协议级约束**
   - `readRoots` 会进入模板、task packet、prompt envelope
   - 但不是 Codex 原生的硬 read allow-list

3. **真实 live 成功链路还在继续硬化**
   - manager bootstrap / timeout recovery / inherited MCP isolation 已经有真实证据
   - 但完整 `answer -> planner -> executor -> verifier -> reviewer -> manager acceptance -> completed`
     的真实成功链还在继续推进

---

## 开发与验证

跑测试：

```bash
npm test
```

如果你在改 v2 runtime，建议至少顺手看：

- `tests/manager-loop.test.js`
- `tests/controller-runtime.test.js`
- `tests/codex-exec-adapter.test.js`
- `tests/cli-v2-routing.test.js`

---

## 一句话总结

如果你只想记住一句：

> **v1 是单 worker 长跑器，v2 是 manager-led 的多 agent 控制内核；当前仓库已经能在真实环境里跑 v2 bootstrap 和恢复路径，但完整 live 成功链仍在继续硬化。**
