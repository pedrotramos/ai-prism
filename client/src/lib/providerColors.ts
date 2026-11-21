// Provider brand colours for the small dot next to a model name. Brand data,
// not UI colour, so they live here instead of in components; the app's own
// colours come from styles/tokens.css. Unknown providers get no colour and
// the dot falls back to the --faint token.
export const PROVIDER_COLORS: Record<string, string> = {
  Anthropic: '#D97757',
  OpenAI: '#10A37F',
  'OpenAI (OSS)': '#10A37F',
  Google: '#4285F4',
  Meta: '#0668E1',
  Alibaba: '#FF6A00',
  'Zhipu AI': '#3859FF',
}

export const providerColor = (provider: string): string | null => PROVIDER_COLORS[provider] || null
