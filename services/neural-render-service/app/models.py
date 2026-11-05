from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Vec3(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    z: float


class Quaternion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    z: float
    w: float


class CameraIntrinsics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)
    fx: float = Field(gt=0)
    fy: float = Field(gt=0)
    cx: float = Field(ge=0)
    cy: float = Field(ge=0)
    distortion: list[float] = Field(default_factory=list)


class CameraPose(BaseModel):
    model_config = ConfigDict(extra="forbid")

    position_m: Vec3
    quaternion_xyzw: Quaternion
    coordinate_frame: Literal["world", "agent", "gimbal"] = "world"


class SceneCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scene_id: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")
    name: str = Field(min_length=1, max_length=200)
    coordinate_frame: str = "platform-world"
    asset_uri: str | None = None
    neural_field_uri: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class Scene(SceneCreate):
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class DatasetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(default_factory=lambda: f"dataset-{uuid4().hex[:12]}")
    name: str = Field(min_length=1, max_length=200)
    scene_id: str | None = None
    scene_version: str | None = None
    image_uri: str | None = None
    pose_uri: str | None = None
    calibration_uri: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    status: Literal["draft", "ready", "training", "completed", "failed"] = "draft"


class Dataset(DatasetCreate):
    created_at: datetime = Field(default_factory=utc_now)


class DatasetValidationIssue(BaseModel):
    code: str
    severity: Literal["error", "warning"]
    message: str
    frame_id: str | None = None


class DatasetValidationResponse(BaseModel):
    dataset_id: str
    valid: bool
    frame_count: int
    issues: list[DatasetValidationIssue]


class DatasetFinalizeResponse(BaseModel):
    dataset: Dataset
    validation: DatasetValidationResponse


class DatasetFramePose(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    position_m: Vec3 = Field(alias="positionM")
    quaternion_xyzw: Quaternion = Field(alias="quaternionXyzw")
    coordinate_frame: Literal["platform-world", "world", "agent", "gimbal"] = Field(
        default="platform-world", alias="coordinateFrame"
    )


class DatasetFrameIntrinsics(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)
    fx: float = Field(gt=0)
    fy: float = Field(gt=0)
    cx: float = Field(ge=0)
    cy: float = Field(ge=0)
    distortion: list[float] = Field(default_factory=list)


class DatasetFrameUpload(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    frame_id: str = Field(alias="frameId", min_length=1, max_length=160)
    image_data_url: str = Field(alias="imageDataUrl", min_length=32)
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)
    simulation_time: float = Field(alias="simulationTime", ge=0)
    captured_at: datetime = Field(alias="capturedAt")
    camera_pose: DatasetFramePose = Field(alias="cameraPose")
    camera_intrinsics: DatasetFrameIntrinsics = Field(alias="cameraIntrinsics")
    metadata: dict[str, Any] = Field(default_factory=dict)


class TrainRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: str
    representation: Literal["3dgs", "nerf", "4dgs"] = "3dgs"
    output_uri: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pose: CameraPose
    intrinsics: CameraIntrinsics
    outputs: list[Literal["rgb", "depth", "normal", "segmentation"]] = Field(
        default_factory=lambda: ["rgb"]
    )
    scene_version: str | None = None
    output_uri: str | None = None


JobType = Literal["train", "render"]
JobStatus = Literal["queued", "running", "completed", "failed"]


class Job(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(default_factory=lambda: f"job-{uuid4().hex[:12]}")
    type: JobType
    status: JobStatus = "queued"
    backend: str
    request: dict[str, Any]
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str
    renderer_backend: str
    database_configured: bool
    storage_root: str


class ReadyResponse(BaseModel):
    status: Literal["ready", "degraded"]
    service: str
    renderer_available: bool
    database_configured: bool
