# Codex native agent template layer

## 结论先说

**可以做，而且应该先做。**

Codex 的 `codex exec` / native subagents 已经支持把一部分 agent 能力直接包装进模板层：

- `developer_instructions` 作为 system prompt 模板
- `model` / `model_reasoning_effort`
- `sandbox_mode`
- `mcp_servers`
- `skills.config`
- project-scoped `.codex/agents/*.toml`

但也有两类能力不是完全原生的：

1. **细粒度 read scope**
   - 目前没有“只允许读某几个子目录”的硬原生 allow-list
   - 最稳做法是：
     - working root / sandbox / writable roots 负责硬边界
     - read scope 通过 task packet + developer instructions + manager 路由协议约束

2. **agent 直接互聊**
   - 目前没有可靠的原生 peer-to-peer 通道
   - 最稳做法是：**manager / controller relay**
     - question packet
     - answer packet
     - result packet

---

## 这个接入层现在放在哪里

本仓库先把“接入层”做成**代码模板层**，而不是直接写死一堆 `.codex/agents/*.toml`：

- `src/lib/native-agent-template.js`
- `tests/native-agent-template.test.js`

这样后面真正开始生成 manager / planner / observer / executor / verifier / reviewer 多实例时，就能：

- 先用统一 schema 组装模板
- 再按角色渲染成真实 TOML
- 最后由 controller/runtime 去 materialize 到 `.codex/agents/`

---

## 现在这层已经提供的能力

### 1. 能力矩阵
`getCodexExecTemplateSupportMatrix()` 会区分：

- `direct`
- `partial`
- `indirect`
- `none`

重点是把“Codex 原生支持什么”和“只能通过协议层实现什么”拆开。

### 2. 角色模板
`buildLongRunAgentTemplate()` 现在支持六个 baseline role：

- `manager`
- `planner`
- `observer`
- `executor`
- `verifier`
- `reviewer`

### 3. 输出 TOML
`renderAgentTemplateToml()` 可以把模板对象渲染成真实 custom agent 文件。

### 4. 整层生成
`createLongRunTemplateLayer()` 可以一次生成整个 long-run baseline role layer。

### 5. 物化到 `.codex/agents/`
`materializeLongRunTemplateLayer()` 可以把整层模板直接写成 project-scoped custom agent TOML 文件。

---

## 模板层如何表达你的几个关键需求

### 提示词模板
通过 `developer_instructions` 直接表达。

### 可读取目录范围限制
当前作为：

- **协议级 read scope**
- 写进 developer instructions
- 由 manager task packet 和 controller relay 共同约束

### 可写范围
对 write-capable agent：

- `sandbox_mode = "workspace-write"`
- `[sandbox_workspace_write]`
- `writable_roots = [...]`

### skills
通过 `skills.config` 挂进模板。

### MCP
通过 `mcp_servers.<id>` 和：

- `enabled_tools`
- `disabled_tools`

做 allow/deny。

### agents 之间如何交流
默认不做 direct peer chat，统一走：

- `controller-relay`
- `questions/`
- `answers/`
- `artifacts/`

也就是：
- agent 提问
- manager/controller 路由
- answer 回注

---

## 设计立场

这个接入层的核心不是“现在就把所有 agent runtime 做完”，而是先把：

- 角色模板
- 能力边界
- 原生支持 vs 协议支持
- 可渲染 TOML

先钉死。

这样后续做 M3/M4 时，真正生成多个 agents 会容易很多，也不容易在 runtime 里一边实现一边临时发明模板格式。

当前我**没有直接把 live `.codex/agents/` 写进仓库根目录并启用**，而是先把：

- 模板 schema
- TOML renderer
- materializer

做成代码层，避免当前开发会话被新模板意外接管。
