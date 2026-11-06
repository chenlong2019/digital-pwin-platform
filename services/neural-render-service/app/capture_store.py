"""Durable capture queue. After first claim a task stays on its worker's local disk.

Every mutation uses a lease token and a transaction. A replacement process with the
same worker ID can reclaim an expired lease; an older process cannot upload after it.
"""
from __future__ import annotations

import hashlib
import time
from contextlib import closing
from datetime import datetime, timezone
from uuid import uuid4

from .capture_models import CaptureClaim, CapturePlan, CaptureTask, CaptureTaskCreate
from .models import Dataset, Scene, utc_now
from .store import DatasetConflict, PersistentStore


def capture_frame_id(task_id: str, shot_id: str) -> str:
    return "capture-" + hashlib.sha256(f"{task_id}\0{shot_id}".encode()).hexdigest()[:40]


class CaptureTaskStore:
    LEASE_SECONDS = 60

    def __init__(self, store: PersistentStore, clock=time.time):
        self.store = store
        self.clock = clock
        self.p = store._placeholder()
        payload = "JSONB" if store.backend == "postgres" else "TEXT"
        with store.transaction() as connection:
            connection.execute(f"""CREATE TABLE IF NOT EXISTS capture_tasks (
                task_id TEXT PRIMARY KEY, status TEXT NOT NULL, worker_id TEXT,
                lease_token TEXT, lease_expires DOUBLE PRECISION NOT NULL DEFAULT 0,
                payload {payload} NOT NULL, created_at TEXT NOT NULL)""")

    def _row(self, connection, task_id):
        lock = " FOR UPDATE" if self.store.backend == "postgres" else ""
        row = connection.execute(
            f"SELECT payload, lease_token, lease_expires FROM capture_tasks WHERE task_id = {self.p}{lock}", (task_id,)
        ).fetchone()
        if not row:
            raise KeyError("capture task not found")
        return CaptureTask.model_validate(self.store._json_load(row[0])), row[1], row[2]

    def _save(self, connection, task, token=None, expires=0):
        task.updated_at = utc_now()
        task.lease_expires_at = datetime.fromtimestamp(expires, timezone.utc) if expires else None
        connection.execute(
            f"UPDATE capture_tasks SET status = {self.p}, worker_id = {self.p}, lease_token = {self.p}, lease_expires = {self.p}, payload = {self.p} WHERE task_id = {self.p}",
            (task.status, task.worker_id, token, expires, task.model_dump_json(by_alias=True), task.task_id),
        )
        return task

    def _owned(self, connection, task_id, request):
        task, token, expires = self._row(connection, task_id)
        if task.status != "running" or task.worker_id != request.worker_id or token != request.lease_token or expires <= self.clock():
            raise DatasetConflict("capture lease is expired or belongs to another execution")
        return task

    def create(self, request: CaptureTaskCreate):
        task = CaptureTask(task_id=request.plan.task_id, dataset_id=f"capture-{request.plan.task_id}", name=request.name,
                           plan=request.plan, total=len(request.plan.shots))
        with self.store.transaction() as connection:
            inserted = connection.execute(
                f"INSERT INTO capture_tasks(task_id, status, payload, created_at) VALUES ({self.p}, {self.p}, {self.p}, {self.p}) ON CONFLICT(task_id) DO NOTHING",
                (task.task_id, task.status, task.model_dump_json(by_alias=True), task.created_at.isoformat()),
            ).rowcount
            if not inserted:
                existing, _, _ = self._row(connection, task.task_id)
                if existing.name != request.name or existing.plan != request.plan:
                    raise DatasetConflict("task ID already contains a different plan")
                return existing
            scene = Scene(scene_id=request.plan.scene_id, name="城市仿真采集场景", coordinate_frame="platform-world",
                          metadata={"sourceCoordinateFrame": "local-enu", "source": "drone-camera"})
            connection.execute(
                f"INSERT INTO scenes(scene_id, payload, created_at, updated_at) VALUES ({self.p}, {self.p}, {self.p}, {self.p}) ON CONFLICT(scene_id) DO NOTHING",
                (scene.scene_id, scene.model_dump_json(), scene.created_at.isoformat(), scene.updated_at.isoformat()),
            )
            scene_row = connection.execute(f"SELECT payload FROM scenes WHERE scene_id = {self.p}", (scene.scene_id,)).fetchone()
            if self.store._json_load(scene_row[0])["coordinate_frame"] != "platform-world":
                raise DatasetConflict("scene already uses a different coordinate frame")
            dataset = Dataset(dataset_id=task.dataset_id, name=request.name, scene_id=scene.scene_id, metadata={
                "captureTaskId": task.task_id, "expectedFrameCount": task.total, "source": "drone-camera-agent",
                "sourceCoordinateFrame": "local-enu", "positionTransform": "[east,north,up] -> [east,up,-north]",
                "rotationConvention": "quaternion xyzw; active camera-local-to-world; forward=-Z, right=+X, up=+Y",
                "simulationTimeBasis": "per-browser-session; metadata.simulationSessionId identifies resets",
            })
            inserted = connection.execute(
                f"INSERT INTO datasets(dataset_id, payload, created_at) VALUES ({self.p}, {self.p}, {self.p}) ON CONFLICT(dataset_id) DO NOTHING",
                (dataset.dataset_id, dataset.model_dump_json(), dataset.created_at.isoformat()),
            ).rowcount
            if not inserted:
                raise DatasetConflict("capture dataset ID is already in use")
        return task

    def get(self, task_id):
        with closing(self.store._connect()) as connection:
            row = connection.execute(f"SELECT payload FROM capture_tasks WHERE task_id = {self.p}", (task_id,)).fetchone()
        return CaptureTask.model_validate(self.store._json_load(row[0])) if row else None

    def list(self):
        with closing(self.store._connect()) as connection:
            rows = connection.execute("SELECT payload FROM capture_tasks ORDER BY created_at DESC LIMIT 100").fetchall()
        return [CaptureTask.model_validate(self.store._json_load(row[0])) for row in rows]

    def claim(self, request):
        with self.store.transaction() as connection:
            lock = " FOR UPDATE SKIP LOCKED" if self.store.backend == "postgres" else ""
            row = connection.execute(
                f"SELECT task_id FROM capture_tasks WHERE (status = 'queued' OR (status = 'running' AND lease_expires <= {self.p})) AND (worker_id IS NULL OR worker_id = {self.p}) ORDER BY created_at LIMIT 1{lock}",
                (self.clock(), request.worker_id),
            ).fetchone()
            if not row:
                return None
            task, _, _ = self._row(connection, row[0])
            task.status = "running"
            task.worker_id = request.worker_id
            task.error = None
            token = uuid4().hex
            self._save(connection, task, token, self.clock() + self.LEASE_SECONDS)
            return CaptureClaim(task=task, lease_token=token)

    def heartbeat(self, task_id, request):
        with self.store.transaction() as connection:
            task = self._owned(connection, task_id, request)
            if task.scene_version and task.scene_version != request.scene_version:
                raise DatasetConflict("renderer version changed; create a new capture task")
            if request.completed > task.total:
                raise ValueError("completed count exceeds plan size")
            dataset = self.store.lock_dataset(connection, task.dataset_id)
            dataset.scene_version = task.scene_version = request.scene_version
            connection.execute(
                f"UPDATE datasets SET payload = {self.p} WHERE dataset_id = {self.p}", (dataset.model_dump_json(), task.dataset_id)
            )
            task.completed = max(task.uploaded, request.completed)
            return self._save(connection, task, request.lease_token, self.clock() + self.LEASE_SECONDS)

    def upload(self, task_id, request):
        with self.store.transaction() as connection:
            task = self._owned(connection, task_id, request)
            frame = request.frame
            meta = frame.metadata
            index = next((i for i, shot in enumerate(task.plan.shots) if shot.id == meta.get("shotId")), None)
            if index is None or meta.get("shotIndex") != index or meta.get("captureTaskId") != task_id:
                raise ValueError("frame does not belong to a planned capture point")
            if frame.frame_id != capture_frame_id(task_id, task.plan.shots[index].id):
                raise ValueError("frame ID does not match task and shot")
            if not task.scene_version or meta.get("sceneVersion") != task.scene_version:
                raise DatasetConflict("frame renderer version does not match the task")
            if not isinstance(meta.get("simulationSessionId"), str) or not 1 <= len(meta["simulationSessionId"]) <= 100:
                raise ValueError("simulationSessionId is required")
            if frame.camera_pose.coordinate_frame != "platform-world":
                raise ValueError("capture frame must use platform-world coordinates")
            result = self.store.add_frame(task.dataset_id, frame, connection)
            task.uploaded = len(self.store._frame_payloads(task.dataset_id, connection))
            self._save(connection, task, request.lease_token, self.clock() + self.LEASE_SECONDS)
            return result

    def finish(self, task_id, request):
        with self.store.transaction() as connection:
            task = self._owned(connection, task_id, request)
            if request.status == "completed":
                if task.uploaded != task.total:
                    raise DatasetConflict("not all planned frames have been uploaded")
                self.store.finalize_dataset(task.dataset_id, connection)
                task.completed = task.total
            task.status = request.status
            task.error = request.error
            task.pause_requested = False
            return self._save(connection, task)

    def pause(self, task_id):
        with self.store.transaction() as connection:
            task, token, expires = self._row(connection, task_id)
            if task.status == "completed":
                return task
            if task.status == "running" and expires > self.clock():
                task.pause_requested = True
                return self._save(connection, task, token, expires)
            task.status = "paused"
            task.pause_requested = False
            return self._save(connection, task)

    def resume(self, task_id):
        with self.store.transaction() as connection:
            task, _, expires = self._row(connection, task_id)
            if task.status == "completed" or (task.status == "running" and expires > self.clock()):
                raise DatasetConflict("task is completed or still running")
            task.status = "queued"
            task.pause_requested = False
            task.error = None
            return self._save(connection, task)
