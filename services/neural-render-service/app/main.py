from __future__ import annotations

from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
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
from .store import PersistentStore


app = FastAPI(
    title="neural-render-service",
    version="0.1.0",
    description="神经渲染场景、训练任务和渲染请求服务。",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:45678", "http://127.0.0.1:45678"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

store = PersistentStore(settings.storage_root, settings.database_url)


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
        return store.add_frame(dataset_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
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
    result = store.validate_dataset(dataset_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")
    validation = DatasetValidationResponse.model_validate(result)
    if not validation.valid:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=validation.model_dump(mode="json"))
    dataset = store.set_dataset_status(dataset_id, "ready")
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dataset not found")
    return DatasetFinalizeResponse(dataset=dataset, validation=validation)


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
