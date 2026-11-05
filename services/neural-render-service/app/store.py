from __future__ import annotations

import base64
import binascii
import json
import mimetypes
import re
import sqlite3
from pathlib import Path
from typing import Any

from .models import Dataset, DatasetCreate, DatasetFrameUpload, Job, Scene, SceneCreate


class PersistentStore:
    """Metadata persistence with SQLite for local work and PostgreSQL for shared work."""

    def __init__(self, storage_root: str, database_url: str = "") -> None:
        self.storage_root = Path(storage_root).resolve()
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self.database_url = database_url.strip()
        self.backend = "postgres" if self.database_url.startswith(("postgres://", "postgresql://")) else "sqlite"
        self.database_path = self.storage_root / "metadata.sqlite3"
        self._ensure_schema()

    @property
    def database_available(self) -> bool:
        try:
            with self._connect() as connection:
                connection.execute("SELECT 1")
            return True
        except Exception:
            return False

    def _connect(self):
        if self.backend == "postgres":
            import psycopg

            return psycopg.connect(self.database_url)
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _placeholder(self) -> str:
        return "%s" if self.backend == "postgres" else "?"

    def _ensure_schema(self) -> None:
        payload_type = "JSONB" if self.backend == "postgres" else "TEXT"
        statements = [
            f"""CREATE TABLE IF NOT EXISTS scenes (
              scene_id TEXT PRIMARY KEY, payload {payload_type} NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
            f"""CREATE TABLE IF NOT EXISTS datasets (
              dataset_id TEXT PRIMARY KEY, payload {payload_type} NOT NULL,
              created_at TEXT NOT NULL)""",
            f"""CREATE TABLE IF NOT EXISTS dataset_frames (
              frame_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, image_uri TEXT NOT NULL,
              payload {payload_type} NOT NULL, created_at TEXT NOT NULL,
              FOREIGN KEY(dataset_id) REFERENCES datasets(dataset_id))""",
            f"""CREATE TABLE IF NOT EXISTS jobs (
              job_id TEXT PRIMARY KEY, payload {payload_type} NOT NULL,
              created_at TEXT NOT NULL)""",
        ]
        with self._connect() as connection:
            for statement in statements:
                connection.execute(statement)
            connection.commit()

    @staticmethod
    def _json_dump(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _json_load(value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            return value
        if isinstance(value, (bytes, bytearray)):
            value = value.decode("utf-8")
        return json.loads(value)

    def create_scene(self, request: SceneCreate) -> Scene:
        if self.get_scene(request.scene_id):
            raise ValueError(f"scene already exists: {request.scene_id}")
        scene = Scene.model_validate(request.model_dump())
        payload = self._json_dump(scene.model_dump(mode="json"))
        placeholder = self._placeholder()
        with self._connect() as connection:
            connection.execute(
                f"INSERT INTO scenes(scene_id, payload, created_at, updated_at) VALUES ({placeholder}, {placeholder}, {placeholder}, {placeholder})",
                (scene.scene_id, payload, scene.created_at.isoformat(), scene.updated_at.isoformat()),
            )
            connection.commit()
        return scene

    def list_scenes(self) -> list[Scene]:
        with self._connect() as connection:
            rows = connection.execute("SELECT payload FROM scenes ORDER BY created_at").fetchall()
        return [Scene.model_validate(self._json_load(row[0])) for row in rows]

    def get_scene(self, scene_id: str) -> Scene | None:
        placeholder = self._placeholder()
        with self._connect() as connection:
            row = connection.execute(f"SELECT payload FROM scenes WHERE scene_id = {placeholder}", (scene_id,)).fetchone()
        return Scene.model_validate(self._json_load(row[0])) if row else None

    def create_dataset(self, request: DatasetCreate) -> Dataset:
        if self.get_dataset(request.dataset_id):
            raise ValueError(f"dataset already exists: {request.dataset_id}")
        dataset = Dataset.model_validate(request.model_dump())
        payload = self._json_dump(dataset.model_dump(mode="json"))
        placeholder = self._placeholder()
        with self._connect() as connection:
            connection.execute(
                f"INSERT INTO datasets(dataset_id, payload, created_at) VALUES ({placeholder}, {placeholder}, {placeholder})",
                (dataset.dataset_id, payload, dataset.created_at.isoformat()),
            )
            connection.commit()
        return dataset

    def get_dataset(self, dataset_id: str) -> Dataset | None:
        placeholder = self._placeholder()
        with self._connect() as connection:
            row = connection.execute(f"SELECT payload FROM datasets WHERE dataset_id = {placeholder}", (dataset_id,)).fetchone()
        return Dataset.model_validate(self._json_load(row[0])) if row else None

    def _frame_payloads(self, dataset_id: str) -> list[dict[str, Any]]:
        placeholder = self._placeholder()
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT payload FROM dataset_frames WHERE dataset_id = {placeholder} ORDER BY created_at, frame_id",
                (dataset_id,),
            ).fetchall()
        return [self._json_load(row[0]) for row in rows]

    def validate_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        dataset = self.get_dataset(dataset_id)
        if not dataset:
            return None
        frames = self._frame_payloads(dataset_id)
        issues: list[dict[str, Any]] = []
        if not frames:
            issues.append({"code": "NO_FRAMES", "severity": "error", "message": "数据集没有采集帧"})
        elif len(frames) < 10:
            issues.append({"code": "FEW_FRAMES", "severity": "warning", "message": "少于 10 帧，可能不足以支持稳定重建"})

        previous_time: float | None = None
        reference_intrinsics: dict[str, Any] | None = None
        for frame in frames:
            frame_id = frame.get("frameId")
            image_uri = frame.get("imageUri", "")
            image_path = self.storage_root / image_uri
            if not image_path.is_file():
                issues.append({"code": "IMAGE_MISSING", "severity": "error", "message": "图片文件不存在", "frame_id": frame_id})
            simulation_time = frame.get("simulationTime")
            if not isinstance(simulation_time, (int, float)):
                issues.append({"code": "TIME_MISSING", "severity": "error", "message": "缺少仿真时间", "frame_id": frame_id})
            elif previous_time is not None and simulation_time <= previous_time:
                issues.append({"code": "TIME_NOT_MONOTONIC", "severity": "error", "message": "仿真时间没有递增", "frame_id": frame_id})
            else:
                previous_time = simulation_time
            pose = frame.get("cameraPose")
            if not pose or pose.get("coordinateFrame") != "platform-world":
                issues.append({"code": "POSE_INVALID", "severity": "error", "message": "相机位姿缺失或坐标系不正确", "frame_id": frame_id})
            intrinsics = frame.get("cameraIntrinsics")
            if not intrinsics:
                issues.append({"code": "INTRINSICS_MISSING", "severity": "error", "message": "缺少相机内参", "frame_id": frame_id})
            elif reference_intrinsics is None:
                reference_intrinsics = intrinsics
            else:
                keys = ("width", "height", "fx", "fy", "cx", "cy")
                if any(abs(float(intrinsics.get(key, 0)) - float(reference_intrinsics.get(key, 0))) > 1e-3 for key in keys):
                    issues.append({"code": "INTRINSICS_INCONSISTENT", "severity": "error", "message": "相机内参在帧之间不一致", "frame_id": frame_id})

        errors = [issue for issue in issues if issue["severity"] == "error"]
        return {"dataset_id": dataset_id, "valid": not errors, "frame_count": len(frames), "issues": issues}

    def set_dataset_status(self, dataset_id: str, status: str) -> Dataset | None:
        dataset = self.get_dataset(dataset_id)
        if not dataset:
            return None
        updated = dataset.model_copy(update={"status": status})
        placeholder = self._placeholder()
        with self._connect() as connection:
            connection.execute(
                f"UPDATE datasets SET payload = {placeholder} WHERE dataset_id = {placeholder}",
                (self._json_dump(updated.model_dump(mode="json")), dataset_id),
            )
            connection.commit()
        return updated

    def create_job(self, job: Job) -> Job:
        payload = self._json_dump(job.model_dump(mode="json"))
        placeholder = self._placeholder()
        with self._connect() as connection:
            connection.execute(
                f"INSERT INTO jobs(job_id, payload, created_at) VALUES ({placeholder}, {placeholder}, {placeholder})",
                (job.job_id, payload, job.created_at.isoformat()),
            )
            connection.commit()
        return job

    def get_job(self, job_id: str) -> Job | None:
        placeholder = self._placeholder()
        with self._connect() as connection:
            row = connection.execute(f"SELECT payload FROM jobs WHERE job_id = {placeholder}", (job_id,)).fetchone()
        return Job.model_validate(self._json_load(row[0])) if row else None

    def add_frame(self, dataset_id: str, request: DatasetFrameUpload) -> dict[str, Any]:
        if not self.get_dataset(dataset_id):
            raise KeyError("dataset not found")
        image_uri = self._save_image(dataset_id, request.frame_id, request.image_data_url)
        frame_payload = {
            "frameId": request.frame_id,
            "imageUri": image_uri,
            "imageMimeType": self._mime_from_data_url(request.image_data_url),
            "width": request.width,
            "height": request.height,
            "simulationTime": request.simulation_time,
            "capturedAt": request.captured_at.isoformat(),
            "cameraPose": request.camera_pose.model_dump(by_alias=True, mode="json"),
            "cameraIntrinsics": request.camera_intrinsics.model_dump(by_alias=True, mode="json"),
            "metadata": request.metadata,
        }
        payload = self._json_dump(frame_payload)
        placeholder = self._placeholder()
        with self._connect() as connection:
            try:
                connection.execute(
                    f"INSERT INTO dataset_frames(frame_id, dataset_id, image_uri, payload, created_at) VALUES ({placeholder}, {placeholder}, {placeholder}, {placeholder}, {placeholder})",
                    (request.frame_id, dataset_id, image_uri, payload, request.captured_at.isoformat()),
                )
                connection.commit()
            except Exception as exc:
                if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                    raise ValueError(f"frame already exists: {request.frame_id}") from exc
                raise
        return {"frameId": request.frame_id, "imageUri": image_uri}

    def get_manifest(self, dataset_id: str) -> dict[str, Any] | None:
        dataset = self.get_dataset(dataset_id)
        if not dataset:
            return None
        placeholder = self._placeholder()
        frames = self._frame_payloads(dataset_id)
        first = frames[0] if frames else None
        return {
            "format": "simulation-platform/neural-dataset",
            "version": 1,
            "datasetId": dataset.dataset_id,
            "sceneId": dataset.scene_id,
            "sceneVersion": dataset.scene_version,
            "coordinateFrame": "platform-world",
            "unit": "meter",
            "createdAt": dataset.created_at.isoformat(),
            "camera": first["cameraIntrinsics"] if first else None,
            "frames": frames,
            "metadata": dataset.metadata,
        }

    def _save_image(self, dataset_id: str, frame_id: str, data_url: str) -> str:
        match = re.fullmatch(r"data:([^;,]+);base64,(.+)", data_url, re.DOTALL)
        if not match:
            raise ValueError("imageDataUrl must be a base64 data URL")
        mime, encoded = match.groups()
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("imageDataUrl contains invalid base64") from exc
        extension = mimetypes.guess_extension(mime) or ".bin"
        safe_frame_id = re.sub(r"[^a-zA-Z0-9._-]", "_", frame_id)
        relative = Path("datasets") / dataset_id / "images" / f"{safe_frame_id}{extension}"
        target = self.storage_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return relative.as_posix()

    @staticmethod
    def _mime_from_data_url(data_url: str) -> str:
        return data_url[5:].split(";", 1)[0] if data_url.startswith("data:") else "application/octet-stream"
