# 园区 3DGS 算法验证

入口 `/experiments` 已连接真实训练工作进程：园区自动采集 → 3DGS 重建 → 独立测试视角渲染 → 画质与帧率评价。控制台和仿真沙盒均提供入口。先使用本地文件和现有数据登记服务验证算法，不增加权限系统、对象存储或数据库建设。

## 环境与启动

前端沿用 Vue + Three.js；API 使用 FastAPI，训练在独立 Python 进程中运行。当前算法用原生 PyTorch 实现可微分三维高斯投影与合成，无需安装 nvcc 或编译 CUDA 扩展。训练要求 CUDA 可用的 NVIDIA GPU，默认占用上限为该 GPU 显存的 65%；API 不导入 PyTorch。

在仓库根目录启动前端：

```powershell
npm install
npm run dev
```

API 的安装沿用 [服务 README](../../services/neural-render-service/README.md)。首次配置独立训练环境：

```powershell
cd services/neural-render-service
py -3.11 -m venv .venv-3dgs
# 本机驱动支持 CUDA 13.0；其他机器请按驱动选择 PyTorch CUDA 安装源。
.\.venv-3dgs\Scripts\python.exe -m pip install "torch>=2.4" --index-url https://download.pytorch.org/whl/cu130
.\.venv-3dgs\Scripts\python.exe -m pip install -r requirements-3dgs.txt
.\.venv-3dgs\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8090
```

如果本机已经有可用的 CUDA PyTorch，可以用 `--system-site-packages` 创建 `.venv-3dgs` 复用它，或将 `NEURAL_TRAIN_PYTHON` 设置为对应 Python 的绝对路径。本机实际验证使用 Python 3.11、PyTorch 2.12.1+cu130、RTX 4060 Laptop 8GB。启动一个 API 进程，不使用多个 uvicorn workers；该版本按一个 GPU 同时执行一个实验设计。

打开 `http://127.0.0.1:45678/experiments`，选择 400 步快速验证或 1200 步充分训练，点击“开始完整实验”。生产预览可使用 `npm run build` 后执行 `npm run preview -- --host 127.0.0.1 --port 45679`。前端的 API 地址通过 `VITE_NEURAL_RENDER_URL` 配置，默认为 `http://127.0.0.1:8090`。

## 一次实验做什么

1. 使用独立虚拟相机拍摄园区，固定 256×192 分辨率、58° 垂直视场角、LOD3 概览。图片不包含无人机、HUD 或辅助标记，且不会受远程细节加载影响。
2. 采集前固定 32 个训练视角、8 个测试视角。训练为半径 300 米的两圈相机，高度 150/210 米；测试角度偏移 11.25°，高度 165/195 米。两组相机位姿不同，测试图像只在最后评价时加载。
3. 逐张上传真实图像、相机位姿、相机内参和预先指定的 split。封存后检查图片哈希、尺寸、内参、视角重叠与训练/测试数量。
4. 从随应用发布的园区概览点云进行 2 米体素下采样，用其几何与颜色先验初始化最多 8000 个三维高斯。相机位姿由仿真提供，不进行 SfM 求解。
5. 优化高斯位置、RGB 颜色、三轴尺度、旋转和透明度。损失为 0.8 L1 + 0.2 DSSIM；每步从一个训练视角抽取图块，其中优先抽取前景图块。高斯投影使用三维协方差、透视 Jacobian、二维椭圆核与按深度排序的 alpha 合成。
6. 对独立测试视角分别保存参考图、训练后渲染和绝对误差 ×3，并比较初始化模型与训练后的画质。完成渲染预热后测量帧率与延迟。

测试组只用于最终报告与初始化基线对照，不用于梯度更新、选检查点、调整学习率或提前停止。当前相机轨迹属于成像实验，没有校验无人机的可飞行性、避障或真实航线约束；采集由本页 Three.js 相机执行，尚未通过 drone-camera/WebRTC 执行这批园区拍点。

## 指标口径

| 指标 | 定义 |
| --- | --- |
| PSNR | RGB `[0,1]` 的均方误差换算为 dB，各测试视角取平均；完全一致时以 120 dB 封顶 |
| SSIM | 11×11、σ=1.5 的高斯窗口，valid 卷积、总体协方差、RGB 平均 |
| 前景 PSNR | 参考图任一通道与背景差异大于 0.03 的像素；单独给出前景占比，避免背景主导整体指标 |
| FPS | 三次预热后，对 20 次完整测试视角渲染计时，`1000 / 平均毫秒`；GPU 前后同步 |
| P50 / P95 | 同一批渲染时间的中位数 / 95 分位数 |
| 显存 | 测速阶段的 PyTorch 张量分配峰值，包含仍保留的模型与训练状态；不代表整个系统显存 |

帧率只计该参考后端的完整高斯渲染，包含投影、排序、分块与合成，排除 PNG 编码、磁盘读写、网络上传、浏览器显示与画质评价。20 个样本用于快速基线，不代表长时间稳定性或大分辨率性能。

## 2026-11-06 实测基线

生产预览中的完整实验为 `job-943980563615`，数据集为 `campus-1793959793535`，32 个训练视角和 8 个测试视角，256×192、8000 个高斯、400 步。浏览器加载的源点云版本与训练先验校验一致。

| 指标 | 初始化 | 训练后 |
| --- | ---: | ---: |
| 测试 PSNR | 18.42 dB | 22.05 dB |
| 测试 SSIM | 0.7801 | 0.8615 |
| 前景 PSNR | — | 16.12 dB |

该次训练耗时 9.07 秒，参考后端渲染 34.19 FPS，平均 29.25 ms、P50 22.63 ms、P95 52.47 ms，张量显存峰值 163.20 MiB。前景占比为 24.25%。训练时间不包括采集、工作进程启动、初始化、最后评价和导出；帧率也会随本机其他应用与 GPU 状态变化，其他验证运行中约为 22–24 FPS。

本机结果链接：`http://127.0.0.1:45679/experiments?job=job-943980563615`。原始报告、模型与测试图保存在本地数据目录，不提交到 Git；新机器按上述步骤重新运行即可。

## 可恢复性与输出

- 采集失败或暂停后，点击“继续采集”，按已保存的 frameId 跳过完成帧。测试视角不足时禁止提交训练；已有足够数据时可点击“提交已有数据训练”，系统先封存再提交。
- 训练每 100 步保存检查点；主动停止时保存当前完整步的模型、Adam 状态、CPU/CUDA 随机状态、历史损失和累计训练时间。进程意外退出时可从最近检查点恢复。
- 点击“从检查点恢复”继续到选定目标步数。数据集、源点云版本、高斯数量与随机种子必须一致，目标步数必须超过保存步数。
- 数据集 Manifest 与源点云索引、概览哈希进入配置、检查点和报告。新采集数据还校验浏览器实际加载的点云版本；旧数据的报告会标记 `source_verified_at_capture=false`。
- 浏览器刷新通过保存的任务编号继续读取进度；`/experiments?job=<job_id>` 可直接打开指定结果。API 重启后从本地任务记录和进度文件继续读取。

每个实验保存在 `services/neural-render-service/data/experiments/<job_id>/`：

```text
config.json                 参数与源版本
manifest.json               封存的数据集快照
progress.json / worker.log  当前阶段与运行日志
checkpoint.pt               模型、优化器、随机状态
model.ply                   标准三维高斯 binary PLY，platform-world 米制坐标
report.json                 逐视角指标、汇总指标与性能口径
comparison.png              首个测试视角的三栏对比
*-reference.png             测试参考图
*-prediction.png            训练后的高斯渲染
*-difference.png            绝对误差 ×3
```

模型 PLY 包含三维高斯位置、degree-0 球谐颜色、log 尺度、opacity logit 与 wxyz 四元数，适合支持该格式的高斯查看器；普通点云查看器无法展示它的完整效果。检查点仅用于本地可信实验恢复。

## 自动验证

在已启动 UI/API 的情况下，从根目录执行真实闭环（默认 UI 为生产预览端口 45679）：

```powershell
npm run experiment:campus
# 使用开发服务或复用已经封存的数据：
npm run experiment:campus -- --ui=http://127.0.0.1:45678 --api=http://127.0.0.1:8090
npm run experiment:campus -- --dataset=<dataset_id> --steps=1200
# 查看并导出现有结果，不再训练：
npm run experiment:campus -- --job=<job_id>
```

脚本通过真实浏览器采集并训练，验证训练/测试编号隔离、指标有限、损失历史及模型/报告下载，导出结果和截图到 `data/experiment-deliverables/<job_id>/`。Windows 默认使用 Microsoft Edge，其他环境需安装 Playwright Chromium 或设置 `PLAYWRIGHT_CHROMIUM_CHANNEL`。

```powershell
npm run verify
npx vitest run --config apps/drone-simulator/vitest.config.ts --maxWorkers=1 --no-file-parallelism
cd services/neural-render-service
.\.venv\Scripts\python.exe -m pytest tests -q
.\.venv-3dgs\Scripts\python.exe -m pytest gaussian_tests -q
```

浏览器测试位于 `apps/drone-simulator/e2e/experiment.spec.ts`，覆盖结果恢复、视角切换、报告暂时失败后的重试、离线重连、小屏布局，以及提交已有数据时先封存的顺序。滚动检查使用真实滚轮、触摸移动和 Home/End 键，确认能从采集预览到达结果区；页面顶部也提供“查看结果”快捷入口。算法测试验证相机坐标转换、训练/测试泄漏、解析遮挡结果、视差、有限非零梯度以及已知误差下的指标数值。

2026-11-06 的恢复实测：`job-e9fb3df4bc63` 在第 125 步主动停止，`job-6b51bc3124ee` 恢复训练至 400 步。与同数据、同种子、不间断训练的 `job-2327e4e367a6` 对比，位置、颜色、尺度、旋转、透明度的最大参数差异均为 **0**，Manifest 和源数据校验值保持一致。

## 当前边界与后续算法工作

这是仿真数据、已知相机位姿、点云几何及颜色先验的可训练基线。源数据本身含合成立面补点，不能将该实验解读为真实照片的三维测绘精度或纯 RGB 重建能力。当前固定高斯数量、degree-0 颜色，无自适应增密、裁剪和视角相关高阶球谐；参考后端的帧率也不能等同于 gsplat 或浏览器实时交互帧率。

下一轮优先在相同数据划分与指标口径下接入 gsplat，逐项验证加速、增密及更高分辨率的收益；随后接入 drone-camera 的实际拍点执行和纯 RGB/COLMAP 初始化。独立新测试集用于后续改进的最终验收，避免反复调整同一测试集造成评价偏差。数据库与权限继续后置。
