// Shared shimmer skeleton primitive. The `animate-shimmer` keyframe animates
// background-position, so it only shows if the element carries a horizontal
// gradient sized at 200% — this component bakes that in so callers can't get a
// static (non-animating) placeholder by mistake. Matches SessionSkeleton's look.
export default function Skeleton({ className = '', rounded = 'rounded', style }) {
  return (
    <span
      aria-hidden
      /* data */ style={style}
      className={`block bg-gradient-to-r from-[var(--surface-2)] via-[var(--surface-3)] to-[var(--surface-2)] bg-[length:200%_100%] animate-shimmer ${rounded} ${className}`}
    />
  )
}
