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

当前渲染后端是 `placeholder`，会正确接受并记录请求，但不会生成神经渲染图像。接入真实后端时，只需要替换 `app/backends` 中的实现，不改变 HTTP 契约。

## 启动

```powershell
cd D:\project\digital-pwin-platform\services\neural-render-service
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m app.main
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
POST /api/v1/jobs/train
POST /api/v1/scenes/{scene_id}/render
GET  /api/v1/jobs/{job_id}
```

## PostgreSQL 隧道

服务只读取连接配置，不会自行创建 SSH 隧道。隧道建立后，把本地转发端口写入 `.env`：

```env
DATABASE_URL=postgresql://user:password@127.0.0.1:15432/neural_render
```

默认使用本地 SQLite 持久化元数据和 `STORAGE_ROOT` 下的图片；配置 `DATABASE_URL` 后切换到 PostgreSQL。`/ready` 会明确返回当前数据库是否已配置。
