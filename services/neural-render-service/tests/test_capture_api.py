from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.capture_models import CaptureClaimRequest
from app.capture_store import CaptureTaskStore, capture_frame_id
from app.models import DatasetFrameUpload
from app.store import PersistentStore

VERSION = "a" * 64


def plan(task_id="capture-test"):
    return {"name": "测试采集", "plan": {
        "schemaVersion": 1, "taskId": task_id, "sceneId": "three-demo-city-webgl-husky-v1",
        "shots": [{"id": f"view-{i}", "positionEnu": [i * 2, 0, 6], "heading": 0, "pitch": -25} for i in range(3)],
    }}


def start(service, task_id="capture-test"):
    client = service["client"]
    response = client.post("/api/v1/capture-tasks", json=plan(task_id))
    assert response.status_code == 201, response.text
    claim = client.post("/api/v1/capture-tasks/claim", json={"worker_id": "worker-a"}).json()
    auth = {"worker_id": "worker-a", "lease_token": claim["lease_token"]}
    assert client.post(f"/api/v1/capture-tasks/{task_id}/heartbeat", json={**auth, "scene_version": VERSION, "completed": 0}).status_code == 200
    return auth, claim["task"]


def captured(frame_factory, task_id, index=0, session="browser-1"):
    shot_id = f"view-{index}"
    frame = frame_factory(capture_frame_id(task_id, shot_id), index)
    frame["metadata"] = {"captureTaskId": task_id, "shotId": shot_id, "shotIndex": index,
                         "sceneVersion": VERSION, "simulationSessionId": session}
    return frame


def test_task_creation_is_atomic_and_idempotent(service):
    client = service["client"]
    request = plan()
    first = client.post("/api/v1/capture-tasks", json=request)
    second = client.post("/api/v1/capture-tasks", json=request)
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert len(client.get("/api/v1/scenes").json()) == 1
    assert len(client.get("/api/v1/datasets").json()) == 1
    request["plan"]["shots"][0]["heading"] = 15
    assert client.post("/api/v1/capture-tasks", json=request).status_code == 409


def test_only_one_concurrent_claim_wins(service):
    service["client"].post("/api/v1/capture-tasks", json=plan())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda i: service["queue"].claim(CaptureClaimRequest(worker_id=f"worker-{i}")), range(2)))
    assert sum(result is not None for result in results) == 1


def test_expired_lease_reclaims_on_same_worker_and_fences_old_process(service, frame_factory, monkeypatch):
    auth, task = start(service)
    service["now"][0] += 61
    # Recreate both metadata and queue objects, as happens after a service restart.
    queue = CaptureTaskStore(PersistentStore(str(service["store"].storage_root)), clock=lambda: service["now"][0])
    monkeypatch.setattr(service["main"], "capture_store", queue)
    client = service["client"]
    assert client.post("/api/v1/capture-tasks/claim", json={"worker_id": "worker-b"}).json() is None
    claim = client.post("/api/v1/capture-tasks/claim", json={"worker_id": "worker-a"}).json()
    assert claim["lease_token"] != auth["lease_token"]
    result = client.post(f"/api/v1/capture-tasks/{task['task_id']}/frames", json={**auth, "frame": captured(frame_factory, task["task_id"])})
    assert result.status_code == 409
    assert client.post(f"/api/v1/capture-tasks/{task['task_id']}/finish", json={**auth, "status": "failed"}).status_code == 409


def test_upload_retries_preserve_bytes_and_conflicting_payload_cannot_overwrite(service, frame_factory):
    auth, task = start(service)
    client = service["client"]
    frame = captured(frame_factory, task["task_id"])
    route = f"/api/v1/capture-tasks/{task['task_id']}/frames"
    first = client.post(route, json={**auth, "frame": frame})
    assert first.status_code == 201, first.text
    image = service["store"].storage_root / first.json()["imageUri"]
    original = image.read_bytes()
    assert client.post(route, json={**auth, "frame": frame}).json() == first.json()
    changed = deepcopy(frame)
    changed["cameraPose"]["positionM"]["x"] = 90
    assert client.post(route, json={**auth, "frame": changed}).status_code == 409
    assert image.read_bytes() == original
    assert len(service["store"].get_manifest(task["dataset_id"])["frames"]) == 1
    assert client.post(f"/api/v1/datasets/{task['dataset_id']}/frames", json=frame).status_code == 409


def test_pause_resume_and_complete_after_clock_reset(service, frame_factory):
    auth, task = start(service)
    client = service["client"]
    route = f"/api/v1/capture-tasks/{task['task_id']}"
    assert client.post(route + "/frames", json={**auth, "frame": captured(frame_factory, task["task_id"])}).status_code == 201
    assert client.post(route + "/finish", json={**auth, "status": "completed"}).status_code == 409
    assert client.post(route + "/pause").json()["pause_requested"] is True
    assert client.post(route + "/heartbeat", json={**auth, "scene_version": VERSION, "completed": 1}).json()["pause_requested"] is True
    assert client.post(route + "/finish", json={**auth, "status": "paused"}).json()["status"] == "paused"
    assert client.post("/api/v1/capture-tasks/claim", json={"worker_id": "worker-a"}).json() is None
    assert client.post(route + "/resume").json()["status"] == "queued"
    claim = client.post("/api/v1/capture-tasks/claim", json={"worker_id": "worker-a"}).json()
    auth["lease_token"] = claim["lease_token"]
    for index in (1, 2):
        frame = captured(frame_factory, task["task_id"], index, session="browser-2")
        frame["simulationTime"] = (index - 1) * 0.2  # genuine reset, not an invented global timestamp
        assert client.post(route + "/frames", json={**auth, "frame": frame}).status_code == 201
    finished = client.post(route + "/finish", json={**auth, "status": "completed"})
    assert finished.status_code == 200, finished.text
    assert finished.json()["uploaded"] == finished.json()["completed"] == 3
    dataset = client.get(f"/api/v1/datasets/{task['dataset_id']}").json()
    assert dataset["status"] == "ready"
    assert dataset["scene_version"] == VERSION
    assert client.post(f"/api/v1/datasets/{task['dataset_id']}/validate").json()["valid"] is True
    frame_id = capture_frame_id(task["task_id"], "view-0")
    assert client.get(f"/api/v1/datasets/{task['dataset_id']}/images/{frame_id}").content.startswith(b"\x89PNG")


def test_dataset_sealing_rejects_new_frames_but_allows_identical_replay(service, frame_factory):
    store = service["store"]
    from app.models import DatasetCreate
    store.create_dataset(DatasetCreate(dataset_id="manual", name="manual"))
    frame = DatasetFrameUpload.model_validate(frame_factory())
    store.add_frame("manual", frame)
    store.finalize_dataset("manual")
    assert store.add_frame("manual", frame)["frameId"] == frame.frame_id
    response = service["client"].post("/api/v1/datasets/manual/frames", json=frame_factory("frame-2", 1))
    assert response.status_code == 409


@pytest.mark.parametrize("damage", ["header-only", "wrong-dimensions", "non-unit-rotation"])
def test_invalid_images_or_pose_are_rejected(service, frame_factory, damage):
    auth, task = start(service)
    frame = captured(frame_factory, task["task_id"])
    if damage == "header-only":
        frame["imageDataUrl"] = "data:image/png;base64,iVBORw0KGgo="
    elif damage == "wrong-dimensions":
        frame["width"] = frame["cameraIntrinsics"]["width"] = 17
    else:
        frame["cameraPose"]["quaternionXyzw"]["w"] = 2
    response = service["client"].post(f"/api/v1/capture-tasks/{task['task_id']}/frames", json={**auth, "frame": frame})
    assert response.status_code in (400, 422), response.text
    assert not service["store"].get_manifest(task["dataset_id"])["frames"]


def test_hash_damage_blocks_completion_until_identical_frame_is_restored(service, frame_factory):
    auth, task = start(service)
    client = service["client"]
    route = f"/api/v1/capture-tasks/{task['task_id']}"
    for index in range(3):
        frame = captured(frame_factory, task["task_id"], index)
        response = client.post(route + "/frames", json={**auth, "frame": frame})
        if index == 0:
            damaged = service["store"].storage_root / response.json()["imageUri"]
    damaged.write_bytes(b"broken")
    assert client.post(route + "/finish", json={**auth, "status": "completed"}).status_code == 409
    assert client.post(route + "/frames", json={**auth, "frame": captured(frame_factory, task["task_id"])}).status_code == 201
    assert client.post(route + "/finish", json={**auth, "status": "completed"}).status_code == 200


def test_renderer_version_and_unplanned_shots_are_rejected(service, frame_factory):
    auth, task = start(service)
    client = service["client"]
    route = f"/api/v1/capture-tasks/{task['task_id']}"
    assert client.post(route + "/heartbeat", json={**auth, "scene_version": "b" * 64, "completed": 0}).status_code == 409
    frame = captured(frame_factory, task["task_id"])
    frame["metadata"]["shotId"] = "not-planned"
    assert client.post(route + "/frames", json={**auth, "frame": frame}).status_code == 400


def test_camel_case_dataset_client_and_path_validation(service):
    client = service["client"]
    assert client.post("/api/v1/scenes", json={"sceneId": "manual-scene", "name": "manual scene"}).status_code == 201
    result = client.post("/api/v1/datasets", json={"datasetId": "manual", "sceneId": "manual-scene", "name": "manual"})
    assert result.status_code == 201, result.text
    assert result.json()["dataset_id"] == "manual"
    assert client.post("/api/v1/datasets", json={"dataset_id": "../escape", "name": "bad"}).status_code == 422
