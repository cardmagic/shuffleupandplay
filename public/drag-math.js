export function dragOffset(options) {
  const { pointer, canvas, card } = options

  return {
    x: pointer.x - (canvas.left + card.left),
    y: pointer.y - (canvas.top + card.top),
  }
}

export function dragPosition(options) {
  const { pointer, canvas, offset } = options

  return {
    left: Math.max(0, Math.round(pointer.x - canvas.left - offset.x)),
    top: Math.max(0, Math.round(pointer.y - canvas.top - offset.y)),
  }
}
