# neural-render-service

神经渲染服务的第一版边界。它把场景、数据集、训练任务和渲染请求从主仿真应用中独立出来，后续接入 COLMAP、3D Gaussian Splatting、对象存储和 PostgreSQL。

当前版本提供：

- 健康检查和运行能力声明；
- 场景登记；
- 数据集登记；
- 图片帧上传与数据集 Manifest 持久化；
- 训练任务与渲染任务的统一任务模型；
- 相机位姿、内参和输出类型的请求校验；
- SQLite/PostgreSQL 元数据存储和本地图片落盘。
- 采集任务持久化队列、执行租约、暂停/恢复和逐张结果登记。

当前渲染后端是 `placeholder`，接受并记录请求，不会生成神经渲染图像；真实训练和渲染工作进程尚未接入。采集队列已能连接 `drone-camera/agent/platform-worker.mjs`，完整启动与恢复说明见 [采集 Agent 接入文档](../../docs/architecture/capture-agent-integration.md)。

## 启动

```powershell
cd D:\project\digital-pwin-platform\services\neural-render-service
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
.\.venv\Scripts\python.exe -m uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8090
```

默认监听 `127.0.0.1:8090`。

也可以直接运行：

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8090 --reload
```

## 接口

```text
GET  /health
GET  /ready
GET  /api/v1/scenes
POST /api/v1/scenes
POST /api/v1/datasets
POST /api/v1/datasets/{dataset_id}/frames
GET  /api/v1/datasets/{dataset_id}/manifest
POST /api/v1/datasets/{dataset_id}/validate
POST /api/v1/datasets/{dataset_id}/finalize
POST /api/v1/jobs/train
POST /api/v1/scenes/{scene_id}/render
GET  /api/v1/jobs/{job_id}
GET  /api/v1/datasets
GET  /api/v1/datasets/{dataset_id}
GET  /api/v1/datasets/{dataset_id}/images/{frame_id}
GET  /api/v1/capture-tasks
POST /api/v1/capture-tasks
POST /api/v1/capture-tasks/claim
GET  /api/v1/capture-tasks/{task_id}
POST /api/v1/capture-tasks/{task_id}/heartbeat
POST /api/v1/capture-tasks/{task_id}/frames
POST /api/v1/capture-tasks/{task_id}/finish
POST /api/v1/capture-tasks/{task_id}/pause
POST /api/v1/capture-tasks/{task_id}/resume
```

## PostgreSQL 隧道

服务只读取连接配置，不会自行创建 SSH 隧道。隧道建立后，把本地转发端口写入 `.env`：

```env
DATABASE_URL=postgresql://user:password@127.0.0.1:15432/neural_render
```

使用上述 `--env-file .env` 命令加载配置，或在启动前设置环境变量；直接导入应用不会自动读取 `.env`。默认使用本地 SQLite 持久化元数据和 `STORAGE_ROOT` 下的图片；配置 `DATABASE_URL` 后切换到 PostgreSQL。`/ready` 的 `database_configured` 字段表示当前存储连接是否可用，包含 SQLite。当前端到端采集验证使用 SQLite，尚未验证实际 PostgreSQL 隧道。
