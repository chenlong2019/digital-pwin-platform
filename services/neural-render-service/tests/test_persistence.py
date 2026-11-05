from app.models import DatasetCreate, DatasetFrameUpload, SceneCreate
from app.store import PersistentStore


def test_sqlite_store_persists_dataset_frames(tmp_path) -> None:
    store = PersistentStore(str(tmp_path))
    store.create_scene(SceneCreate(scene_id="scene-1", name="Scene 1"))
    store.create_dataset(DatasetCreate(dataset_id="dataset-1", name="Dataset 1", scene_id="scene-1"))

    result = store.add_frame(
        "dataset-1",
        DatasetFrameUpload(
            frameId="frame-1",
            imageDataUrl="data:image/png;base64,iVBORw0KGgo=",
            width=1280,
            height=720,
            simulationTime=1.25,
            capturedAt="2026-11-05T12:00:00Z",
            cameraPose={
                "positionM": {"x": 1, "y": 2, "z": 3},
                "quaternionXyzw": {"x": 0, "y": 0, "z": 0, "w": 1},
            },
            cameraIntrinsics={
                "width": 1280,
                "height": 720,
                "fx": 800,
                "fy": 800,
                "cx": 640,
                "cy": 360,
            },
        ),
    )

    manifest = store.get_manifest("dataset-1")
    assert result["imageUri"].endswith("frame-1.png")
    assert manifest is not None
    assert manifest["coordinateFrame"] == "platform-world"
    assert len(manifest["frames"]) == 1


def test_dataset_validation_survives_store_restart(tmp_path) -> None:
    first = PersistentStore(str(tmp_path))
    first.create_scene(SceneCreate(scene_id="scene-2", name="Scene 2"))
    first.create_dataset(DatasetCreate(dataset_id="dataset-2", name="Dataset 2", scene_id="scene-2"))
    for index in range(10):
        first.add_frame(
            "dataset-2",
            DatasetFrameUpload(
                frameId=f"frame-{index}",
                imageDataUrl="data:image/png;base64,iVBORw0KGgo=",
                width=1280,
                height=720,
                simulationTime=float(index),
                capturedAt=f"2026-11-05T12:00:{index:02d}Z",
                cameraPose={
                    "positionM": {"x": index, "y": 2, "z": 3},
                    "quaternionXyzw": {"x": 0, "y": 0, "z": 0, "w": 1},
                },
                cameraIntrinsics={
                    "width": 1280,
                    "height": 720,
                    "fx": 800,
                    "fy": 800,
                    "cx": 640,
                    "cy": 360,
                },
            ),
        )

    second = PersistentStore(str(tmp_path))
    validation = second.validate_dataset("dataset-2")
    assert validation is not None
    assert validation["valid"] is True
    assert validation["frame_count"] == 10
    finalized = second.set_dataset_status("dataset-2", "ready")
    assert finalized is not None
    assert finalized.status == "ready"
