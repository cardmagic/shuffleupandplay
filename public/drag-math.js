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

export function rotationFromTransform(transform) {
  if (typeof transform !== "string") return 0

  const values = /^matrix\(([^)]+)\)$/.exec(transform.trim())
  if (!values) return 0

  const numbers = values[1].split(",").map((value) => Number(value))
  if (numbers.length < 2 || numbers.some((value) => !Number.isFinite(value))) return 0

  return Math.atan2(numbers[1], numbers[0])
}

export function cardPoint(options) {
  const { pointer, frame } = options
  const deltaX = pointer.x - frame.center.x
  const deltaY = pointer.y - frame.center.y
  const cosine = Math.cos(frame.rotation)
  const sine = Math.sin(frame.rotation)

  return {
    x: deltaX * cosine + deltaY * sine + frame.size.width / 2,
    y: deltaY * cosine - deltaX * sine + frame.size.height / 2,
  }
}
