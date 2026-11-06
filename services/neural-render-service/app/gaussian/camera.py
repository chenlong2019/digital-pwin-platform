from __future__ import annotations

from typing import TYPE_CHECKING
if TYPE_CHECKING:
    import numpy as np


def quaternion_matrix(xyzw) -> np.ndarray:
    import numpy as np
    x, y, z, w = np.asarray(xyzw, dtype=np.float64)
    if not np.isfinite([x, y, z, w]).all() or abs(x*x + y*y + z*z + w*w - 1) > 1e-3:
        raise ValueError("Camera quaternion must be finite and normalized")
    return np.array([
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)],
    ], dtype=np.float32)


def frame_camera(frame: dict, origin: np.ndarray, scale: float) -> dict:
    """Three/OpenGL camera (+Y up, -Z forward) -> CV (+Y down, +Z forward)."""
    import numpy as np
    pose = frame["cameraPose"]
    if pose.get("coordinateFrame", "platform-world") != "platform-world":
        raise ValueError("Experiment requires platform-world camera poses")
    rotation = quaternion_matrix([pose["quaternionXyzw"][key] for key in "xyzw"])
    position = np.array([pose["positionM"][key] for key in "xyz"], dtype=np.float32)
    world_to_camera = np.diag([1, -1, -1]).astype(np.float32) @ rotation.T
    position = (position - origin) / scale
    return {**frame["cameraIntrinsics"], "rotation": world_to_camera,
            "translation": -world_to_camera @ position, "frame_id": frame["frameId"]}


def validate_split(manifest: dict) -> tuple[list[dict], list[dict]]:
    train, test, seen = [], [], set()
    for frame in manifest["frames"]:
        frame_id = frame["frameId"]
        if frame_id in seen:
            raise ValueError("Duplicate frame ID in experiment")
        seen.add(frame_id)
        if frame["cameraPose"].get("coordinateFrame", "platform-world") != "platform-world":
            raise ValueError("Experiment requires platform-world camera poses")
        intrinsics = frame["cameraIntrinsics"]
        if (intrinsics["width"], intrinsics["height"]) != (frame["width"], frame["height"]):
            raise ValueError("Image and calibration dimensions disagree")
        if any(abs(value) > 1e-9 for value in intrinsics.get("distortion", [])):
            raise ValueError("Reference experiment requires undistorted images")
        split = frame.get("metadata", {}).get("split")
        if split not in {"train", "test"}:
            raise ValueError("Every frame must declare train/test before training")
        (train if split == "train" else test).append(frame)
    if len(train) < 8 or len(test) < 2:
        raise ValueError("At least 8 training and 2 independent test views are required")
    def pose_key(frame):
        pose = frame["cameraPose"]
        quaternion = [pose["quaternionXyzw"][k] for k in "xyzw"]
        # q and -q represent the same physical camera orientation.
        sign = next((1 if value > 0 else -1 for value in reversed(quaternion) if abs(value) > 1e-9), 1)
        return tuple(round(pose["positionM"][k], 5) for k in "xyz") + tuple(round(value*sign, 6) for value in quaternion)
    if {pose_key(f) for f in train} & {pose_key(f) for f in test}:
        raise ValueError("Test camera poses overlap training camera poses")
    sizes = {(f["width"], f["height"]) for f in train + test}
    if len(sizes) != 1:
        raise ValueError("All experiment images must share one resolution")
    width, height = next(iter(sizes))
    if not (64 <= width <= 512 and 64 <= height <= 512) or width % 16 or height % 16:
        raise ValueError("Experiment resolution must be 64..512 pixels and divisible by 16")
    if len(train) + len(test) > 128:
        raise ValueError("Reference experiment supports at most 128 views")
    return train, test
