import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTemplateTokens } from './templatePayload.ts'

const FONT = 'data:font/woff2;base64,d09GMgABAAAAA+=='
const font = (over = {}) => ({ family: 'Inter', weight: '400', style: 'normal', dataUrl: FONT, ...over })

test('a design system as the importer builds it passes', () => {
  const t = {
    headingFont: 'DM Sans',
    bodyFont: 'Helvetica, Arial, sans-serif',
    palette: [{ varName: '--db-navy', name: 'Navy', value: '#1B3139' }, { varName: '', name: 'x', value: '#FFFFFF' }],
    fontAssets: [
      font(),
      font({ family: 'Noto Sans JP', weight: '700', style: 'italic', dataUrl: 'data:font/ttf;base64,AAEAAA==' }),
      font({ family: 'Söhne Mono', weight: 400, dataUrl: 'data:application/font-woff;base64,d09GRg==' }),
      font({ family: 'Helvetica Neue (Custom) & Co+', dataUrl: 'data:application/x-font-ttf;base64,AAEAAA==' }),
      font({ family: 'Legacy', weight: '100 900', style: 'oblique 10deg', dataUrl: 'data:application/octet-stream;base64,AAEAAA==' }),
      { family: 'Bare', dataUrl: FONT },
    ],
  }
  assert.deepEqual(validateTemplateTokens(t), [])
})

test('absent fields are not checked', () => {
  assert.deepEqual(validateTemplateTokens({}), [])
  assert.deepEqual(validateTemplateTokens({ headingFont: '', bodyFont: null }), [])
})

test('a font family that could close the CSS string or the <style> is rejected', () => {
  for (const family of ["Inter'}</style><img src=x onerror=alert(1)>", 'Inter;}', 'a{b}', 'x\\27', '', 'A'.repeat(81)]) {
    assert.deepEqual(validateTemplateTokens({ fontAssets: [font({ family })] }), ['fontAssets'], family)
  }
})

test('font weight and style accept only letters, digits, space, dot and hyphen', () => {
  assert.deepEqual(validateTemplateTokens({ fontAssets: [font({ weight: 'regular', style: 'oblique -10.5deg' })] }), [])
  for (const over of [{ weight: '400;}</style>' }, { weight: '400}' }, { style: 'italic;color:red' }, { style: '</style>' }, { weight: '1'.repeat(33) }]) {
    assert.deepEqual(validateTemplateTokens({ fontAssets: [font(over)] }), ['fontAssets'], JSON.stringify(over))
  }
})

test('the font data URL must be a base64 font', () => {
  for (const dataUrl of [
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:font/woff2;base64,AAAA);}</style><script>',
    'data:font/woff2,rawtext',
    'https://evil.example/f.woff2',
    'javascript:alert(1)',
  ]) {
    assert.deepEqual(validateTemplateTokens({ fontAssets: [font({ dataUrl })] }), ['fontAssets'], dataUrl)
  }
})

test('heading and body font names reject CSS/HTML metacharacters', () => {
  assert.deepEqual(validateTemplateTokens({ headingFont: "X'}</style><img src=x onerror=1>" }), ['headingFont'])
  assert.deepEqual(validateTemplateTokens({ bodyFont: 'Arial;}body{display:none' }), ['bodyFont'])
  assert.deepEqual(validateTemplateTokens({ headingFont: 'A'.repeat(121) }), ['headingFont'])
})

test('a palette variable name is a plain CSS identifier', () => {
  for (const varName of ['--x:red;}</style><img src=x onerror=1>', '--a b', '--a{', 'x'.repeat(83)]) {
    assert.deepEqual(validateTemplateTokens({ palette: [{ varName, value: '#000000' }] }), ['palette'], varName)
  }
})

test('non-string or non-array shapes are rejected', () => {
  assert.deepEqual(validateTemplateTokens({ headingFont: 42 }), ['headingFont'])
  assert.deepEqual(validateTemplateTokens({ fontAssets: [font({ family: ['Inter'] })] }), ['fontAssets'])
  assert.deepEqual(validateTemplateTokens({ palette: [{ varName: { x: 1 } }] }), ['palette'])
})
