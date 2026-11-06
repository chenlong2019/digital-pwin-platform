export interface CampusCaptureView {
  id: string
  split: 'train' | 'test'
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
}

/** Test angles and heights are fixed before capture, and never enter training. */
export function campusCapturePlan(): CampusCaptureView[] {
  const views: CampusCaptureView[] = []
  const target = { x: 0, y: 22, z: -105 }
  for (const split of ['train', 'test'] as const) {
    const count = split === 'train' ? 16 : 4
    const heights = split === 'train' ? [150, 210] : [165, 195]
    for (let ring = 0; ring < heights.length; ring++)
      for (let index = 0; index < count; index++) {
        const angle = (((index * 360) / count + (split === 'test' ? 11.25 : 0)) * Math.PI) / 180
        views.push({
          id: `${split}-${ring}-${index.toString().padStart(2, '0')}`,
          split,
          position: {
            x: Math.sin(angle) * 300,
            y: heights[ring]!,
            z: -105 + Math.cos(angle) * 300,
          },
          target,
        })
      }
  }
  return views
}
