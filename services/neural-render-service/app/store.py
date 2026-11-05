from __future__ import annotations

from datetime import datetime, timezone

from .models import Dataset, DatasetCreate, Job, Scene, SceneCreate


def now() -> datetime:
    return datetime.now(timezone.utc)


class InMemoryStore:
    """Temporary store used to keep the HTTP contract usable before persistence is added."""

    def __init__(self) -> None:
        self.scenes: dict[str, Scene] = {}
        self.datasets: dict[str, Dataset] = {}
        self.jobs: dict[str, Job] = {}

    def create_scene(self, request: SceneCreate) -> Scene:
        if request.scene_id in self.scenes:
            raise ValueError(f"scene already exists: {request.scene_id}")
        scene = Scene.model_validate(request.model_dump())
        self.scenes[scene.scene_id] = scene
        return scene

    def list_scenes(self) -> list[Scene]:
        return list(self.scenes.values())

    def get_scene(self, scene_id: str) -> Scene | None:
        return self.scenes.get(scene_id)

    def create_dataset(self, request: DatasetCreate) -> Dataset:
        if request.dataset_id in self.datasets:
            raise ValueError(f"dataset already exists: {request.dataset_id}")
        dataset = Dataset.model_validate(request.model_dump())
        self.datasets[dataset.dataset_id] = dataset
        return dataset

    def get_dataset(self, dataset_id: str) -> Dataset | None:
        return self.datasets.get(dataset_id)

    def create_job(self, job: Job) -> Job:
        self.jobs[job.job_id] = job
        return job

    def get_job(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)
