from app.models import CameraIntrinsics, CameraPose, RenderRequest, SceneCreate


def test_render_request_keeps_platform_camera_contract() -> None:
    request = RenderRequest(
        pose={
            "position_m": {"x": 1, "y": 2, "z": 3},
            "quaternion_xyzw": {"x": 0, "y": 0, "z": 0, "w": 1},
        },
        intrinsics={
            "width": 1280,
            "height": 720,
            "fx": 800,
            "fy": 800,
            "cx": 640,
            "cy": 360,
        },
        outputs=["rgb", "depth"],
    )

    assert request.pose.coordinate_frame == "world"
    assert request.intrinsics.width == 1280
    assert request.outputs == ["rgb", "depth"]


def test_scene_id_is_safe_for_urls() -> None:
    scene = SceneCreate(scene_id="tower-yard_01", name="tower yard")
    assert scene.scene_id == "tower-yard_01"
