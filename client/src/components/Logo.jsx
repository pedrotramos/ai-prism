export default function Logo({ size = 28 }) {
  const id = 'pg' + size
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      {/* data:start brand gradient, fixed by the logo artwork */}
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF3621" />
          <stop offset="0.4" stopColor="#FF8A00" />
          <stop offset="0.7" stopColor="#22C55E" />
          <stop offset="1" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      {/* prism */}
      <polygon
        points="32,12 52,48 12,48"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      {/* white beam in (hits the left face), refracts, exits as a spectrum
          fan from the middle of the right face (~42,30) */}
      <line x1="3" y1="30" x2="24" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <line x1="42" y1="30" x2="61" y2="21" stroke="#FF3621" strokeWidth="2.6" strokeLinecap="round" />
      <line x1="42" y1="30" x2="61" y2="27" stroke="#FF8A00" strokeWidth="2.6" strokeLinecap="round" />
      <line x1="42" y1="30" x2="61" y2="33" stroke="#22C55E" strokeWidth="2.6" strokeLinecap="round" />
      <line x1="42" y1="30" x2="61" y2="39" stroke="#3B82F6" strokeWidth="2.6" strokeLinecap="round" />
      {/* data:end */}
    </svg>
  )
}
