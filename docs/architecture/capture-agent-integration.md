# 采集 Agent 平台接入

目标链路：**平台创建任务 → 执行端领取 → 仿真飞行和拍摄 → 逐张持久化登记 → 全量校验 → 数据集 ready**。

## 代码职责

| 位置 | 职责 |
| --- | --- |
| `apps/drone-simulator/src/views/CaptureTasksView.vue` | `/capture-tasks` 任务下发、进度、暂停/恢复、照片预览 |
| `services/neural-render-service/app/capture_models.py` | 有界拍摄计划和任务接口模型 |
| `services/neural-render-service/app/capture_store.py` | 持久化队列、执行租约、结果登记与封存 |
| `services/neural-render-service/app/store.py` | 数据集、原始图片、内外参和 SHA-256 持久化 |
| `drone-camera/agent/runtime.mjs` | 飞行与拍摄执行、逐张回执和断点恢复 |
| `drone-camera/agent/platform-client.mjs` | HTTP 客户端和坐标系适配 |
| `drone-camera/agent/platform-worker.mjs` | 主动领取任务、心跳、结果上传和远端文件恢复 |

采集队列暂与已有元数据服务一起部署，代码与训练占位接口独立。平台的 `packages/drone-agent` 仍是仿真机体能力；本次采集执行器位于独立的 `drone-camera` 仓库。

## 本机启动

需要两个更新后的仓库、Python 3.11+、Node 22.22.2+（22 系列）或 24.15+，以及 Playwright Chromium。

终端一，启动元数据和任务服务：

```powershell
cd D:\project\digital-pwin-platform\services\neural-render-service
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
.\.venv\Scripts\python.exe -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8090
```

终端二，启动执行端：

```powershell
cd D:\project\drone-camera
npm ci
npx playwright install chromium
npm run agent:worker -- --url http://127.0.0.1:8090
```

终端三，启动平台：

```powershell
cd D:\project\digital-pwin-platform
npm ci
npm run dev
```

访问 `http://127.0.0.1:45678/capture-tasks`，填写任务名称和拍点，点击“下发采集任务”。也可以从沙盒顶部的“采集任务”进入。默认三个拍点用于验证流程；大场景重建应另行规划覆盖率与视角。

执行端主动访问服务，服务无需连接执行端的端口。`--url` 和平台的 `VITE_NEURAL_RENDER_URL` 应指向同一服务。默认执行端 ID 来自主机名与本地任务目录；首次领取后任务绑定该 ID。重启时保持相同服务地址、执行端 ID 和任务目录。

单次批处理示例：

```powershell
npm run agent:worker -- --url http://127.0.0.1:8090 --once --max-shots 1
```

此命令领取一项任务，新增一张照片后暂停并释放租约。网页点击“继续任务”后，再运行不带 `--max-shots` 的执行端即可完成剩余拍点。`--root` 可指定持久化目录，`--worker-id` 可指定固定执行端 ID；每个目录只允许一个执行进程。

## 任务与恢复语义

状态为 `queued → running → paused / failed / completed`。暂停或失败后由网页恢复为 queued；已完成任务不会重新领取。

- 创建任务、登记场景和创建 draft 数据集在同一事务中提交。同任务 ID、相同名称和计划可重试，改变计划会返回 409。
- 租约有效期 60 秒，执行端约每 10 秒续期。服务重启保留租约与任务。进程崩溃后，原执行端可在租约过期后重新领取；其他执行端不会接管其本地任务。
- 每次领取产生新的随机租约标记，所有执行端写操作必须带此标记。过期进程不能继续登记图片或改变状态。
- 拍照成功后先落盘图片、回执和检查点，再调用上传回调。上传失败终止本次执行，保留已经拍好的照片；上传错误不触发重新拍照。
- 图片帧 ID 由任务 ID 与拍点 ID 的哈希派生。完全相同的重试返回原登记结果；不同内容或参数使用相同 ID 会返回 409，原图片不会被覆盖。
- 执行端重启会核对已提交图片；本地图片丢失但服务端已有有效图片时，从服务端下载并核对 SHA-256 后恢复原回执。
- 页面暂停、Ctrl+C 和 SIGTERM 会在当前拍点处理完成后生效。网络故障时先保留本地回执；若失败状态已经回传，需要在页面点击继续，若服务一直无法连接，待租约过期后可重新领取。
- 完成时必须上传全部计划拍点，图片可完整解码、尺寸与相机参数一致且 SHA-256 正确。校验与封存处于同一写事务；数据集进入 ready 后拒绝新增或修改帧。普通数据集允许完全相同的已登记帧重试；Agent 数据集完成后租约释放，后续执行端写入会拒绝。

## 坐标与时间

`drone-camera` 的位置是 ENU `[东, 北, 上]`，平台是 `[东, 上, 南]`，因此转换为 `[east, up, -north]`。四元数采用 xyzw、相机局部到世界的主动旋转，乘以 `Rx(-90°)` 转换世界坐标基；相机局部轴保持前向 -Z、右向 +X、上向 +Y。图片实际相机光心来自同帧快照，允许与计划的机体位置不同。

原始回执保存在每帧 `metadata.sourceReceipt`，可追溯原始相机姿态、计划、图像哈希和观测状态。每帧 `simulationTime` 保留实际浏览器仿真时钟，`simulationSessionId` 标识浏览器会话。跨重启会话允许时钟归零；同一会话按计划顺序检查时间递增，不拼接虚构的全局仿真时间。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/v1/capture-tasks` | 最近 100 项任务 / 创建任务 |
| GET | `/api/v1/capture-tasks/{task_id}` | 状态与固定计划 |
| POST | `/api/v1/capture-tasks/claim` | 领取任务，空队列返回 null |
| POST | `/api/v1/capture-tasks/{task_id}/heartbeat` | 续租、版本绑定、进度和暂停指令 |
| POST | `/api/v1/capture-tasks/{task_id}/frames` | 带租约的逐张上传 |
| POST | `/api/v1/capture-tasks/{task_id}/finish` | 暂停、失败或完成；完成时校验并封存 |
| POST | `/api/v1/capture-tasks/{task_id}/pause` | 请求暂停 |
| POST | `/api/v1/capture-tasks/{task_id}/resume` | 恢复排队，保留原执行端绑定 |
| GET | `/api/v1/datasets/{dataset_id}` | 登记信息与 ready 状态 |
| GET | `/api/v1/datasets/{dataset_id}/manifest` | 平台格式清单，含相机参数和来源回执 |
| GET | `/api/v1/datasets/{dataset_id}/images/{frame_id}` | 原始图片预览和恢复下载 |

创建接口接受 `{ "name": "任务名称", "plan": <drone-camera 结构化任务> }`。固定场景为 `three-demo-city-webgl-husky-v1`，2–200 个拍点，只执行内部仿真。相机尺寸、实际位置与姿态均来自采集回执。

## 验证

```powershell
cd D:\project\digital-pwin-platform\services\neural-render-service
.\.venv\Scripts\python.exe -m pytest -q
cd D:\project\digital-pwin-platform
npm run test:unit
npm run verify
npm run capture:verify
cd D:\project\drone-camera
npm run agent:test
```

`capture:verify` 启动独立临时端口和独立 SQLite 存储，通过真实平台网页创建三拍点任务：首个独立执行进程采一张 → 关闭并重启服务 → 删除本次测试的一张本地照片以验证远端恢复 → 网页恢复任务 → 新执行进程完成两张 → 校验三张实图、来源、照片哈希、首次拍摄次数为 1 和数据集 ready。验证结束关闭服务和浏览器。

结果、截图、平台清单及日志保留在 `services/neural-render-service/data/capture-integration-<timestamp>/`；本地原始采集包位于该目录的 `worker/<taskId>/capture-colmap.zip`。可通过 `DRONE_CAMERA_ROOT`、`CAPTURE_PYTHON` 覆盖兄弟仓库位置和 Python 可执行文件。

当前端到端验证使用本机 SQLite；PostgreSQL 代码路径使用行锁和 `SKIP LOCKED`，尚需在实际隧道与数据库上验证。大文件对象存储和跨机器接管尚未接入。COLMAP ZIP 保留在执行端，平台保存完整原始图片与清单；其稀疏点云仍需后续匹配/三角化。训练和神经渲染接口仍是占位实现。
