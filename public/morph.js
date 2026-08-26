const KEY_ATTRIBUTES = ["data-instance-id", "data-counter-id"]

export function morph(target, rendered) {
  const next = document.createElement("div")
  next.innerHTML = rendered
  if (target.innerHTML === next.innerHTML) return

  const activeId = document.activeElement?.id
  morphChildren(target, next)
  if (activeId) document.getElementById(activeId)?.focus()
}

function morphChildren(current, next) {
  const keyed = keyedChildren(current)
  const nextNodes = [...next.childNodes]

  for (let index = 0; index < nextNodes.length; index += 1) {
    const desired = nextNodes[index]
    const existing = current.childNodes[index]
    const match = keyedMatch({ desired, keyed })

    if (match && match !== existing) {
      current.insertBefore(match, existing ?? null)
      morphNode(match, desired)
      continue
    }

    if (!existing) {
      current.append(desired)
      continue
    }

    morphNode(existing, desired)
  }

  while (current.childNodes.length > nextNodes.length) {
    current.lastChild?.remove()
  }
}

function keyedChildren(current) {
  const keyed = new Map()
  for (const node of current.children) {
    const key = nodeKey(node)
    if (key) keyed.set(key, node)
  }
  return keyed
}

function keyedMatch(options) {
  const { desired, keyed } = options
  const key = nodeKey(desired)
  if (!key) return null

  return keyed.get(key) ?? null
}

function nodeKey(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null

  const parts = KEY_ATTRIBUTES.map((name) => node.getAttribute(name)).filter(
    (value) => value !== null,
  )
  if (parts.length === 0) return null

  return `${node.nodeName}:${parts.join(":")}`
}

function morphNode(current, desired) {
  if (current.nodeType !== desired.nodeType || current.nodeName !== desired.nodeName) {
    current.replaceWith(desired)
    return
  }

  if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue
    return
  }

  if (current.nodeType !== Node.ELEMENT_NODE) return

  if (current.nodeName === "IMG" && current.getAttribute("src") !== desired.getAttribute("src")) {
    current.replaceWith(desired)
    return
  }

  morphAttributes(current, desired)
  morphChildren(current, desired)
}

function morphAttributes(current, desired) {
  for (const attribute of [...current.attributes]) {
    if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
  }

  for (const attribute of [...desired.attributes]) {
    if (current.getAttribute(attribute.name) === attribute.value) continue
    current.setAttribute(attribute.name, attribute.value)
  }
}
