"""Bounded simulation plans shared with drone-camera/agent/task.mjs."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .models import DatasetFrameUpload, utc_now

SCENE_ID = "three-demo-city-webgl-husky-v1"
AGENT_ID = r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$"


class CaptureModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, allow_inf_nan=False)


class CaptureShot(CaptureModel):
    id: str = Field(pattern=AGENT_ID)
    position_enu: tuple[float, float, float] = Field(alias="positionEnu")
    heading: float = Field(ge=0, le=360)
    pitch: float = Field(ge=-90, le=60)

    @model_validator(mode="after")
    def bounded_position(self):
        east, north, up = self.position_enu
        if not (-100 <= east <= 100 and -100 <= north <= 100 and 1 <= up <= 100):
            raise ValueError("positionEnu must be within horizontal ±100 m and altitude 1–100 m")
        return self


class CapturePlan(CaptureModel):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    task_id: str = Field(alias="taskId", pattern=AGENT_ID)
    scene_id: Literal[SCENE_ID] = Field(alias="sceneId")
    max_attempts: int = Field(default=2, alias="maxAttempts", ge=1, le=3)
    shots: list[CaptureShot] = Field(min_length=2, max_length=200)

    @model_validator(mode="after")
    def unique_shots(self):
        if len({shot.id for shot in self.shots}) != len(self.shots):
            raise ValueError("duplicate shot IDs")
        return self


class CaptureTaskCreate(CaptureModel):
    name: str = Field(min_length=1, max_length=200)
    plan: CapturePlan


class CaptureTask(CaptureModel):
    task_id: str
    dataset_id: str
    name: str
    plan: CapturePlan
    status: Literal["queued", "running", "paused", "failed", "completed"] = "queued"
    completed: int = 0
    uploaded: int = 0
    total: int
    worker_id: str | None = None
    scene_version: str | None = None
    pause_requested: bool = False
    error: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    lease_expires_at: datetime | None = None


class CaptureClaimRequest(CaptureModel):
    worker_id: str = Field(pattern=AGENT_ID)


class CaptureClaim(CaptureModel):
    task: CaptureTask
    lease_token: str


class CaptureLeaseRequest(CaptureClaimRequest):
    lease_token: str = Field(min_length=1, max_length=100)


class CaptureHeartbeat(CaptureLeaseRequest):
    scene_version: str = Field(pattern=r"^[a-f0-9]{64}$")
    completed: int = Field(ge=0, le=200)


class CaptureFrame(CaptureLeaseRequest):
    frame: DatasetFrameUpload


class CaptureFinish(CaptureLeaseRequest):
    status: Literal["paused", "failed", "completed"]
    error: str | None = Field(default=None, max_length=2000)
