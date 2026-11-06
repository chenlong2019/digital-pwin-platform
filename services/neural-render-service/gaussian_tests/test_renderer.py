import math

import pytest
import torch

from app.gaussian.metrics import image_metrics, ssim
from app.gaussian.renderer import GaussianModel

torch.set_num_threads(1)


def camera():
    return {"width": 32, "height": 32, "fx": 30., "fy": 30., "cx": 16.5, "cy": 16.5,
            "rotation": torch.eye(3), "translation": torch.zeros(3)}


def test_depth_ordered_alpha_compositing_matches_analytic_occlusion():
    model = GaussianModel(torch.tensor([[0., 0., 1.], [0., 0., 2.]]),
                          torch.tensor([[1., 0., 0.], [0., 0., 1.]]), torch.full((2, 3), .15))
    with torch.no_grad(): model.opacity.copy_(torch.logit(torch.tensor([.8, .5])))
    image = model.render(camera(), torch.zeros(3))
    colors = model.colors.sigmoid()
    expected = .8*colors[0]+.2*.5*colors[1]
    torch.testing.assert_close(image[16, 16], expected, atol=1e-6, rtol=1e-5)
    # Reversing input storage order must preserve depth and visible colors.
    reversed_model = GaussianModel(model.means.detach().flip(0), colors.detach().flip(0), torch.full((2, 3), .15))
    with torch.no_grad(): reversed_model.opacity.copy_(model.opacity.detach().flip(0))
    torch.testing.assert_close(reversed_model.render(camera(), torch.zeros(3)), image)


def test_camera_translation_produces_depth_dependent_parallax_and_hides_rear_points():
    model = GaussianModel(torch.tensor([[0., 0., 2.], [0., 0., 4.]]), torch.full((2, 3), .7), torch.full((2, 3), .1))
    initial = model.project(camera()).means
    shifted = camera()
    shifted["translation"] = torch.tensor([-.5, 0., 0.])
    delta = model.project(shifted).means-initial
    torch.testing.assert_close(delta[:, 0], torch.tensor([-7.5, -3.75]))
    shifted["translation"] = torch.tensor([0., 0., -10.])
    background = torch.tensor([.1, .2, .3])
    torch.testing.assert_close(model.render(shifted, background), background.expand(32, 32, 3), atol=1e-6, rtol=1e-5)


def test_anisotropic_gaussians_have_finite_nonzero_gradients_for_all_parameters():
    model = GaussianModel(torch.tensor([[.1, -.06, 2.]]), torch.tensor([[.7, .3, .5]]), torch.tensor([[.2, .08, .1]]))
    with torch.no_grad(): model.quaternions.copy_(torch.tensor([[.98, .1, .05, .15]]))
    image = model.render(camera(), torch.zeros(3))
    weights = torch.arange(32, dtype=torch.float32)[None, :, None]/32
    (image.square().mean()+(image*weights).mean()).backward()
    for name, parameter in model.named_parameters():
        assert parameter.grad is not None, name
        assert torch.isfinite(parameter.grad).all(), name
        assert parameter.grad.norm() > 1e-7, name


def test_quality_metrics_match_known_errors_and_exclude_background():
    reference, prediction = torch.zeros(32, 32, 3), torch.zeros(32, 32, 3)
    reference[:16, :16] = .5
    prediction[:16, :16] = .4
    result = image_metrics(prediction, reference, torch.zeros(3))
    assert result["psnr"] == pytest.approx(-10*math.log10(.25*.1**2), abs=1e-5)
    assert result["foreground_psnr"] == pytest.approx(20, abs=1e-5)
    assert result["foreground_fraction"] == .25
    assert float(ssim(reference, reference)) == pytest.approx(1, abs=1e-6)
    assert float(ssim(torch.zeros_like(reference), torch.ones_like(reference))) == pytest.approx(.0001/1.0001, abs=1e-6)
    assert image_metrics(reference, reference, torch.zeros(3))["psnr"] == 120
    assert image_metrics(torch.zeros_like(reference), torch.zeros_like(reference), torch.zeros(3))["foreground_psnr"] is None
