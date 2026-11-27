export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-0.9 -1.75 26 26" fill="none" aria-hidden>
      {/* the prism and its input beam follow the surrounding text colour */}
      <path d="M12 3.5 20.5 19H3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M1 13.2 9.6 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {/* data:start spectrum rays, fixed by the logo artwork */}
      <path d="m14.6 11.8 8.4-3" stroke="#5B6CFF" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m14.8 12.4 8.4-.4" stroke="#2FB4C6" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m15 13 8 2.4" stroke="#F0B43C" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m15.2 13.6 7.4 4.8" stroke="#EC6A5C" strokeWidth="1.6" strokeLinecap="round" />
      {/* data:end */}
    </svg>
  )
}
