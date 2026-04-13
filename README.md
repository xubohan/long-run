# Long Run Mission Keeper

一个包在 `codex` CLI 外层的 terminal-first supervisor，用来解决长时间运行时目标漂移、无进展空转、以及中断后难以续跑的问题。

## 设计目标

- 先锁定 `mission lock`，把目标、完成标准、约束和 guardrails 落盘
- 每一轮都从落盘状态重建 prompt，而不是只靠聊天历史
- 每一轮执行后做审计，检查偏航、重复 bug、无进展和高风险操作
- 只有在高风险或明显异常时暂停，其他情况持续往下跑
- `codex` 或 supervisor 进程中断后，可以从本地状态继续同一个 run

## 目录结构

- `.longrun/runs/<run_id>/mission.lock.json`
- `.longrun/runs/<run_id>/plan.json`
- `.longrun/runs/<run_id>/run.json`
- `.longrun/runs/<run_id>/events.jsonl`
- `.longrun/runs/<run_id>/artifacts/cycle-XXXX/`

## 用法

直接用 Node：

```bash
node src/cli.js start --goal "搭建一个长期稳定运行的任务监督系统" \
  --done "系统可以持续执行并在目标完成时停止" \
  --done "发现偏航或高风险时会暂停并等待确认"
```

查看状态：

```bash
node src/cli.js status
```

恢复继续跑：

```bash
node src/cli.js resume
```

批准后继续：

```bash
node src/cli.js approve --note "继续执行"
```

停止：

```bash
node src/cli.js stop --reason "人工停止"
```

看最近事件：

```bash
node src/cli.js logs --tail 30
```

## 运行要求

- Node 20+
- `codex` CLI 已安装并登录
- 当前工作目录就是你要让 Codex 持续工作的目录

## 当前边界

- v1 直接绑定 `codex exec` / `codex exec resume`
- 只做 terminal-first，本地文件状态，不做 Web UI
- `stop` 目前会优先请求停止并尝试结束 worker/supervisor 进程
- 是否真正完成，仍依赖 worker 输出的结构化证据和 supervisor 审计
