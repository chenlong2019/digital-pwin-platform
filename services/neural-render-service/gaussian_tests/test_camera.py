from copy import deepcopy
import math

import numpy as np
import pytest

from app.gaussian.camera import frame_camera, validate_split
from app.gaussian.compare import match_cameras


def frame(index=0, split="train"):
    return {
        "frameId": f"view-{index}", "width": 256, "height": 192, "metadata": {"split": split},
        "cameraPose": {"positionM": {"x": index, "y": 2, "z": 5},
                       "quaternionXyzw": {"x": 0, "y": 0, "z": 0, "w": 1}, "coordinateFrame": "platform-world"},
        "cameraIntrinsics": {"width": 256, "height": 192, "fx": 100, "fy": 100, "cx": 128, "cy": 96},
    }


def test_opengl_camera_maps_forward_up_right_to_cv_and_pixels():
    item = frame()
    camera = frame_camera(item, np.zeros(3), 1)
    # Camera at (0,2,5); point is 2 right, 1 up, 10 forward.
    view = camera["rotation"] @ np.array([2, 3, -5]) + camera["translation"]
    np.testing.assert_allclose(view, [2, -1, 10])
    np.testing.assert_allclose([camera["fx"]*view[0]/view[2]+camera["cx"],
                                camera["fy"]*view[1]/view[2]+camera["cy"]], [148, 86])


def test_rotated_camera_and_scene_normalization_keep_the_same_projection():
    item = frame(3)
    item["cameraPose"]["quaternionXyzw"] = {"x": 0, "y": math.sqrt(.5), "z": 0, "w": math.sqrt(.5)}
    origin, scale = np.array([100, -5, 25]), 150
    camera = frame_camera(item, origin, scale)
    view = camera["rotation"] @ ((np.array([-7, 1, 3])-origin)/scale) + camera["translation"]
    np.testing.assert_allclose(view*scale, [2, 1, 10], atol=1e-5)


def test_native_1024_capture_is_supported_but_larger_and_untiled_sizes_are_rejected():
    manifest = {"frames": [frame(i, "train" if i < 8 else "test") for i in range(10)]}
    for item in manifest["frames"]:
        item.update(width=1024, height=768)
        item["cameraIntrinsics"].update(width=1024, height=768, fx=800, fy=800, cx=512, cy=384)
    assert tuple(map(len, validate_split(manifest))) == (8, 2)
    for width in [1040, 1000]:
        for item in manifest["frames"]:
            item["width"] = item["cameraIntrinsics"]["width"] = width
        with pytest.raises(ValueError, match="resolution"):
            validate_split(manifest)


def test_quality_comparison_matches_physical_cameras_across_resolutions_and_rejects_changed_views():
    previous = [frame(i) for i in range(2)]
    current = deepcopy(previous[::-1])
    for item in current:
        item["frameId"] += "-hd"
        item["width"] *= 2; item["height"] *= 2
        for key in ["width", "height", "fx", "fy", "cx", "cy"]:
            item["cameraIntrinsics"][key] *= 2
        item["cameraPose"]["quaternionXyzw"]["w"] = -1
    assert match_cameras(previous, current) == previous[::-1]
    current[0]["cameraIntrinsics"]["fx"] += 10
    with pytest.raises(ValueError, match="normalized calibration"):
        match_cameras(previous, current)
    current[0]["cameraIntrinsics"]["fx"] -= 10
    current[0]["cameraPose"]["positionM"]["x"] += 0.01
    with pytest.raises(ValueError, match="poses"):
        match_cameras(previous, current)


@pytest.mark.parametrize("damage", ["same-pose", "opposite-quaternion", "same-id", "missing-split", "resolution", "distortion"])
def test_training_test_leakage_and_unsupported_calibration_are_rejected(damage):
    manifest = {"frames": [frame(i, "train" if i < 8 else "test") for i in range(10)]}
    assert tuple(map(len, validate_split(manifest))) == (8, 2)
    held_out = manifest["frames"][8]
    if damage in {"same-pose", "opposite-quaternion"}:
        held_out["cameraPose"] = deepcopy(manifest["frames"][0]["cameraPose"])
        if damage == "opposite-quaternion": held_out["cameraPose"]["quaternionXyzw"]["w"] = -1
    elif damage == "same-id": held_out["frameId"] = "view-0"
    elif damage == "missing-split": held_out["metadata"] = {}
    elif damage == "resolution": held_out["width"] = 255
    else: held_out["cameraIntrinsics"]["distortion"] = [.1]
    with pytest.raises(ValueError): validate_split(manifest)
