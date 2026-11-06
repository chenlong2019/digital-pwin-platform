import json
import os

import pytest

from app.experiments import ASSET_ROOT, ExperimentRunner
from app.gaussian.source import source_identity
from app.models import DatasetCreate, DatasetFrameUpload
from app.store import PersistentStore

SCENE = "campus-road-points-v2-spacing-fix"


@pytest.fixture
def experiment_service(service, png_url, frame_factory, monkeypatch):
    runner = ExperimentRunner()
    monkeypatch.setattr(service["main"], "runner", runner)
    store = service["store"]
    store.create_dataset(DatasetCreate(dataset_id="campus", name="campus", scene_id=SCENE,
                                     metadata={"source_identity": source_identity(ASSET_ROOT)}))
    for index in range(10):
        frame = frame_factory(f"view-{index}", index)
        frame.update(width=64, height=64, imageDataUrl=png_url(64, 64, index),
                     cameraIntrinsics={"width": 64, "height": 64, "fx": 50, "fy": 50, "cx": 32, "cy": 32},
                     metadata={"split": "train" if index < 8 else "test"})
        store.add_frame("campus", DatasetFrameUpload.model_validate(frame))
    store.finalize_dataset("campus")
    service["runner"] = runner
    return service


def fake_worker(monkeypatch):
    class Process:
        pid = os.getpid()
        def poll(self): return None
    monkeypatch.setattr("app.experiments.subprocess.Popen", lambda *args, **kwargs: Process())


def test_experiment_requests_validate_options_without_launching_a_worker(experiment_service):
    client = experiment_service["client"]
    for body in [{"steps": 1}, {"gaussians": 999999}, {"quality_preset": "unknown"}, {"unknown": True}]:
        assert client.post("/api/v1/experiments", json={"dataset_id": "campus", **body}).status_code == 422
        assert client.post("/api/v1/jobs/train", json={"dataset_id": "campus", "options": {
            "workflow": "campus-3dgs", **body}}).status_code == 422
    assert client.post("/api/v1/experiments", json={"dataset_id": "missing"}).status_code == 404


def test_draft_and_wrong_scene_cannot_start(experiment_service):
    store, client = experiment_service["store"], experiment_service["client"]
    store.set_dataset_status("campus", "draft")
    assert client.post("/api/v1/experiments", json={"dataset_id": "campus"}).status_code == 400
    store.create_dataset(DatasetCreate(dataset_id="other", name="other", scene_id="other", status="ready"))
    assert client.post("/api/v1/experiments", json={"dataset_id": "other"}).status_code == 400


def test_job_progress_and_artifacts_survive_service_restart(experiment_service, monkeypatch):
    fake_worker(monkeypatch)
    client, runner, store = (experiment_service[key] for key in ["client", "runner", "store"])
    response = client.post("/api/v1/experiments", json={"dataset_id": "campus"})
    assert response.status_code == 202, response.text
    job = store.get_job(response.json()["job_id"])
    output = runner.directory(store, job)
    config = json.loads((output/"config.json").read_text())
    assert config["source_verified_at_capture"] is True
    assert config["source_identity"] == source_identity(ASSET_ROOT)
    assert client.post("/api/v1/experiments", json={"dataset_id": "campus"}).status_code == 400
    (output/"progress.json").write_text(json.dumps({"status": "running", "stage": "training", "step": 100, "steps": 400}))
    monkeypatch.setattr(experiment_service["main"], "runner", ExperimentRunner())
    monkeypatch.setattr(experiment_service["main"], "store", PersistentStore(str(store.storage_root)))
    assert client.get(f"/api/v1/jobs/{job.job_id}").json()["result"]["step"] == 100
    (output/"progress.json").write_text(json.dumps({"status": "completed", "stage": "completed", "step": 400}))
    (output/"report.json").write_text('{"quality":{"psnr":22}}')
    final = client.get(f"/api/v1/jobs/{job.job_id}").json()
    assert final["status"] == "completed"
    assert client.get(final["result"]["report_url"]).json()["quality"]["psnr"] == 22
    assert client.get(f"/api/v1/experiments/{job.job_id}/artifacts/config.json").status_code == 404
    assert client.get(f"/api/v1/experiments/{job.job_id}/artifacts/missing.png").status_code == 404


def test_resume_preserves_manifest_bytes_and_rejects_changed_source(experiment_service, monkeypatch):
    fake_worker(monkeypatch)
    store, runner, client = (experiment_service[key] for key in ["store", "runner", "client"])
    job_id = client.post("/api/v1/experiments", json={"dataset_id": "campus"}).json()["job_id"]
    old = runner.directory(store, store.get_job(job_id))
    (old/"checkpoint.pt").write_bytes(b"checkpoint-fixture")
    monkeypatch.setattr("app.experiments.process_alive", lambda pid: False)
    resumed = client.post("/api/v1/experiments", json={"dataset_id": "campus", "resume_job_id": job_id})
    assert resumed.status_code == 202, resumed.text
    output = runner.directory(store, store.get_job(resumed.json()["job_id"]))
    assert (output/"manifest.json").read_bytes() == (old/"manifest.json").read_bytes()
    assert (output/"checkpoint.pt").read_bytes() == b"checkpoint-fixture"
    assert client.post("/api/v1/experiments", json={"dataset_id": "campus", "resume_job_id": job_id, "seed": 1}).status_code == 400
    config = json.loads((old/"config.json").read_text())
    config["source_identity"]["index_sha256"] = "0"*64
    (old/"config.json").write_text(json.dumps(config))
    result = client.post("/api/v1/experiments", json={"dataset_id": "campus", "resume_job_id": job_id})
    assert result.status_code == 400
    assert "源点云" in result.json()["detail"]


def test_detail_profile_is_snapshotted_and_resume_cannot_change_it(experiment_service, monkeypatch):
    fake_worker(monkeypatch)
    store, runner, client = (experiment_service[key] for key in ["store", "runner", "client"])
    result = client.post("/api/v1/experiments", json={"dataset_id": "campus", "quality_preset": "detail",
                                                  "gaussians": 48000, "steps": 2400})
    assert result.status_code == 202, result.text
    job_id = result.json()["job_id"]
    output = runner.directory(store, store.get_job(job_id))
    config = json.loads((output/"config.json").read_text())
    assert config["training_profile"]["voxel_size_m"] == 0.6
    assert config["training_profile"]["foreground_tiles"] == 24
    (output/"checkpoint.pt").write_bytes(b"detail-checkpoint")
    monkeypatch.setattr("app.experiments.process_alive", lambda pid: False)
    options = {"dataset_id": "campus", "resume_job_id": job_id, "gaussians": 48000, "steps": 4000}
    incompatible = client.post("/api/v1/experiments", json=options)
    assert incompatible.status_code == 400
    assert "画质档位" in incompatible.json()["detail"]
    compatible = client.post("/api/v1/experiments", json={**options, "quality_preset": "detail"})
    assert compatible.status_code == 202, compatible.text
    resumed = runner.directory(store, store.get_job(compatible.json()["job_id"]))
    assert (resumed/"checkpoint.pt").read_bytes() == b"detail-checkpoint"


def test_legacy_training_route_remains_explicit_placeholder(experiment_service):
    response = experiment_service["client"].post("/api/v1/jobs/train", json={"dataset_id": "campus"})
    assert response.status_code == 202
    assert response.json()["backend"] == "placeholder"
    assert "not connected" in response.json()["result"]["message"]


def test_finished_worker_does_not_hold_gpu_or_overwrite_new_dataset_status(experiment_service, monkeypatch):
    fake_worker(monkeypatch)
    store, runner, client = (experiment_service[key] for key in ["store", "runner", "client"])
    old_id = client.post("/api/v1/experiments", json={"dataset_id": "campus"}).json()["job_id"]
    old = runner.directory(store, store.get_job(old_id))
    (old/"progress.json").write_text(json.dumps({"status": "completed", "stage": "completed"}))
    # The old PID can still exist or be reused by an unrelated process.
    monkeypatch.setattr("app.experiments.process_alive", lambda pid: True)
    assert client.post("/api/v1/experiments", json={"dataset_id": "campus"}).status_code == 202
    assert client.get(f"/api/v1/jobs/{old_id}").json()["status"] == "completed"
    assert store.get_dataset("campus").status == "training"
