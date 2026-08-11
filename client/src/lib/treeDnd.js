// Pure drag-and-drop decision helpers for the element tree (item 1). Kept free
// of React/DOM so both the inspector and the QA harness exercise the exact same
// logic — the risky parts of a tree move are these decisions, not the DOM splice.

// Where a drop lands given the cursor's vertical position within a row (0 = top
// edge, 1 = bottom edge). Middle band reparents INSIDE; the top/bottom bands
// drop as a sibling before/after. The slide root can only be dropped INTO.
export function zoneFromRatio(ratio, isRoot = false) {
  if (isRoot) return 'inside'
  if (ratio < 0.28) return 'before'
  if (ratio > 0.72) return 'after'
  return 'inside'
}

// Is dropping `from` onto `to` legal? A node may not be dropped onto itself or
// into its own subtree (that would detach the branch). Paths are element-index
// strings like "1.0.2"; a descendant path is the ancestor path + "." + more.
export function canDrop(fromPath, toPath) {
  if (fromPath == null || toPath == null) return false
  if (fromPath === toPath) return false
  if (toPath === fromPath || String(toPath).startsWith(fromPath + '.')) return false
  return true
}
