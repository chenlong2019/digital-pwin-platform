from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading

from pydantic import BaseModel, ConfigDict, Field

from .models import Job, SAFE_ID, utc_now
from .gaussian.camera import validate_split
from .gaussian.source import source_identity

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
ASSET_ROOT = REPO_ROOT / "apps/drone-simulator/public/scenes/campus-road"
BACKEND = "torch-3dgs-reference"


class ExperimentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(pattern=SAFE_ID, max_length=160)
    steps: int = Field(default=400, ge=100, le=2000)
    gaussians: int = Field(default=8000, ge=1000, le=20000)
    seed: int = Field(default=20261106, ge=0, le=2**31-1)
    resume_job_id: str | None = Field(default=None, pattern=SAFE_ID, max_length=160)


def process_alive(pid: int) -> bool:
    if pid <= 0: return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle: return False
        code = wintypes.DWORD()
        try:
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally: kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError: return False
    except PermissionError: return True


class ExperimentRunner:
    def __init__(self):
        self.lock = threading.Lock()
        self.children: dict[str, subprocess.Popen] = {}

    @property
    def python(self) -> str:
        default = SERVICE_ROOT / ".venv-3dgs" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        return os.getenv("NEURAL_TRAIN_PYTHON") or (str(default) if default.is_file() else sys.executable)

    def capabilities(self) -> dict:
        gpu = None
        try:
            result = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                                    capture_output=True, text=True, timeout=4,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            if result.returncode == 0: gpu = result.stdout.strip().splitlines()[0]
        except (OSError, subprocess.TimeoutExpired, IndexError): pass
        return {"backend": BACKEND, "python_configured": Path(self.python).is_file(),
                "source_available": (ASSET_ROOT/"overview.bin.gz").is_file(), "gpu": gpu,
                "initialization": "simulation_point_cloud_geometry_color_prior", "default_steps": 400,
                "default_gaussians": 8000}

    def directory(self, store, job: Job) -> Path:
        return store.storage_root / "experiments" / job.job_id

    def start(self, store, request: ExperimentRequest) -> Job:
        with self.lock:
            root = store.storage_root / "experiments"
            root.mkdir(parents=True, exist_ok=True)
            active_path = root / "active.json"
            if active_path.is_file():
                active = json.loads(active_path.read_text(encoding="utf-8"))
                last_progress = root / active["job_id"] / "progress.json"
                terminal = last_progress.is_file() and json.loads(last_progress.read_text(encoding="utf-8")).get("status") in {"completed", "failed"}
                if not terminal and process_alive(active["pid"]):
                    raise ValueError("已有实验占用 GPU，请等待当前实验结束")
            dataset = store.get_dataset(request.dataset_id)
            if not dataset: raise KeyError("dataset not found")
            if dataset.scene_id != "campus-road-points-v2-spacing-fix":
                raise ValueError("当前实验只支持园区点云场景")
            if dataset.status == "draft": raise ValueError("请先完成采集并封存数据集")
            validation = store.validate_dataset(request.dataset_id)
            if not validation or not validation["valid"]: raise ValueError("数据集校验未通过")
            manifest = store.get_manifest(request.dataset_id)
            validate_split(manifest)
            identity = source_identity(ASSET_ROOT)
            captured_source = manifest.get("metadata", {}).get("source_identity")
            if captured_source and captured_source != identity:
                raise ValueError("采集场景与当前园区点云版本不同，请重新采集")
            job = store.create_job(Job(type="train", status="queued", backend=BACKEND,
                request={**request.model_dump(), "workflow": "campus-3dgs"},
                result={"stage": "starting", "step": 0, "steps": request.steps}))
            output = self.directory(store, job)
            output.mkdir()
            try:
                config = {"storage": str(store.storage_root), "assets": str(ASSET_ROOT),
                          "background": [10/255, 20/255, 27/255], "source_identity": identity,
                          "source_verified_at_capture": bool(captured_source), **request.model_dump()}
                (output/"manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                if request.resume_job_id:
                    previous = store.get_job(request.resume_job_id)
                    if not previous or previous.backend != BACKEND or previous.request["dataset_id"] != request.dataset_id:
                        raise ValueError("恢复任务必须属于同一数据集和后端")
                    old = self.directory(store, previous)
                    if not (old/"checkpoint.pt").is_file(): raise ValueError("尚未生成可恢复的训练检查点")
                    if request.gaussians != previous.request["gaussians"] or request.seed != previous.request["seed"]:
                        raise ValueError("恢复时需保持相同的高斯数量与随机种子")
                    old_config = json.loads((old/"config.json").read_text(encoding="utf-8"))
                    if old_config.get("source_identity") != identity:
                        raise ValueError("恢复时必须使用同一版本的源点云")
                    shutil.copy2(old/"checkpoint.pt", output/"checkpoint.pt")
                    # Preserve snapshot bytes so the checkpoint hash remains exact.
                    shutil.copy2(old/"manifest.json", output/"manifest.json")
                    config["resume"] = True
                (output/"config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
                with (output/"worker.log").open("w", encoding="utf-8") as log:
                    process = subprocess.Popen([self.python, "-u", "-m", "app.gaussian.experiment", "--config", str(output/"config.json")],
                        cwd=SERVICE_ROOT, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                self.children[job.job_id] = process
                temporary = active_path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"job_id": job.job_id, "pid": process.pid}), encoding="utf-8")
                os.replace(temporary, active_path)
                store.set_dataset_status(request.dataset_id, "training")
                return job
            except Exception as error:
                store.update_job(job.model_copy(update={"status": "failed", "error": str(error)}))
                raise

    def refresh(self, store, job: Job) -> Job:
        if job.backend != BACKEND: return job
        output = self.directory(store, job)
        progress_path = output / "progress.json"
        progress = json.loads(progress_path.read_text(encoding="utf-8")) if progress_path.is_file() else job.result or {}
        child = self.children.get(job.job_id)
        if child is not None:
            alive = child.poll() is None
        else:
            active_path = store.storage_root / "experiments/active.json"
            active = json.loads(active_path.read_text(encoding="utf-8")) if active_path.is_file() else {}
            alive = active.get("job_id") == job.job_id and process_alive(active.get("pid", 0))
        status = progress.get("status", "running" if alive else job.status)
        error = progress.get("error")
        if status not in {"completed", "failed"} and not alive:
            status, error = "failed", "训练进程已退出，可查看日志并从检查点恢复"
        updated = job.model_copy(update={"status": status, "result": progress, "error": error})
        if status == "completed" and (output/"report.json").is_file():
            updated.result = {**progress, "report_url": f"/api/v1/experiments/{job.job_id}/artifacts/report.json",
                              "comparison_url": f"/api/v1/experiments/{job.job_id}/artifacts/comparison.png"}
        if updated.model_dump() != job.model_dump():
            updated.updated_at = utc_now()
            store.update_job(updated)
            active_path = store.storage_root / "experiments/active.json"
            active = json.loads(active_path.read_text(encoding="utf-8")) if active_path.is_file() else {}
            if status in {"completed", "failed"} and active.get("job_id") == job.job_id:
                store.set_dataset_status(job.request["dataset_id"], status)
        return updated

    def artifact(self, store, job: Job, name: str) -> Path:
        if job.backend != BACKEND or not re.fullmatch(r"[a-zA-Z0-9._-]+", name): raise KeyError("artifact not found")
        allowed = {"report.json", "comparison.png", "model.ply", "worker.log", "checkpoint.pt", "manifest.json"}
        if name not in allowed and not re.fullmatch(r"[a-zA-Z0-9._-]+-(reference|prediction|difference)\.png", name):
            raise KeyError("artifact not found")
        path = self.directory(store, job) / name
        if not path.is_file(): raise KeyError("artifact not found")
        return path


runner = ExperimentRunner()
