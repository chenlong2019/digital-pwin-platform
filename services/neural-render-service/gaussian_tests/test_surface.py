import numpy as np
import torch

from app.gaussian.renderer import GaussianModel, rotation_matrices
from app.gaussian.surface import initialize_surfaces


def test_local_surface_normal_matches_tilted_plane_and_keeps_geometry_and_colors():
    x, y = np.meshgrid(np.arange(12) * .1, np.arange(12) * .1)
    positions = np.column_stack([x.ravel(), y.ravel(), .5 * x.ravel() + .2 * y.ravel()])
    model = GaussianModel(torch.tensor(positions, dtype=torch.float32),
                          torch.full((len(positions), 3), .6), torch.full((len(positions), 3), .12))
    means, colors = model.means.detach().clone(), model.colors.detach().clone()
    result = initialize_surfaces(model, positions, .2, 1)
    assert result["flattened_gaussians"] > .8 * len(positions)
    mask = model.log_scales[:, 2].exp() < .03
    normals = rotation_matrices(model.quaternions)[mask, :, 2]
    expected = torch.tensor([-.5, -.2, 1.])
    expected /= expected.norm()
    torch.testing.assert_close((normals @ expected).abs(), torch.ones(len(normals)), atol=1e-5, rtol=1e-5)
    torch.testing.assert_close(model.means, means)
    torch.testing.assert_close(model.colors, colors)


def test_weighted_microbatches_preserve_full_batch_training_gradients():
    from app.gaussian.metrics import ssim
    camera = {"width": 32, "height": 32, "fx": 30., "fy": 30., "cx": 16., "cy": 16.,
              "rotation": torch.eye(3), "translation": torch.zeros(3)}
    models = [GaussianModel(torch.tensor([[.1, -.1, 2.], [-.2, .15, 2.5]]),
                            torch.full((2, 3), .6), torch.full((2, 3), .2)) for _ in range(2)]
    reference = torch.full((4, 256, 3), .3)
    for model, size in zip(models, [4, 3]):
        for ids in torch.arange(4).split(size):
            prediction = model.render_tiles(model.project(camera), camera, ids, torch.zeros(3))
            target = reference[ids]
            loss = .8 * (prediction-target).abs().mean() + .2 * (1-ssim(
                prediction.reshape(-1, 16, 16, 3).permute(0, 3, 1, 2),
                target.reshape(-1, 16, 16, 3).permute(0, 3, 1, 2)))
            (loss * len(ids)/4).backward()
    for a, b in zip(models[0].parameters(), models[1].parameters()):
        torch.testing.assert_close(a.grad, b.grad, atol=1e-6, rtol=1e-5)
