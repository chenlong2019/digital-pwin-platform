# 通用智能体仿真与数字孪生平台

## Technical Architecture & Specification

> 当前第一阶段：DJI Mini 4 Pro 无人机仿真
> 后续扩展：汽车、船舶、机器人、多智能体、多人协同、AI Agent、数字孪生

---

# 快速开始

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | `^22.18.0` 或 `>=24.12.0`（见根 `package.json` 的 `engines`） |
| npm | 随 Node 自带即可；仓库用 **npm workspaces**，不需要 pnpm / yarn |

## 安装与启动

```bash
npm ci          # 严格按 package-lock.json 安装；没有锁文件时才用 npm install
npm run dev     # 启动无人机沙盒，默认 http://localhost:5173
```

应用层直接消费 `packages/*` 的 **TypeScript 源码**（不做预构建），改包内源码即时热更。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动沙盒开发服务器 |
| `npm run build` | 类型检查 + 生产构建，产物在 `apps/drone-simulator/dist` |
| `npm run preview` | 预览生产构建 |
| `npm run check:arch` | 只跑架构静态检查（§74） |
| `npm run type-check` | 架构静态检查 + 全量类型检查 |
| `npm run test:unit` | 单元测试（vitest，逐包执行） |
| `npm run verify` | `type-check` + `build`，**提交前跑这一条** |
| `npm run format` | Prettier 格式化 |

端到端测试用 Playwright，首次需要先装浏览器：

```bash
npx playwright install chromium
npm run test:unit -w @simulation/drone-simulator
cd apps/drone-simulator && npx playwright test --project=chromium
```

## 仓库结构

```text
packages/                各层能力包，按六层架构分层（§40）
  contracts/             契约层：中性数据结构与接口
  simulation-core/       仿真时钟与固定步长循环
  agent-core/            智能体基座与运行时
  sandbox-core/          沙盒：世界、物理、障碍物、场景
  drone-agent/           无人机领域智能体（DJI Mini 4 Pro）
  task-core/             任务与航点
  recorder/              事件 / 指令 / 快照记录
  domain-api/            领域门面：外部唯一入口
  three-adapter/         渲染适配层（three.js 隔离在此）
apps/
  drone-simulator/       唯一 UI 宿主：Vue 3 + Vite
```

## 页面入口

| 路由 | 页面 |
| --- | --- |
| `/` | 无人机沙盒 |
| `/flow` | 模块流程图与依赖关系 |
| `/docs` | 项目文档：使用手册 + 本规范全文 |

---

# 1. 文档目的

本文定义通用智能体仿真与数字孪生平台的整体技术架构。

目标不是只构建一个“无人机模拟器”，而是建立一个可持续扩展的平台，使：

```text
无人机
汽车
船舶
机器人
AI Agent
多人协同
数字孪生
真实设备
```

都可以在统一的仿真基础设施上运行。

本文重点解决：

- 平台整体架构
- 核心领域模型
- 模块边界
- Package 边界
- 模块交互接口
- 依赖方向
- 仿真运行时
- 多人协同
- AI / MCP
- Recorder / Replay
- Renderer Adapter
- Device Adapter
- 非功能需求
- 验收标准
- Package 可迁移能力

---

# 2. 产品定位

平台定位为：

> **通用智能体仿真与数字孪生基础平台**

平台本身不绑定某一种 Agent。

第一阶段：

```text
DJI Mini 4 Pro
```

第二阶段：

```text
Vehicle
Boat
Robot
```

第三阶段：

```text
Multi-Agent
AI Agent
Human + AI Collaboration
```

第四阶段：

```text
Digital Twin
Real Device Integration
Large-Scale Simulation
```

---

# 3. 核心设计目标

## 3.1 Simulation First

平台首先是：

> Simulation Platform

而不是：

> UI Application

UI 只是 Simulation 的一个使用方式。

---

## 3.2 Agent First

平台围绕：

```text
Agent
```

设计。

Agent 可以是：

```text
Drone
Vehicle
Boat
Robot
NPC
AI Agent
Digital Twin Entity
```

---

## 3.3 Package First

所有核心能力必须尽量独立成 Package。

目标：

```text
Drone Agent
```

能够脱离：

```text
Drone Simulator Application
```

单独迁移到：

```text
Vehicle Simulator
Digital Twin
Robot Simulator
Server Simulation
```

---

## 3.4 Specific First, Generic Later

第一阶段允许针对无人机做具体实现。

例如：

```text
DroneController
DroneDynamics
FlightMission
DJIAdapter
```

但这些实现不能污染：

```text
Simulation Core
Agent Core
Task Core
```

---

# 4. 产品演进路线

```text
Phase 1
Drone Simulation
        ↓
Phase 2
Vehicle / Boat / Robot
        ↓
Phase 3
Multi-Agent
        ↓
Phase 4
Multi-User Collaboration
        ↓
Phase 5
AI Agent / MCP
        ↓
Phase 6
Digital Twin
        ↓
Phase 7
Real Device / Large Scale Simulation
```

---

# 5. 技术架构目标

平台最终需要支持：

```text
                    ┌───────────────┐
                    │ Human User    │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
                    │ AI Agent      │
                    └───────┬───────┘
                            │
                       Domain API
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
      Drone              Vehicle             Robot
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                    Simulation Runtime
                            │
                       Sandbox / World
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
     Renderer           Recorder           Realtime
        │                   │                   │
    Three/Cesium        Replay              Clients
```

---

# 6. 核心领域术语

以下术语为平台统一术语。

| 术语               | 定义                       |
| ------------------ | -------------------------- |
| World              | 概念上的完整仿真世界       |
| Sandbox            | Agent 运行所处的环境与规则 |
| Scenario           | Sandbox 的可保存、加载配置 |
| Session            | 一次具体仿真实例           |
| Agent              | 可被仿真驱动的智能体       |
| Task               | 平台级任务抽象             |
| Mission            | 领域特定的 Task 实现       |
| Route              | 规划路径                   |
| AgentTrack         | Agent 实际运动轨迹         |
| Simulation Runtime | 仿真执行核心               |
| Simulation Clock   | 仿真时间                   |
| Snapshot           | 某个 Tick 的可发布状态     |
| Command            | 请求执行某个动作           |
| State              | 当前真实状态               |
| Event              | 已经发生的事实             |
| Result             | 任务执行结果               |
| Recorder           | 过程记录系统               |
| Replay             | 历史数据回放               |
| Collaboration      | 多人协同能力               |
| Authority          | 权限/操作规则              |
| Control Token      | 对具体 Agent 的控制权      |
| Adapter            | 外部技术/设备/渲染适配器   |
| Package            | 软件复用与迁移边界         |
| Application        | 面向用户的产品             |

---

# 7. World / Sandbox / Scenario

三者必须区分。

## World

概念层：

> 一个完整仿真世界。

例如：

```text
City
Terrain
Road
River
Buildings
Weather
Traffic
Agents
```

World 不一定对应一个独立 Package。

---

## Sandbox

运行时环境：

```text
Terrain
Building
Obstacle
RoadNetwork
Water
Weather
Wind
Traffic
Geofence
GeoReference
```

Sandbox 不负责：

- Agent Dynamics
- Task Execution
- User Permission
- UI
- Replay

---

## Scenario

Scenario 是：

> Sandbox 的可持久化配置。

例如：

```text
Scenario
├── Environment
├── Terrain
├── Weather
├── Wind
├── Geofence
├── Initial Agents
└── Initial Tasks
```

关系：

```text
Scenario
    ↓ load
Sandbox
    ↓ runtime
Session
```

因此：

> `Scenario ≠ Sandbox`

---

# 8. Agent

Agent 是平台最核心的运行单元。

统一模型：

```text
Agent
├── Identity
├── State
├── Controller
├── Dynamics
├── Sensors
├── Actuators
└── Safety
```

具体 Agent：

```text
DroneAgent
VehicleAgent
BoatAgent
RobotAgent
```

---

# 9. Agent Runtime

平台不把：

```text
Agent Runtime
```

作为独立业务模块。

Agent 的执行发生在：

```text
Simulation Runtime
```

内部。

因此：

```text
Simulation Runtime
        ↓
Agent.update()
```

而不是：

```text
Simulation Runtime
        ↓
Agent Runtime
        ↓
Agent
```

这样可以避免 Runtime 概念重复。

---

# 10. Task / Mission

平台统一使用：

```text
Task
```

作为任务抽象。

例如：

```text
Task
├── definition
├── route
├── actions
├── constraints
├── executor
└── result
```

领域实现：

```text
FlightMission implements Task
DrivingMission implements Task
NavigationMission implements Task
RobotTask implements Task
```

因此：

> `Mission` 不是平台级核心抽象。

---

# 11. Route / AgentTrack

必须严格区分：

```text
Route
```

和：

```text
AgentTrack
```

### Route

表示：

> 计划怎么走。

### AgentTrack

表示：

> 实际怎么走。

关系：

```text
Route
   ↓
Task
   ↓
Agent
   ↓
AgentTrack
```

统一使用：

```text
AgentTrack
```

而不是：

```text
FlightTrack
DrivingTrack
RobotTrack
```

UI 可以根据领域显示：

```text
飞行轨迹
驾驶轨迹
机器人轨迹
```

但平台底层统一为：

```text
AgentTrack
```

---

# 12. Simulation Runtime

Simulation Runtime 是平台仿真执行核心。

负责：

- Simulation Clock
- Fixed Tick
- Agent Update
- Task Update
- Environment Update
- Collision / Safety
- State Transition
- Snapshot
- Runtime Lifecycle

不负责：

- UI
- Renderer
- User Permission
- MCP Tool Definition
- WebSocket UI Logic

---

# 13. Simulation Clock

仿真时间必须独立于现实时间。

禁止：

```text
Date.now()
requestAnimationFrame()
```

作为核心仿真时间来源。

统一：

```text
Simulation Clock
```

提供：

```text
simulationTime
tick
deltaTime
fixedDeltaTime
```

---

# 14. Fixed Tick

推荐：

```text
60 Hz
```

作为本地实时仿真目标。

运行逻辑：

```text
Tick
 ↓
Environment Update
 ↓
Task Update
 ↓
Agent Update
 ↓
Collision / Safety
 ↓
State Commit
 ↓
Snapshot
 ↓
Event
```

---

# 15. Snapshot

Snapshot 是：

> 某一个 Simulation Tick 对外发布的状态快照。

例如：

```text
SimulationSnapshot
├── tick
├── simulationTime
├── agents
├── tasks
├── environment
└── events
```

Snapshot 用于：

- Renderer
- Realtime
- Recorder
- Debug
- Client Synchronization
- Replay

---

# 16. Session

Session 表示：

> 一次具体的仿真运行实例。

Session 包含：

```text
Session
├── Scenario
├── Sandbox
├── Agents
├── Tasks
├── Simulation Runtime
├── Collaboration
├── Recorder
└── Result
```

Session 可以是：

```text
Single Player
```

也可以是：

```text
Multi Player
```

---

# 17. Collaboration

Collaboration 是 Session 的协同能力。

负责：

- User
- Role
- Presence
- Authority
- Control Token
- Command Routing
- Collaborative Editing
- Conflict Handling

不负责：

- Physics
- Agent Dynamics
- Simulation Clock
- Agent State

---

# 18. Authority / Control Token

两者必须区分。

## Authority

表示：

> 某个用户/角色是否允许执行某类操作。

例如：

```text
canObserve
canControl
canEditScenario
canStartTask
canPauseSimulation
```

## Control Token

表示：

> 某个具体 Agent 当前由谁控制。

例如：

```text
Drone A
    ↓
Control Token
    ↓
User A
```

一个 Agent：

> 同一时刻最多拥有一个有效 Operator Control Token。

---

# 19. Command / State / Event / Result

平台统一采用：

```text
Command
State
Event
Result
```

四种核心数据概念。

### Command

请求：

```text
“我要做什么”
```

### State

事实：

```text
“现在是什么状态”
```

### Event

历史：

```text
“刚才发生了什么”
```

### Result

结果：

```text
“这次任务最终怎么样”
```

---

# 20. Recorder

Recorder 负责记录：

```text
AgentTrack
TelemetryLog
EventLog
CommandLog
```

Recorder 不负责：

- TaskResult
- Replay UI
- Agent Dynamics
- State Mutation

---

# 21. TaskResult

统一使用：

```text
TaskResult
```

代替：

```text
MissionResult
```

因为平台核心是：

```text
Task
```

而不是：

```text
Mission
```

TaskResult 可以包含：

```text
TaskResult
├── status
├── duration
├── metrics
├── statistics
├── trackReference
├── eventReference
└── mediaReference
```

---

# 22. Replay

Replay 是独立能力。

第一阶段：

> 使用历史数据驱动回放。

结构：

```text
Recorder Data
      ↓
ReplaySession
      ↓
ReplayController
      ↓
ReplaySnapshot
      ↓
Renderer
```

Replay 不等于 Recorder。

---

# 23. MediaAsset

统一媒体模型：

```text
MediaAsset
├── id
├── type
├── uri
├── timestamp
├── agentId
├── taskId
└── metadata
```

例如：

```text
Photo
Video
Screenshot
Sensor Media
```

媒体不直接塞入 Agent Core。

---

# 24. Domain API

所有外部业务操作统一进入：

```text
SimulationDomainAPI
```

调用方包括：

```text
UI
MCP
REST
WebSocket
SDK
AI Agent
Automation
```

不允许外部直接修改：

```text
Agent State
Task State
Simulation State
```

---

# 25. Adapter

Adapter 是外部技术边界。

例如：

```text
ThreeAdapter
CesiumAdapter
DJIAdapter
VehicleDeviceAdapter
RobotAdapter
```

Adapter 的职责：

> 把平台标准接口转换成外部技术接口。

Adapter 不修改核心领域模型。

---

# 26. Package

Package 是：

> 软件复用、迁移和依赖管理边界。

一个 Package 必须具备：

- Public API
- Internal API
- Dependencies
- Tests
- Documentation
- Build
- Version

目标：

```text
@simulation/drone-agent
```

可以独立安装到新的 Application。

---

# 27. Application

Application 是：

> 面向最终用户的产品。

例如：

```text
drone-simulator
vehicle-simulator
robot-simulator
digital-twin
collaboration-client
```

关系：

```text
Application = Product
Package = Capability
```

---

# 28. Manager / Registry

避免万能 Manager。

推荐：

```text
AgentRegistry
TaskRegistry
SessionRegistry
```

Registry 只负责：

- Create
- Register
- Remove
- Lookup
- Lifecycle

不负责：

- Physics
- Evaluation
- Task Logic
- Rendering
- Authority Decision

---

# 29. 推荐 Monorepo

推荐结构：

```text
simulation-platform/
├── packages/
│   ├── contracts/
│   ├── simulation-core/
│   ├── agent-core/
│   ├── sandbox-core/
│   ├── task-core/
│   ├── drone-agent/
│   ├── vehicle-agent/
│   ├── boat-agent/
│   ├── robot-agent/
│   ├── recorder/
│   ├── result/
│   ├── replay/
│   ├── collaboration/
│   ├── realtime/
│   ├── domain-api/
│   ├── input/
│   ├── three-adapter/
│   ├── cesium-adapter/
│   └── device-adapters/
│
├── apps/
│   ├── drone-simulator/
│   ├── vehicle-simulator/
│   ├── robot-simulator/
│   ├── digital-twin/
│   └── collaboration-client/
│
├── servers/
│   ├── simulation-server/
│   ├── realtime-server/
│   └── persistence-server/
│
├── mcp/
│   └── mcp-server/
│
└── docs/
    ├── architecture/
    ├── terminology/
    ├── packages/
    ├── api/
    └── adr/
```

---

# 30. Core Package 职责

## contracts

稳定的跨模块 Contract：

```text
Agent
State
Command
Event
Snapshot
Task
Session
Adapter
```

---

## simulation-core

负责：

```text
Simulation Clock
Fixed Tick
Runtime
Snapshot
Lifecycle
```

不负责具体 Agent。

---

## agent-core

负责：

```text
Agent
AgentState
Controller Contract
Dynamics Contract
Sensor Contract
Actuator Contract
Safety Contract
```

不负责具体 Drone。

---

## sandbox-core

负责：

```text
Sandbox
Scenario
Environment
Terrain
Obstacle
GeoReference
```

后续扩展：

```text
RoadNetwork
Water
Traffic
Weather
```

---

## task-core

负责：

```text
Task
TaskDefinition
Route
TaskPoint
TaskExecutor
Task Lifecycle
TaskResult Contract
```

---

# 31. Domain Agent Packages

## drone-agent

负责：

```text
DroneAgent
DroneState
FlightController
FlightDynamics
Gimbal
Camera
Battery
FlightSafety
FlightMission
```

---

## vehicle-agent

负责：

```text
VehicleAgent
VehicleState
VehicleController
VehicleDynamics
VehicleSensor
VehicleSafety
DrivingMission
```

---

## boat-agent

负责：

```text
BoatAgent
BoatState
MarineController
MarineDynamics
WaterSensor
MarineSafety
NavigationMission
```

---

## robot-agent

负责：

```text
RobotAgent
RobotState
RobotController
RobotDynamics
RobotSensor
RobotActuator
RobotSafety
RobotTask
```

---

# 32. Capability Packages

## recorder

负责：

```text
AgentTrack
TelemetryLog
EventLog
CommandLog
```

---

## result

负责：

```text
TaskResult
ResultSummary
Statistics
ResultExporter
```

---

## replay

负责：

```text
ReplaySession
ReplayTimeline
ReplayController
ReplaySnapshot
```

---

## collaboration

负责：

```text
User
Role
Presence
Authority
ControlToken
Command Routing
Collaborative Editing
```

---

## realtime

负责：

```text
WebSocket
Connection
Snapshot Transport
Event Transport
Reconnect
Resync
```

只负责 Transport。

---

## input

负责：

```text
Keyboard
Mouse
Touch
Gamepad
VirtualJoystick
```

把输入转换为 Command。

---

# 33. Adapter Packages

## three-adapter

```text
Snapshot
 ↓
Three.js Scene
```

---

## cesium-adapter

```text
Snapshot
 ↓
Cesium Scene
```

---

## device-adapters

```text
Domain Command
 ↓
Device Adapter
 ↓
Real Device SDK
```

---

# 34. Server

推荐：

```text
simulation-server
```

负责：

- Server Authoritative Simulation
- Session Runtime
- Agent Runtime
- Task Runtime
- Snapshot
- Event

---

```text
realtime-server
```

负责：

- WebSocket
- Connection
- Broadcast
- Reconnect
- Resync

---

```text
persistence-server
```

负责：

- Scenario
- Session
- Recorder Data
- Result
- Media Metadata

---

# 35. Server Authoritative

多人协同场景必须采用：

> **Server Authoritative**

客户端：

```text
Command
```

服务端：

```text
Validate
 ↓
Execute
 ↓
State
 ↓
Snapshot
```

客户端不拥有最终仿真权威。

---

# 36. 核心数据模型关系

```text
Scenario
   ↓
Sandbox
   ↓
Session
   ├── Agent
   └── Task
         ↓
    Task Execution
         ↓
Simulation Runtime
         ↓
State
         ↓
Snapshot
 ┌───────┼────────┐
 ↓       ↓        ↓
Render Realtime Recorder
                   ↓
          AgentTrack / EventLog
                   ↓
               TaskResult
                   ↓
                 Replay
```

---

# 37. Route / Track 关系

```text
Route
   ↓
Task
   ↓
Agent
   ↓
AgentTrack
```

即：

```text
Route      = Planned
AgentTrack = Actual
```

这是平台统一规则。

---

# 38. 状态分离

平台严格区分三个 State：

## Simulation State

```text
Agent
Task
Environment
Simulation
```

## Collaboration State

```text
User
Presence
Authority
ControlToken
EditingLock
```

## UI State

```text
Panel
Tab
Camera
Selection
Layout
```

三者不能混合。

---

# 39. 模块交互接口与依赖方向

本章定义：

- 模块之间如何通信
- 模块依赖方向
- Public API
- Runtime Contract
- Command / State / Event / Snapshot 流转

核心原则：

> **静态依赖单向，运行时通过 Contract、Command、Event、Snapshot 进行交互。**

---

# 40. 六层架构

```text
┌──────────────────────────────────────────────┐
│                  Application                 │
│        Drone Simulator / Digital Twin       │
├──────────────────────────────────────────────┤
│                 Domain API                   │
│           SimulationDomainAPI               │
├──────────────────────────────────────────────┤
│              Capability Layer                │
│ Task / Collaboration / Recorder / Replay    │
├──────────────────────────────────────────────┤
│                Domain Layer                  │
│       Drone / Vehicle / Boat / Robot        │
├──────────────────────────────────────────────┤
│                 Core Layer                   │
│ Simulation / Agent / Sandbox / Contracts    │
├──────────────────────────────────────────────┤
│              Infrastructure                 │
│ Realtime / Storage / Logging / Transport    │
└──────────────────────────────────────────────┘

External Adapters:
Three / Cesium / Device / SDK / MCP
```

---

# 41. 总体架构与依赖方向

```text
                           ┌───────────────────────┐
                           │     Applications      │
                           │ Drone / Vehicle / DT  │
                           └───────────┬───────────┘
                                       │
                                       ↓
                           ┌───────────────────────┐
                           │      Domain API       │
                           │ SimulationDomainAPI   │
                           └───────────┬───────────┘
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 ↓                     ↓                     ↓
        ┌────────────────┐    ┌────────────────┐    ┌────────────────┐
        │ Collaboration  │    │      Task      │    │    Recorder    │
        │ Authority      │    │ Route/Executor │    │ Track/Event    │
        └───────┬────────┘    └───────┬────────┘    └───────┬────────┘
                │                     │                     │
                └─────────────────────┼─────────────────────┘
                                      ↓
                         ┌───────────────────────┐
                         │    Domain Agents      │
                         │ Drone / Vehicle /     │
                         │ Boat / Robot          │
                         └───────────┬───────────┘
                                     ↓
                         ┌───────────────────────┐
                         │      Agent Core       │
                         └───────────┬───────────┘
                                     ↓
                         ┌───────────────────────┐
                         │  Simulation Runtime   │
                         │ Clock / Tick / State  │
                         └───────────┬───────────┘
                                     ↓
                         ┌───────────────────────┐
                         │     Sandbox Core      │
                         │ Terrain / Environment │
                         └───────────────────────┘
```

外部边界：

```text
Snapshot
   ↓
Render Adapter
   ↓
Three.js / Cesium
```

```text
Domain API
   ↓
Device Adapter
   ↓
Real Device SDK
```

```text
MCP
   ↓
Domain API
```

---

# 42. Package 静态依赖规则

统一依赖方向：

```text
Application
      ↓
Domain API
      ↓
Capability
      ↓
Domain
      ↓
Core
      ↓
Contracts
```

Adapter / Infrastructure：

```text
Domain / Core
      ↓
Adapter / Infrastructure
```

核心规则：

- 低层不得依赖高层
- Core 不依赖 UI
- Core 不依赖 Renderer
- Core 不依赖 Network
- Domain 不依赖 Application
- Capability 不依赖具体 Application
- Adapter 不反向进入 Core
- Package 不允许循环依赖

---

# 43. Package 依赖矩阵

| Package         | 可以依赖                                 | 禁止依赖           |
| --------------- | ---------------------------------------- | ------------------ |
| contracts       | 基础类型                                 | 业务实现           |
| simulation-core | contracts                                | UI、Three、Network |
| agent-core      | simulation-core、contracts               | UI、Renderer       |
| sandbox-core    | simulation-core、contracts               | Domain Agent       |
| task-core       | simulation-core、contracts               | 具体 Agent         |
| drone-agent     | agent-core、task-core、sandbox contracts | UI、Three          |
| vehicle-agent   | agent-core、task-core、sandbox contracts | UI、Three          |
| boat-agent      | agent-core、task-core、sandbox contracts | UI、Three          |
| robot-agent     | agent-core、task-core、sandbox contracts | UI、Three          |
| recorder        | contracts、simulation contracts          | UI                 |
| result          | task、recorder contracts                 | Renderer           |
| replay          | simulation、recorder                     | UI                 |
| collaboration   | contracts、domain contracts              | Dynamics           |
| realtime        | contracts                                | Simulation State   |
| domain-api      | Domain、Capability                       | Renderer           |
| input           | contracts、domain-api                    | Agent Internal     |
| three-adapter   | contracts、snapshot                      | Simulation Logic   |
| cesium-adapter  | contracts、snapshot                      | Simulation Logic   |
| device-adapters | domain contracts                         | UI                 |
| MCP             | domain-api                               | Agent Internal     |
| Application     | Public API                               | Internal API       |

---

# 44. Contract 层

推荐：

```text
packages/contracts/
```

负责定义稳定的跨模块契约：

```text
contracts/
├── agent
├── state
├── command
├── event
├── snapshot
├── task
├── session
└── adapter
```

Contract 只定义：

> 模块之间约定什么。

不定义：

> 模块内部如何实现。

---

# 45. Public API / Internal API

每个 Package：

```text
package/
├── src/
│   ├── public/
│   └── internal/
└── index.ts
```

其他 Package 只能使用：

```text
index.ts
```

禁止：

```text
package/src/internal/*
```

例如：

```text
@simulation/drone-agent
```

公开：

```text
DroneAgent
DroneState
DroneConfig
```

不公开：

```text
FlightIntegrator
InternalPhysicsState
PrivateController
```

---

# 46. Agent 接口

统一 Agent Contract：

```text
Agent
├── id
├── type
├── state
├── update()
├── handleCommand()
├── getSnapshot()
└── dispose()
```

实现：

```text
DroneAgent implements Agent
VehicleAgent implements Agent
BoatAgent implements Agent
RobotAgent implements Agent
```

Simulation Runtime 只依赖 Agent Contract。

---

# 47. AgentUpdateContext

Agent 不允许访问 Runtime 内部对象。

统一：

```text
AgentUpdateContext
├── time
├── deltaTime
├── simulationTime
├── environment
├── sensors
├── commands
├── collisionQuery
└── terrainQuery
```

正确：

```text
Agent
 ↓
AgentUpdateContext
```

禁止：

```text
Agent
 ↓
SimulationRuntime.internal
```

---

# 48. Task 接口

统一：

```text
Task
├── id
├── type
├── status
├── start()
├── pause()
├── resume()
├── abort()
├── update()
└── getResult()
```

具体实现：

```text
FlightMission implements Task
DrivingMission implements Task
NavigationMission implements Task
RobotTask implements Task
```

---

# 49. Task 与 Agent

Task 不直接修改 Agent State。

正确：

```text
Task
 ↓
Command
 ↓
Agent
 ↓
Controller
 ↓
Dynamics
 ↓
State
```

例如：

```text
GotoWaypointCommand
```

而不是：

```text
setDronePosition()
```

---

# 50. Sandbox 接口

Sandbox 向 Agent 提供：

```text
SandboxQuery
├── getTerrainHeight()
├── queryObstacle()
├── raycast()
├── getWind()
├── getWeather()
├── getWaterDepth()
└── isInsideGeofence()
```

Agent：

```text
Agent
 ↓
SandboxQuery
 ↓
Sandbox
```

Agent 不直接访问 Sandbox 内部数据结构。

---

# 51. Command

统一：

```text
Command
├── commandId
├── type
├── timestamp
├── sessionId
├── actorId
└── payload
```

例如：

```text
TakeoffCommand
MoveCommand
LandCommand
StartTaskCommand
RequestControlCommand
```

---

# 52. Command 流程

```text
User / AI
    ↓
Input / MCP
    ↓
Domain API
    ↓
Authority
    ↓
Validation
    ↓
Command Bus
    ↓
Simulation Runtime
    ↓
Agent / Task
    ↓
State Update
```

---

# 53. Event

统一：

```text
Event
├── eventId
├── type
├── timestamp
├── tick
├── sessionId
├── agentId
├── actorId
└── payload
```

例如：

```text
DroneTakeoffEvent
TaskCompletedEvent
CollisionEvent
UserJoinedEvent
ControlGrantedEvent
```

Event 表示已经发生的事实。

---

# 54. Snapshot

统一：

```text
SimulationSnapshot
├── tick
├── simulationTime
├── agents
├── tasks
├── environment
└── events
```

Snapshot：

> 是对外发布的状态视图，不是内部 State 本身。

---

# 55. Event / Snapshot 数据流

```text
Simulation Runtime
       ↓
State Change
       ↓
┌──────┴──────┐
↓             ↓
Event       Snapshot
↓             ↓
Recorder    Renderer
Realtime    Realtime
Result      Recorder
AI          Debug
```

---

# 56. Recorder

Recorder 消费：

```text
Event
Snapshot
```

记录：

```text
AgentTrack
TelemetryLog
EventLog
CommandLog
```

Recorder 不：

```text
agent.update()
```

也不：

```text
agent.state = ...
```

---

# 57. Result

统一：

```text
TaskResult
```

生成过程：

```text
Task
 ↓
Completed
 ↓
Result Builder
 ↓
TaskResult
```

Result 可以读取：

```text
Task
AgentTrack
Events
Media
Recorder
```

---

# 58. Replay

```text
Recorder Data
      ↓
ReplaySession
      ↓
ReplayController
      ↓
ReplaySnapshot
      ↓
Renderer
```

第一阶段采用：

> 历史数据驱动回放。

Replay 不负责原始数据记录。

---

# 59. Collaboration

统一：

```text
CollaborationService
├── joinSession()
├── leaveSession()
├── requestControl()
├── releaseControl()
├── getPresence()
├── lockObject()
└── unlockObject()
```

Collaboration 不直接修改 Agent State。

正确：

```text
Collaboration
 ↓
Command
 ↓
Domain API
 ↓
Runtime
```

---

# 60. Authority

统一：

```text
AuthorityService
├── canExecute()
├── requestControl()
├── grantControl()
├── releaseControl()
└── revokeControl()
```

Command：

```text
Command
 ↓
AuthorityService
 ↓
Allowed / Rejected
```

---

# 61. Realtime

Realtime 只负责：

```text
Transport
```

接口：

```text
RealtimeTransport
├── connect()
├── disconnect()
├── sendCommand()
├── publishSnapshot()
├── publishEvent()
├── subscribeSnapshot()
├── subscribeEvent()
└── reconnect()
```

Realtime 不拥有：

```text
Simulation State
Agent State
Task State
```

---

# 62. Domain API

统一：

```text
SimulationDomainAPI
├── Session API
├── Agent API
├── Task API
├── Result API
├── Collaboration API
└── Environment API
```

示例：

```text
Agent API
├── getAgent()
├── getAgentState()
├── executeCommand()
└── getAgentTrack()
```

---

# 63. MCP

MCP 必须：

```text
MCP
 ↓
Domain API
 ↓
Command
 ↓
Authority
 ↓
Simulation
```

禁止：

```text
MCP
 ↓
DroneAgent internal API
```

---

# 64. Renderer Adapter

统一：

```text
RenderAdapter
├── initialize()
├── updateSnapshot()
├── updateSelection()
└── dispose()
```

实现：

```text
ThreeAdapter
CesiumAdapter
```

Renderer 只消费 Snapshot。

---

# 65. Device Adapter

统一：

```text
DeviceAdapter
├── connect()
├── disconnect()
├── getState()
├── executeCommand()
└── getTelemetry()
```

例如：

```text
DJIAdapter
VehicleDeviceAdapter
RobotDeviceAdapter
```

---

# 66. Input

输入：

```text
Keyboard
Mouse
Touch
Gamepad
VirtualJoystick
```

统一：

```text
Input
 ↓
InputIntent
 ↓
Command
```

Input 不直接操作 Agent。

---

# 67. 运行时完整流程

```text
User / AI
    ↓
Input / MCP
    ↓
Domain API
    ↓
Authority
    ↓
Command
    ↓
Simulation Runtime
    ↓
Agent / Task
    ↓
Controller
    ↓
Dynamics
    ↓
State
    ↓
Snapshot
 ┌──┼───────────────┐
 ↓  ↓               ↓
UI Realtime      Recorder
                   ↓
             AgentTrack/Event
                   ↓
               TaskResult
                   ↓
                 Replay
```

---

# 68. 多人协同流程

```text
User A
  ↓
Client
  ↓
Domain API
  ↓
Collaboration
  ↓
Authority
  ↓
Command
  ↓
Simulation Server
  ↓
Simulation Runtime
  ↓
State
  ↓
Snapshot
  ↓
Realtime
  ├──→ User A
  ├──→ User B
  └──→ User C
```

Server 是唯一权威仿真源。

---

# 69. AI Agent 流程

```text
AI Agent
   ↓
MCP
   ↓
Domain API
   ↓
Authority
   ↓
Command
   ↓
Simulation
   ↓
State
   ↓
Event
   ↓
MCP Resource
   ↓
AI Agent
```

Human 与 AI 使用相同 Domain API。

---

# 70. 静态依赖与运行时交互

两者必须分开。

## 静态依赖

```text
Application
 ↓
Domain API
 ↓
Capability
 ↓
Domain
 ↓
Core
 ↓
Contracts
```

## Runtime

```text
Command
 ↓
Runtime
 ↓
State
 ↓
Snapshot
 ↓
Consumer
```

例如：

```text
Recorder
```

可以消费：

```text
Snapshot
Event
```

但：

```text
simulation-core
```

不能反向依赖：

```text
recorder
```

---

# 71. 反向依赖处理

禁止：

```text
Core
 ↓
Recorder
```

采用：

```text
Core
 ↓
Event / Snapshot
 ↓
EventBus
 ↓
Recorder
```

或者：

```text
Core
 ↓
Contract
 ↓
External Subscriber
```

核心原则：

> **通过 Contract、Event、Snapshot 解耦，而不是直接 Import 高层模块。**

---

# 72. 循环依赖

禁止：

```text
A → B → A
```

例如：

```text
Agent Core
 ↓
Task Core
 ↓
Agent Core
```

解决：

```text
Agent Core
Task Core
    ↓
Contracts
```

或者通过：

```text
Command
Event
```

进行解耦。

---

# 73. Package 迁移要求

任何核心 Package 都必须能够：

```text
Build
 ↓
Install
 ↓
Import
 ↓
Initialize
 ↓
Run
```

例如：

```text
New Application
 ↓
Install @simulation/drone-agent
 ↓
Create DroneAgent
 ↓
Create Simulation
 ↓
Run
```

不能依赖原 Application：

```text
Vue Component
Pinia Store
Application Route
Application UI
Application Singleton
```

---

# 74. 架构静态检查

CI 必须检查：

### 依赖方向

```text
Core → Domain
```

失败。

### 循环依赖

```text
A → B → A
```

失败。

### Internal Import

```text
package-A
 ↓
package-B/src/internal
```

失败。

### Renderer Import

```text
simulation-core
 ↓
three
```

失败。

### UI Import

```text
agent-core
 ↓
vue
```

失败。

---

# 75. 非功能需求

## P0 启动性能

参考机器：

- 首个有意义画面 ≤ 2 秒
- 进入可操作状态 ≤ 5 秒

---

## P0 仿真性能

目标：

```text
60 Hz
```

验收：

- 5 分钟运行中 ≥ 95% Tick 在目标间隔内完成
- 不允许出现 > 200ms 的长时间阻塞

---

## P0 Renderer

简单场景：

```text
60 FPS
```

标准场景：

```text
≥ 30 FPS
```

---

## P0 Input Latency

目标：

```text
典型 ≤ 100ms
P95 ≤ 150ms
```

---

## P0 Determinism

相同：

```text
Seed
Scenario
Initial State
Command Sequence
```

应该得到等价最终结果。

建议验收容差：

```text
Position ≤ 0.5m
Attitude ≤ 2°
Battery ≤ 1%
```

具体容差以后根据仿真精度重新校准。

---

# 76. Task / Mission 验收

重复执行确定性测试：

```text
Task Success Rate ≥ 99%
```

包括：

- 起飞
- 航点
- 降落
- 任务取消
- 任务暂停
- 任务恢复
- 越界
- 碰撞
- 异常状态

---

# 77. Recorder / Replay 验收

Recorder：

- Event 不丢失
- Command 可追踪
- Track 数据完整
- 时间戳连续

建议：

```text
AgentTrack Sampling = 20 Hz
```

Replay：

> 在相同输入数据下，应与记录状态保持规定容差内一致。

---

# 78. 多人协同验收

Baseline：

```text
≥ 4 Users
```

Stretch：

```text
≥ 10 Users
```

更长期目标：

```text
≥ 20 Users
≥ 20 Agents
```

指标：

```text
Command RTT ≤ 200ms
Authority Grant ≤ 500ms
Presence ≤ 500ms
Reconnect ≤ 5s
Session Convergence ≤ 3s
```

---

# 79. 网络异常

在：

```text
5% Packet Loss
```

条件下：

- 客户端能够恢复
- 不产生永久状态分叉
- 正常情况下 ≤ 3 秒恢复一致

---

# 80. 多 Agent 性能

Baseline：

```text
10 Agents @ 30Hz
```

Stretch：

```text
20 Agents
```

长期目标：

```text
≥ 20 Drones / Vehicles
≥ 50 Total Agents
≥ 20Hz
```

最终指标以 Benchmark 为准。

---

# 81. 内存稳定性

连续运行：

```text
30 min
```

在固定场景下：

```text
Memory Growth ≤ 10%
```

需要排除：

- Browser Cache
- Three.js Texture Cache
- GPU Resource Cache
- DevTools 本身造成的内存增长

---

# 82. 安全要求

所有写操作必须经过：

```text
Authority
```

包括：

```text
Agent Control
Task Control
Scenario Editing
Session Control
Device Control
```

Observer 不得修改状态。

非法 Command：

```text
Reject
```

禁止提供：

```text
Direct State Mutation API
```

---

# 83. 日志要求

关键日志必须包含：

```text
sessionId
userId
agentId
commandId
tick
timestamp
correlationId
```

用于：

- Debug
- Replay
- Audit
- Multiplayer Troubleshooting
- AI Tool Tracing

---

# 84. 浏览器与设备兼容性

目标：

```text
Chrome
Edge
Safari
```

支持：

```text
Windows
macOS
iOS
Android
```

图形基础：

```text
WebGL2
```

---

# 85. 测试策略

采用：

```text
Unit Test
Integration Test
Simulation Test
Performance Test
Soak Test
Multi-Client Test
Fault Injection
Compatibility Test
Security Test
Package Migration Test
```

---

# 86. Package Migration Test

例如：

```text
@simulation/drone-agent
```

测试：

```text
Fresh Application
       ↓
Install Package
       ↓
Import Public API
       ↓
Create Agent
       ↓
Create Simulation
       ↓
Run
```

必须保证：

```text
No Vue Dependency
No Pinia Dependency
No Application Route Dependency
No Original Application Dependency
```

---

# 87. 最终模块边界总表

| 层级        | 模块              | 核心职责           | 主要接口             |
| ----------- | ----------------- | ------------------ | -------------------- |
| Core        | contracts         | 稳定数据/接口契约  | Contract             |
| Core        | simulation-core   | 仿真时间与运行循环 | SimulationRuntime    |
| Core        | agent-core        | Agent Contract     | Agent                |
| Core        | sandbox-core      | 世界环境           | SandboxQuery         |
| Domain      | drone-agent       | 无人机能力         | DroneAgent           |
| Domain      | vehicle-agent     | 汽车能力           | VehicleAgent         |
| Domain      | boat-agent        | 船舶能力           | BoatAgent            |
| Domain      | robot-agent       | 机器人能力         | RobotAgent           |
| Capability  | task-core         | Task 生命周期      | Task                 |
| Capability  | recorder          | 过程记录           | Recorder             |
| Capability  | result            | 任务结果           | TaskResult           |
| Capability  | replay            | 历史回放           | ReplaySession        |
| Capability  | collaboration     | 多人协同           | CollaborationService |
| Capability  | realtime          | 实时传输           | RealtimeTransport    |
| Capability  | input             | 用户输入           | InputAdapter         |
| API         | domain-api        | 业务入口           | SimulationDomainAPI  |
| Adapter     | three-adapter     | Three.js           | RenderAdapter        |
| Adapter     | cesium-adapter    | Cesium             | RenderAdapter        |
| Adapter     | device-adapters   | 真实设备           | DeviceAdapter        |
| Integration | mcp-server        | AI 接入            | MCP                  |
| Application | drone-simulator   | 无人机产品         | Application API      |
| Application | vehicle-simulator | 汽车产品           | Application API      |
| Application | robot-simulator   | 机器人产品         | Application API      |
| Application | digital-twin      | 数字孪生产品       | Application API      |

---

# 88. 核心架构原则

1. **Package 是软件复用边界。**
2. **Application 是产品边界。**
3. **Contract 是模块协作边界。**
4. **Domain API 是所有外部业务操作的统一入口。**
5. **Simulation Runtime 是仿真执行核心。**
6. **Agent 是智能体运行单元。**
7. **Sandbox 是 Agent 运行世界。**
8. **Task 是平台级任务抽象。**
9. **Mission 是领域 Task 实现。**
10. **Session 是一次具体仿真实例。**
11. **Collaboration 是 Session 的协同能力。**
12. **Authority 是操作规则。**
13. **Control Token 是具体控制权。**
14. **Command 表示请求。**
15. **State 表示当前事实。**
16. **Event 表示历史事实。**
17. **Snapshot 表示可发布状态。**
18. **Route 表示计划路径。**
19. **AgentTrack 表示实际轨迹。**
20. **Recorder 记录过程。**
21. **TaskResult 表示任务结果。**
22. **Replay 读取历史过程。**
23. **Realtime 只负责传输。**
24. **Renderer 只消费 Snapshot。**
25. **Adapter 隔离外部技术。**
26. **Manager / Registry 只负责生命周期。**
27. **低层不能依赖高层。**
28. **Core 不依赖 UI / Renderer / Network。**
29. **Package 不依赖 Application。**
30. **禁止循环依赖。**
31. **禁止跨 Package 访问 Internal API。**
32. **模块之间优先通过 Contract、Command、Event、Snapshot 交互。**
33. **静态依赖与运行时数据流必须分开。**
34. **新增 Agent 不应修改 Simulation Core。**
35. **更换 Renderer 不应修改 Simulation Core。**
36. **更换 UI 不应修改 Domain Core。**
37. **AI 与 Human 使用相同 Domain API。**
38. **真实设备通过 Device Adapter 接入。**
39. **所有核心 Package 必须具备独立迁移能力。**
40. **Server 是多人仿真的最终权威。**

---

# 89. 最终四条主线

整个平台最终可以压缩成四条主线。

## ① Package Dependency

```text
Application
    ↓
Domain API
    ↓
Capability
    ↓
Domain
    ↓
Core
    ↓
Contracts
```

---

## ② Control Flow

```text
User / AI
    ↓
Domain API
    ↓
Authority
    ↓
Command
    ↓
Simulation Runtime
```

---

## ③ Simulation Flow

```text
Runtime
    ↓
State
    ↓
Snapshot
    ├──→ Renderer
    ├──→ Realtime
    └──→ Recorder
```

---

## ④ History / Result Flow

```text
Event / Snapshot
    ↓
Recorder
    ↓
AgentTrack / EventLog
    ├──→ TaskResult
    └──→ Replay
```

---

# 90. 最终架构图

```text
                           ┌───────────────────────┐
                           │     Applications      │
                           │ Drone / Vehicle / DT  │
                           └───────────┬───────────┘
                                       │
                                       ↓
                           ┌───────────────────────┐
                           │      Domain API       │
                           │ SimulationDomainAPI   │
                           └───────────┬───────────┘
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 ↓                     ↓                     ↓
        ┌────────────────┐    ┌────────────────┐    ┌────────────────┐
        │ Collaboration  │    │      Task      │    │    Recorder    │
        │ Authority      │    │ Route/Executor │    │ Track/Event    │
        └───────┬────────┘    └───────┬────────┘    └───────┬────────┘
                │                     │                     │
                └─────────────────────┼─────────────────────┘
                                      ↓
                         ┌───────────────────────┐
                         │    Domain Agents      │
                         │ Drone / Vehicle /     │
                         │ Boat / Robot          │
                         └───────────┬───────────┘
                                     ↓
                         ┌───────────────────────┐
                         │      Agent Core       │
                         │ Agent Contract        │
                         └───────────┬───────────┘
                                     ↓
                         ┌───────────────────────┐
                         │  Simulation Runtime   │
                         │ Clock / Tick / State  │
                         └───────────┬───────────┘
                                     ↓
                         ┌───────────────────────┐
                         │     Sandbox Core      │
                         │ Terrain / Weather /   │
                         │ Environment / World   │
                         └───────────────────────┘


Runtime Data Flow
──────────────────────────────────────────────

Command
   ↓
Authority
   ↓
Runtime
   ↓
State
   ↓
Snapshot
   ├────────→ ThreeAdapter
   ├────────→ CesiumAdapter
   ├────────→ Realtime
   └────────→ Recorder
                    ↓
              AgentTrack / Event
                    ↓
                TaskResult
                    ↓
                  Replay


AI / MCP
──────────────────────────────────────────────

AI Agent
   ↓
MCP
   ↓
Domain API
   ↓
Command
   ↓
Simulation


Real Device
──────────────────────────────────────────────

Domain API
   ↓
Device Adapter
   ↓
Real Device SDK


Package Dependency
──────────────────────────────────────────────

Application
      ↓
Domain API
      ↓
Capability
      ↓
Domain
      ↓
Core
      ↓
Contracts
```

---

# 91. 架构决策检查清单

以后新增任何模块，都必须回答以下问题：

### 1. 它是什么？

```text
Core
Domain
Capability
Adapter
Infrastructure
Application
```

---

### 2. 它属于哪个 Package？

必须有明确的 Package 边界。

---

### 3. 它依赖谁？

必须遵守：

```text
Application
 ↓
API
 ↓
Capability
 ↓
Domain
 ↓
Core
 ↓
Contracts
```

---

### 4. 它暴露什么 Public API？

不能依赖：

```text
Internal API
```

---

### 5. 它如何和其他模块通信？

优先：

```text
Contract
Command
Event
Snapshot
```

---

### 6. 它是否直接修改 State？

如果是，需要重新检查架构。

正常情况下：

```text
Command
 ↓
Runtime
 ↓
State
```

---

### 7. 它是否依赖 Renderer？

如果是 Core / Domain，通常说明边界错误。

---

### 8. 它是否依赖 UI？

Core / Domain 不允许。

---

### 9. 它是否能独立迁移？

如果不能：

> 检查是否存在 Application 反向依赖。

---

### 10. 新增它是否需要修改 Core？

如果一个新的：

```text
Drone
Vehicle
Robot
Boat
```

必须修改 Simulation Core：

> 说明抽象边界存在问题。

---

# 92. 结论

平台最终不是：

```text
一个无人机模拟器
```

而是：

```text
一个通用智能体仿真基础平台
```

其核心结构为：

```text
                    Platform
                       │
          ┌────────────┴────────────┐
          ↓                         ↓
       Simulation                Digital Twin
          │
          ↓
        Agent
          │
    ┌─────┼─────┬─────┐
    ↓     ↓     ↓     ↓
  Drone Vehicle Boat Robot
          │
          ↓
        Task
          │
          ↓
      Simulation
          │
          ↓
       Snapshot
      ┌───┼────┐
      ↓   ↓    ↓
   Render Realtime Record
                │
                ↓
              Result
                │
                ↓
              Replay
```

最终形成：

> **Simulation Core + Agent Core + Sandbox + Task + Collaboration + Recorder + Domain API + Adapter**

八个核心能力边界。

在此基础上：

```text
无人机
汽车
船舶
机器人
AI Agent
多人协同
数字孪生
真实设备
```

都可以作为能力扩展，而无需重新设计整个系统架构。

**最终架构目标不是“把所有东西抽象成一个万能框架”，而是让不同能力在稳定边界内独立演进、独立测试、独立迁移和组合。**
