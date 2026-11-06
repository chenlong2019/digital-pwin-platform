from __future__ import annotations

from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .capture_models import (
    CaptureClaim, CaptureClaimRequest, CaptureFinish, CaptureFrame,
    CaptureHeartbeat, CaptureTask, CaptureTaskCreate,
)
from .capture_store import CaptureTaskStore
from .models import (
    Dataset,
    DatasetCreate,
    DatasetFrameUpload,
    DatasetFinalizeResponse,
    HealthResponse,
    Job,
    ReadyResponse,
    RenderRequest,
    Scene,
    SceneCreate,
    TrainRequest,
    DatasetValidationResponse,
)
from .store import DatasetConflict, PersistentStore


app = FastAPI(
    title="neural-render-service",
    version="0.1.0",
    description="神经渲染场景、训练任务和渲染请求服务。",
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

store = PersistentStore(settings.storage_root, settings.database_url)
capture_store = CaptureTaskStore(store)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        service=settings.service_name,
        renderer_backend=settings.render_backend,
        database_configured=store.database_available,
        storage_root=settings.storage_root,
    )


@app.get("/ready", response_model=ReadyResponse)
def ready(response: Response) -> ReadyResponse:
    renderer_available = settings.render_backend in {"placeholder", "gsplat", "nerf"}
    database_available = store.database_available
    is_ready = database_available and renderer_available
    if not is_ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyResponse(
        status="ready" if is_ready else "degraded",
        service=settings.service_name,
        renderer_available=renderer_available,
        database_configured=database_available,
    )


@app.get("/api/v1/scenes", response_model=list[Scene])
def list_scenes() -> list[Scene]:
    return store.list_scenes()


@app.post("/api/v1/scenes", response_model=Scene, status_code=status.HTTP_201_CREATED)
def create_scene(request: SceneCreate) -> Scene:
    try:
        return store.create_scene(request)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@app.post("/api/v1/datasets", response_model=Dataset, status_code=status.HTTP_201_CREATED)
def create_dataset(request: DatasetCreate) -> Dataset:
    if request.scene_id and not store.get_scene(request.scene_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="scene not found")
    try:
        return store.create_dataset(request)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@app.post("/api/v1/datasets/{dataset_id}/frames", status_code=status.HTTP_201_CREATED)
def upload_dataset_frame(dataset_id: str, request: DatasetFrameUpload) -> dict[str, str]:
    try:
        dataset = store.get_dataset(dataset_id)
        if dataset and dataset.metadata.get("captureTaskId"):
            raise DatasetConflict("Agent datasets accept frames through the leased capture task endpoint")
        return store.add_frame(dataset_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except DatasetConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@app.post("/api/v1/datasets/{dataset_id}/validate", response_model=DatasetValidationResponse)
def validate_dataset(dataset_id: str) -> DatasetValidationResponse:
    result = store.validate_dataset(dataset_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")
    return DatasetValidationResponse.model_validate(result)


@app.post("/api/v1/datasets/{dataset_id}/finalize", response_model=DatasetFinalizeResponse)
def finalize_dataset(dataset_id: str) -> DatasetFinalizeResponse:
    dataset = store.get_dataset(dataset_id)
    if dataset and dataset.metadata.get("captureTaskId"):
        raise HTTPException(status_code=409, detail="Agent datasets are sealed by capture task completion")
    try:
        return DatasetFinalizeResponse.model_validate(store.finalize_dataset(dataset_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except DatasetConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/v1/datasets/{dataset_id}/manifest")
def get_dataset_manifest(dataset_id: str) -> dict:
    manifest = store.get_manifest(dataset_id)
    if not manifest:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")
    return manifest


@app.post("/api/v1/jobs/train", response_model=Job, status_code=status.HTTP_202_ACCEPTED)
def queue_training(request: TrainRequest) -> Job:
    if not store.get_dataset(request.dataset_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")
    return store.create_job(
        Job(
            type="train",
            backend=settings.render_backend,
            request=request.model_dump(mode="json"),
            result={"message": "training backend is not connected"},
        )
    )


@app.get("/api/v1/datasets", response_model=list[Dataset])
def list_datasets():
    return store.list_datasets()


@app.get("/api/v1/datasets/{dataset_id}", response_model=Dataset)
def get_dataset(dataset_id: str):
    dataset = store.get_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return dataset


@app.get("/api/v1/datasets/{dataset_id}/images/{frame_id}")
def get_dataset_image(dataset_id: str, frame_id: str):
    frame = next((f for f in store._frame_payloads(dataset_id) if f["frameId"] == frame_id), None)
    if frame:
        image_path = (store.storage_root / frame["imageUri"]).resolve()
        if image_path.is_relative_to(store.storage_root) and image_path.is_file():
            return FileResponse(image_path, media_type=frame["imageMimeType"])
    raise HTTPException(status_code=404, detail="image not found")


def capture_action(action, *args):
    try:
        return action(*args)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except DatasetConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/capture-tasks", response_model=CaptureTask, status_code=201)
def create_capture_task(request: CaptureTaskCreate):
    return capture_action(capture_store.create, request)


@app.get("/api/v1/capture-tasks", response_model=list[CaptureTask])
def list_capture_tasks():
    return capture_store.list()


@app.post("/api/v1/capture-tasks/claim", response_model=CaptureClaim | None)
def claim_capture_task(request: CaptureClaimRequest):
    return capture_action(capture_store.claim, request)


@app.get("/api/v1/capture-tasks/{task_id}", response_model=CaptureTask)
def get_capture_task(task_id: str):
    task = capture_store.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="capture task not found")
    return task


@app.post("/api/v1/capture-tasks/{task_id}/heartbeat", response_model=CaptureTask)
def capture_heartbeat(task_id: str, request: CaptureHeartbeat):
    return capture_action(capture_store.heartbeat, task_id, request)


@app.post("/api/v1/capture-tasks/{task_id}/frames", status_code=201)
def capture_upload(task_id: str, request: CaptureFrame):
    return capture_action(capture_store.upload, task_id, request)


@app.post("/api/v1/capture-tasks/{task_id}/finish", response_model=CaptureTask)
def capture_finish(task_id: str, request: CaptureFinish):
    return capture_action(capture_store.finish, task_id, request)


@app.post("/api/v1/capture-tasks/{task_id}/pause", response_model=CaptureTask)
def capture_pause(task_id: str):
    return capture_action(capture_store.pause, task_id)


@app.post("/api/v1/capture-tasks/{task_id}/resume", response_model=CaptureTask)
def capture_resume(task_id: str):
    return capture_action(capture_store.resume, task_id)


@app.post(
    "/api/v1/scenes/{scene_id}/render",
    response_model=Job,
    status_code=status.HTTP_202_ACCEPTED,
)
def queue_render(scene_id: str, request: RenderRequest) -> Job:
    if not store.get_scene(scene_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="scene not found")
    return store.create_job(
        Job(
            type="render",
            backend=settings.render_backend,
            request={"scene_id": scene_id, **request.model_dump(mode="json")},
            result={"message": "render backend is not connected"},
        )
    )


@app.get("/api/v1/jobs/{job_id}", response_model=Job)
def get_job(job_id: str) -> Job:
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="job not found")
    return job


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)
