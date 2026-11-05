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
    image_uri: str | None = None
    pose_uri: str | None = None
    calibration_uri: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class Dataset(DatasetCreate):
    created_at: datetime = Field(default_factory=utc_now)


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
