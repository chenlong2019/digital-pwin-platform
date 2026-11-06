from __future__ import annotations

import math
import torch
import torch.nn.functional as F


def ssim(prediction: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    """11x11 Gaussian SSIM, RGB in [0,1], population covariance, valid window."""
    if prediction.ndim == 3:
        prediction = prediction.permute(2, 0, 1)[None]
        reference = reference.permute(2, 0, 1)[None]
    window = min(11, prediction.shape[-2], prediction.shape[-1])
    window -= 1-window % 2
    axis = torch.arange(window, device=prediction.device, dtype=prediction.dtype) - window//2
    kernel = torch.exp(-axis.square() / (2*1.5**2))
    kernel /= kernel.sum()
    kernel = (kernel[:, None]*kernel[None, :])[None, None].expand(3, 1, -1, -1)
    smooth = lambda image: F.conv2d(image, kernel, groups=3)
    mean_x, mean_y = smooth(prediction), smooth(reference)
    variance_x = smooth(prediction.square()) - mean_x.square()
    variance_y = smooth(reference.square()) - mean_y.square()
    covariance = smooth(prediction*reference) - mean_x*mean_y
    return (((2*mean_x*mean_y+0.01**2)*(2*covariance+0.03**2)) /
            ((mean_x.square()+mean_y.square()+0.01**2)*(variance_x+variance_y+0.03**2))).mean()


def image_metrics(prediction: torch.Tensor, reference: torch.Tensor, background: torch.Tensor) -> dict:
    error = (prediction-reference).square().mean(-1)
    mask = (reference-background).abs().amax(-1) > 0.03
    psnr = lambda mse: min(120.0, -10*math.log10(max(float(mse), 1e-12)))
    return {"psnr": psnr(error.mean()), "ssim": float(ssim(prediction, reference)),
            "foreground_psnr": psnr(error[mask].mean()) if mask.any() else None,
            "foreground_fraction": float(mask.float().mean())}
