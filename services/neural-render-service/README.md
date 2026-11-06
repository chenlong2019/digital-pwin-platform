# neural-render-service

神经渲染服务把场景、数据集、采集任务和训练工作进程从主仿真应用中独立出来。目前支持园区 3D Gaussian Splatting 参考实验与 SQLite/PostgreSQL 元数据登记，后续完善 COLMAP 初始化与加速渲染后端。

当前版本提供：

- 健康检查和运行能力声明；
- 场景登记；
- 数据集登记；
- 图片帧上传与数据集 Manifest 持久化；
- 训练任务与渲染任务的统一任务模型；
- 相机位姿、内参和输出类型的请求校验；
- SQLite/PostgreSQL 元数据存储和本地图片落盘。
- 采集任务持久化队列、执行租约、暂停/恢复和逐张结果登记。

园区实验已接入真实的 `torch-3dgs-reference` 工作进程：自动采集、训练三维高斯、渲染独立测试视角，并输出 PSNR、SSIM、前景 PSNR 和同步渲染帧率。入口是 `/experiments`；使用仿真点云的几何与颜色先验、已知相机位姿，不是纯 RGB 重建。环境配置、实测结果、恢复方法和算法边界见 [园区 3DGS 实验](../../docs/product/campus-3dgs-experiment.md)。

未指定园区工作流的旧训练、通用场景渲染接口仍是 `placeholder`，只登记请求。采集队列可连接 `drone-camera/agent/platform-worker.mjs`，启动与恢复说明见 [采集 Agent 接入文档](../../docs/architecture/capture-agent-integration.md)。

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
GET  /api/v1/experiments/capabilities
POST /api/v1/experiments
POST /api/v1/experiments/{job_id}/stop
GET  /api/v1/experiments/{job_id}/artifacts/{name}
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

园区实验的 Web API 不加载 PyTorch，通过独立训练环境运行工作进程。默认寻找 `.venv-3dgs`，也可设置 `NEURAL_TRAIN_PYTHON` 为训练 Python 的绝对路径。启动一个 API 进程（不使用多个 uvicorn workers），同一存储目录同时执行一个 GPU 任务。每 100 步和主动停止时保存模型、优化器、随机状态、数据集与源点云校验值；已封存的数据集不可追加图片。

## PostgreSQL 隧道

服务只读取连接配置，不会自行创建 SSH 隧道。隧道建立后，把本地转发端口写入 `.env`：

```env
DATABASE_URL=postgresql://user:password@127.0.0.1:15432/neural_render
```

使用上述 `--env-file .env` 命令加载配置，或在启动前设置环境变量；直接导入应用不会自动读取 `.env`。默认使用本地 SQLite 持久化元数据和 `STORAGE_ROOT` 下的图片；配置 `DATABASE_URL` 后切换到 PostgreSQL。`/ready` 的 `database_configured` 字段表示当前存储连接是否可用，包含 SQLite。当前端到端采集验证使用 SQLite，尚未验证实际 PostgreSQL 隧道。
